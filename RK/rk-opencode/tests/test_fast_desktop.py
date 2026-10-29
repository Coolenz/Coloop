import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from fast_desktop import FastDesktop, observe_initial
from mcp_server import MCPServer


class FastDesktopTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / ".runtime").mkdir()
        self.folder = self.root / "logs/testbench-test"
        self.folder.mkdir(parents=True)
        self.initial = {
            "session_id": "pc",
            "observation_id": "first",
            "window_open": True,
            "targets": [
                {
                    "id": 1,
                    "name": "Code: 01234567",
                    "type": "TextRegion",
                    "source": "ocr",
                    "rect": [1, 1, 10, 10],
                }
            ],
        }
        (self.root / ".runtime/desktop-session.json").write_text(json.dumps({"session_id": "pc"}))
        self.write_initial(self.initial)

    def write_initial(self, value):
        (self.root / ".runtime/fast-desktop-initial.json").write_text(json.dumps(value))

    def test_initial_observation_is_real_and_preserves_raw_data_only_in_private_file(self):
        desktop = Mock()
        desktop.call.return_value = self.initial
        with patch.dict(os.environ, {"RK_DESKTOP_BENCH_DIR": str(self.folder)}):
            compact = observe_initial(self.root, desktop)
        desktop.call.assert_called_once_with({"op": "observe"})
        self.assertNotIn("session_id", compact)
        self.assertNotIn("rect", compact["targets"][0])
        raw = json.loads((self.root / ".runtime/fast-desktop-initial.json").read_text())
        self.assertEqual(raw, self.initial)

    def test_benchmark_step_guards_stage_then_returns_automatic_observation(self):
        fast = FastDesktop(self.root)
        observed = {
            **self.initial,
            "observation_id": "after-type",
            "targets": [{"id": 2, "name": "01234567", "source": "ocr"}],
        }
        fast.desktop = Mock()
        fast.desktop.step.return_value = {
            "action": {"executed": True, "state": "input_sent"},
            "observation": observed,
        }
        with patch.dict(os.environ, {"RK_DESKTOP_BENCH_DIR": str(self.folder)}):
            result = fast.call({"observation_id": "first", "action": "type", "text": "01234567"})
            with self.assertRaisesRegex(ValueError, "Apply"):
                fast.call({"observation_id": "after-type", "action": "click", "target_id": 2})
        self.assertEqual(result["observation"]["observation_id"], "after-type")
        self.assertFalse(result["task_verified_complete"])
        fast.desktop.step.assert_called_once()

    def test_sent_input_observation_failure_blocks_replay_until_new_user_observation(self):
        fast = FastDesktop(self.root)
        fast.desktop = Mock()
        fast.desktop.step.return_value = {
            "action": {"executed": True},
            "observation_error": "foreground changed",
        }
        with patch.dict(os.environ, {"RK_DESKTOP_BENCH_DIR": ""}):
            result = fast.call({"observation_id": "first", "action": "type", "text": "x"})
            self.assertTrue(result["action"]["executed"])
            with self.assertRaisesRegex(ValueError, "new user message"):
                fast.call({"observation_id": "first", "action": "type", "text": "x"})
            self.assertEqual(fast.desktop.step.call_count, 1)
            self.write_initial({**self.initial, "observation_id": "new-turn"})
            fast.call({"observation_id": "new-turn", "action": "type", "text": "y"})
        self.assertEqual(fast.desktop.step.call_count, 2)

    def test_mcp_exposes_step_and_validates_args_before_dispatch(self):
        mcp = MCPServer(self.root, "desktop-fast")
        self.assertEqual(
            [t["name"] for t in mcp.dispatch({"method": "tools/list"})["tools"]], ["step"]
        )
        mcp.desktop = Mock()
        mcp.desktop.call.return_value = {"action": {"executed": False}}
        request = {
            "method": "tools/call",
            "params": {
                "name": "step",
                "arguments": {"observation_id": "first", "action": "type", "text": "01234567"},
            },
        }
        result = mcp.dispatch(request)
        self.assertFalse(json.loads(result["content"][0]["text"])["action"]["executed"])
        request["params"]["arguments"]["unexpected"] = True
        with self.assertRaises(ValueError):
            mcp.dispatch(request)
        self.assertEqual(mcp.desktop.call.call_count, 1)


if __name__ == "__main__":
    unittest.main()
