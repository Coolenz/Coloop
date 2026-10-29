from pathlib import Path
import sqlite3
import sys
import threading
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from mem0_engine import Mem0Engine
from memory_service import Service


class MemorySchedulingTests(unittest.TestCase):
    def test_foreground_stops_remaining_extraction_and_compression(self):
        engine = Mem0Engine.__new__(Mem0Engine)
        engine.project = "test"
        engine.db = sqlite3.connect(":memory:")
        self.addCleanup(engine.db.close)
        engine.db.row_factory = sqlite3.Row
        engine.db.execute(
            "CREATE TABLE jobs(id TEXT,project TEXT,text TEXT,status TEXT,created REAL,error TEXT)"
        )
        engine.db.executemany(
            "INSERT INTO jobs VALUES(?,?,?,'pending',?,NULL)",
            [("a", "test", "first", 1), ("b", "test", "second", 2)],
        )
        foreground = threading.Event()

        def infer(*args):
            foreground.set()  # user arrives while the first memory request is running
            return {"results": []}

        engine.ingest = Mock(side_effect=infer)
        engine.compact = Mock()
        result = engine.maintain(should_stop=foreground.is_set)
        self.assertTrue(result["deferred"])
        engine.ingest.assert_called_once_with("first", "a")
        engine.compact.assert_not_called()
        self.assertEqual(
            engine.db.execute("SELECT status FROM jobs WHERE id='b'").fetchone()[0], "pending"
        )

    def test_foreground_gate_waits_for_inflight_request(self):
        service = Service.__new__(Service)
        service.busy = True
        service.stop = threading.Event()
        finished = threading.Event()
        thread = threading.Thread(
            target=lambda: (service.call("/ready-for-foreground", {}), finished.set())
        )
        thread.start()
        self.assertFalse(finished.wait(0.02))
        service.busy = False
        self.assertTrue(finished.wait(1))
        thread.join()


if __name__ == "__main__":
    unittest.main()
