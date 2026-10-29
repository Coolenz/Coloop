"""Standard-library client; OpenCode/MCP do not import the embedding runtime."""

import json
from pathlib import Path
import urllib.request


class MemoryClient:
    def __init__(self, root):
        self.root = Path(root)

    def request(self, path, body=None, timeout=180):
        key = (self.root / ".runtime/memory-key").read_text().strip()
        request = urllib.request.Request(
            "http://127.0.0.1:8092" + path,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            data=json.dumps(body).encode() if body is not None else None,
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)

    def call(self, args):
        return self.request("/call", args)

    def get(self, key):
        return self.call({"op": "get", "key": key})["memory"]

    def set(self, key, value, kind="fact", **kwargs):
        return self.call({"op": "set", "key": key, "value": value, "kind": kind, **kwargs})

    def delete(self, key, **kwargs):
        return self.call({"op": "delete", "key": key})


def memory_backend(root):
    root = Path(root)
    config = root / ".runtime/memory-config.json"
    if config.exists() and json.loads(config.read_text()).get("enabled"):
        return MemoryClient(root)  # unavailable service is an error, never silent legacy fallback
    from memory import MemoryStore

    return MemoryStore(root / ".runtime/memory.sqlite3")
