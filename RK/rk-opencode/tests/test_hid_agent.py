"""Agent context/state/control boundaries. Actual model/USB success is tested separately."""

import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from hid_agent import AgentContext, DesktopAgent, check_business, literal_mismatch, task_literals  # noqa: E402


class FakeWorkflow:
    def __init__(self):
        self.requests = []
        self.fail = False
        self.raw = {"observation_id": "first", "window": "Fixture", "window_identity": "bound",
            "targets": [{"id": 1, "name": "Text", "type": "Edit", "value": "001", "enabled": True}]}

    def call(self, request, **kwargs):
        self.requests.append(copy.deepcopy(request))
        if request["op"] == "observe":
            return {"view": "full", "observation_id": "first", "targets": [[1, "Edit", "Text", "001"]]}
        return {"ok": not self.fail, "executed": True, "state": "fields_verified",
                "verified_fields": [1], "observation": {"view": "delta", "base": "first",
                    "observation_id": "second"}}

    def snapshot(self):
        return copy.deepcopy(self.raw)


class FakeModel:
    prompt_budget = 10000

    def __init__(self, messages):
        self.replies = messages
        self.requests = []

    @staticmethod
    def measure(messages):
        return len(json.dumps(messages).encode())

    def __call__(self, messages, tool):
        self.requests.append(copy.deepcopy(messages))
        return self.replies.pop(0)

    def reset_context(self):
        pass


def call(args):
    return {"role": "assistant", "content": None, "tool_calls": [{"id": "call-1",
        "function": {"name": "hid", "arguments": json.dumps(args)}, "type": "function"}]}


class AgentTests(unittest.TestCase):
    def test_whitespace_rejection_precedes_input_and_allows_one_new_decision(self):
        bad = {"op": "fill_form", "observation_id": "first", "fields": [
            {"target_id": 1, "text": "001  "}]}
        good = copy.deepcopy(bad)
        good["fields"][0]["text"] = "001 "
        workflow = FakeWorkflow()
        events = []
        model = FakeModel([call(bad), call(good), {"content": "Actual 001"}])
        DesktopAgent(".", model, events.append, workflow=workflow).run('Fill with "001 "')
        writes = [r for r in workflow.requests if r["op"] != "observe"]
        self.assertEqual(writes, [good])
        self.assertEqual(events[1]["input"], bad)
        self.assertEqual(events[1]["output"]["state"], "not_executed_literal_mismatch")
        self.assertIn("no input was sent", model.requests[1][-1]["content"])

    def test_repeated_whitespace_error_stops_without_input(self):
        args = {"op": "act", "action": "type", "text": "001  "}
        workflow = FakeWorkflow()
        with self.assertRaisesRegex(RuntimeError, "Repeated literal"):
            DesktopAgent(".", FakeModel([call(args), call(args)]), lambda e: None,
                         workflow=workflow).run('Type "001 "')
        self.assertTrue(all(r["op"] == "observe" for r in workflow.requests))

    def test_literal_guard_uses_only_user_quotes_and_does_not_infer_other_values(self):
        self.assertEqual(task_literals(r'Type " a\"b " and "-001.00"'), [' a"b ', '-001.00'])
        self.assertTrue(literal_mismatch('Type " x "', {"op": "act", "action": "type", "text": "x"}))
        self.assertFalse(literal_mismatch('Type " x " or "x"',
                                        {"op": "act", "action": "type", "text": "x"}))
        self.assertFalse(literal_mismatch('Compute "1" + "2"',
                                        {"op": "act", "action": "type", "text": "3"}))
        self.assertFalse(literal_mismatch('Type x', {"op": "act", "action": "type", "text": "x "}))
        self.assertFalse(literal_mismatch('Type "x"', {"op": "fill_form", "fields": None}))

    def test_default_path_sends_compact_state_and_actual_generated_batch(self):
        args = {"op": "fill_form", "observation_id": "first", "fields": [
            {"target_id": 1, "text": "001"}]}
        model = FakeModel([call(args), {"role": "assistant", "content": "Actual 001"}])
        workflow = FakeWorkflow()
        result = DesktopAgent(".", model, lambda event: None, workflow=workflow).run(
            "Fill Text with 001", {"fields": {"Text": "001"}})
        self.assertEqual(workflow.requests[1], args)
        self.assertTrue(result["task_verified"])
        self.assertIn('"view":"full"', model.requests[0][1]["content"])
        self.assertNotIn("window_identity", json.dumps(model.requests))
        self.assertEqual(len(model.requests), 2)

    def test_failed_input_stops_before_another_model_decision_and_never_replays(self):
        args = {"op": "fill_form", "observation_id": "first", "fields": [
            {"target_id": 1, "text": "001"}]}
        model = FakeModel([call(args), {"content": "I could try again"}])
        workflow = FakeWorkflow()
        workflow.fail = True
        with self.assertRaisesRegex(RuntimeError, "stopped without replay"):
            DesktopAgent(".", model, lambda event: None, workflow=workflow).run("Fill Text")
        self.assertEqual(len(model.requests), 1)
        self.assertEqual(len(workflow.requests), 2)

    def test_model_done_does_not_override_actual_business_failure(self):
        model = FakeModel([{"content": "Done"}, {"content": "Still unverified"}])
        result = DesktopAgent(".", model, lambda event: None, workflow=FakeWorkflow()).run(
            "Fill Text with 999", {"fields": {"Text": "999"}})
        self.assertTrue(result["model_finished"])
        self.assertFalse(result["task_verified"])

    def test_final_clarification_cannot_dispatch_another_input(self):
        args = {"op": "act", "observation_id": "first", "action": "type", "text": "999"}
        model = FakeModel([{"content": "Done"}, call(args)])
        workflow = FakeWorkflow()
        with self.assertRaisesRegex(RuntimeError, "forbidden; no replay"):
            DesktopAgent(".", model, lambda event: None, workflow=workflow).run(
                "Fill Text with 999", {"fields": {"Text": "999"}})
        self.assertTrue(all(request["op"] == "observe" for request in workflow.requests))

    def test_final_clarification_generates_a_real_new_answer_without_leaking_checker_values(self):
        model = FakeModel([{"content": "Done"}, {"content": "Actual 001"}])
        result = DesktopAgent(".", model, lambda event: None, workflow=FakeWorkflow()).run(
            "Quote the actual value", {"answer_contains": ["001"]})
        self.assertTrue(result["task_verified"])
        self.assertEqual(len(model.requests), 2)
        self.assertIn("No further keyboard/mouse input", model.requests[1][-1]["content"])

    def test_no_check_is_unverified_and_empty_checks_are_rejected(self):
        self.assertIsNone(check_business(None, {}, "done"))
        with self.assertRaises(ValueError):
            check_business({}, {}, "done")

    def test_context_rebase_keeps_literal_task_and_receipts_and_supplies_full_baseline(self):
        context = AgentContext('Type " 001.00 " and do not submit', {"observation_id": "old"})
        context.messages.append({"role": "user", "content": "STALE SCREEN " * 2000})
        context.journal = [{"op": "fill_form", "state": "fields_verified", "submitted": False}]
        rebased = context.fit(FakeModel.measure, lambda: {
            "view": "full", "observation_id": "new", "targets": [[1, "Edit", "Text", " 001.00 "]]})
        self.assertTrue(rebased)
        serialized = json.dumps(context.messages)
        self.assertNotIn("STALE SCREEN", serialized)
        self.assertIn('do not submit', serialized)
        self.assertIn(' 001.00 ', serialized)
        self.assertIn('fields_verified', serialized)
        self.assertIn('"view": "full"', context.messages[1]["content"].replace(':', ': '))
        self.assertEqual([m["role"] for m in context.messages], ["system", "user"])

    def test_context_refuses_silent_truncation_when_task_and_current_state_do_not_fit(self):
        context = AgentContext("keep original task", {"view": "full"}, max_prompt_bytes=20)
        original = copy.deepcopy(context.messages)
        with self.assertRaisesRegex(ValueError, "context budget"):
            context.fit(FakeModel.measure, lambda: {"view": "full"})
        self.assertEqual(context.messages, original)


if __name__ == "__main__":
    unittest.main()
