import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from compact import BenchmarkTask, compact_observation, run_task


def observation(id_, names, closed=False):
    return {
        "observation_id": id_,
        "window_open": not closed,
        "closed_by_fixture": closed,
        "focused_control": "Edit",
        "targets": [
            {"id": i, "name": name, "type": "TextRegion", "source": "ocr"}
            for i, name in enumerate(names)
        ],
    }


class CompactTests(unittest.TestCase):
    def setup_loop(self):
        initial = observation("a", ["Code: 01234567", "Apply"])
        typed = observation("b", ["Code: 01234567", "01234567", "Apply"])
        applied = observation("c", ["Applied: 01234567", "Apply"])
        closed = observation("d", [], closed=True)
        desktop = Mock()
        desktop.call.return_value = initial
        desktop.step.side_effect = [
            {"action": {"executed": True, "action_id": str(i)}, "observation": o}
            for i, o in enumerate((typed, applied, closed))
        ]
        args = [
            {"observation_id": "a", "action": "type", "text": "01234567"},
            {"observation_id": "b", "action": "click", "target_id": 2},
            {"observation_id": "c", "action": "hotkey", "keys": "ALT+F4"},
        ]
        model = Mock(
            side_effect=[
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call-" + str(i),
                            "type": "function",
                            "function": {"name": "desktop_step", "arguments": json.dumps(a)},
                        }
                    ],
                }
                for i, a in enumerate(args)
            ]
        )
        return initial, desktop, model

    def test_three_decisions_use_fresh_observations_and_stop_without_final_model_call(self):
        _, desktop, model = self.setup_loop()
        events = []
        result = run_task(desktop, model, lambda e: events.append(copy.deepcopy(e)))
        self.assertTrue(result["passed"])
        self.assertEqual(model.call_count, 3)
        self.assertEqual(desktop.call.call_count, 1)
        self.assertEqual(
            [c.args[0]["observation_id"] for c in desktop.step.call_args_list], ["a", "b", "c"]
        )
        self.assertEqual(events[-1]["type"], "complete")
        # Raw trace verifies the same causal business sequence as the older OpenCode events.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from bench_report import verify_trace

        self.assertTrue(verify_trace(events, "01234567")["passed"])
        self.assertFalse(verify_trace(events, "12345678")["passed"])

    def test_observation_failure_after_input_never_replays_input(self):
        _, desktop, model = self.setup_loop()
        desktop.step.side_effect = [
            {"action": {"executed": True}, "observation_error": "PC connection lost"}
        ]
        with self.assertRaisesRegex(RuntimeError, "do not retry"):
            run_task(desktop, model, lambda _: None)
        self.assertEqual(model.call_count, 1)
        self.assertEqual(desktop.step.call_count, 1)

    def test_missing_effect_polls_only_observations_and_never_repeats_type(self):
        initial, desktop, model = self.setup_loop()
        desktop.step.side_effect = [{"action": {"executed": True}, "observation": initial}]
        with patch("compact.time.sleep"):
            with self.assertRaisesRegex(ValueError, "effect"):
                run_task(desktop, model, lambda _: None)
        self.assertEqual(model.call_count, 1)
        self.assertEqual(desktop.step.call_count, 1)
        self.assertEqual(desktop.call.call_count, 3)

    def test_wrong_target_or_premature_close_is_rejected_before_hid(self):
        initial, _, _ = self.setup_loop()
        task = BenchmarkTask(initial)
        with self.assertRaisesRegex(ValueError, "typing"):
            task.validate_action(
                {"observation_id": "a", "action": "type", "keys": "01234567"}, initial
            )
        with self.assertRaisesRegex(ValueError, "typing"):
            task.validate_action(
                {"observation_id": "a", "action": "hotkey", "keys": "ALT+F4"}, initial
            )
        task.phase = 1
        with self.assertRaisesRegex(ValueError, "Apply"):
            task.validate_action(
                {"observation_id": "a", "action": "click", "target_id": 0}, initial
            )
        with self.assertRaisesRegex(ValueError, "outdated"):
            task.validate_action(
                {"observation_id": "old", "action": "click", "target_id": 1}, initial
            )

    def test_model_observation_omits_costly_coordinates_but_keeps_ids_and_sources(self):
        initial, _, _ = self.setup_loop()
        initial.update(rect=[1, 2, 3, 4], image_sha256="hash", session_id="session")
        public = compact_observation(initial)
        self.assertNotIn("rect", public)
        self.assertEqual(public["targets"][0]["source"], "ocr")
        self.assertEqual(public["observation_id"], "a")


if __name__ == "__main__":
    unittest.main()
