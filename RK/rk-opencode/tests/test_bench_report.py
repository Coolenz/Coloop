import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bench_report import verify_calls


class BenchmarkVerificationTests(unittest.TestCase):
    def workflow(self, close_first=False, claim_only=False):
        events = []

        def call(args, output):
            events.append(
                {
                    "type": "tool_use",
                    "part": {
                        "tool": "rk_desktop_desktop",
                        "state": {
                            "status": "completed",
                            "input": args,
                            "output": json.dumps(output),
                        },
                    },
                }
            )

        def observe(id_, targets=None, closed=False):
            call(
                {"op": "observe"},
                {"observation_id": id_, "targets": targets or [], "window_open": not closed},
            )

        def act(id_, action, **kwargs):
            call(
                {"op": "act", "action": action, "observation_id": id_, **kwargs},
                {"executed": not claim_only},
            )

        observe("1")
        act("1", "type", text="12345678")
        observe("2", [{"id": 3, "name": "Apply"}])
        act("2", "click", target_id=3)
        observe("3", [] if close_first else [{"name": "Applied: 12345678"}])
        act("3", "hotkey", keys="ALT+F4")
        observe("4", closed=True)
        return events

    def test_requires_real_actions_apply_verification_and_close_in_order(self):
        self.assertTrue(verify_calls(self.workflow(), "12345678")["passed"])
        self.assertFalse(verify_calls(self.workflow(close_first=True), "12345678")["passed"])
        self.assertFalse(verify_calls(self.workflow(claim_only=True), "12345678")["passed"])
        self.assertFalse(verify_calls(self.workflow(), "87654321")["passed"])


if __name__ == "__main__":
    unittest.main()
