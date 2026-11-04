"""Manage Mem0 jobs, compression and compatibility operations on the board."""

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
from memory_client import MemoryClient  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "op", choices=("status", "set", "get", "search", "delete", "ingest", "compact", "maintain",
                       "lookup_private", "sync_private")
    )
    parser.add_argument("key", nargs="?")
    parser.add_argument("value", nargs="?")
    parser.add_argument(
        "--kind", choices=("fact", "preference", "procedure", "task"), default="fact"
    )
    parser.add_argument("--ttl", type=float)
    args = parser.parse_args()
    client = MemoryClient(ROOT)
    if args.op == "maintain":
        result = client.request("/maintain", {"force": True}, timeout=600)
    else:
        result = client.call(
            {
                "op": args.op,
                "key": args.key,
                "value": args.key if args.op == "ingest" else args.value,
                "query": args.key if args.op in ("search", "lookup_private") else "",
                "kind": args.kind,
                "ttl": args.ttl,
            }
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
