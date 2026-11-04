"""Authenticated Mem0 service with idle-only batch extraction and compression."""

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time
import urllib.request

from mem0_engine import Mem0Engine


class Service:
    def __init__(self, root, config):
        self.root, self.config = root, config
        self.engine = Mem0Engine(root, config)
        self.lock = threading.Lock()
        self.activity_lock = threading.Lock()
        self.active = {}
        self.last_activity = time.monotonic()
        self.busy = False
        self.stop = threading.Event()

    def model_ready(self):
        try:
            key = (self.root / ".runtime/api-key").read_text().strip()
            req = urllib.request.Request(
                "http://127.0.0.1:8088/health", headers={"Authorization": "Bearer " + key}
            )
            with urllib.request.urlopen(req, timeout=1) as response:
                return json.load(response).get("ready") is True
        except (OSError, ValueError):
            return False

    def call(self, path, body):
        if path == "/health":
            return {"ready": True, "provider": "mem0", "version": "2.2.1", "busy": self.busy,
                    "capabilities": ["tag_catalog_v1"]}
        if path == "/activity":
            session = body.get("session_id")
            if not isinstance(session, str) or len(session) > 128:
                raise ValueError("Invalid activity session")
            with self.activity_lock:
                if body.get("active"):
                    self.active[session] = time.monotonic()
                else:
                    self.active.pop(session, None)
                self.last_activity = time.monotonic()
            return {"active_sessions": len(self.active)}
        if path == "/ready-for-foreground":
            deadline = time.monotonic() + 180
            while self.busy and time.monotonic() < deadline:
                self.stop.wait(0.1)
            if self.busy:
                raise TimeoutError("Memory inference has not drained")
            return {"ready": True}
        if path == "/recall" and self.busy:
            return {"context": "", "deferred": True, "reason": "memory maintenance in progress"}
        if path == "/enqueue":
            return self.engine.enqueue(body["text"], independent=True)
        if path == "/call" and body.get("op") in ("catalog", "get_many"):
            # Foreground lookups must not queue behind an uninterruptible NPU maintenance run.
            if self.busy or not self.lock.acquire(timeout=0.05):
                return {"memories": [], "deferred": True,
                        "reason": "memory maintenance in progress"}
            try:
                return self.engine.call(body)
            finally:
                self.lock.release()
        with self.lock:
            if path == "/call":
                return self.engine.call(body)
            if path == "/recall":
                return self.engine.recall(
                    body.get("query", ""), self.config.get("context_bytes", 1200)
                )
            if path == "/maintain":
                self.busy = True
                try:
                    return self.engine.maintain(body.get("force", False))
                finally:
                    self.busy = False
            if path == "/import-legacy":
                result = []
                for row in body["rows"]:
                    result.append(
                        self.engine.set(
                            row["key"],
                            row["value"],
                            row["kind"],
                            source=row["source"],
                            verified=bool(row["verified"]),
                            ttl=max(1, row["expires_at"] - time.time())
                            if row.get("expires_at")
                            else None,
                        )
                    )
                return {"imported": len(result)}
        raise ValueError("Unknown memory endpoint")

    def worker(self):
        while not self.stop.wait(2):
            current = json.loads((self.root / ".runtime/memory-config.json").read_text())
            self.config["auto_maintain"] = current.get("auto_maintain", False)
            with self.activity_lock:
                self.active = {k: v for k, v in self.active.items() if time.monotonic() - v < 600}
                idle = not self.active and time.monotonic() - self.last_activity >= self.config.get(
                    "idle_seconds", 120
                )
            if not self.config.get("auto_maintain", True) or not idle or not self.model_ready():
                continue
            if not self.lock.acquire(blocking=False):
                continue
            try:
                self.busy = True
                result = self.engine.maintain(should_stop=self.has_foreground)
                record = {"at": time.time(), "result": result}
            except Exception as error:
                record = {"at": time.time(), "error": str(error)}
            finally:
                self.busy = False
                self.last_activity = time.monotonic()
                self.lock.release()
            with (self.root / "logs/memory-maintenance.jsonl").open("a", encoding="utf-8") as log:
                log.write(json.dumps(record, ensure_ascii=False) + "\n")

    def has_foreground(self):
        with self.activity_lock:
            return bool(self.active)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        status = 200
        try:
            if self.headers.get("Origin") or not hmac.compare_digest(
                self.headers.get("Authorization", ""), "Bearer " + self.server.key
            ):
                status = 403
                raise ValueError("Memory authentication required; browser origins disabled")
            body = {}
            if self.command == "POST":
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 262144:
                    raise ValueError("Invalid request size")
                self.connection.settimeout(5)
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise ValueError("Expected JSON object")
            elif self.path != "/health":
                raise ValueError("Expected POST")
            result = self.server.service.call(self.path, body)
        except Exception as error:
            status = status if status != 200 else 409
            result = {"error": str(error)}
        data = json.dumps(result, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (OSError, BrokenPipeError):
            pass

    do_GET = handle_request
    do_POST = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    os.environ["RK_AGENT_ROOT"] = str(args.root)
    config = json.loads((args.root / ".runtime/memory-config.json").read_text())
    server = ThreadingHTTPServer(("127.0.0.1", 8092), Handler)
    server.key = (args.root / ".runtime/memory-key").read_text().strip()
    server.service = Service(args.root, config)
    threading.Thread(target=server.service.worker, daemon=True).start()
    print("Mem0 memory service ready (local embeddings, compression and provenance)", flush=True)
    try:
        server.serve_forever()
    finally:
        server.service.stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
