"""Back up a live legacy SQLite DB using its backup API, then import active records."""

import datetime
import json
from pathlib import Path
import sqlite3
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
from memory_client import MemoryClient  # noqa: E402


def main():
    folder = (
        ROOT / "logs" / ("memory-migration-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    )
    folder.mkdir(exist_ok=False)
    original = ROOT / ".runtime/memory.sqlite3"
    rows = []
    if original.exists():
        with (
            sqlite3.connect(original) as source,
            sqlite3.connect(folder / "legacy-backup.sqlite3") as backup,
        ):
            source.backup(backup)
            source.row_factory = sqlite3.Row
            rows = [
                dict(r)
                for r in source.execute(
                    "SELECT * FROM memories WHERE expires_at IS NULL OR expires_at>?",
                    (time.time(),),
                )
            ]
    result = MemoryClient(ROOT).request("/import-legacy", {"rows": rows})
    result["backup"] = str(folder / "legacy-backup.sqlite3")
    (folder / "migration.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
