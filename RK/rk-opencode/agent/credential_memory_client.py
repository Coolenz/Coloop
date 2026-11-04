"""Local UI relay to the unified Mem0 catalog. No credentials or model calls."""

import json
from pathlib import Path
import sys
import urllib.request


def main():
    line = sys.stdin.buffer.readline(16385)
    if len(line) > 16384:
        raise ValueError()
    body = json.loads(line)
    if not isinstance(body, dict) or body.get("op") not in (
        "browse", "set", "revise", "remove_record", "status", "sync_private"
    ):
        raise ValueError()
    root = Path("/home/cat/rk-opencode")
    config = json.loads((root / ".runtime/memory-config.json").read_text())
    if config.get("enabled") is not True:
        raise ValueError()
    key = (root / ".runtime/memory-key").read_text().strip()
    request = urllib.request.Request(
        "http://127.0.0.1:8092/call", data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=12) as response:
        result = json.load(response)
    print(json.dumps({"ok": True, "value": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"ok":false,"error":"MEMORY_UNAVAILABLE"}')
        sys.exit(1)
