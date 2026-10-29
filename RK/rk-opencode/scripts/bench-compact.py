"""Board benchmark with automatic observations and exactly three requested decisions."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import signal
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
sys.path.insert(0, str(ROOT / "scripts"))
from compact import run_task  # noqa: E402
from desktop import DesktopTools  # noqa: E402
from importlib import import_module  # noqa: E402

lines = import_module("bench-agent").lines


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", args.run_id):
        parser.error("Invalid run id")
    folder = ROOT / "logs" / ("testbench-" + args.run_id)
    config = json.loads((folder / "agent-input.json").read_text())
    key = (ROOT / ".runtime/api-key").read_text().strip()
    session = "compact-" + args.run_id
    status = {"run_id": args.run_id, "runner": "compact", "timed_out": False, "session_id": session}
    started = time.perf_counter()
    request_count = 0

    def emit(event):
        event["elapsed_seconds"] = time.perf_counter() - started
        with (folder / "agent-trace.jsonl").open("a", encoding="utf-8") as output:
            output.write(json.dumps(event, ensure_ascii=False) + "\n")
        if event["type"] in ("decision_start", "complete"):
            print(json.dumps(event), flush=True)

    def model(messages, tool):
        nonlocal request_count
        request_count += 1
        body = {
            "model": "qwen35-4b-rkllm",
            "messages": messages,
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool["description"],
                        "parameters": tool["inputSchema"],
                    },
                }
            ],
            "tool_choice": "required",
            "max_tokens": 128,
        }
        (folder / f"request-{request_count}.json").write_text(
            json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        if request_count == 1:
            (folder / "prompt.txt").write_text(
                json.dumps(messages, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        request = urllib.request.Request(
            "http://127.0.0.1:8088/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + key,
                "X-RK-Session-ID": session,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                value = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode("utf-8", errors="replace")) from error
        (folder / f"response-{request_count}.json").write_text(
            json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return value["choices"][0]["message"]

    def timeout(*_):
        raise TimeoutError("Compact benchmark timed out")

    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(args.timeout)
    (folder / "prompt.txt").touch()
    (folder / "agent-trace.jsonl").touch()
    try:
        status.update(run_task(DesktopTools(ROOT), model, emit), exit_code=0)
    except Exception as error:
        status.update(
            passed=False, exit_code=1, error=str(error), timed_out=isinstance(error, TimeoutError)
        )
        emit({"type": "error", "error": str(error)})
    finally:
        signal.alarm(0)
        status.update(agent_seconds=time.perf_counter() - started, model_decisions=request_count)
        tag = hashlib.sha256(json.dumps(session, separators=(",", ":")).encode()).hexdigest()[:16]
        # The server appends its record immediately after responding; allow the final flush.
        for _ in range(50):
            requests = [
                r for r in lines(ROOT / "logs/requests.jsonl") if r.get("session_tag") == tag
            ]
            if len(requests) >= request_count:
                break
            time.sleep(0.02)
        actions = [
            r
            for r in lines(ROOT / "logs/desktop-actions.jsonl")
            if r.get("session_id") == config["desktop_session_id"]
        ]
        for name, records in (("model-requests.jsonl", requests), ("hid-actions.jsonl", actions)):
            (folder / name).write_text(
                "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records), encoding="utf-8"
            )
        status["model_requests"] = len(requests)
        (folder / "agent-status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
        print(json.dumps(status), flush=True)


if __name__ == "__main__":
    main()
