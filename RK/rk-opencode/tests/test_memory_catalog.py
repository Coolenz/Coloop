"""Catalog tests use SQLite and a fake vector adapter; not hardware/Mem0 validation."""
from pathlib import Path
import sqlite3
import sys
import threading
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from mem0_engine import Mem0Engine  # noqa: E402
from memory_service import Service  # noqa: E402
from test_private_memory import IndexStub  # noqa: E402


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.engine = e = Mem0Engine.__new__(Mem0Engine)
        e.project, e.user = "test", "local"
        e.db = sqlite3.connect(":memory:")
        e.db.row_factory = sqlite3.Row
        self.addCleanup(e.db.close)
        e.db.executescript("""
          CREATE TABLE entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,
          project TEXT,key TEXT,value TEXT,kind TEXT,source TEXT,verified INT,
          expires REAL,layer TEXT,sources TEXT,job TEXT);
          CREATE TABLE jobs(id TEXT,project TEXT,status TEXT);
        """)
        e.stores = {"facts": IndexStub()}
        e.invalidate_capsules = Mock()
        e.private_catalog = Mock()
        e.init_catalog()

    def test_additive_schema_legacy_rows_and_no_body_in_directory(self):
        e = self.engine
        e.record("legacy", "BODY_CANARY", key="old")
        e.init_catalog()
        directory = e.catalog()["memories"][0]
        self.assertEqual(directory["summary"], "")
        self.assertEqual(directory["tags"], [])
        self.assertNotIn("value", directory)
        self.assertNotIn("BODY_CANARY", str(directory))
        self.assertEqual(e.get_many(["legacy"])["memories"][0]["value"], "BODY_CANARY")

    def test_explicit_set_without_inference_tag_and_query_filters(self):
        e = self.engine
        a = e.set("a", "正文", tags=[" APP:notepad ", "workflow:outline", "APP:notepad"],
                  summary="写作提纲", source_task_id="task-a")
        e.set("b", "另一个", tags=["app:notepad"])
        self.assertEqual(a["tags"], ["app:notepad", "workflow:outline"])
        self.assertFalse(e.stores["facts"].add_calls[0][1]["infer"])
        found = e.call({"op": "catalog", "tags": ["workflow:outline", "app:notepad"], "query": "写作"})
        self.assertEqual([r["id"] for r in found["memories"]], [a["id"]])
        self.assertEqual(found["memories"][0]["sourceTaskId"], "task-a")
        e.private_catalog.search.assert_not_called()
        self.assertEqual(e.get_many(["private:credential:abc"])["missing"], ["private:credential:abc"])

    def test_updated_expired_deleted_and_cross_project_ids_are_unavailable(self):
        e = self.engine
        old = e.set("a", "旧值", tags=["app:notepad"])
        current = e.set("a", "新值", ttl=1)
        self.assertEqual(e.get_many([old["id"]])["missing"], [old["id"]])
        with patch("mem0_engine.time.time", return_value=time.time() + 2):
            self.assertEqual(e.catalog()["memories"], [])
            self.assertEqual(e.get_many([current["id"]])["memories"], [])
        e.project = "other"
        self.assertEqual(e.get_many([current["id"]])["missing"], [current["id"]])
        e.project = "test"
        e.delete("a")
        self.assertEqual(e.catalog()["memories"], [])

    def test_revision_preserves_tags_and_metadata_edit_deduplicates(self):
        e = self.engine
        a = e.set("a", "正文", tags=["app:notepad"], summary="摘要")
        same = e.set("a", "正文", tags=["topic:work"])
        self.assertEqual(a["id"], same["id"])
        self.assertEqual(same["tags"], ["topic:work"])
        changed = e.revise(a["id"], "修改")
        self.assertEqual(changed["tags"], ["topic:work"])
        self.assertEqual(changed["summary"], "摘要")
        self.assertEqual(e.catalog(tags=["app:notepad"])["memories"], [])

    def test_validation_and_cannot_self_verify(self):
        e = self.engine
        for tags in ([""], ["a"] * 9, [123], ["a\n"]):
            # Trailing whitespace is valid normalization; embedded controls are rejected.
            if tags == ["a\n"]:
                tags = ["a\nb"]
            with self.assertRaises(ValueError):
                e.set("a", "正文", tags=tags)
        with self.assertRaises(ValueError):
            e.get_many(["a", "a"])
        with self.assertRaises(ValueError):
            e.set("a", "正文", verified=True)
        self.assertEqual(e.rows(), [])

    def test_foreground_lookups_defer_without_waiting_for_maintenance(self):
        service = Service.__new__(Service)
        service.lock, service.busy, service.engine = threading.Lock(), False, Mock()
        service.lock.acquire()
        try:
            result = service.call("/call", {"op": "catalog"})
        finally:
            service.lock.release()
        self.assertTrue(result["deferred"])
        service.busy = True
        self.assertTrue(service.call("/call", {"op": "get_many", "ids": ["a"]})["deferred"])
        service.engine.call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
