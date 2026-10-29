"""Board-side OpenCode benchmark; no expected challenge value is sent to the model."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def lines(path):
    if not path.exists():
        return []
    result = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            result.append(json.loads(line))
        except ValueError:
            pass
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--fast", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", args.run_id):
        parser.error("Invalid run id")
    folder = ROOT / "logs" / ("testbench-" + args.run_id)
    config = json.loads((folder / "agent-input.json").read_text())
    status = {
        "run_id": args.run_id,
        "timed_out": False,
        "runner": "opencode-fast" if args.fast else "opencode",
    }
    prompt = (
        "Observe the test window. Read the Code label. Input is currently focused and empty. "
        "Type only that code into Input using act type, then observe. "
        "Click Apply using the new observation, then observe to verify Applied equals the code. "
        "After verifying Applied, close the window using act hotkey keys ALT+F4. "
        "Observe again to verify window_open is false, then finish."
    )
    if args.fast:
        prompt = (
            "Complete the test window task. Read the supplied Code. Input is focused and empty. "
            "Use rk_desktop_fast_step to type only the Code in text, click the current Apply target, "
            "then after Applied is verified send hotkey keys ALT+F4. "
            "Observations arrive automatically after each action. "
            "When task_verified_complete is true, report completion briefly and stop."
        )
        (folder / "agent-trace.jsonl").touch()
    (folder / "prompt.txt").write_text(prompt, encoding="utf-8")
    started = time.perf_counter()
    last_progress = 0
    with (
        (folder / "opencode.jsonl").open("w") as output,
        (folder / "opencode.stderr").open("w") as errors,
    ):
        process = subprocess.Popen(
            [
                "bash",
                str(ROOT / "scripts/opencode.sh"),
                "run",
                "--format",
                "json",
                "--agent",
                "rk-testbench-fast" if args.fast else "rk-testbench",
                prompt,
            ],
            cwd=ROOT,
            stdout=output,
            stderr=errors,
            start_new_session=True,
            env={**os.environ, **({"RK_DESKTOP_BENCH_DIR": str(folder)} if args.fast else {})},
        )
        try:
            while process.poll() is None:
                try:
                    process.wait(
                        timeout=min(1, max(0.1, args.timeout - (time.perf_counter() - started)))
                    )
                except subprocess.TimeoutExpired:
                    elapsed = time.perf_counter() - started
                    if elapsed >= args.timeout:
                        status["timed_out"] = True
                        break
                    events = lines(folder / "opencode.jsonl")
                    calls = [x for x in events if x.get("type") == "tool_use"]
                    if args.fast and any(
                        x.get("type") == "error"
                        or x.get("part", {}).get("state", {}).get("status") == "error"
                        for x in events
                    ):
                        status["stopped_after_tool_error"] = True
                        break
                    if elapsed - last_progress >= 20:
                        last_progress = elapsed
                        print(
                            json.dumps(
                                {"progress_seconds": round(elapsed, 1), "tool_events": len(calls)}
                            ),
                            flush=True,
                        )
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
    status.update(exit_code=process.returncode, agent_seconds=time.perf_counter() - started)
    events = lines(folder / "opencode.jsonl")
    sessions = {e.get("sessionID") for e in events if e.get("sessionID")}
    if args.fast and len(sessions) == 1:
        try:
            exported = subprocess.run(
                ["bash", str(ROOT / "scripts/opencode.sh"), "export", next(iter(sessions))],
                capture_output=True,
                timeout=30,
            )
            (folder / "opencode-export.json").write_bytes(exported.stdout)
            status["export_exit_code"] = exported.returncode
        except subprocess.TimeoutExpired as error:
            (folder / "opencode-export.json").write_bytes(error.stdout or b"")
            status["export_error"] = "Optional session export timed out"
    tags = {
        hashlib.sha256(
            json.dumps(s, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()[:16]
        for s in sessions
    }
    requests = [r for r in lines(ROOT / "logs/requests.jsonl") if r.get("session_tag") in tags]
    actions = [
        r
        for r in lines(ROOT / "logs/desktop-actions.jsonl")
        if r.get("session_id") == config["desktop_session_id"]
    ]
    for name, records in (("model-requests.jsonl", requests), ("hid-actions.jsonl", actions)):
        (folder / name).write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records), encoding="utf-8"
        )
    status.update(
        sessions=sorted(sessions), session_tags=sorted(tags), model_requests=len(requests)
    )
    (folder / "agent-status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    print(json.dumps(status), flush=True)


if __name__ == "__main__":
    main()
