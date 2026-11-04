"""Evidence validation tests only; these do not claim Linux syscall coverage."""

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from validate_coloop_managed_fd import CASE_IDS, validate_result, valid_remote_directory


class ManagedFdEvidenceTests(unittest.TestCase):
    def result(self):
        return {
            "passed": True,
            "passed_cases": len(CASE_IDS),
            "source_core_sha256": "a" * 64,
            "platform": "linux",
            "runtime": {"version": "1.4.4"},
            "own_fixture_fd_remaining": 0,
            "no_agent_started": True,
            "npu_calls": 0,
            "permit_issued": False,
            "results": [
                {
                    "id": name,
                    "passed": True,
                    "errors": [],
                    "own_fixture_fd_before": 0,
                    "own_fixture_fd_after": 0,
                    "scanOpenCount": 1,
                    "scanBytes": 64,
                    "mutation_applied": True,
                }
                for name in sorted(CASE_IDS)
            ],
        }

    def test_cleanup_path_is_one_owned_tmp_component(self):
        self.assertTrue(valid_remote_directory("/tmp/coloop-managed-fd-abcd1234"))
        for path in (
            "/tmp",
            "/tmp/coloop-managed-fd-short",
            "/tmp/coloop-managed-fd-abcd1234/child",
            "/tmp/../tmp/coloop-managed-fd-abcd1234",
            "/home/cat/coloop-managed-fd-abcd1234",
            "tmp/coloop-managed-fd-abcd1234",
        ):
            self.assertFalse(valid_remote_directory(path), path)

    def test_complete_evidence_binds_runtime_and_core(self):
        self.assertEqual(validate_result(self.result(), "a" * 64, "1.4.4"), [])
        result = self.result()
        result["source_core_sha256"] = "b" * 64
        self.assertIn("EXECUTED_CORE_HASH_MISMATCH", validate_result(result, "a" * 64, "1.4.4"))
        result = self.result()
        result["runtime"]["version"] = "another"
        self.assertIn("WRONG_RUNTIME", validate_result(result, "a" * 64, "1.4.4"))

    def test_missing_or_duplicate_case_is_not_a_full_pass(self):
        for modify in (
            lambda result: result["results"].pop(),
            lambda result: result["results"].append(copy.deepcopy(result["results"][0])),
        ):
            result = self.result()
            modify(result)
            self.assertIn("CASE_SET_CHANGED", validate_result(result, "a" * 64, "1.4.4"))

    def test_descriptor_leak_and_wrong_scope_fail_closed(self):
        result = self.result()
        result["results"][0]["own_fixture_fd_after"] = 1
        result["npu_calls"] = 1
        errors = validate_result(result, "a" * 64, "1.4.4")
        self.assertIn("VALIDATION_SCOPE_CHANGED", errors)
        self.assertTrue(any(error.startswith("CASE_DESCRIPTOR_LEAK:") for error in errors))

    def test_counter_boolean_and_oversized_read_are_invalid(self):
        for key, value in (("scanOpenCount", True), ("scanBytes", 65538)):
            result = self.result()
            result["results"][0][key] = value
            self.assertTrue(
                any(
                    error.startswith("CASE_COUNTER_INVALID:")
                    for error in validate_result(result, "a" * 64, "1.4.4")
                )
            )

    def test_missing_controlled_mutation_cannot_claim_coverage(self):
        result = self.result()
        row = next(
            item
            for item in result["results"]
            if item["id"] == "root-directory-pinned-before-file-open"
        )
        row["mutation_applied"] = False
        self.assertIn(
            "CONTROLLED_MUTATION_MISSING:root-directory-pinned-before-file-open",
            validate_result(result, "a" * 64, "1.4.4"),
        )


if __name__ == "__main__":
    unittest.main()
