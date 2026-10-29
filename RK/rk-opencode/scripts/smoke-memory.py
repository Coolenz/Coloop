"""Real OpenCode/NPU memory test: two independent sessions and selected storage."""

import datetime
import json
from pathlib import Path
import secrets
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
from memory_client import memory_backend  # noqa: E402


def run(prompt, folder, label):
    result = subprocess.run(
        [
            "bash",
            str(ROOT / "scripts/opencode.sh"),
            "run",
            "--format",
            "json",
            "--agent",
            "rk-memory",
            prompt,
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=240,
    )
    (folder / (label + ".jsonl")).write_text(result.stdout, encoding="utf-8")
    (folder / (label + ".stderr")).write_text(result.stderr, encoding="utf-8")
    events = []
    for line in result.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    calls = [
        e["part"]["state"]
        for e in events
        if e.get("type") == "tool_use"
        and e.get("part", {}).get("tool") == "rk_memory_memory"
        and e["part"].get("state", {}).get("status") == "completed"
    ]
    answers = "\n".join(
        e.get("part", {}).get("text", "") for e in events if e.get("type") == "text"
    )
    return result.returncode, calls, answers


def main():
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime(
        "%Y%m%d-%H%M%S"
    )
    folder = ROOT / "logs" / ("memory-" + stamp)
    folder.mkdir(parents=True, exist_ok=False)
    key, token = "smoke_" + secrets.token_hex(3), secrets.token_hex(6)
    store = memory_backend(ROOT)
    status = {"key": key, "status": "running"}
    try:
        code1, calls1, _ = run(
            f'Use rk_memory_memory to set key "{key}" to value "{token}" with kind "task". '
            "After the tool returns, briefly confirm.",
            folder,
            "write",
        )
        record = store.get(key)
        # The second prompt intentionally does not contain the value.
        code2, calls2, answer = run(
            f'Use rk_memory_memory to get key "{key}". Answer with its exact stored value.',
            folder,
            "read-new-session",
        )
        status.update(
            write_exit_code=code1,
            read_exit_code=code2,
            write_tool_completed=bool(calls1),
            read_tool_completed=bool(calls2),
            persisted_value_correct=bool(record and record["value"] == token),
            answer_contains_actual_value=token in answer,
            provenance_correct=bool(
                record and record["source"] == "agent" and not record["verified"]
            ),
        )
        status["passed"] = (
            code1 == code2 == 0
            and bool(calls1)
            and bool(calls2)
            and status["persisted_value_correct"]
            and token in answer
            and status["provenance_correct"]
        )
        status["status"] = "completed"
    except (subprocess.TimeoutExpired, OSError) as error:
        status.update(status="failed", passed=False, error=str(error))
    finally:
        store.delete(key, source="verifier")
        (folder / "status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
        (ROOT / "logs/memory-status.json").write_text(
            json.dumps(status, indent=2), encoding="utf-8"
        )
    print(json.dumps(status))
    raise SystemExit(0 if status.get("passed") else 1)


if __name__ == "__main__":
    main()
