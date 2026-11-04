"""Unified-memory directory boundaries; real Mem0/embedding checks run separately."""

import json
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import Mock
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from private_memory import PREFIX, PrivateMemoryCatalog, reference_text  # noqa: E402
from mem0_engine import Mem0Engine  # noqa: E402
from mcp_server import MEMORY_TOOL, memory_tool_result  # noqa: E402


class IndexStub:
    def __init__(self):
        self.rows, self.add_calls = {}, []

    def add(self, text, **kwargs):
        self.add_calls.append((text, kwargs))
        identifier = str(uuid.uuid4())
        self.rows[identifier] = {"id": identifier, "memory": text, "score": 0.9}
        return {"results": [{"id": identifier}]}

    def delete(self, identifier):
        del self.rows[identifier]

    def search(self, query, **kwargs):
        return {"results": list(self.rows.values())}

    def update(self, identifier, **kwargs):
        self.rows[identifier].update(kwargs)


class PrivateMemoryTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.store = IndexStub()
        self.record = {"id": str(uuid.uuid4()), "origin": "https://test-login.invalid", "createdAt": 42}
        self.records = [self.record]
        self.config = {"project": "rk", "user": "local", "private_credentials": {
            "enabled": True, "project": "rk", "user": "local",
        }}
        self.catalog = PrivateMemoryCatalog(
            self.db, self.store, self.config, reader=lambda: self.records
        )

    def test_real_memory_tool_announces_and_routes_private_lookup(self):
        self.assertIn("lookup_private", MEMORY_TOOL["inputSchema"]["properties"]["op"]["enum"])
        engine = Mem0Engine.__new__(Mem0Engine)
        engine.private_catalog, engine.project, engine.user = self.catalog, "rk", "local"
        result = engine.call({"op": "lookup_private", "query": "登录账号在哪里"})
        ref = result["memories"][0]
        self.assertEqual(ref["private"]["record_id"], self.record["id"])
        self.assertEqual(ref["private"]["locator"], "rk-vault://" + self.record["id"])
        self.assertEqual(ref["private"]["resolver"], "coloop_private_login")
        self.assertFalse(ref["private"]["plaintext_readable"])
        self.assertTrue(result["private_memory"]["available"])

    def test_index_exactly_once_without_extraction_and_excludes_provider_values(self):
        self.catalog.search("登录密码", 5, "rk", "local")
        self.catalog.search("登录密码", 5, "rk", "local")
        self.assertEqual(len(self.store.add_calls), 1)
        self.assertIs(self.store.add_calls[0][1]["infer"], False)
        self.assertEqual(self.store.add_calls[0][1]["metadata"]["source"], "private_catalog")
        # A provider accidentally returning username/password fails before any embedding or indexing.
        self.records = [{**self.record, "password": "SECRET_CANARY", "username": "PRIVATE_USER"}]
        with self.assertRaisesRegex(ValueError, "unavailable"):
            self.catalog.search("登录", 5, "rk", "local", explicit=True)
        self.assertNotIn("SECRET_CANARY", json.dumps(self.store.add_calls))
        self.assertNotIn("PRIVATE_USER", json.dumps(self.store.add_calls))
        self.assertFalse(self.catalog.available)

    def test_delete_invalidates_live_lookup_and_index_but_not_ordinary_facts(self):
        first = self.catalog.search("密码", 5, "rk", "local")[0]
        self.records = []
        self.assertEqual(self.catalog.search("密码", 5, "rk", "local"), [])
        self.assertNotIn(first["id"], self.store.rows)
        self.assertIsNone(self.catalog.get(PREFIX + self.record["id"], "rk", "local"))

    def test_project_user_scope_and_unavailable_provider_cannot_return_stale_refs(self):
        self.catalog.search("密码", 5, "rk", "local")
        self.assertEqual(self.catalog.search("密码", 5, "other", "local"), [])
        self.assertEqual(self.catalog.search("密码", 5, "rk", "other"), [])
        self.assertFalse(self.catalog.available)
        self.catalog.reader = Mock(side_effect=OSError("may contain private provider detail"))
        self.assertEqual(self.catalog.search("密码", 5, "rk", "local"), [])
        with self.assertRaisesRegex(ValueError, "^Private memory provider or index unavailable$"):
            self.catalog.search("密码", 5, "rk", "local", explicit=True)

    def test_existing_memory_search_and_get_use_the_same_directory(self):
        engine = Mem0Engine.__new__(Mem0Engine)
        engine.private_catalog, engine.project, engine.user = self.catalog, "rk", "local"
        engine.rows = Mock(return_value=[{"id": "fact", "key": "theme", "value": "深色界面"}])
        engine.stores = {"facts": Mock()}
        engine.stores["facts"].search.return_value = {"results": [{"id": "fact", "score": 0.8}]}
        found = engine.search("test-login.invalid 登录凭据在哪里", 5)
        self.assertEqual(found[0]["private"]["record_id"], self.record["id"])
        self.assertEqual(found[-1]["key"], "theme")
        self.assertEqual(engine.get(PREFIX + self.record["id"])["kind"], "credential_reference")
        for operation in ("set", "delete"):
            with self.assertRaisesRegex(ValueError, "[Pp]rivate memory"):
                engine.call({"op": operation, "key": PREFIX + self.record["id"], "value": "fake"})

    def test_unrelated_recall_avoids_reference_injection_and_text_is_bounded(self):
        self.assertEqual(self.catalog.search("今天几度", 5, "rk", "local"), [])
        self.assertIn("rk-vault://", reference_text(self.record))
        self.assertLess(len(reference_text(self.record).encode()), 900)
        self.assertEqual(len(self.catalog.search("", 1, "rk", "local")), 1)

    def test_mcp_exposes_only_execution_record_id_not_sdk_index_id(self):
        ref = self.catalog.search("登录", 5, "rk", "local")[0]
        value = memory_tool_result({"memories": [ref]}, "lookup_private")
        public = value["memories"][0]
        self.assertEqual(public["record_id"], self.record["id"])
        self.assertNotIn(ref["id"], json.dumps(value))
        self.assertNotIn("value", public)
        self.assertNotIn("id", public)
        ordinary = {"id": "ordinary-id", "key": "theme", "value": "dark"}
        self.assertEqual(memory_tool_result({"memories": [ordinary]}, "search")["memories"], [ordinary])
        self.assertEqual(memory_tool_result({"memory": None}, "get"), {"memory": None})

    def test_unified_browse_contains_both_types_and_paginates_without_body(self):
        engine = Mem0Engine.__new__(Mem0Engine)
        engine.db = self.db
        engine.init_catalog()
        engine.private_catalog, engine.project, engine.user = self.catalog, "rk", "local"
        fact = {"id": str(uuid.uuid4()), "key": "theme", "value": "dark", "kind": "preference",
                "source": "agent", "verified": 0, "expires": None}
        engine.rows = Mock(return_value=[fact])
        engine.stores = {"facts": self.store}
        found = engine.browse()
        self.assertEqual(found["total"], 2)
        self.assertEqual({row["category"] for row in found["items"]}, {"ordinary", "private"})
        private = next(row for row in found["items"] if row["category"] == "private")
        self.assertEqual(private["recordId"], self.record["id"])
        self.assertNotIn("text", private)
        self.assertNotIn("password", private)
        self.assertEqual(len(engine.browse(offset=1, limit=1)["items"]), 1)
        self.assertEqual(engine.browse(category="private")["total"], 1)
        self.assertEqual(engine.browse(category="ordinary")["total"], 1)
        exact = engine.browse(query="theme")
        self.assertEqual(exact["mode"], "literal")
        self.assertEqual(exact["total"], 1)
        self.assertEqual(exact["items"][0]["category"], "ordinary")

    def test_ordinary_revision_keeps_history_and_anonymous_fact_binding(self):
        engine = Mem0Engine.__new__(Mem0Engine)
        engine.private_catalog, engine.project, engine.user = self.catalog, "rk", "local"
        engine.db, engine.stores = self.db, {"facts": IndexStub()}
        engine.init_catalog()
        engine.invalidate_capsules = Mock()
        self.db.execute("""CREATE TABLE entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT UNIQUE,project TEXT,key TEXT,value TEXT,kind TEXT,source TEXT,verified INT,
            expires REAL,layer TEXT,sources TEXT,job TEXT)""")
        self.db.execute("CREATE TABLE jobs(id TEXT,project TEXT,status TEXT)")
        original = engine.set("theme", "dark", "preference")
        changed = engine.revise(original["id"], "light")
        self.assertNotEqual(original["id"], changed["id"])
        self.assertEqual(engine.get("theme")["value"], "light")
        self.assertEqual(len(engine.rows(history=True)), 2)
        self.assertFalse(changed["verified"])
        self.assertTrue(engine.call({"op": "remove_record", "id": changed["id"]})["deleted"])
        self.assertIsNone(engine.get("theme"))
        identifier = str(uuid.uuid4())
        engine.record(identifier, "原始自动事实")
        engine.stores["facts"].rows[identifier] = {"id": identifier}
        edited = engine.revise(identifier, "更正后的事实")
        self.assertEqual(edited["value"], "更正后的事实")
        self.assertEqual(edited["key"], "memory_" + identifier)
        self.assertNotIn(identifier, {row["id"] for row in engine.rows()})


if __name__ == "__main__":
    unittest.main()
