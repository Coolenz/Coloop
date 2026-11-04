"""Statistics and native-receipt guards; never launch a model or OpenCode."""

import importlib.util
import argparse
import base64
import json
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
import unittest

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("hook_benchmark", TOOLS / "bench_coloop_hooks.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class BenchmarkTests(unittest.TestCase):
    def test_source_idle_does_not_finish_before_its_consumption_receipt(self):
        receipt = {
            "kind": "status",
            "state": "approval.completed",
            "status": 200,
            "sessionId": "current",
        }
        self.assertFalse(bench.source_completion_ready(True, {}, [], "current"))
        self.assertFalse(bench.source_completion_ready(True, {}, [receipt], "other"))
        self.assertFalse(bench.source_completion_ready(False, {}, [receipt], "current"))
        self.assertFalse(
            bench.source_completion_ready(True, {"type": "busy"}, [receipt], "current")
        )
        self.assertTrue(bench.source_completion_ready(True, {}, [receipt], "current"))

    def test_nearest_rank_does_not_hide_tail(self):
        self.assertEqual(bench.percentile(list(range(1, 21)), 0.95), 19)
        self.assertEqual(bench.distribution([1, 3, 5000])["p95_ms"], 5000)
        self.assertIsNone(bench.percentile([], 0.95))

    def test_missing_failed_or_nonfinite_sample_cannot_pass(self):
        passing = [{"success": True, "latency": 2}] * 20
        self.assertTrue(bench.timing_pass(passing, "latency", 20, 10))
        self.assertFalse(bench.timing_pass(passing[:19], "latency", 20, 10))
        self.assertFalse(
            bench.timing_pass([*passing[:19], {"success": False, "latency": 2}], "latency", 20, 10)
        )
        for value in (None, float("inf"), float("nan"), -1, True):
            self.assertFalse(
                bench.timing_pass([{"success": True, "latency": value}], "latency", 1, 10)
            )
        self.assertFalse(bench.timing_pass([], "latency", 0, 10))

    def test_only_source_completed_receipt_with_valid_monotonic_metric_counts(self):
        self.assertTrue(
            bench.is_success_receipt(
                {"kind": "status", "state": "approval.completed", "status": 200}
            )
        )
        self.assertFalse(
            bench.is_success_receipt({"kind": "approval", "state": "approval.completed"})
        )
        self.assertFalse(bench.is_success_receipt({"kind": "status", "state": "approval.failed"}))
        self.assertFalse(
            bench.is_success_receipt(
                {"kind": "status", "state": "approval.completed", "status": 502}
            )
        )
        self.assertEqual(
            bench.receipt_duration({"plugin_metrics": {"hookToConsumedMs": 21.5}}), 21.5
        )
        for value in (None, -1, float("nan"), True):
            self.assertIsNone(
                bench.receipt_duration({"plugin_metrics": {"hookToConsumedMs": value}})
            )

    def test_metadata_recorder_never_exports_text_paths_token_or_answers(self):
        event = {
            "version": 1,
            "sourceId": "fixture",
            "kind": "approval",
            "workspace": "PRIVATE_PATH",
            "payload": {
                "text": "PRIVATE_TEXT",
                "token": "PRIVATE_TOKEN",
                "approval": {
                    "id": "question-1",
                    "originalDigest": "a" * 64,
                    "question": "PRIVATE_QUESTION",
                    "choices": [{"label": "PRIVATE_CHOICE"}],
                },
                "metrics": {"hookToConsumedMs": 10, "unexpectedText": "PRIVATE_EXTRA"},
            },
        }
        result = bench.canonical_json(bench.metadata_event(event))
        self.assertNotIn("PRIVATE_", result)
        self.assertIn('"hookToConsumedMs":10', result)

    def test_status_metadata_preserves_consumption_digest_without_approval(self):
        digest = "b" * 64
        for approval in (None, {}):
            payload = {
                "state": "approval.completed",
                "originalDigest": digest,
                "relatedEventId": "approval-1",
                "metrics": {"hookToConsumedMs": 3045},
            }
            if approval is not None:
                payload["approval"] = approval
            recorded = bench.metadata_event({"kind": "status", "payload": payload})
            self.assertEqual(recorded["originalDigest"], digest)
            self.assertEqual(recorded["relatedEventId"], "approval-1")
            self.assertNotIn("approvalId", recorded)
            self.assertEqual(recorded["plugin_metrics"]["hookToConsumedMs"], 3045)
        recorded = bench.metadata_event(
            {
                "kind": "approval",
                "payload": {
                    "approval": {
                        "id": "question-1",
                        "originalDigest": digest,
                    }
                },
            }
        )
        self.assertEqual(recorded["approvalId"], "question-1")
        self.assertEqual(recorded["originalDigest"], digest)

    def test_consumption_receipt_requires_one_matching_event_and_digest(self):
        approval = {"eventId": "event-1", "originalDigest": "a" * 64}
        receipt = {"relatedEventId": "event-1", "originalDigest": "a" * 64}
        self.assertTrue(bench.receipt_binding_verified([approval], [receipt]))
        for approvals, receipts in (
            ([], [receipt]),
            ([approval], []),
            ([approval, approval], [receipt]),
            ([approval], [receipt, receipt]),
            ([approval], [{**receipt, "relatedEventId": "event-2"}]),
            ([approval], [{**receipt, "originalDigest": "b" * 64}]),
            ([{}], [{}]),
            ([{"eventId": "event-1"}], [{"relatedEventId": "event-1"}]),
        ):
            self.assertFalse(bench.receipt_binding_verified(approvals, receipts))

    def test_bootstrap_is_compilable_uses_0600_and_real_plugin_only(self):
        script = bench.bootstrap_script(
            "/home/cat/rk-opencode",
            8088,
            19477,
            "x" * 64,
            "D:\\RK",
            "source-1",
            "export default async () => ({})",
        )
        compile(script, "<test-bootstrap>", "exec")
        self.assertIn("0o600", script)
        self.assertIn("COLOOP_HOOK_CONNECTION", script)
        self.assertIn("coloop-hook.mjs", script)
        self.assertIn("start_new_session=True", script)
        self.assertNotIn("OpenCodeAdapter", script)

    def test_http_success_without_matching_receipt_cannot_count_ingest(self):
        event = bench.envelope("source", "instance", 1, text="synthetic")
        valid = {
            "version": 1,
            **{k: event[k] for k in ("sourceId", "instanceId", "eventId", "sequence")},
            "contextBytes": 20,
            "contextEvents": 1,
        }
        self.assertTrue(bench.valid_receipt(valid, event))
        self.assertFalse(bench.valid_receipt({"error": "not received"}, event))
        self.assertFalse(bench.valid_receipt({**valid, "eventId": "wrong"}, event))
        self.assertFalse(bench.valid_receipt({**valid, "contextBytes": 8193}, event))

    def test_real_question_positions_alternate_without_mutating_fixture(self):
        original = bench.canonical_json(bench.QUESTION_ARGUMENTS)
        for index in range(21):
            arguments = bench.question_arguments(index)
            options = arguments["questions"][0]["options"]
            self.assertEqual(options[index % 2]["label"], bench.OFFLINE)
            self.assertEqual(bench.canonical_json(bench.QUESTION_ARGUMENTS), original)

    def test_private_dependency_copy_is_pinned_and_does_not_copy_user_config(self):
        script = bench.bootstrap_script(
            "/home/cat/rk-opencode",
            8088,
            19000,
            "x" * 64,
            "D:\\RK",
            "source",
            "export default async () => ({})",
        )
        self.assertIn("PURE_JS_PLUGIN_SDK_REQUIRED", script)
        self.assertIn("PINNED_PLUGIN_SDK_LOCK_MISMATCH", script)
        self.assertIn("for name in ('package.json','package-lock.json')", script)
        self.assertNotIn("shutil.copytree(sdk_source", script)
        self.assertIn("process.poll()", script)

    def test_whole_experiment_budget_is_distinct_and_bounded(self):
        parser = bench.argument_parser()
        args = parser.parse_args(["--connection", "unused.json", "--output-dir", "unused-dir"])
        self.assertEqual(args.timeout, 1200)
        self.assertEqual(bench.experiment_timeout("30"), 30)
        self.assertEqual(bench.experiment_timeout("1800"), 1800)
        for value in ("29", "1801", "abc", "12.5"):
            with self.assertRaises(argparse.ArgumentTypeError):
                bench.experiment_timeout(value)
        help_text = parser.format_help()
        self.assertIn("WHOLE experiment", help_text)
        self.assertIn("per-review/model timeouts remain unchanged", help_text)

    def test_source_stage_fixture_is_private_optional_and_reported(self):
        plain = bench.source_config("/private/coloop-hook.mjs")
        staged = bench.source_config("/private/coloop-hook.mjs", "/private/test-stage.mjs")
        self.assertEqual(plain["plugin"], ["file:///private/coloop-hook.mjs"])
        self.assertEqual(
            staged["plugin"], ["file:///private/coloop-hook.mjs", "file:///private/test-stage.mjs"]
        )
        self.assertEqual(
            staged["agent"]["coloop-question-smoke"]["prompt"], bench.SOURCE_STAGE_INITIAL_PROMPT
        )
        self.assertNotIn(bench.OFFLINE, bench.SOURCE_STAGE_FIXTURE)
        manifest = bench.source_fixture_manifest()
        self.assertTrue(manifest["test_only"])
        self.assertFalse(manifest["expected_answer_injected"])
        script = bench.bootstrap_script(
            "/home/cat/rk-opencode",
            8088,
            19000,
            "x" * 64,
            "D:\\RK",
            "source",
            "export default async () => ({})",
            stage_fixture=True,
        )
        compile(script, "<test-stage-bootstrap>", "exec")
        self.assertIn(manifest["code_sha256"], script)
        self.assertIn("TEST_FIXTURE_HASH_MISMATCH", script)
        self.assertIn("coloop-benchmark-source-stage.mjs", script)

    @unittest.skipUnless(shutil.which("node"), "Node required for real fixture hook callbacks")
    def test_source_stage_fixture_switches_only_after_its_real_question_result(self):
        uri = (
            "data:text/javascript;base64,"
            + base64.b64encode(bench.SOURCE_STAGE_FIXTURE.encode()).decode()
        )
        script = (
            r"""
import assert from 'node:assert/strict';
const {default: fixture} = await import(URI);
const hooks = await fixture();
const initial = INITIAL, final = FINAL;
async function system(id) {
 const output={system:['original default','original agent']};
 await hooks['experimental.chat.system.transform']({sessionID:id},output);
 return output.system;
}
assert.deepEqual(await system('unknown'),['original default','original agent']);
await hooks['chat.message']({sessionID:'other',agent:'production-agent'});
assert.deepEqual(await system('other'),['original default','original agent']);
await hooks['chat.message']({sessionID:'one',agent:'coloop-question-smoke'});
await hooks['chat.message']({sessionID:'two',agent:'coloop-question-smoke'});
assert.deepEqual(await system('one'),[initial]);
const info={sessionID:'one',tool:'question',callID:'call-1'};
await hooks['tool.execute.before'](info,{args:{questions:['UNCHANGED']}});
await hooks['tool.execute.after'](info,{output:'not a completed answer',metadata:{}});
assert.deepEqual(await system('one'),[initial]);
await hooks['tool.execute.before'](info,{args:{questions:['UNCHANGED']}});
const output={output:'real synthetic tool result',metadata:{answers:[['sample selected label']]}};
const before=JSON.stringify(output);
await hooks['tool.execute.after'](info,output);
assert.equal(JSON.stringify(output),before);
assert.deepEqual(await system('one'),[final]);
assert.deepEqual(await system('two'),[initial]);
await hooks['tool.execute.before']({...info,callID:'old-call'},{});
await hooks['chat.message']({sessionID:'one',agent:'coloop-question-smoke'});
await hooks['tool.execute.after']({...info,callID:'old-call'},output);
assert.deepEqual(await system('one'),[initial]);
assert.equal(hooks['experimental.chat.messages.transform'],undefined);
assert.equal(hooks.tool,undefined);
await hooks.event({event:{type:'session.deleted',properties:{info:{id:'one'}}}});
assert.deepEqual(await system('one'),['original default','original agent']);
await hooks.dispose();
assert.deepEqual(await system('two'),['original default','original agent']);
""".replace("URI", json.dumps(uri))
            .replace("INITIAL", json.dumps(bench.SOURCE_STAGE_INITIAL_PROMPT))
            .replace("FINAL", json.dumps(bench.SOURCE_STAGE_FINAL_PROMPT))
        )
        result = subprocess.run(
            [shutil.which("node"), "--input-type=module", "-e", script],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_requested_formal_count_without_actual_samples_cannot_pass_size_gate(self):
        report = {}
        bench.summarize_result(
            report, [], [], [], SimpleNamespace(samples=20, warmup=1, hook_samples=100, pilot=False)
        )
        self.assertFalse(report["targets_passed"]["required_sample_sizes"])
        self.assertFalse(report["performancePassed"])

    def test_small_pilot_functionality_never_becomes_formal_performance_pass(self):
        report = {
            "context_isolation": {"passed": True},
            "no_long_term_memory_writes": True,
            "all_own_sessions_deleted": True,
            "private_model_logs": True,
            "remote_connection_removed": True,
            "local_audit_scan": {"passed": True},
            "synthetic_scope_cleanup": {"failed": 0},
        }
        rows = [
            {"success": True, "warmup": i == 0, "asked_to_consumed_ms": 100, "task_total_ms": 1000}
            for i in range(4)
        ]
        loads = [{"success": True, "elapsed_ms": 2} for _ in range(100)]
        rules = [{"success": True, "elapsed_ms": 2} for _ in range(10)]
        bench.summarize_result(
            report,
            rows,
            loads,
            rules,
            SimpleNamespace(samples=3, warmup=1, hook_samples=100, pilot=True),
        )
        self.assertTrue(report["functionalityPassed"])
        self.assertFalse(report["performancePassed"])
        self.assertFalse(report["passed"])
        self.assertFalse(report["targets_passed"]["required_sample_sizes"])


if __name__ == "__main__":
    unittest.main()
