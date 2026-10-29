"""Small durable memory store. Agent-authored claims retain their provenance."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import time


KINDS = ("fact", "preference", "procedure", "task")


class MemoryStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS memories (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL, kind TEXT NOT NULL,
                    source TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
                    updated_at REAL NOT NULL, expires_at REAL
                );
                CREATE TABLE IF NOT EXISTS memory_events (
                    id INTEGER PRIMARY KEY, key TEXT NOT NULL,
                    operation TEXT NOT NULL, source TEXT NOT NULL, at REAL NOT NULL
                );
            """)
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def checked_key(key):
        if not isinstance(key, str) or not key.strip() or len(key) > 128 or "\x00" in key:
            raise ValueError("key must be 1..128 characters")
        return key.strip()

    def set(self, key, value, kind="fact", *, source="agent", verified=False, ttl=None):
        key = self.checked_key(key)
        if not isinstance(value, str) or not 1 <= len(value) <= 1000 or "\x00" in value:
            raise ValueError("value must be 1..1000 characters")
        if kind not in KINDS:
            raise ValueError("Unknown memory kind")
        if ttl is not None and (
            isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not 1 <= ttl <= 31536000
        ):
            raise ValueError("ttl must be 1..31536000 seconds")
        if source not in ("agent", "user", "verifier"):
            raise ValueError("Unknown source")
        if source == "agent" and verified:
            raise ValueError("Agent claims cannot mark themselves verified")
        now = time.time()
        with self.connect() as db:
            db.execute(
                """INSERT INTO memories VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, kind=excluded.kind,
                source=excluded.source, verified=excluded.verified,
                updated_at=excluded.updated_at, expires_at=excluded.expires_at""",
                (key, value, kind, source, int(verified), now, now + ttl if ttl else None),
            )
            db.execute(
                "INSERT INTO memory_events(key,operation,source,at) VALUES (?,?,?,?)",
                (key, "set", source, now),
            )
        return self.get(key)

    def get(self, key):
        with self.connect() as db:
            row = db.execute(
                """SELECT * FROM memories WHERE key=?
                AND (expires_at IS NULL OR expires_at>?)""",
                (self.checked_key(key), time.time()),
            ).fetchone()
        return dict(row) if row else None

    def search(self, query="", limit=5):
        if not isinstance(query, str) or len(query) > 200:
            raise ValueError("query must be at most 200 characters")
        if type(limit) is not int or not 1 <= limit <= 10:
            raise ValueError("limit must be 1..10")
        # Literal substring search handles short Chinese keywords without FTS tokenizers.
        with self.connect() as db:
            rows = db.execute(
                """SELECT * FROM memories WHERE
                (expires_at IS NULL OR expires_at>?) AND
                (instr(lower(key),lower(?))>0 OR instr(lower(value),lower(?))>0)
                ORDER BY updated_at DESC LIMIT ?""",
                (time.time(), query, query, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def delete(self, key, source="agent"):
        key = self.checked_key(key)
        with self.connect() as db:
            deleted = db.execute("DELETE FROM memories WHERE key=?", (key,)).rowcount
            db.execute(
                "INSERT INTO memory_events(key,operation,source,at) VALUES (?,?,?,?)",
                (key, "delete", source, time.time()),
            )
        return {"deleted": bool(deleted), "key": key}

    def call(self, arguments):
        op = arguments.get("op")
        if op == "set":
            return self.set(
                arguments.get("key"),
                arguments.get("value"),
                arguments.get("kind", "fact"),
                ttl=arguments.get("ttl"),
            )
        if op == "get":
            return {"memory": self.get(arguments.get("key"))}
        if op == "search":
            return {"memories": self.search(arguments.get("query", ""), arguments.get("limit", 5))}
        if op == "delete":
            return self.delete(arguments.get("key"))
        raise ValueError("Unknown memory operation")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("op", choices=["set", "get", "search", "delete"])
    parser.add_argument("key", nargs="?", default="")
    parser.add_argument("value", nargs="?")
    parser.add_argument("--kind", choices=KINDS, default="fact")
    parser.add_argument(
        "--db", type=Path, default=Path(__file__).resolve().parents[1] / ".runtime/memory.sqlite3"
    )
    args = parser.parse_args()
    store = MemoryStore(args.db)
    if args.op == "set":
        result = store.set(args.key, args.value, args.kind, source="user", verified=True)
    elif args.op == "delete":
        result = store.delete(args.key, source="user")
    else:
        result = store.call({"op": args.op, "key": args.key, "query": args.key})
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
