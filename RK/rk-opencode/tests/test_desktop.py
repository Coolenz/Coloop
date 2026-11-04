import json
from pathlib import Path
import sys
import tempfile
import unittest
import os
from contextlib import nullcontext
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from desktop import DesktopTools


class DesktopTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / ".runtime").mkdir()
        self.tool = DesktopTools(self.root)
        if os.name == "nt":
            # Test protocol rejection on Windows without pretending to provide Linux flock.
            lock = patch.object(self.tool, "input_lock", side_effect=nullcontext)
            lock.start()
            self.addCleanup(lock.stop)
        self.action = {"op": "act", "observation_id": "observed", "action": "click", "target_id": 1}

    def test_default_is_a_plan_and_never_opens_hid(self):
        with patch.object(self.tool, "pc", return_value={"valid": True, "session_id": "pc"}) as pc:
            with patch("desktop.HIDController") as hid:
                result = self.tool.call(self.action)
        self.assertFalse(result["executed"])
        self.assertEqual(result["state"], "planned")
        self.assertNotIn("session_id", result)
        self.assertNotIn("validation_ms", result)
        recorded = json.loads((self.root / "logs/desktop-actions.jsonl").read_text())
        self.assertEqual(recorded["session_id"], "pc")
        self.assertGreaterEqual(recorded["validation_ms"], 0)
        hid.assert_not_called()
        self.assertFalse(pc.call_args.args[1]["consume"])

    def test_foreground_acquisition_uses_one_real_hid_click_and_checks_result(self):
        (self.root / ".runtime/desktop-session.json").write_text(
            json.dumps({"session_id": "pc", "execute_hid": True}))
        observed = {"session_id": "pc", "observation_id": "caption", "foreground": False}
        validated = {"session_id": "pc", "reservation": "one-use", "screen": [0, 0, 1920, 1080],
                     "center": [200, 18]}
        with patch.object(self.tool, "pc", side_effect=[observed, validated,
                          {**observed, "foreground": True}]), patch("desktop.HIDController") as hid:
            with patch("desktop.time.sleep"):
                result = self.tool.acquire_window()
        self.assertEqual(result["state"], "foreground_verified")
        hid.return_value.execute.assert_called_once()
        self.assertEqual(hid.return_value.execute.call_args.args[0]["action"], "click")

    def test_stale_session_cannot_send_input(self):
        (self.root / ".runtime/desktop-session.json").write_text(
            json.dumps({"execute_hid": True, "session_id": "old-session"})
        )
        with patch.object(
            self.tool, "pc", return_value={"valid": True, "session_id": "new-session"}
        ):
            with patch("desktop.HIDController") as hid:
                with self.assertRaises(RuntimeError):
                    self.tool.call(self.action)
        hid.assert_not_called()

    def test_step_automatically_observes_once_after_sent_input(self):
        sent = {"executed": True, "state": "input_sent"}
        with patch.object(self.tool, "call", side_effect=[sent, {"observation_id": "new"}]) as call:
            with patch("desktop.time.sleep"):
                result = self.tool.step(self.action)
        self.assertEqual(result["observation"]["observation_id"], "new")
        self.assertEqual(call.call_args_list[1].args[0], {"op": "observe"})

    def test_step_retains_sent_input_when_observation_fails_and_does_not_retry(self):
        with patch.object(
            self.tool, "call", side_effect=[{"executed": True}, RuntimeError("foreground changed")]
        ) as call:
            with patch("desktop.time.sleep"):
                result = self.tool.step(self.action)
        self.assertTrue(result["action"]["executed"])
        self.assertIn("foreground", result["observation_error"])
        self.assertEqual(call.call_count, 2)

    def test_input_guard_checks_stop_session_and_physical_zero_before_each_report(self):
        session = self.root / ".runtime/desktop-session.json"
        session.write_text(json.dumps({"execute_hid": True, "session_id": "pc"}))
        guard = self.tool.input_guard(self.action, {"session_id": "pc", "reservation": "token",
                                                   "screen": [0, 0, 1920, 1080]})
        with patch.object(self.tool, "pc", return_value={"valid": True, "session_id": "pc"}) as pc:
            guard(bytes(6))
            self.assertEqual(pc.call_args.args[1]["point"], [0, 0])
            self.assertEqual(pc.call_args.kwargs["timeout"], 1)
            session.write_text(json.dumps({"execute_hid": False, "session_id": "pc"}))
            with self.assertRaisesRegex(RuntimeError, "stopped"):
                guard(bytes(6))
            self.assertEqual(pc.call_count, 1)

    def test_malformed_drag_is_rejected_before_pc_reservation(self):
        with patch.object(self.tool, "pc") as pc:
            with self.assertRaises(ValueError):
                self.tool.call({**self.action, "action": "drag"})
        pc.assert_not_called()

    def test_mcp_exposes_new_action_schema_and_rejects_bad_drag_before_reservation(self):
        from mcp_server import MCPServer
        server = MCPServer(self.root, "desktop")
        schema = server.tools[0]["inputSchema"]["properties"]
        self.assertIn("drag", schema["action"]["enum"])
        self.assertIn("end_target_id", schema)
        with patch.object(server.desktop, "pc") as pc:
            result = server.dispatch({"method": "tools/call", "params": {"name": "desktop",
                "arguments": {**self.action, "action": "drag", "end_target_id": 2,
                              "duration_ms": -1}}})
        self.assertTrue(result["isError"])
        pc.assert_not_called()

    @unittest.skipIf(os.name == "nt", "Actual advisory lock is Linux-only")
    def test_nested_batch_lock_excludes_another_executor_until_outer_exit(self):
        other = DesktopTools(self.root)
        with self.tool.input_lock():
            with self.tool.input_lock():
                pass
            with self.assertRaises(BlockingIOError):
                with other.input_lock():
                    self.fail("Other executor acquired a batch's outer lock")
        with other.input_lock():
            pass

    @unittest.skipIf(os.name == "nt", "Actual advisory lock is Linux-only")
    def test_compound_action_cannot_interleave_with_lock_owner(self):
        import fcntl
        (self.root / ".runtime/desktop-session.json").write_text(
            json.dumps({"session_id": "pc", "execute_hid": True}))
        with (self.root / ".runtime/hid.lock").open("a") as owner:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(self.tool, "pc", return_value={"session_id": "pc"}):
                with patch("desktop.HIDController") as hid:
                    with self.assertRaises(BlockingIOError):
                        self.tool.call(self.action)
            hid.assert_not_called()


if __name__ == "__main__":
    unittest.main()
