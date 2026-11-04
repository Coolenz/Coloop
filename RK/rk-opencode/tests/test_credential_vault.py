"""Linux vault security boundaries, using synthetic fields and a fake HID sink."""

import importlib.util
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
HAS_FCNTL = importlib.util.find_spec("fcntl") is not None
if HAS_FCNTL:
    sys.path.insert(0, str(ROOT / "agent"))
    from credential_vault import Handler, Server, Vault, VaultError, decode


@unittest.skipUnless(HAS_FCNTL, "Unix socket / fcntl service requires Linux")
class VaultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.vault = Vault(Path(self.temp.name) / "store")
        self.user = "  vault_user_" + uuid.uuid4().hex[:10] + "  "
        self.password = ' A!z9_"\\' + uuid.uuid4().hex[:12] + " "
        self.record = self.vault.call({
            "op": "create", "origin": "https://example.com",
            "username": self.user, "password": self.password,
        })

    def tearDown(self):
        self.temp.cleanup()

    def fill(self, **kwargs):
        return {"op": "fill", "id": self.record["id"], "origin": self.record["origin"],
                "field": "password", "requestId": str(uuid.uuid4()), **kwargs}

    def test_exact_encrypted_and_no_read_operation(self):
        self.assertEqual(self.vault.consume(self.fill()), self.password)
        self.assertEqual(self.vault.consume(self.fill(field="username")), self.user)
        public = json.dumps(self.vault.call({"op": "list"}))
        self.assertNotIn(self.user, public)
        self.assertNotIn(self.password, public)
        for path in self.vault.directory.glob("*.sqlite3*"):
            self.assertNotIn(self.user.encode(), path.read_bytes())
            self.assertNotIn(self.password.encode(), path.read_bytes())
        with self.assertRaises(VaultError):
            self.vault.call({"op": "get", "id": self.record["id"]})
        reopened = Vault(self.vault.directory)
        self.assertEqual(reopened.consume(self.fill()), self.password)

    def test_replay_origin_and_schema(self):
        body = self.fill()
        self.vault.consume(body)
        with self.assertRaisesRegex(VaultError, "REQUEST_ALREADY_USED"):
            self.vault.consume(body)
        for site in ("https://example.com.evil.test", "http://example.com", "https://example.com:444"):
            with self.assertRaises(VaultError):
                self.vault.consume(self.fill(origin=site))
        with self.assertRaises(VaultError):
            self.vault.consume(self.fill(text=self.password))
        with self.assertRaises(VaultError):
            decode(b'{"op":"list","op":"get"}\n')

    def test_fields_cannot_include_hid_navigation(self):
        for value in ("a\nb", "a\tb", "\x1b", "中文", "x" * 65):
            with self.assertRaisesRegex(VaultError, "UNSUPPORTED_TEXT"):
                self.vault.call({"op": "create", "origin": "https://example.com",
                                 "username": "user", "password": value})

    def test_binding_rejects_swapped_ciphertext_and_deleted_id(self):
        other = self.vault.call({"op": "create", "origin": "https://example.com",
                                 "username": "another", "password": "another-password"})
        with self.vault.connect() as db:
            db.execute("UPDATE credentials SET payload=(SELECT payload FROM credentials WHERE id=?) WHERE id=?",
                       (other["id"], self.record["id"]))
        with self.assertRaisesRegex(VaultError, "PAYLOAD_MISMATCH"):
            self.vault.consume(self.fill())
        self.vault.call({"op": "delete", "id": self.record["id"]})
        with self.assertRaises(VaultError):
            self.vault.consume(self.fill())

    def test_stream_heartbeat_loss_and_no_secret_in_reply(self):
        path = str(Path(self.temp.name) / "service.sock")
        sent = []

        def sender(value, allowed, _lock):
            self.assertEqual(value, self.password)
            for char in value:
                if not allowed():
                    raise VaultError("INPUT_OUTCOME_UNKNOWN")
                sent.append(char)
                time.sleep(0.06)

        with Server(path, Handler) as server:
            server.vault, server.sender, server.lock_path = self.vault, sender, "unused"
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with socket.socket(socket.AF_UNIX) as channel:
                    channel.connect(path)
                    channel.settimeout(3)
                    body = self.fill()
                    channel.sendall(json.dumps(body).encode() + b"\n")
                    reader = channel.makefile("rb")
                    self.assertEqual(json.loads(reader.readline())["state"], "awaiting_focus")
                    channel.sendall(json.dumps({"continue": body["requestId"]}).encode() + b"\n")
                    reply = reader.readline()
                    self.assertEqual(json.loads(reply)["error"], "INPUT_OUTCOME_UNKNOWN")
                    self.assertLess(len(sent), len(self.password))
                    self.assertNotIn(self.password.encode(), reply)
                    self.assertNotIn(self.user.encode(), reply)
            finally:
                server.shutdown()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
