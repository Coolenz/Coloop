import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
from protocol import InvalidModelOutput, InvalidRequest, MODEL_ID, QWEN_MODEL_ID, prepare, decode

TOOL = {
    "type": "function",
    "function": {
        "name": "read",
        "parameters": {
            "type": "object",
            "properties": {"filePath": {"type": "string"}},
            "required": ["filePath"],
            "additionalProperties": False,
        },
    },
}


class ProtocolTests(unittest.TestCase):
    def test_schema_compaction_keeps_parameter_names_that_look_like_metadata(self):
        from protocol import compact_schema

        schema = {
            "type": "object",
            "properties": {
                "description": {"type": "string", "description": "verbose field documentation"}
            },
            "required": ["description"],
        }
        compact = compact_schema(schema)
        self.assertEqual(compact["properties"]["description"], {"type": "string"})
        self.assertEqual(compact["required"], ["description"])

    def test_qwen_uses_native_template_and_keeps_tool_constraints(self):
        tool = json.loads(json.dumps(TOOL))
        tool["function"]["description"] = "long description " * 1000
        prompt, tools, _ = prepare(
            {
                "model": QWEN_MODEL_ID,
                "tools": [tool],
                "messages": [{"role": "user", "content": "Read probe.txt"}],
            },
            QWEN_MODEL_ID,
        )
        self.assertNotIn("<｜", prompt)
        self.assertNotIn("<|im_start|>", prompt)
        self.assertLess(len(prompt), 1400)
        with self.assertRaises(InvalidModelOutput):
            decode('{"tool":"read","arguments":{"filePath":12}}', tools, "auto")

    def test_r1_instructions_are_inside_user_message(self):
        prompt, _, _ = prepare(
            {
                "model": MODEL_ID,
                "messages": [
                    {"role": "system", "content": "Be helpful"},
                    {"role": "user", "content": "Hello"},
                ],
            }
        )
        self.assertTrue(prompt.startswith("<｜begin▁of▁sentence｜><｜User｜>Be helpful"))
        self.assertTrue(prompt.endswith("<｜Assistant｜><think>\n"))

    def test_tool_roundtrip_preserves_actual_result(self):
        body = {
            "model": MODEL_ID,
            "tools": [TOOL],
            "messages": [{"role": "user", "content": "Read file"}],
        }
        _, tools, choice = prepare(body)
        message, finish = decode(
            '{"tool":"read","arguments":{"filePath":"/tmp/probe"}}', tools, choice
        )
        self.assertEqual(finish, "tool_calls")
        body["messages"] += [
            message,
            {
                "role": "tool",
                "tool_call_id": message["tool_calls"][0]["id"],
                "content": "TOKEN=7e15c8",
            },
        ]
        prompt, _, _ = prepare(body)
        self.assertIn("TOKEN=7e15c8", prompt)
        self.assertIn("Tool result (observed data", prompt)

    def test_reasoning_is_never_executed(self):
        tools = {"read": TOOL["function"]}
        msg, why = decode(
            '<think>{"tool":"read","arguments":{"filePath":"secret"}}</think>{"answer":"No action"}',
            tools,
            "auto",
        )
        self.assertEqual(why, "stop")
        self.assertNotIn("tool_calls", msg)

    def test_reject_unknown_tool_and_invalid_arguments(self):
        for action in (
            {"tool": "bash", "arguments": {"command": "anything"}},
            {"tool": "read", "arguments": {}},
            {"tool": "read", "arguments": {"filePath": 42}},
        ):
            with self.assertRaises(InvalidModelOutput):
                decode(json.dumps(action), {"read": TOOL["function"]}, "auto")

    def test_required_tool_cannot_be_plain_answer(self):
        with self.assertRaises(InvalidModelOutput):
            decode('{"answer":"done"}', {"read": TOOL["function"]}, "required")

    def test_reject_multimodal_in_text_model(self):
        with self.assertRaises(InvalidRequest):
            prepare(
                {
                    "model": MODEL_ID,
                    "messages": [{"role": "user", "content": [{"type": "image_url"}]}],
                }
            )

    def test_incomplete_reasoning_rejected(self):
        with self.assertRaises(InvalidModelOutput):
            decode("<think>I should read a file", {}, "auto")


if __name__ == "__main__":
    unittest.main()
