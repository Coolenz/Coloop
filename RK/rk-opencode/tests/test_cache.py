import concurrent.futures
from copy import deepcopy
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
from cache import ConversationCache, message_key, request_context
from protocol import QWEN_MODEL_ID, InvalidRequest, prepare
from server import Worker


class CacheTests(unittest.TestCase):
    def body(self):
        return {
            "model": QWEN_MODEL_ID,
            "messages": [
                {"role": "system", "content": "Keep the exact verification value."},
                {"role": "user", "content": "Verification value is BLUE."},
            ],
        }

    def continuation(self, body, answer=None):
        return {
            **body,
            "messages": body["messages"]
            + [
                answer or {"role": "assistant", "content": "BLUE"},
                {"role": "user", "content": "Repeat the verification value."},
            ],
        }

    def ready_cache(self):
        body = self.body()
        cache = ConversationCache()
        decision = cache.begin(request_context(body, "A"))
        cache.commit(decision["ticket"], {"role": "assistant", "content": "BLUE"}, 200)
        return cache, self.continuation(body)

    def test_append_reuses_only_accepted_history(self):
        cache, body = self.ready_cache()
        decision = cache.begin(request_context(body, "A"))
        self.assertFalse(decision["reset"])
        self.assertEqual(decision["message_start"], 3)
        self.assertEqual(decision["native_tokens"], 200)

    def test_sessions_history_tools_instructions_and_retries_reset(self):
        for change in ("session", "history", "tools", "instructions", "retry"):
            cache, body = self.ready_cache()
            session = "A"
            if change == "session":
                session = "B"
            elif change == "history":
                body["messages"][1]["content"] = "Verification value is GREEN."
            elif change == "tools":
                body["tools"] = [{"name": "different-tool-schema"}]
            elif change == "instructions":
                body["messages"][0]["content"] = "Different instructions"
            else:
                body = self.body()
            self.assertTrue(cache.begin(request_context(body, session))["reset"], change)

    def test_expiry_missing_session_and_disable_reset(self):
        with patch("cache.time.monotonic", return_value=100):
            cache, body = self.ready_cache()
        with patch("cache.time.monotonic", return_value=401):
            self.assertEqual(cache.begin(request_context(body, "A"))["reason"], "expired")
        cache, body = self.ready_cache()
        self.assertTrue(cache.begin(request_context(body, None))["reset"])
        self.assertIsNone(request_context(body, "A", "off"))
        with self.assertRaises(InvalidRequest):
            request_context(body, "bad session\n")

    def test_uncommitted_invalidated_and_stale_generations_never_reuse(self):
        cache, body = self.ready_cache()
        old = cache.begin(request_context(body, "A"))
        newer = cache.begin(request_context(self.body(), "B"))
        self.assertTrue(newer["reset"])
        cache.commit(old["ticket"], {"role": "assistant", "content": "stale"}, 999)
        self.assertFalse(cache.ready)
        cache.commit(newer["ticket"], {"role": "assistant", "content": "BLUE"}, 100)
        cache.invalidate(old["ticket"])
        self.assertTrue(cache.ready)
        cache.invalidate(newer["ticket"])
        self.assertFalse(cache.ready)

    def test_tool_calls_normalize_sdk_json_and_empty_content(self):
        a = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read", "arguments": '{"a":1,"b":2}'},
                }
            ],
        }
        b = deepcopy(a)
        b["content"] = ""
        b["tool_calls"][0]["function"]["arguments"] = '{ "b": 2, "a": 1 }'
        self.assertEqual(message_key(a), message_key(b))
        b["tool_calls"][0]["id"] = "call_2"
        self.assertNotEqual(message_key(a), message_key(b))

    def fake_worker(self):
        worker = Worker.__new__(Worker)
        worker.lock = threading.Lock()
        worker.timeout = 3
        worker.context = 16384
        worker.model_id = QWEN_MODEL_ID
        worker.prompt_format = "embedded"
        worker.cache_mode = "native"
        worker.cache = ConversationCache()
        worker.process = SimpleNamespace(poll=lambda: None)
        worker.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.addCleanup(worker.executor.shutdown)
        worker.calls = []

        def exchange(prompt, tokens, mode):
            worker.calls.append((prompt, mode))
            return (
                "BLUE",
                20,
                1,
                {
                    "prefill_ms": 100,
                    "generate_ms": 10,
                    "kv_before": 100 if mode == 2 else 0,
                    "kv_after": 200,
                },
            )

        worker._exchange = exchange
        return worker

    def test_worker_submits_delta_and_resets_near_native_context_limit(self):
        worker = self.fake_worker()
        body = self.body()
        raw, _, _, metrics = worker.generate(
            prepare(body, QWEN_MODEL_ID)[0], 64, request_context(body, "A"), body
        )
        worker.cache.commit(metrics["cache_ticket"], {"role": "assistant", "content": raw}, 100)
        next_body = self.continuation(body)
        _, _, _, metrics = worker.generate(
            prepare(next_body, QWEN_MODEL_ID)[0], 64, request_context(next_body, "A"), next_body
        )
        self.assertEqual([c[1] for c in worker.calls], [1, 2])
        self.assertNotIn("Verification value is BLUE", worker.calls[-1][0])
        self.assertIn("Repeat the verification value", worker.calls[-1][0])
        worker.cache.commit(
            metrics["cache_ticket"], {"role": "assistant", "content": "BLUE"}, 16300
        )
        third = self.continuation(next_body)
        _, _, _, metrics = worker.generate(
            prepare(third, QWEN_MODEL_ID)[0], 64, request_context(third, "A"), third
        )
        self.assertEqual(worker.calls[-1][1], 1)
        self.assertEqual(metrics["cache_reason"], "native_context_budget")
        self.assertIn("Verification value is BLUE", worker.calls[-1][0])


if __name__ == "__main__":
    unittest.main()
