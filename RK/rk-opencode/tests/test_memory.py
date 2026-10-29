from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from memory import MemoryStore
from mcp_server import MCPServer


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / "memory.sqlite3"
        self.store = MemoryStore(self.path)

    def test_persists_across_store_restart_and_handles_short_chinese(self):
        self.store.set("save_dir", "默认保存在D盘测试目录", "preference")
        reopened = MemoryStore(self.path)
        self.assertEqual(reopened.get("save_dir")["source"], "agent")
        self.assertEqual(reopened.search("目录")[0]["key"], "save_dir")
        self.assertEqual(reopened.get("save_dir")["verified"], 0)
        reopened.delete("save_dir")
        self.assertIsNone(self.store.get("save_dir"))

    def test_expiry_and_agent_cannot_promote_own_claim(self):
        with patch("memory.time.time", return_value=100):
            self.store.set("temporary", "window observation", ttl=10)
        with patch("memory.time.time", return_value=111):
            self.assertIsNone(self.store.get("temporary"))
            self.assertEqual(self.store.search(), [])
        with self.assertRaises(ValueError):
            self.store.set("claim", "success", verified=True)

    def test_mcp_call_uses_real_database_and_no_trusted_source_argument(self):
        mcp = MCPServer(self.root, "memory")
        request = {
            "method": "tools/call",
            "params": {
                "name": "memory",
                "arguments": {
                    "op": "set",
                    "key": "token",
                    "value": "random-test-value",
                    "kind": "task",
                },
            },
        }
        mcp.dispatch(request)
        self.assertEqual(
            MemoryStore(self.root / ".runtime/memory.sqlite3").get("token")["value"],
            "random-test-value",
        )
        request["params"]["arguments"]["verified"] = True
        with self.assertRaises(ValueError):
            mcp.dispatch(request)


if __name__ == "__main__":
    unittest.main()
