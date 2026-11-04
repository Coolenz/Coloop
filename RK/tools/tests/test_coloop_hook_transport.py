"""Real local HTTP/SSE tests for the controlled source provider; no SSH or NPU."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bench_coloop_hook_transport as transport  # noqa: E402


class ProviderTests(unittest.TestCase):
    def setUp(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is required for the actual provider HTTP fixture")
        self.temporary = tempfile.TemporaryDirectory(prefix="coloop-scripted-source-test-")
        self.directory = Path(self.temporary.name)
        (self.directory / "provider.mjs").write_text(
            transport.SCRIPTED_SOURCE_PLUGIN, encoding="utf-8"
        )
        (self.directory / "runner.mjs").write_text(
            "import provider from './provider.mjs';\n"
            "const hooks=await provider();\n"
            "const config={provider:{rkllm:{options:{}}}};await hooks.config(config);\n"
            "process.stdout.write(JSON.stringify(config.provider.rkllm.options)+'\\n');\n"
            "process.stdin.resume();process.stdin.once('data',async()=>{"
            "await hooks.dispose();process.exit(0)});\n",
            encoding="utf-8",
        )
        self.process = subprocess.Popen(
            [node, str(self.directory / "runner.mjs")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        ready = json.loads(self.process.stdout.readline())
        self.url = ready["baseURL"] + "/chat/completions"
        self.authorization = "Bearer " + ready["apiKey"]
        self.opener = build_opener(ProxyHandler({}))

    def tearDown(self):
        if hasattr(self, "process"):
            if self.process.poll() is None:
                self.process.stdin.write("stop\n")
                self.process.stdin.flush()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
            self.process.stdin.close()
            self.process.stdout.close()
            stderr = self.process.stderr.read()
            self.process.stderr.close()
            self.assertEqual(stderr, "")
        if hasattr(self, "temporary"):
            self.temporary.cleanup()

    @staticmethod
    def arguments(reverse=False, marker="synthetic"):
        labels = ["local " + marker, "skip " + marker]
        if reverse:
            labels.reverse()
        return {"questions": [{
            "question": "choose " + marker,
            "header": "mode",
            "options": [{"label": label, "description": ""} for label in labels],
            "multiple": False,
            "custom": False,
        }]}

    @staticmethod
    def body(arguments, stream=False):
        return {
            "model": "qwen35-4b-rkllm",
            "messages": [{"role": "user", "content":
                          "Call question now using exactly these arguments: "
                          + json.dumps(arguments, ensure_ascii=False)}],
            "tools": [{"type": "function", "function": {
                "name": "question", "parameters": {"type": "object"},
            }}],
            "stream": stream,
        }

    def request(self, body, *, headers=None, raw=None):
        payload = json.dumps(body, ensure_ascii=False).encode() if raw is None else raw
        request = Request(self.url, data=payload, method="POST", headers={
            "Authorization": self.authorization, "Content-Type": "application/json",
            **(headers or {}),
        })
        try:
            with self.opener.open(request, timeout=5) as response:
                return response.status, response.headers.get_content_type(), response.read()
        except HTTPError as error:
            return error.code, error.headers.get_content_type(), error.read()

    def message(self, body):
        status, kind, raw = self.request(body)
        self.assertEqual(status, 200)
        if not body["stream"]:
            self.assertEqual(kind, "application/json")
            value = json.loads(raw)
            return value["choices"][0]["message"], value["choices"][0]["finish_reason"]
        self.assertEqual(kind, "text/event-stream")
        self.assertTrue(raw.endswith(b"data: [DONE]\n\n"))
        chunks = [json.loads(line[6:]) for line in raw.decode().splitlines()
                  if line.startswith("data: ") and line != "data: [DONE]"]
        message = {"role": "assistant", "content": ""}
        finish = None
        for chunk in chunks:
            choice = chunk["choices"][0]
            delta = choice["delta"]
            message["content"] += delta.get("content", "")
            if "tool_calls" in delta:
                message["tool_calls"] = [
                    {key: value for key, value in call.items() if key != "index"}
                    for call in delta["tool_calls"]
                ]
            finish = choice.get("finish_reason") or finish
        return message, finish

    @staticmethod
    def result_body(body, message, arguments, selected):
        result = deepcopy(body)
        question = arguments["questions"][0]["question"]
        output = f'User has answered your questions: "{question}"="{selected}". '
        output += "You can now continue with the user's answers in mind."
        result["messages"] += [message, {
            "role": "tool", "tool_call_id": message["tool_calls"][0]["id"], "content": output,
        }]
        return result

    def test_json_and_sse_preserve_both_orders_and_actual_selected_label(self):
        for stream in (False, True):
            for reverse in (False, True):
                for selected_index in (0, 1):
                    with self.subTest(stream=stream, reverse=reverse, selected=selected_index):
                        arguments = self.arguments(reverse)
                        body = self.body(arguments, stream)
                        message, finish = self.message(body)
                        self.assertEqual(finish, "tool_calls")
                        self.assertEqual(len(message["tool_calls"]), 1)
                        call = message["tool_calls"][0]
                        self.assertEqual(call["function"]["name"], "question")
                        self.assertEqual(json.loads(call["function"]["arguments"]), arguments)
                        selected = arguments["questions"][0]["options"][selected_index]["label"]
                        final, finish = self.message(
                            self.result_body(body, message, arguments, selected)
                        )
                        self.assertEqual(finish, "stop")
                        self.assertEqual(final["content"], selected)
                        self.assertNotIn("tool_calls", final)

    def test_skip_is_echoed_instead_of_replaced_by_a_preferred_option(self):
        arguments = self.arguments()
        body = self.body(arguments)
        message, _ = self.message(body)
        selected = arguments["questions"][0]["options"][1]["label"]
        final, _ = self.message(self.result_body(body, message, arguments, selected))
        self.assertEqual(final["content"], "skip synthetic")

    def test_unknown_tool_and_changed_arguments_are_rejected(self):
        arguments = self.arguments()
        body = self.body(arguments)
        message, _ = self.message(body)
        result = self.result_body(body, message, arguments, "local synthetic")
        for change in ("tool", "arguments", "answer"):
            broken = deepcopy(result)
            if change == "tool":
                broken["messages"][1]["tool_calls"][0]["function"]["name"] = "bash"
            elif change == "arguments":
                altered = self.arguments(marker="changed")
                broken["messages"][1]["tool_calls"][0]["function"]["arguments"] = json.dumps(altered)
            else:
                broken["messages"][2]["content"] = "unrecognized result"
            self.assertEqual(self.request(broken)[0], 400)

    def test_sdk_key_reordering_keeps_full_value_and_array_order_checks(self):
        arguments = self.arguments()
        body = self.body(arguments, True)
        message, _ = self.message(body)
        result = self.result_body(body, message, arguments, "local synthetic")
        question = arguments["questions"][0]
        reordered = {"questions": [{key: question[key] for key in reversed(question)}]}
        result["messages"][1]["tool_calls"][0]["function"]["arguments"] = json.dumps(reordered)
        final, finish = self.message(result)
        self.assertEqual(final["content"], "local synthetic")
        self.assertEqual(finish, "stop")
        reordered["questions"][0]["options"].reverse()
        result["messages"][1]["tool_calls"][0]["function"]["arguments"] = json.dumps(reordered)
        self.assertEqual(self.request(result)[0], 400)

    def test_auth_origin_size_and_utf8_boundaries(self):
        body = self.body(self.arguments())
        for headers, status in (({"Authorization": "Bearer incorrect"}, 401),
                                ({"Origin": "https://example.invalid"}, 403),
                                ({"Content-Type": "text/plain"}, 415)):
            self.assertEqual(self.request(body, headers=headers)[0], status)
        self.assertEqual(self.request(body, raw=b"x" * 65537)[0], 413)
        self.assertEqual(self.request(body, raw=b"\xff")[0], 400)

    def test_metrics_store_only_counters_and_no_prompt_key_or_tool_result(self):
        marker = "PASSWORD_CANARY_do_not_store"
        arguments = self.arguments(marker=marker)
        body = self.body(arguments, True)
        message, _ = self.message(body)
        selected = arguments["questions"][0]["options"][0]["label"]
        self.message(self.result_body(body, message, arguments, selected))
        path = self.directory / "logs/scripted-source-metrics.json"
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            value = json.loads(path.read_text())
            if value["final_responses"] == 1:
                break
            time.sleep(0.01)
        raw = path.read_text()
        self.assertEqual(set(value), transport.METRIC_FIELDS)
        self.assertEqual(value["tool_responses"], 1)
        self.assertEqual(value["final_responses"], 1)
        self.assertNotIn(marker, raw)
        self.assertNotIn(self.authorization.removeprefix("Bearer "), raw)
        self.assertNotIn("User has answered", raw)
        self.assertNotIn("input.client", transport.SCRIPTED_SOURCE_PLUGIN)
        self.assertNotIn("/question/", transport.SCRIPTED_SOURCE_PLUGIN)


class EvidenceTests(unittest.TestCase):
    def test_manifest_labels_the_scripted_source(self):
        value = transport.source_fixture_manifest()
        self.assertTrue(value["source_model_scripted"])
        self.assertFalse(value["rk_review_scripted"])
        self.assertFalse(value["approval_reply_fabricated"])
        self.assertEqual(len(value["code_sha256"]), 64)

    def test_evidence_requires_real_npu_count_and_exact_source_echo(self):
        report = {"requested_samples": 2, "passed": True, "functionalityPassed": True,
                  "performancePassed": True, "cleanup": {
                      "scripted_source": {"requests": 6, "tool_responses": 3,
                                          "final_responses": 3, "rejected": 0,
                                          "source_model_scripted": True},
                      "requests.jsonl": {"metadata_only": True, "record_count": 3},
                  }}
        echoes = {"checked_samples": 3, "exact_tool_result_echo": True}
        good = deepcopy(report)
        transport.annotate(good, echoes)
        self.assertTrue(good["scripted_source_evidence_passed"])
        for field in ("record_count", "metadata_only"):
            broken = deepcopy(report)
            broken["cleanup"]["requests.jsonl"][field] = 0
            transport.annotate(broken, echoes)
            self.assertFalse(broken["passed"])
            self.assertFalse(broken["performancePassed"])
        transport.annotate(report, {"checked_samples": 3, "exact_tool_result_echo": False})
        self.assertFalse(report["functionalityPassed"])

    def test_final_echo_is_checked_against_actual_tool_output_without_an_answer_key(self):
        arguments = ProviderTests.arguments()
        selected = arguments["questions"][0]["options"][1]["label"]
        q = arguments["questions"][0]["question"]
        output = f'User has answered your questions: "{q}"="{selected}". '
        output += "You can now continue with the user's answers in mind."
        rows = [{"messages": [{"info": {"role": "assistant"}, "parts": [{
            "type": "tool", "tool": "question", "state": {
                "status": "completed", "input": arguments, "output": output,
            },
        }]}, {"info": {"role": "assistant"}, "parts": [{"type": "text", "text": selected}]}]}]
        self.assertTrue(transport.verify_source_echo(rows)["exact_tool_result_echo"])
        rows[0]["messages"][1]["parts"][0]["text"] = "local synthetic"
        self.assertFalse(transport.verify_source_echo(rows)["exact_tool_result_echo"])


if __name__ == "__main__":
    unittest.main()
