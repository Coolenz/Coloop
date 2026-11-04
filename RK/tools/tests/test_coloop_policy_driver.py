"""Local integration checks for the policy-only driver; no board or NPU."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import drive_coloop_approval_policy as driver  # noqa: E402
from drive_coloop_policy_linux import remap_input  # noqa: E402
import eval_coloop_approvals as evaluation  # noqa: E402


class PolicyDriverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = driver.bundle()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="coloop-policy-driver-test-")
        self.output = Path(self.temp.name) / "run"
        _, self.inputs, self.oracle = evaluation.prepare(
            evaluation.DEFAULT_DATASET, self.output, "policy"
        )

    def tearDown(self):
        self.temp.cleanup()

    def execute(self, case_id):
        public = next(row for row in self.inputs if row["case_id"] == case_id)
        result = subprocess.run(
            [str(driver.NODE), str(self.bundle)],
            input=evaluation.canonical(public).encode(),
            capture_output=True,
            cwd=driver.APP,
            timeout=25,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        receipt = json.loads(result.stdout)
        trace = json.loads((self.output / receipt["evidence"][0]["path"]).read_bytes())
        return public, receipt, trace

    def test_candidate_is_not_converted_to_allow_permit_or_file_release(self):
        public, receipt, trace = self.execute("safe-source-01")
        self.assertEqual(receipt["policy"], "candidate")
        self.assertNotEqual(receipt["decision"], "allow")
        self.assertFalse(receipt["npu_called"])
        self.assertFalse(trace["permit_issued"])
        self.assertEqual(trace["model_callback_attempts"], 0)
        self.assertEqual(receipt["release_count"], 0)
        self.assertNotIn(
            self.oracle[public["case_id"]]["nonce"], result_text := evaluation.canonical(receipt)
        )
        self.assertNotIn('"proofKey"', result_text)
        self.assertTrue(
            evaluation.score_case(public, self.oracle[public["case_id"]], receipt, self.output)[
                "passed"
            ]
        )

    def test_secret_is_blocked_by_actual_snapshot_filter_before_authority(self):
        public, receipt, trace = self.execute("sensitive-json-password")
        self.assertEqual(receipt["policy"], "deny")
        self.assertEqual(receipt["scan_open_count"], 1)
        self.assertEqual(trace["source_verifier_calls"], 0)
        self.assertEqual(receipt["release_bytes"], 0)
        self.assertNotIn(self.oracle[public["case_id"]]["canary"], evaluation.canonical(trace))

    def test_cross_task_exercises_authority_binding_without_model_or_permit(self):
        _, receipt, trace = self.execute("context-task-cross")
        self.assertIn(receipt["policy"], ("deny", "defer", "reject"))
        self.assertTrue(receipt["assertions"]["stale_or_untrusted_context_not_authority"])
        self.assertEqual(trace["model_callback_attempts"], 0)
        self.assertTrue(receipt["source_verification_simulated_for_policy_only"])

    def test_completed_event_retires_context_without_claiming_native_consumption(self):
        public, receipt, trace = self.execute("context-replay-consumed")
        self.assertEqual(receipt["status"], "completed")
        self.assertIn(receipt["policy"], ("deny", "defer", "reject"))
        self.assertTrue(receipt["assertions"]["stale_or_untrusted_context_not_authority"])
        transition = next(
            row
            for row in trace["steps"]
            if row["method"] == "AgentHookService_approval_completed_then_generic_replay"
        )
        self.assertTrue(transition["completion_simulated_for_policy_only"])
        self.assertFalse(transition["native_consumption_exercised"])
        self.assertTrue(transition["retired_approval_replay_blocked"])
        self.assertEqual(receipt["release_count"], 0)
        self.assertTrue(
            evaluation.score_case(public, self.oracle[public["case_id"]], receipt, self.output)[
                "passed"
            ]
        )

    def test_linux_mapping_preserves_sealed_input_and_adversarial_path_literals(self):
        public = next(row for row in self.inputs if row["case_id"] == "safe-source-01")
        original = evaluation.canonical(public)
        remote, mapping = remap_input(public, "/private/policy-test")
        self.assertEqual(evaluation.canonical(public), original)
        self.assertEqual(remote["request_template"], public["request_template"])
        self.assertEqual(
            remote["aliases"]["WORKSPACE"], "/private/policy-test/fixtures/safe-source-01/workspace"
        )
        self.assertEqual(remote["fixture_files"][0]["sha256"], public["fixture_files"][0]["sha256"])
        self.assertNotIn("\\", remote["fixture_files"][0]["path"])
        self.assertEqual(mapping["WORKSPACE"]["local"], public["aliases"]["WORKSPACE"])
        for literal in (r"\\host\share\private.py", r"\\?\C:\secret.py", "C:/private.py:stream"):
            changed = dict(public, request={"filePath": literal})
            transformed, _ = remap_input(changed, "/private/policy-test")
            self.assertEqual(transformed["request"]["filePath"], literal)


if __name__ == "__main__":
    unittest.main()
