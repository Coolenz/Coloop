import json
from pathlib import Path
import sys
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
