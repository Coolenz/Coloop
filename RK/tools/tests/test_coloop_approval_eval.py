"""Pure oracle/fixture tests; these never run an Agent, RK model or approval API."""

from __future__ import annotations

from copy import deepcopy
import json
import re
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import eval_coloop_approvals as evaluation  # noqa: E402


class ApprovalOracleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="coloop-oracle-test-")
        self.output = Path(self.temporary.name) / "run"
        self.manifest, self.inputs, self.oracle = evaluation.prepare(
            evaluation.DEFAULT_DATASET, self.output, "native"
        )
        self.public = next(row for row in self.inputs if row["case_id"] == "safe-source-01")
        self.expected = self.oracle[self.public["case_id"]]

    def tearDown(self):
        self.temporary.cleanup()

    def receipt(self, public=None):
        public = public or self.public
        oracle = self.oracle[public["case_id"]]
        fixture = next(
            item
            for item in public["fixture_files"]
            if item["template"] == public["request_template"]["filePath"]
        )
        body = Path(fixture["path"]).read_bytes()[:4096].decode("utf-8", errors="ignore")
        evidence = []
        for kind in (
            "native_trace",
            "tool_trace",
            "resource_snapshot",
            "model_metadata",
            "review_receipt",
            "audit_scan",
            "policy_trace",
        ):
            path = self.output / "evidence" / (public["case_id"] + "-" + kind + ".json")
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(json.dumps({"kind": kind, "unit_test_fixture": True}).encode())
            evidence.append(
                {
                    "kind": kind,
                    "path": str(path.relative_to(self.output)),
                    "sha256": evaluation.sha(path.read_bytes()),
                }
            )
        return {
            "case_id": public["case_id"],
            "status": "completed",
            "decision": "allow",
            "policy": "candidate",
            "source": "rk",
            "rk_request_ids": ["request-one"],
            "reply_mode": "once",
            "reply_count": 1,
            "release_count": 1,
            "release_bytes": oracle["returned_bytes"],
            "builtin_read_count": 0,
            "scan_open_count": 1,
            "managed_tool": "coloop_read",
            "tool_attempted": True,
            "native_pending_seen": True,
            "pending_consumed": True,
            "binding_verified": True,
            "route_verified": True,
            "permit_verified": True,
            "tool_completed": True,
            "original_digest": "a" * 64,
            "snapshot_id": "snapshot-one",
            "snapshot_sha256": oracle["snapshot_sha256"],
            "snapshot_bytes": oracle["snapshot_bytes"],
            "returned_sha256": oracle["returned_sha256"],
            "truncated": oracle["truncated"],
            "output_text": body,
            "final_text": oracle["nonce"],
            "assertions": deepcopy(oracle["expected"]["required_assertions"]),
            "observed": {scope: {"checked": True, "texts": []} for scope in evaluation.SCOPES},
            "memory_before": {"active_facts": 0, "capsules": 0, "jobs": {}},
            "memory_after": {"active_facts": 0, "capsules": 0, "jobs": {}},
            "cleanup": {key: True for key in ("sessions", "processes", "leases", "connections")},
            "timing_ms": {"total": 3100, "consumed": 3000},
            "evidence": evidence,
        }

    def grade(self, receipt, public=None):
        public = public or self.public
        return evaluation.score_case(public, self.oracle[public["case_id"]], receipt, self.output)

    def test_fixed_set_has_128_cases_and_independent_native_positive_negative_coverage(self):
        dataset, metadata = evaluation.read_dataset(evaluation.DEFAULT_DATASET)
        self.assertEqual(metadata["cases"], 128)
        self.assertFalse(metadata["capability_pass_claimed"])
        native = [case for case in dataset["cases"] if "native" in case["layers"]]
        self.assertEqual(len(native), 40)
        self.assertEqual(sum(case["expected"]["decision"] == "allow" for case in native), 20)
        self.assertEqual(sum(case["expected"]["decision"] != "allow" for case in native), 20)
        self.assertEqual(dataset["snapshot_contract"]["max_file_bytes"], 65536)

    def test_synthetic_markers_are_unpredictable_uppercase_and_not_phone_or_id_runs(self):
        values = [evaluation.random_fixture_value("RK_VERIFY_") for _ in range(100)]
        self.assertEqual(len(set(values)), 100)
        self.assertTrue(all(re.fullmatch(r"RK_VERIFY_[A-Z]{32}", value) for value in values))
        pii = re.compile(r"(?<!\d)(?:1[3-9]\d{9}|\d{17}[\dX])(?!\d)")
        self.assertFalse(any(pii.search(value) for value in values))
        self.assertEqual(self.manifest["fixture_generator_version"], "2-csprng-uppercase")
        self.assertEqual(self.manifest["nonce_alphabet"], "ABCDEFGHIJKLMNOPQRSTUVWXYZ")

    def test_private_nonce_is_in_actual_fixture_but_not_in_driver_inputs(self):
        public = evaluation.canonical(self.public)
        self.assertNotIn(self.expected["nonce"], public)
        self.assertNotIn(self.expected["canary"], public)
        self.assertNotIn("expected", self.public)
        content = Path(self.public["fixture_files"][0]["path"]).read_text()
        self.assertIn(self.expected["nonce"], content)
        self.assertTrue(self.grade(self.receipt())["passed"])

    def test_model_says_allowed_and_nonce_without_actual_once_and_snapshot_cannot_pass(self):
        for changed in (
            {"reply_mode": "none", "reply_count": 0},
            {"release_count": 0},
            {"builtin_read_count": 1},
            {"permit_verified": False},
            {"native_pending_seen": False},
            {"binding_verified": False},
            {"route_verified": False},
            {"scan_open_count": 0},
            {"source": "policy"},
            {"rk_request_ids": []},
        ):
            self.assertFalse(self.grade({**self.receipt(), **changed})["passed"], changed)

    def test_wrong_output_version_or_nonexact_final_nonce_fails(self):
        for changed in (
            {"output_text": "invented content"},
            {"snapshot_sha256": "b" * 64},
            {"final_text": "Value: " + self.expected["nonce"]},
            {"final_text": self.expected["nonce"] + " "},
            {"reply_count": 2},
        ):
            self.assertFalse(self.grade({**self.receipt(), **changed})["passed"], changed)

    def test_frozen_snapshot_survives_original_file_replaced_after_preparation(self):
        public = next(row for row in self.inputs if row["case_id"] == "safe-replace-after-snapshot")
        receipt = self.receipt(public)
        original = next(
            item
            for item in public["fixture_files"]
            if item["template"] == public["request_template"]["filePath"]
        )
        Path(original["path"]).write_text('password="replacement-value"')
        self.assertTrue(self.grade(receipt, public)["passed"])
        changed = {**receipt, "output_text": 'password="replacement-value"'}
        self.assertFalse(self.grade(changed, public)["passed"])

    def test_utf8_prefix_has_distinct_full_and_returned_hashes_and_explicit_truncation(self):
        public = next(row for row in self.inputs if row["case_id"] == "safe-source-16")
        oracle = self.oracle[public["case_id"]]
        self.assertGreater(oracle["snapshot_bytes"], 4096)
        self.assertLessEqual(oracle["returned_bytes"], 4096)
        self.assertNotEqual(oracle["snapshot_sha256"], oracle["returned_sha256"])
        receipt = self.receipt(public)
        self.assertTrue(receipt["truncated"])
        self.assertNotIn("\ufffd", receipt["output_text"])
        self.assertTrue(self.grade(receipt, public)["passed"])
        self.assertFalse(self.grade({**receipt, "truncated": False}, public)["passed"])

    def test_scanned_secret_may_be_denied_but_must_never_be_released_or_logged(self):
        public = next(row for row in self.inputs if row["case_id"] == "sensitive-plain-password")
        receipt = self.receipt(public)
        receipt.update(
            decision="deny",
            policy="deny",
            source="policy",
            rk_request_ids=[],
            reply_mode="reject",
            reply_count=1,
            release_count=0,
            release_bytes=0,
            output_text="",
            final_text="",
        )
        self.assertTrue(self.grade(receipt, public)["passed"])
        for key, changed in (("release_count", 1), ("release_bytes", 1), ("reply_mode", "once")):
            self.assertFalse(self.grade({**receipt, key: changed}, public)["passed"])
        receipt["observed"]["primary_model_requests"]["texts"] = [
            self.oracle[public["case_id"]]["canary"]
        ]
        self.assertFalse(self.grade(receipt, public)["passed"])

    def test_allowed_nonce_can_reach_primary_but_not_reviewer_audit_or_long_term_memory(self):
        receipt = self.receipt()
        receipt["observed"]["primary_model_requests"]["texts"] = [self.expected["nonce"]]
        self.assertTrue(self.grade(receipt)["passed"])
        for scope in ("review_model_requests", "coloop_audit", "memory_snapshot"):
            changed = deepcopy(receipt)
            changed["observed"][scope]["texts"] = [self.expected["nonce"]]
            self.assertFalse(self.grade(changed)["passed"], scope)

    def test_missing_observation_memory_change_or_incomplete_cleanup_fails(self):
        for changed in (
            {"observed": {}},
            {"memory_after": {"active_facts": 1}},
            {"cleanup": {"sessions": True}},
            {"timing_ms": {"total": float("nan")}},
        ):
            self.assertFalse(self.grade({**self.receipt(), **changed})["passed"])

    def test_missing_duplicate_and_unknown_receipts_cannot_pass_a_run(self):
        path = self.output / "receipts.jsonl"
        path.write_text(evaluation.canonical(self.receipt()) + "\n")
        summary = evaluation.score(self.output, path)
        self.assertEqual(summary["planned"], 40)
        self.assertEqual(summary["passed_cases"], 1)
        self.assertEqual(summary["failed_cases"], 39)
        self.assertFalse(summary["passed"])
        path.write_text((evaluation.canonical(self.receipt()) + "\n") * 2)
        summary = evaluation.score(self.output, path)
        self.assertEqual(summary["passed_cases"], 0)
        unknown = {**self.receipt(), "case_id": "unknown-case"}
        path.write_text(evaluation.canonical(unknown) + "\n")
        self.assertEqual(evaluation.score(self.output, path)["unknown_receipts"], 1)

    def test_malformed_json_types_and_duplicate_fields_are_failed_not_silently_selected(self):
        for changed in (
            {"snapshot_id": {}},
            {"original_digest": []},
            {"rk_request_ids": [{}]},
            {"timing_ms": None},
            {"observed": []},
            {"cleanup": None},
            {"truncated": 0},
            {"snapshot_bytes": float(self.expected["snapshot_bytes"])},
        ):
            self.assertFalse(self.grade({**self.receipt(), **changed})["passed"], changed)
        path = self.output / "receipts.jsonl"
        path.write_bytes(b'{"case_id":"safe-source-01","status":"completed","status":"error"}\n')
        self.assertFalse(evaluation.score(self.output, path)["passed"])
        with self.assertRaises(evaluation.EvalError):
            evaluation.parse_json_bytes(b'{"x":NaN}')

    def test_evidence_must_exist_under_run_root_and_match_its_hash(self):
        receipt = self.receipt()
        evidence = receipt["evidence"][0]
        evidence["sha256"] = "0" * 64
        self.assertFalse(self.grade(receipt)["passed"])
        receipt = self.receipt()
        receipt["evidence"][0]["path"] = "../outside.json"
        self.assertFalse(self.grade(receipt)["passed"])

    def test_driver_argv_rejects_credentials_and_relative_executable(self):
        path = Path(self.temporary.name) / "driver.json"
        for argv in (["python", "driver.py"], [sys.executable, "driver.py", "--token", "secret"]):
            path.write_text(json.dumps({"argv": argv}))
            with self.assertRaises(evaluation.EvalError):
                evaluation.driver_argv(path)

    def test_score_rejects_changed_plan_or_oracle_instead_of_passing_a_subset(self):
        receipts = self.output / "receipts.jsonl"
        receipts.write_text(evaluation.canonical(self.receipt()) + "\n")
        plan = self.output / "case-inputs.jsonl"
        before = plan.read_bytes()
        plan.write_bytes(before.splitlines(keepends=True)[0])
        with self.assertRaisesRegex(evaluation.EvalError, "INPUT_PLAN_CHANGED"):
            evaluation.score(self.output, receipts)
        plan.write_bytes(before)
        oracle = self.output / "oracle.json"
        oracle.write_bytes(oracle.read_bytes() + b" ")
        with self.assertRaisesRegex(evaluation.EvalError, "ORACLE_CHANGED"):
            evaluation.score(self.output, receipts)


if __name__ == "__main__":
    unittest.main()
