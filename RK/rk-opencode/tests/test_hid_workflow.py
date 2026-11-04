"""Meaningful composite boundaries; hardware delivery is verified separately in a fixture."""

from contextlib import nullcontext
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from hid_workflow import HIDWorkflow  # noqa: E402


class FakeDesktop:
    def __init__(self):
        self.actions = []
        self.observations = 0
        self.corrupt = False
        self.observed = {"window": "Fixture", "window_identity": "window-1", "session_id": "pc",
            "rect": [0, 0, 500, 500], "screen": [0, 0, 1920, 1080], "dpi": 96,
            "targets": [self.target(1, "Text"), self.target(2, "Number"),
                        {"id": 3, "name": "Apply", "type": "Button", "identity": "button",
                         "rect": [10, 200, 100, 240], "source": "uia", "enabled": True}]}

    @staticmethod
    def target(index, name):
        return {"id": index, "name": name, "type": "Edit", "identity": "edit-" + str(index),
                "rect": [10, index * 50, 100, index * 50 + 20], "source": "uia",
                "enabled": True, "value": "old", "focused": index == 1}

    def input_lock(self):
        return nullcontext()

    def pc(self, path, body):
        assert path == "/validate" and body["consume"] is False
        return {"valid": True, "session_id": "pc"}

    def call(self, request):
        assert request == {"op": "observe"}
        self.observations += 1
        self.observed["observation_id"] = str(self.observations)
        return copy.deepcopy(self.observed)

    def step(self, action):
        self.actions.append(action)
        if action["action"] == "click":
            for t in self.observed["targets"]:
                t["focused"] = t["id"] == action["target_id"]
        if action["action"] == "type":
            for t in self.observed["targets"]:
                if t.get("focused"):
                    t["value"] = "wrong" if self.corrupt else action["text"]
        if action["action"] == "hotkey" and action["keys"] == "BACKSPACE":
            next(t for t in self.observed["targets"] if t.get("focused"))["value"] = ""
        return {"action": {"executed": True}, "observation": self.call({"op": "observe"})}


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / ".runtime").mkdir()
        (self.root / ".runtime/desktop-session.json").write_text(
            json.dumps({"session_id": "pc", "execute_hid": True}))
        self.desktop = FakeDesktop()
        self.tool = HIDWorkflow(self.root, self.desktop)
        self.initial = self.tool.call({"op": "observe"}, reset=True)
        self.request = {"op": "fill_form", "observation_id": self.initial["observation_id"],
                        "fields": [{"target_id": 1, "text": "  literal  "},
                                   {"target_id": 2, "text": "-00123.4500"}], "submit_target_id": 3}

    def test_batch_verifies_literal_values_before_exactly_one_submit(self):
        result = self.tool.call(self.request)
        self.assertTrue(result["ok"])
        self.assertEqual(result["verified_fields"], [1, 2])
        self.assertTrue(result["submitted"])
        self.assertEqual(self.desktop.observed["targets"][1]["value"], "-00123.4500")
        self.assertEqual([a.get("target_id") for a in self.desktop.actions if a["action"] == "click"], [1, 2, 3])
        self.assertEqual(result["observation"]["view"], "delta")

    def test_invalid_later_field_rejects_whole_batch_before_any_input(self):
        for bad in ("中文", "line\nbreak", "tab\t", "\r", "x" * 65, 123):
            self.request["fields"][1]["text"] = bad
            with self.assertRaises(ValueError):
                self.tool.call(self.request)
        self.assertEqual(self.desktop.actions, [])

    def test_failed_readback_never_replays_or_submits_and_latch_survives_process(self):
        self.desktop.corrupt = True
        result = self.tool.call(self.request)
        self.assertFalse(result["ok"])
        self.assertEqual(result["verified_fields"], [])
        self.assertFalse(result["submitted"])
        tool = HIDWorkflow(self.root, self.desktop)
        tool.call({"op": "observe"})
        with self.assertRaisesRegex(RuntimeError, "Previous input"):
            tool.call({**self.request, "observation_id": self.desktop.observed["observation_id"]})
        self.assertEqual(len(self.desktop.actions), 3)
        tool.call({"op": "observe"}, reset=True)
        self.assertFalse(json.loads(tool.path.read_text()).get("blocked", False))

    def test_focus_loss_prevents_select_all_and_type(self):
        original = self.desktop.step
        def no_focus(action):
            result = original(action)
            result["observation"]["targets"][0]["focused"] = False
            return result
        self.desktop.step = no_focus
        result = self.tool.call(self.request)
        self.assertFalse(result["ok"])
        self.assertEqual(len(self.desktop.actions), 1)

    def test_changed_window_identity_forces_full_view_and_blocks_batch(self):
        original = self.desktop.step
        def changed(action):
            result = original(action)
            result["observation"]["window_identity"] = "another-window"
            return result
        self.desktop.step = changed
        result = self.tool.call(self.request)
        self.assertFalse(result["ok"])
        self.assertEqual(result["observation"]["view"], "full")
        self.assertEqual(len(self.desktop.actions), 1)

    def test_plan_only_never_starts_reports_or_claims_fields_verified(self):
        (self.root / ".runtime/desktop-session.json").write_text(
            json.dumps({"session_id": "pc", "execute_hid": False}))
        result = self.tool.call(self.request)
        self.assertEqual(result["state"], "planned")
        self.assertFalse(result["executed"])
        self.assertEqual(result["verified_fields"], [])
        self.assertEqual(self.desktop.actions, [])

    def test_cache_rejects_old_or_cross_session_input(self):
        self.tool.call({"op": "observe"})
        with self.assertRaisesRegex(ValueError, "Observe again"):
            self.tool.call(self.request)
        self.assertEqual(self.desktop.actions, [])

    def test_empty_field_is_cleared_and_verified(self):
        self.request["fields"][0]["text"] = ""
        result = self.tool.call(self.request)
        self.assertTrue(result["ok"])
        self.assertEqual(self.desktop.observed["targets"][0]["value"], "")

    def test_later_field_side_effect_cancels_submit(self):
        original = self.desktop.step
        def dependent(action):
            value = original(action)
            if action.get("text") == "-00123.4500":
                value["observation"]["targets"][0]["value"] = "changed by application"
            return value
        self.desktop.step = dependent
        result = self.tool.call(self.request)
        self.assertFalse(result["ok"])
        self.assertFalse(result["submitted"])
        self.assertEqual(len(self.desktop.actions), 6)

    def test_interrupt_after_entry_persists_unknown_outcome_without_replay(self):
        def interrupted(action):
            self.desktop.actions.append(action)
            raise KeyboardInterrupt()
        self.desktop.step = interrupted
        with self.assertRaises(KeyboardInterrupt):
            self.tool.call(self.request)
        tool = HIDWorkflow(self.root, self.desktop)
        with self.assertRaisesRegex(RuntimeError, "Previous input"):
            tool.call(self.request)
        self.assertEqual(len(self.desktop.actions), 1)


if __name__ == "__main__":
    unittest.main()
