"""No-NPU checks for the isolated internal-fetch smoke's acceptance boundary."""

import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from smoke_coloop_internal_hook import (  # noqa: E402
    OFFLINE,
    ObservationClient,
    RUNNER_SOURCE,
    functionality_passed,
    internal_bootstrap,
    result_predicates,
    write_progress,
)


class Client:
    authorization = "Bearer synthetic-test-token"

    def request(self, method, path, body=None):
        return {"ok": True}


class InternalHookSmokeTests(unittest.TestCase):
    def records(self):
        return [
            {"kind": "approval", "eventId": "approval-1", "originalDigest": "a" * 64,
             "offlineChoiceId": "1", "decision": {
                 "decision": "select", "choiceId": "1", "source": "rk"}},
            {"kind": "status", "status": 200, "state": "approval.completed",
             "relatedEventId": "approval-1", "originalDigest": "a" * 64,
             "plugin_metrics": {"hookToConsumedMs": 2100}},
            {"kind": "status", "state": "idle"},
        ]

    def observed(self):
        return {"question_tool_completed_with_offline": True, "assistant_final_exact_offline": True}

    def test_real_rk_choice_and_bound_consumption_required(self):
        records = self.records()
        self.assertTrue(functionality_passed(result_predicates(records, self.observed())))
        for key, value in (("source", "policy"), ("choiceId", "0"), ("decision", "defer")):
            changed = copy.deepcopy(records)
            changed[0]["decision"][key] = value
            self.assertFalse(functionality_passed(result_predicates(changed, self.observed())))

    def test_failed_missing_duplicate_and_changed_receipts_do_not_pass(self):
        records = self.records()
        for changed in (
            records[:1], records + [records[1]],
            [{**records[0]}, {**records[1], "originalDigest": "b" * 64}, records[2]],
            records + [{"kind": "status", "state": "approval.pending"}],
            [{**records[0]}, {**records[1], "plugin_metrics": {"hookToConsumedMs": float("nan")}}, records[2]],
        ):
            self.assertFalse(functionality_passed(result_predicates(changed, self.observed())))

    def test_final_answer_must_be_exact_and_latest_part(self):
        observer = ObservationClient(Client())

        def emit(text):
            return observer.request("POST", "/v1/hooks", {
                "kind": "message", "payload": {"role": "assistant", "partId": "p", "text": text},
            })

        emit(OFFLINE)
        self.assertTrue(observer.snapshot()["assistant_final_exact_offline"])
        emit(json.dumps({"answer": OFFLINE}))
        self.assertFalse(observer.snapshot()["assistant_final_exact_offline"])
        emit(json.dumps({"answer": OFFLINE, "extra": "unverified"}))
        self.assertFalse(observer.snapshot()["assistant_final_exact_offline"])
        emit("Maybe " + OFFLINE)
        self.assertFalse(observer.snapshot()["assistant_final_exact_offline"])
        emit(OFFLINE + " ")
        self.assertFalse(observer.snapshot()["assistant_final_exact_offline"])

    def test_progress_is_metadata_only(self):
        report = {"phase": "waiting_for_native_internal_fetch_consumption", "passed": False,
                  "token": "secret-token", "text": "synthetic-body-canary",
                  "result": {**self.observed(), "actual_approval_count": 1,
                             "text": "synthetic-body-canary", "token": "secret-token"}}
        with tempfile.TemporaryDirectory() as directory:
            write_progress(Path(directory), report, time.monotonic(), event_count=4, snapshot_count=2)
            raw = (Path(directory) / "progress.json").read_text(encoding="utf-8")
            self.assertNotIn("secret-token", raw)
            self.assertNotIn("synthetic-body-canary", raw)
            value = json.loads(raw)
            self.assertEqual(value["hook_event_count"], 4)
            self.assertEqual(value["result"]["actual_approval_count"], 1)
            self.assertFalse((Path(directory) / "progress.next").exists())

    def test_private_bootstrap_has_no_serve_spawn(self):
        script = internal_bootstrap(
            "/home/cat/rk-opencode", 8088, 10000, "SYNTHETIC_TOKEN", "source-test", "// test", 240
        )
        compile(script, "<test-bootstrap>", "exec")
        compile(RUNNER_SOURCE, "<test-guardian>", "exec")
        self.assertNotIn("'serve'", script)
        self.assertNotIn("--format", RUNNER_SOURCE)
        self.assertNotIn("--attach", RUNNER_SOURCE)
        self.assertNotIn("--auto", RUNNER_SOURCE)
        self.assertIn("'INTERNAL_SMOKE_TIMEOUT':str(240)", script)
        self.assertIn("b'\\x1b[1;1R'", RUNNER_SOURCE)
        self.assertNotIn("os.write(master,b'\\r')", RUNNER_SOURCE)


if __name__ == "__main__":
    unittest.main()
