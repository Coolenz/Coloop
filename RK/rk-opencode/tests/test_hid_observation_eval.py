"""Strict scoring and no answer leakage in the observation-only NPU benchmark."""

import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("observation_eval", ROOT / "scripts/bench-hid-observation.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class EvaluationTests(unittest.TestCase):
    @staticmethod
    def response(content, finish="stop"):
        return {"choices": [{"message": {"content": content}, "finish_reason": finish}]}

    def test_score_preserves_spaces_and_number_types_and_rejects_markdown_or_truncation(self):
        expected = {"value": " 001.00 "}
        self.assertTrue(bench.score(self.response('{"value":" 001.00 "}'), expected))
        for text in ('{"value":"001.00"}', '{"value":1.0}', '```json\n{"value":" 001.00 "}\n```'):
            self.assertFalse(bench.score(self.response(text), expected))
        self.assertFalse(bench.score(self.response('{"value":" 001.00 "}', "length"), expected))
        self.assertFalse(bench.score(self.response('{"complete":1}'), {"complete": True}))

    def test_expected_answer_and_other_view_never_enter_request(self):
        case = {"question": "Read actual value.", "expected": {"secret": "SCORING_ONLY"},
                "views": {"raw": {"raw_only": 1}, "compact": {"small_only": 2}}}
        request = bench.request_body(case, "compact", "local-model")
        encoded = json.dumps(request)
        self.assertNotIn("SCORING_ONLY", encoded)
        self.assertNotIn("raw_only", encoded)
        self.assertIn("small_only", encoded)
        self.assertNotIn("tools", request)


if __name__ == "__main__":
    unittest.main()
