"""HTTP contract tests with a fake worker; these do not measure model quality."""

import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
from server import Handler, ThreadingHTTPServer


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.http.api_key = "test-key"
        cls.http.records = Path(cls.directory.name) / "requests.jsonl"
        cls.http.record_lock = threading.Lock()
        cls.http.worker = SimpleNamespace(context=4096, process=SimpleNamespace(poll=lambda: None))
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.http.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        cls.directory.cleanup()

    def setUp(self):
        self.http.worker.generate = lambda *_: ("some reasoning</think>5", 8, 12, {})

    def request(
        self,
        body=None,
        key="test-key",
        origin=None,
        path="/v1/chat/completions",
        session=None,
        cache_control=None,
    ):
        headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        if session:
            headers["x-opencode-session-id"] = session
        if cache_control:
            headers["X-RK-Cache"] = cache_control
        req = urllib.request.Request(
            self.url + path,
            headers=headers,
            data=json.dumps(body).encode() if body is not None else None,
        )
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read().decode()

    def body(self, **extra):
        return {
            "model": "deepseek-rkllm",
            "messages": [{"role": "user", "content": "2+3?"}],
            **extra,
        }

    def test_auth_and_origin(self):
        self.assertEqual(self.request(key="bad", path="/health")[0], 401)
        self.assertEqual(self.request(origin="https://example.com", path="/health")[0], 403)
        self.assertEqual(self.request(path="/health")[0], 200)

    def test_json_and_buffered_sse(self):
        status, text = self.request(self.body())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text)["choices"][0]["message"]["content"], "5")
        status, text = self.request(self.body(stream=True))
        self.assertEqual(status, 200)
        chunks = text.strip().split("\n\n")
        self.assertEqual(chunks[-1], "data: [DONE]")
        self.assertEqual(json.loads(chunks[0][6:])["choices"][0]["delta"]["content"], "5")

    def test_unfinished_reasoning_is_not_an_answer(self):
        self.http.worker.generate = lambda *_: ("I should think longer", 8, 512, {})
        status, text = self.request(self.body())
        self.assertEqual(status, 422)
        self.assertEqual(json.loads(text)["error"]["type"], "invalid_model_output")

    def test_oversized_prompt_rejected_before_inference(self):
        def unexpected(*_):
            raise AssertionError("Inference must not run")

        self.http.worker.generate = unexpected
        body = self.body()
        body["messages"][0]["content"] = "x" * 4096
        self.assertEqual(self.request(body)[0], 400)

    def test_qwen_16k_accepts_input_beyond_old_4k_budget(self):
        prompts = []

        def generate(prompt, tokens, *_):
            prompts.append(prompt)
            return "received", 2500, 4, {}

        worker = SimpleNamespace(
            context=16384,
            model_id="qwen35-4b-rkllm",
            runtime_version="1.3.0",
            generate=generate,
            process=SimpleNamespace(poll=lambda: None),
        )
        body = {
            "model": worker.model_id,
            "max_tokens": 24,
            "messages": [{"role": "user", "content": "x" * 5000}],
        }
        with patch.object(self.http, "worker", worker):
            status, text = self.request(body)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(text)["choices"][0]["message"]["content"], "received")
            self.assertIn("x" * 5000, prompts[0])
            status, text = self.request(path="/health")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(text)["context"], 16384)
            prompts.clear()
            body["messages"][0]["content"] = "x" * 16384
            self.assertEqual(self.request(body)[0], 400)
            self.assertEqual(prompts, [])

    def test_busy_is_explicit(self):
        def busy(*_):
            raise BlockingIOError("busy")

        self.http.worker.generate = busy
        self.assertEqual(self.request(self.body())[0], 429)

    def test_custom_model_format_and_output_limit_are_profile_capabilities(self):
        prompts = []

        def generate(prompt, *_):
            prompts.append(prompt)
            return "8B fixture answer", 8, 3, {}

        worker = SimpleNamespace(
            context=8192, model_id="qwen3-8b-fixture", prompt_format="embedded",
            max_output=128, default_output=24, generate=generate,
            process=SimpleNamespace(poll=lambda: None),
        )
        body = self.body(model=worker.model_id)
        with patch.object(self.http, "worker", worker):
            status, text = self.request(body)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(text)["model"], worker.model_id)
            self.assertNotIn("<｜", prompts[0])
            self.assertEqual(self.request({**body, "max_tokens": 129})[0], 400)
            self.assertEqual(len(prompts), 1)
            # An arbitrary ID with the R1 format must still finish its reasoning segment.
            worker.prompt_format = "deepseek-r1"
            self.assertEqual(self.request(body)[0], 422)

    def test_cache_session_forwarding_usage_and_commit(self):
        cache = Mock()
        contexts = []

        def generate(prompt, tokens, context, body):
            contexts.append(context)
            return (
                "reasoning</think>5",
                8,
                12,
                {"cache_ticket": 7, "kv_before": 100, "kv_after": 120},
            )

        worker = SimpleNamespace(context=4096, cache=cache, generate=generate)
        with patch.object(self.http, "worker", worker):
            status, text = self.request(self.body(), session="session-A")
        self.assertEqual(status, 200)
        self.assertEqual(contexts[0].session, "session-A")
        self.assertEqual(json.loads(text)["usage"]["prompt_tokens"], 108)
        self.assertEqual(json.loads(text)["usage"]["prompt_tokens_details"]["cached_tokens"], 100)
        cache.commit.assert_called_once_with(7, {"role": "assistant", "content": "5"}, 120)
        cache.invalidate.assert_not_called()

    def test_invalid_or_truncated_generation_is_not_cached(self):
        for raw, output_tokens, expected_status in (
            ("unfinished reasoning", 10, 422),
            ("reasoning</think>5", 512, 200),
        ):
            cache = Mock()
            worker = SimpleNamespace(
                context=4096,
                cache=cache,
                generate=lambda *_: (raw, 8, output_tokens, {"cache_ticket": 9, "kv_after": 100}),
            )
            with patch.object(self.http, "worker", worker):
                status, _ = self.request(self.body(), session="session-A")
            self.assertEqual(status, expected_status)
            cache.commit.assert_not_called()
            cache.invalidate.assert_called_with(9)

    def test_invalid_cache_control_is_rejected_before_generation(self):
        def unexpected(*_):
            raise AssertionError("Invalid cache control must not reach the model")

        self.http.worker.generate = unexpected
        self.assertEqual(self.request(self.body(), session="A", cache_control="unsafe")[0], 400)


if __name__ == "__main__":
    unittest.main()
