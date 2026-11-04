"""Private credential store. This service has no secret-read or network API."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import select
import socketserver
import sqlite3
import stat
import sys
import threading
import time
from urllib.parse import urlsplit
import uuid

from cryptography.fernet import Fernet

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hid import HIDController, text_reports  # noqa: E402

LIMIT = 16384


class VaultError(Exception):
    pass


def fail(code):
    raise VaultError(code)


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("INVALID_REQUEST")
        result[key] = value
    return result


def decode(line):
    if not line or len(line) > LIMIT or not line.endswith(b"\n"):
        fail("INVALID_REQUEST")
    try:
        value = json.loads(line, object_pairs_hook=object_pairs)
    except (ValueError, UnicodeError):
        fail("INVALID_REQUEST")
    if not isinstance(value, dict):
        fail("INVALID_REQUEST")
    return value


def exact_fields(body, names):
    if set(body) != set(names):
        fail("INVALID_REQUEST")


def record_id(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            fail("INVALID_ID")
    except ValueError:
        fail("INVALID_ID")
    return value


def origin(value):
    if not isinstance(value, str) or len(value) > 500:
        fail("INVALID_ORIGIN")
    try:
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.path
            or url.query
            or url.fragment
            or url.hostname.endswith(".")
        ):
            fail("INVALID_ORIGIN")
        host = url.hostname.encode("idna").decode("ascii").lower()
        if ":" in host:
            host = "[" + host + "]"
        normalized = "https://" + host
        if url.port and url.port != 443:
            normalized += ":" + str(url.port)
        if value != normalized:
            fail("INVALID_ORIGIN")
    except (ValueError, UnicodeError):
        fail("INVALID_ORIGIN")
    return value


def secret(value):
    # No controls/Enter/Tab: a stored field cannot smuggle additional HID actions.
    if not isinstance(value, str) or not 1 <= len(value) <= 64:
        fail("UNSUPPORTED_TEXT")
    if any(not 32 <= ord(char) <= 126 for char in value):
        fail("UNSUPPORTED_TEXT")
    return value


class Vault:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        key = self.directory / "master.key"
        try:
            fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "wb") as output:
                output.write(Fernet.generate_key())
                output.flush()
                os.fsync(output.fileno())
        self.cipher = Fernet(key.read_bytes())
        self.path = self.directory / "vault.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS credentials (
                    id TEXT PRIMARY KEY, origin TEXT NOT NULL,
                    payload BLOB NOT NULL, created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS spent (
                    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL
                );
            """)
        os.chmod(self.path, 0o600)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=3)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA secure_delete=ON")
        return db

    def metadata(self, row):
        return {"id": row["id"], "origin": row["origin"], "createdAt": row["created_at"]}

    def call(self, body):
        op = body.get("op")
        if op in ("status", "list"):
            exact_fields(body, ("op",))
            with self.connect() as db:
                rows = db.execute(
                    "SELECT id,origin,created_at FROM credentials ORDER BY created_at,id"
                ).fetchall()
            return {"version": 1, "records": [self.metadata(row) for row in rows]}
        if op == "create":
            exact_fields(body, ("op", "origin", "username", "password"))
            site = origin(body["origin"])
            user, password = secret(body["username"]), secret(body["password"])
            identifier = str(uuid.uuid4())
            payload = self.cipher.encrypt(json.dumps({
                "id": identifier, "origin": site, "username": user, "password": password,
            }).encode())
            created = int(time.time() * 1000)
            with self.connect() as db:
                if db.execute("SELECT count(*) FROM credentials").fetchone()[0] >= 100:
                    fail("VAULT_FULL")
                db.execute("INSERT INTO credentials VALUES (?,?,?,?)", (
                    identifier, site, payload, created,
                ))
            return {"id": identifier, "origin": site, "createdAt": created}
        if op == "delete":
            exact_fields(body, ("op", "id"))
            with self.connect() as db:
                db.execute("DELETE FROM credentials WHERE id=?", (record_id(body["id"]),))
            return {"deleted": True}
        fail("UNSUPPORTED_OPERATION")

    def consume(self, body):
        exact_fields(body, ("op", "id", "origin", "field", "requestId"))
        if body["op"] != "fill" or body["field"] not in ("username", "password"):
            fail("INVALID_REQUEST")
        identifier = record_id(body["id"])
        site = origin(body["origin"])
        request = record_id(body["requestId"])
        with self.connect() as db:
            row = db.execute("SELECT * FROM credentials WHERE id=?", (identifier,)).fetchone()
            if row is None or row["origin"] != site:
                fail("TARGET_MISMATCH")
            try:
                db.execute("INSERT INTO spent VALUES (?,?)", (request, int(time.time() * 1000)))
            except sqlite3.IntegrityError:
                fail("REQUEST_ALREADY_USED")
        data = json.loads(self.cipher.decrypt(row["payload"]))
        if data["id"] != identifier or data["origin"] != site:
            fail("PAYLOAD_MISMATCH")
        return secret(data[body["field"]])


def send_hid(value, allowed, lock_path):
    # Existing desktop controller uses this same regular lock file. Root only opens it read-only.
    lock_fd = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            fail("HID_LOCK_UNAVAILABLE")
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fd = os.open(HIDController.node("hid.rk_keyboard"), os.O_WRONLY | os.O_NONBLOCK)
        try:
            for report in text_reports(value):
                if not allowed():
                    fail("INPUT_OUTCOME_UNKNOWN")
                if not select.select([], [fd], [], 0.15)[1] or not allowed():
                    fail("INPUT_OUTCOME_UNKNOWN")
                if os.write(fd, report) != len(report):
                    fail("INPUT_OUTCOME_UNKNOWN")
                time.sleep(0.025)
        finally:
            try:
                if select.select([], [fd], [], 0.1)[1]:
                    os.write(fd, bytes(8))
            finally:
                os.close(fd)
    finally:
        os.close(lock_fd)


class Handler(socketserver.StreamRequestHandler):
    def write(self, body):
        self.wfile.write(json.dumps(body, separators=(",", ":")).encode() + b"\n")
        self.wfile.flush()

    def handle(self):
        attempted = False
        try:
            self.connection.settimeout(3)
            body = decode(self.rfile.readline(LIMIT + 1))
            if body.get("op") != "fill":
                self.write({"ok": True, "value": self.server.vault.call(body)})
                return
            value = self.server.vault.consume(body)
            attempted = True
            pulse = {"at": 0.0}
            stop, ready = threading.Event(), threading.Event()

            def listen():
                self.connection.settimeout(0.3)
                try:
                    while not stop.is_set():
                        beat = decode(self.rfile.readline(LIMIT + 1))
                        if beat != {"continue": body["requestId"]}:
                            break
                        pulse["at"] = time.monotonic()
                        ready.set()
                except (OSError, VaultError):
                    pass
                stop.set()

            self.write({"ok": True, "state": "awaiting_focus"})
            monitor = threading.Thread(target=listen, daemon=True)
            monitor.start()
            try:
                if not ready.wait(2) or stop.is_set():
                    fail("INPUT_OUTCOME_UNKNOWN")
                self.server.sender(
                    value,
                    lambda: not stop.is_set() and time.monotonic() - pulse["at"] < 0.3,
                    self.server.lock_path,
                )
                self.write({"ok": True, "value": {"state": "input_sent"}})
            finally:
                stop.set()
                value = None
        except Exception as error:
            # No exception text, payload, field value or length crosses this boundary.
            code = error.args[0] if isinstance(error, VaultError) else "VAULT_UNAVAILABLE"
            if attempted:
                code = "INPUT_OUTCOME_UNKNOWN"
            try:
                self.write({"ok": False, "error": code})
            except OSError:
                pass


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    block_on_close = False

    def handle_error(self, *_):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("/var/lib/rk-credential-vault"))
    parser.add_argument("--socket", default="/run/rk-credential-vault/service.sock")
    parser.add_argument("--lock", default="/home/cat/rk-opencode/.runtime/hid.lock")
    args = parser.parse_args()
    os.umask(0o077)
    path = Path(args.socket)
    path.unlink(missing_ok=True)
    with Server(str(path), Handler) as server:
        server.vault = Vault(args.data)
        server.lock_path = args.lock
        server.sender = send_hid
        os.chmod(path, 0o660)
        server.serve_forever()


if __name__ == "__main__":
    main()
