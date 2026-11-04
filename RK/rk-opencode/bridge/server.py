"""Loopback-only chat-completions adapter, Python standard library only."""

import argparse
import concurrent.futures
import hmac
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model_profiles import WORKER_PROTOCOL, load_profile, check_assets  # noqa: E402
from protocol import MODEL_ID, InvalidRequest, InvalidModelOutput, prepare, decode
from cache import ConversationCache, request_context, digest


def metadata_record(record):
    """Allowlist diagnostic scalars; model text and reflected errors never reach disk."""
    result = {"id": record["id"], "privacy": "metadata-only"}
    for key in (
        "started_at", "prompt_bytes", "input_tokens", "output_tokens", "elapsed_seconds"
    ):
        value = record.get(key)
        if type(value) in (int, float) and math.isfinite(value):
            result[key] = value
    if record.get("finish_reason") in ("stop", "length", "tool_calls"):
        result["finish_reason"] = record["finish_reason"]
    if record.get("error_code") in (
        "model_busy", "invalid_request_error", "invalid_model_output",
        "inference_timeout", "client_disconnected", "model_unavailable",
    ):
        result["error_code"] = record["error_code"]
    metrics = record.get("inference", {})
    safe_metrics = {}
    for key in ("prefill_ms", "generate_ms", "kv_before", "kv_after", "submitted_bytes"):
        value = metrics.get(key)
        if type(value) in (int, float) and math.isfinite(value):
            safe_metrics[key] = value
    if metrics.get("cache_mode") in ("off", "native"):
        safe_metrics["cache_mode"] = metrics["cache_mode"]
    if safe_metrics:
        result["inference"] = safe_metrics
    return result


class Worker:
    def __init__(
        self,
        root,
        model,
        runtime,
        context,
        timeout,
        profile="deepseek",
        cache_mode="off",
        cache_ttl=300,
        worker_log_mode="metadata-only",
        settings=None,
    ):
        if worker_log_mode not in ("metadata-only", "raw"):
            raise ValueError("Unsupported worker log mode")
        self.lock = threading.Lock()
        self.timeout = timeout
        self.context = context
        settings = settings or load_profile(profile)
        self.model_id = settings["model_id"]
        self.profile = profile
        self.prompt_format = settings["prompt_format"]
        self.profile_fingerprint = settings["fingerprint"]
        self.max_output = min(settings["max_output"], context - 1)
        self.default_output = settings["default_output"]
        self.cache_mode = cache_mode
        if cache_mode == "native" and not settings["native_cache"]:
            raise ValueError("Native cache is not enabled for this model profile")
        self.cache = ConversationCache(cache_mode == "native", cache_ttl)
        self.runtime_version = settings["runtime_version"]
        self.worker_log_mode = worker_log_mode
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        # The native runtime can emit arbitrary diagnostics, including input/output.
        # Its protocol stdout is a separate pipe retained by worker.cpp.
        self.log = (
            (root / "logs/worker.log").open("ab", buffering=0)
            if worker_log_mode == "raw" else None
        )
        env = {**os.environ, "LD_LIBRARY_PATH": str(runtime), "RKLLM_LOG_LEVEL": "1"}
        self.process = subprocess.Popen(
            [
                str(root / ("build/rkllm-worker-" + profile)),
                str(model),
                str(context),
                settings["lock"],
                self.prompt_format,
                str(int(settings["thinking"])),
                str(settings["embed_flash"]),
                str(settings["base_domain_id"]),
                str(settings["n_keep"]),
                str(int(settings["native_cache"])),
                str(self.max_output),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log if self.log is not None else subprocess.DEVNULL,
            env=env,
        )
        future = self.executor.submit(self.process.stdout.readline)
        try:
            if future.result(timeout=90) != f"READY {WORKER_PROTOCOL}\n".encode():
                raise RuntimeError("Model worker failed to start; see logs/worker.log")
        except BaseException:
            self.close()
            raise

    def _exchange(self, prompt, tokens, mode):
        data = prompt.encode("utf-8")
        self.process.stdin.write(f"{len(data)} {tokens} {mode}\n".encode() + data)
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Model worker stopped; see logs/worker.log")
        fields = line.split()
        if len(fields) != 8:
            raise RuntimeError("Worker protocol mismatch; rebuild the matching worker")
        code, length, input_tokens, output_tokens = map(int, fields[:4])
        prefill_ms, generate_ms = map(float, fields[4:6])
        kv_before, kv_after = map(int, fields[6:])
        if not 0 <= length <= 1048576:
            raise RuntimeError("Invalid model worker response")
        raw = self.process.stdout.read(length)
        if len(raw) != length or code:
            raise RuntimeError(f"RKLLM inference failed ({code})")
        return (
            raw.decode("utf-8"),
            input_tokens,
            output_tokens,
            {
                "prefill_ms": prefill_ms,
                "generate_ms": generate_ms,
                "kv_before": kv_before,
                "kv_after": kv_after,
            },
        )

    def generate(self, prompt, tokens, cache_context=None, body=None):
        if not self.lock.acquire(blocking=False):
            raise BlockingIOError("Model busy; retry after the current request")
        try:
            if self.process.poll() is not None:
                raise RuntimeError("Model worker unavailable; restart bridge")
            decision = self.cache.begin(cache_context)
            submitted = prompt
            if not decision["reset"]:
                delta_body = {
                    "model": self.model_id,
                    "tools": [],
                    "tool_choice": "none",
                    "messages": body["messages"][decision["message_start"] :],
                }
                submitted, _, _ = prepare(delta_body, self.model_id, self.prompt_format)
                if (
                    decision["native_tokens"] + len(submitted.encode("utf-8")) + tokens + 32
                    > self.context
                ):
                    decision.update(reset=True, reason="native_context_budget")
                    submitted = prompt
            mode = (1 if decision["reset"] else 2) if self.cache.enabled else 0
            future = self.executor.submit(self._exchange, submitted, tokens, mode)
            try:
                raw, inp, out, metrics = future.result(timeout=self.timeout)
                metrics.update(
                    cache_ticket=decision["ticket"],
                    cache_reset=decision["reset"],
                    cache_reason=decision["reason"],
                    cache_mode=self.cache_mode,
                    submitted_bytes=len(submitted.encode("utf-8")),
                )
                return raw, inp, out, metrics
            except concurrent.futures.TimeoutError as error:
                self.process.kill()
                self.process.wait()
                self.cache.invalidate(decision["ticket"])
                raise TimeoutError("Inference timeout; worker stopped. Restart bridge.") from error
            except BaseException:
                self.cache.invalidate(decision["ticket"])
                raise
        finally:
            self.lock.release()

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.executor.shutdown(wait=False, cancel_futures=True)
        if self.log is not None:
            self.log.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "RKOpenCodeBridge/0.1"

    def log_message(self, fmt, *args):
        if getattr(self, "_privacy_metadata_only", False):
            return
        print(time.strftime("%Y-%m-%dT%H:%M:%S"), fmt % args, flush=True)

    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if getattr(self, "_privacy_metadata_only", False):
            self.send_header("X-RK-Privacy", "metadata-only")
        self.end_headers()
        self.wfile.write(data)

    def error(self, status, text, kind="invalid_request_error"):
        if getattr(self, "_privacy_metadata_only", False):
            text = "Private request failed; inspect the error code"
        self.reply(status, {"error": {"message": text, "type": kind, "code": kind}})

    def authorized(self):
        # No browser cross-origin access; only authenticated local processes.
        if self.headers.get("Origin"):
            self.error(403, "Browser cross-origin requests are disabled")
            return False
        if not hmac.compare_digest(
            self.headers.get("Authorization", ""), "Bearer " + self.server.api_key
        ):
            self.error(401, "Missing or invalid local API key")
            return False
        return True

    def do_GET(self):
        if not self.authorized():
            return
        if self.path == "/health":
            alive = self.server.worker.process.poll() is None
            return self.reply(
                200 if alive else 503,
                {
                    "ready": alive,
                    "model": getattr(self.server.worker, "model_id", MODEL_ID),
                    "runtime": getattr(self.server.worker, "runtime_version", "1.3.1"),
                    "context": self.server.worker.context,
                    "cache_mode": getattr(self.server.worker, "cache_mode", "off"),
                    "worker_protocol": WORKER_PROTOCOL,
                    "profile": getattr(self.server.worker, "profile", "deepseek"),
                    "profile_fingerprint": getattr(self.server.worker, "profile_fingerprint", None),
                    "prompt_format": getattr(self.server.worker, "prompt_format", "deepseek-r1"),
                    "max_output": getattr(self.server.worker, "max_output", 2048),
                    "privacy_metadata_only": (
                        getattr(self.server.worker, "worker_log_mode", "metadata-only")
                        == "metadata-only"
                    ),
                },
            )
        if self.path == "/v1/models":
            return self.reply(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": getattr(self.server.worker, "model_id", MODEL_ID),
                            "object": "model",
                            "created": 0,
                            "owned_by": "local-rkllm",
                        }
                    ],
                },
            )
        self.error(404, "Unknown endpoint")

    def do_POST(self):
        # Any supplied privacy header suppresses content, including malformed values.
        privacy_header = self.headers.get("X-RK-Privacy")
        self._privacy_metadata_only = privacy_header is not None
        if not self.authorized():
            return
        if self.path != "/v1/chat/completions":
            return self.error(404, "Unknown endpoint")
        request_id = uuid.uuid4().hex
        started = time.monotonic()
        record = {"id": request_id, "started_at": time.time()}
        metrics = {}
        discarded = False

        def discard_cache():
            nonlocal discarded
            if not discarded and metrics and hasattr(self.server.worker, "cache"):
                self.server.worker.cache.invalidate(metrics["cache_ticket"])
                discarded = True

        try:
            if privacy_header is not None and privacy_header != "metadata-only":
                raise InvalidRequest("Unsupported X-RK-Privacy mode")
            if self._privacy_metadata_only and (
                getattr(self.server.worker, "worker_log_mode", "metadata-only")
                != "metadata-only"
            ):
                raise InvalidRequest("Private requests require metadata-only worker diagnostics")
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                raise InvalidRequest("Content-Type must be application/json")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 262144:
                raise InvalidRequest("Request body must be 1..262144 bytes")
            self.connection.settimeout(300)
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise InvalidRequest("Request must be an object")
            model_id = getattr(self.server.worker, "model_id", MODEL_ID)
            prompt_format = getattr(
                self.server.worker, "prompt_format",
                "deepseek-r1" if model_id == MODEL_ID else "embedded",
            )
            prompt, tools, choice = prepare(body, model_id, prompt_format)
            tokens = body.get("max_completion_tokens", body.get(
                "max_tokens", getattr(self.server.worker, "default_output", 512)
            ))
            maximum = getattr(self.server.worker, "max_output", 2048)
            if (
                isinstance(tokens, bool) or not isinstance(tokens, int)
                or not 1 <= tokens <= maximum
            ):
                raise InvalidRequest(f"max_tokens must be between 1 and {maximum}")
            # Conservative byte bound: no silent truncation of system instructions or tool results.
            if len(prompt.encode("utf-8")) + tokens + 32 > self.server.worker.context:
                raise InvalidRequest(
                    "Prompt exceeds conservative context budget; "
                    "shorten input or start a new session"
                )
            record.update(prompt_bytes=len(prompt.encode("utf-8")), tools=list(tools))
            cache_context = request_context(
                body,
                self.headers.get("x-opencode-session-id") or self.headers.get("X-RK-Session-ID"),
                self.headers.get("X-RK-Cache", "auto"),
            )
            record["session_tag"] = digest(cache_context.session)[:16] if cache_context else None
            raw, input_tokens, output_tokens, metrics = self.server.worker.generate(
                prompt, tokens, cache_context, body
            )
            record.update(
                raw_model_output=raw, input_tokens=input_tokens, output_tokens=output_tokens
            )
            record["inference"] = metrics
            if prompt_format == "deepseek-r1" and "</think>" not in raw:
                raise InvalidModelOutput(
                    "Model stopped before completing its prefixed reasoning segment"
                )
            message, finish = decode(raw, tools, choice)
            if output_tokens >= tokens and finish != "tool_calls":
                finish = "length"
            record.update(message=message, finish_reason=finish)
            if hasattr(self.server.worker, "cache"):
                if finish != "length" and output_tokens < tokens:
                    self.server.worker.cache.commit(
                        metrics["cache_ticket"], message, metrics["kv_after"]
                    )
                else:
                    self.server.worker.cache.invalidate(metrics["cache_ticket"])
            cached_tokens = metrics.get("kv_before", 0)
            usage = {
                "prompt_tokens": input_tokens + cached_tokens,
                "completion_tokens": output_tokens,
                "total_tokens": input_tokens + cached_tokens + output_tokens,
                "prompt_tokens_details": {"cached_tokens": cached_tokens},
            }
            base = {"id": "chatcmpl-" + request_id, "created": int(time.time()), "model": model_id}
            if body.get("stream", False):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                if self._privacy_metadata_only:
                    self.send_header("X-RK-Privacy", "metadata-only")
                self.end_headers()
                # Buffered SSE: never present incomplete reasoning as an executable tool call.
                delta = dict(message)
                if "tool_calls" in delta:
                    delta["tool_calls"] = [
                        dict(call, index=i) for i, call in enumerate(delta["tool_calls"])
                    ]
                chunks = [
                    dict(
                        base,
                        object="chat.completion.chunk",
                        choices=[{"index": 0, "delta": delta, "finish_reason": None}],
                    ),
                    dict(
                        base,
                        object="chat.completion.chunk",
                        choices=[{"index": 0, "delta": {}, "finish_reason": finish}],
                        usage=usage,
                    ),
                ]
                for chunk in chunks:
                    self.wfile.write(
                        ("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode()
                    )
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                self.close_connection = True
            else:
                self.reply(
                    200,
                    dict(
                        base,
                        object="chat.completion",
                        choices=[{"index": 0, "message": message, "finish_reason": finish}],
                        usage=usage,
                    ),
                )
        except BlockingIOError as error:
            record["error"] = str(error)
            record["error_code"] = "model_busy"
            self.error(429, str(error), "model_busy")
        except (InvalidRequest, ValueError, KeyError, TypeError) as error:
            record["error"] = str(error)
            discard_cache()
            if isinstance(error, InvalidModelOutput):
                record["error_code"] = "invalid_model_output"
                self.error(422, str(error), "invalid_model_output")
            else:
                record["error_code"] = "invalid_request_error"
                self.error(400, str(error))
        except TimeoutError as error:
            record["error"] = str(error)
            record["error_code"] = "inference_timeout"
            self.error(504, str(error), "inference_timeout")
        except (BrokenPipeError, ConnectionResetError):
            record["error"] = "client disconnected"
            record["error_code"] = "client_disconnected"
        except RuntimeError as error:
            record["error"] = str(error)
            record["error_code"] = "model_unavailable"
            self.error(503, str(error), "model_unavailable")
        finally:
            if record.get("error"):
                discard_cache()
            record["elapsed_seconds"] = round(time.monotonic() - started, 3)
            if self._privacy_metadata_only:
                record = metadata_record(record)
            with self.server.record_lock, self.server.records.open("a", encoding="utf-8") as log:
                log.write(json.dumps(record, ensure_ascii=False) + "\n")


def stop_on_signal(*_):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--context", type=int, help="Bounded by the selected model profile")
    parser.add_argument("--port", type=int, default=8088)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--profile", default=os.environ.get("RK_AGENT_PROFILE", "qwen35-4b"))
    parser.add_argument("--cache-mode", choices=["off", "native"])
    parser.add_argument("--cache-ttl", type=int, default=300)
    parser.add_argument(
        "--worker-log-mode", choices=["metadata-only", "raw"], default="metadata-only",
        help="Native diagnostics are discarded by default; raw disables private requests",
    )
    args = parser.parse_args()
    overrides = dict(os.environ)
    for field, value in (
        ("RKLLM_MODEL", args.model), ("RKLLM_RUNTIME", args.runtime),
        ("RKLLM_CONTEXT", args.context), ("RK_AGENT_CACHE_MODE", args.cache_mode),
    ):
        if value is not None:
            overrides[field] = str(value)
    try:
        settings = load_profile(args.profile, environ=overrides)
        check_assets(settings)
    except (OSError, ValueError, KeyError) as error:
        parser.error(str(error))
    if not 1 <= args.cache_ttl <= 3600:
        parser.error("Cache TTL must be in 1..3600 seconds")
    root = Path(__file__).resolve().parents[1]
    (root / "logs").mkdir(exist_ok=True)
    key_path = root / ".runtime/api-key"
    key = key_path.read_text().strip()
    if len(key) < 32:
        raise ValueError("Local API key missing or too short")
    worker = Worker(
        root,
        Path(settings["model"]),
        Path(settings["runtime"]),
        settings["context"],
        args.timeout,
        args.profile,
        settings["cache_mode"],
        args.cache_ttl,
        args.worker_log_mode,
        settings=settings,
    )
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
        server.worker, server.api_key = worker, key
        server.records, server.record_lock = root / "logs/requests.jsonl", threading.Lock()
        signal.signal(signal.SIGTERM, stop_on_signal)
        print(
            f"Ready: http://127.0.0.1:{args.port}, model={worker.model_id}, context={worker.context}",
            flush=True,
        )
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    finally:
        worker.close()


if __name__ == "__main__":
    main()
