"""Request-level privacy logging tests; fake worker, no NPU invocation."""

import contextlib
import io
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
from server import Handler, ThreadingHTTPServer, Worker, metadata_record


CANARY = "PRIVATE_RANDOM_CANARY_14bba7d569"


class PrivacyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.api_key = "fake-test-key"
        self.server.records = Path(self.directory.name) / "requests.jsonl"
        self.server.record_lock = threading.Lock()
        self.server.worker = SimpleNamespace(
            context=16384,
            model_id="qwen35-4b-rkllm",
            process=SimpleNamespace(poll=lambda: None),
            generate=lambda *_: (
                CANARY, 12, 7,
                {"prefill_ms": 2.0, "generate_ms": 3.0, "cache_reason": CANARY},
            ),
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, *, privacy="metadata-only", stream=False, path="/v1/chat/completions"):
        headers = {"Authorization": "Bearer fake-test-key", "Content-Type": "application/json"}
        if privacy is not None:
            headers["X-RK-Privacy"] = privacy
        body = {
            "model": "qwen35-4b-rkllm",
            "messages": [{"role": "user", "content": CANARY}],
            "stream": stream,
        }
        data = json.dumps(body).encode() if path != "/health" else None
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.server.server_port}" + path, data, headers
        )
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, dict(response.headers), response.read().decode()

    def record(self):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with self.server.record_lock:
                if self.server.records.exists():
                    rows = self.server.records.read_text(encoding="utf-8").splitlines()
                    if rows:
                        return json.loads(rows[-1])
            time.sleep(0.01)
        self.fail("Request audit did not complete")

    def test_private_json_preserves_response_and_suppresses_all_text_logs(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status, headers, text = self.request()
            record = self.record()
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-RK-Privacy"], "metadata-only")
        self.assertEqual(json.loads(text)["choices"][0]["message"]["content"], CANARY)
        self.assertNotIn(CANARY, json.dumps(record))
        self.assertNotIn("raw_model_output", record)
        self.assertNotIn("message", record)
        self.assertNotIn("tools", record)
        self.assertEqual(record["privacy"], "metadata-only")
        self.assertEqual(record["input_tokens"], 12)
        self.assertEqual(output.getvalue(), "")

    def test_private_sse_keeps_content_on_response_only(self):
        status, headers, text = self.request(stream=True)
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-RK-Privacy"], "metadata-only")
        self.assertIn(CANARY, text)
        self.assertNotIn(CANARY, json.dumps(self.record()))

    def test_reflected_worker_error_is_redacted_in_record_and_response(self):
        def fail(*_):
            raise RuntimeError(CANARY)

        self.server.worker.generate = fail
        status, _, text = self.request()
        self.assertEqual(status, 503)
        self.assertNotIn(CANARY, text)
        record = self.record()
        self.assertNotIn(CANARY, json.dumps(record))
        self.assertEqual(record["error_code"], "model_unavailable")

    def test_unknown_and_empty_privacy_modes_fail_before_inference(self):
        def unexpected(*_):
            self.fail("Unknown privacy mode must not reach model")

        self.server.worker.generate = unexpected
        for mode in (CANARY, ""):
            status, _, text = self.request(privacy=mode)
            self.assertEqual(status, 400)
            self.assertNotIn(CANARY, text)
            self.assertNotIn(CANARY, json.dumps(self.record()))

    def test_health_advertises_privacy_support(self):
        status, _, text = self.request(privacy=None, path="/health")
        self.assertEqual(status, 200)
        self.assertIs(json.loads(text)["privacy_metadata_only"], True)

    def test_default_logging_behavior_retains_existing_diagnostics(self):
        status, headers, _ = self.request(privacy=None)
        self.assertEqual(status, 200)
        self.assertNotIn("X-RK-Privacy", headers)
        record = self.record()
        self.assertEqual(record["raw_model_output"], CANARY)
        self.assertEqual(record["message"]["content"], CANARY)

    def test_raw_native_logging_disables_privacy_capability_and_request(self):
        self.server.worker.worker_log_mode = "raw"
        status, _, text = self.request(privacy=None, path="/health")
        self.assertEqual(status, 200)
        self.assertIs(json.loads(text)["privacy_metadata_only"], False)

        def unexpected(*_):
            self.fail("Raw native logging must refuse private inference")

        self.server.worker.generate = unexpected
        status, _, text = self.request()
        self.assertEqual(status, 400)
        self.assertNotIn(CANARY, text)
        self.assertNotIn(CANARY, json.dumps(self.record()))

    def test_native_stderr_is_discarded_by_default_and_raw_is_explicit(self):
        root = Path(self.directory.name)
        (root / "logs").mkdir()
        for mode in ("metadata-only", "raw"):
            process = SimpleNamespace(
                stdout=io.BytesIO(b"READY 3\n"), poll=lambda: 0,
            )
            with patch("server.subprocess.Popen", return_value=process) as launch:
                worker = Worker(
                    root, root / "model.rkllm", root / "lib", 16384, 180,
                    profile="qwen35-4b", worker_log_mode=mode,
                )
                try:
                    destination = launch.call_args.kwargs["stderr"]
                    if mode == "metadata-only":
                        self.assertEqual(destination, subprocess.DEVNULL)
                        self.assertIsNone(worker.log)
                    else:
                        self.assertIs(destination, worker.log)
                        self.assertEqual(Path(worker.log.name), root / "logs/worker.log")
                finally:
                    worker.close()

    def test_allowlist_rejects_strings_in_numeric_and_nested_metrics(self):
        record = metadata_record({
            "id": "server-generated-id", "started_at": 2.0,
            "prompt_bytes": CANARY, "error": CANARY, "session_tag": CANARY,
            "finish_reason": CANARY, "tools": [CANARY], "unexpected": CANARY,
            "inference": {"prefill_ms": CANARY, "kv_before": 0,
                          "cache_mode": CANARY, "cache_ticket": CANARY},
        })
        self.assertNotIn(CANARY, json.dumps(record))
        self.assertEqual(record["inference"], {"kv_before": 0})


if __name__ == "__main__":
    unittest.main()
