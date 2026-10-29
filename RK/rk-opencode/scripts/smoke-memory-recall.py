"""Verify automatic semantic recall in a real, independent OpenCode/NPU session."""

import datetime
import json
from pathlib import Path
import secrets
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
from memory_client import MemoryClient  # noqa: E402


def main():
    folder = ROOT / "logs" / ("mem0-recall-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    folder.mkdir()
    client = MemoryClient(ROOT)
    token = secrets.token_hex(5)
    key, value = "recall_" + token, "D:\\RK\\archive-" + token
    status = {"passed": False, "folder": str(folder), "expected": value}
    try:
        client.set(key, "星河项目的文件归档目录是 " + value, "preference")
        prompt = "星河项目生成的文件应该归档到哪个文件夹？直接回答已保存的目录即可。"
        started = time.perf_counter()
        result = subprocess.run(
            [
                "bash",
                str(ROOT / "scripts/opencode.sh"),
                "run",
                "--format",
                "json",
                "--agent",
                "rk-local",
                prompt,
            ],
            capture_output=True,
            text=True,
            timeout=240,
        )
        (folder / "opencode.jsonl").write_text(result.stdout, encoding="utf-8")
        (folder / "stderr").write_text(result.stderr, encoding="utf-8")
        events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        answers = "\n".join(
            e.get("part", {}).get("text", "") for e in events if e.get("type") == "text"
        )
        tools = [e for e in events if e.get("type") == "tool_use"]
        sessions = {e["sessionID"] for e in events if e.get("sessionID")}
        status.update(
            exit_code=result.returncode,
            seconds=time.perf_counter() - started,
            answer=answers,
            tool_calls=len(tools),
            actual_value_in_answer=token in answers,
        )
        if len(sessions) == 1:
            exported = subprocess.run(
                ["bash", str(ROOT / "scripts/opencode.sh"), "export", next(iter(sessions))],
                capture_output=True,
                timeout=30,
            )
            (folder / "session.json").write_bytes(exported.stdout)
            status["export_exit_code"] = exported.returncode
            status["recall_in_export"] = (
                b"Relevant stored memories" in exported.stdout and token.encode() in exported.stdout
            )
        status["passed"] = (
            result.returncode == 0
            and token in answers
            and not tools
            and status.get("recall_in_export", False)
        )
    finally:
        client.delete(key)
        (folder / "status.json").write_text(
            json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps(status, ensure_ascii=False))
    raise SystemExit(0 if status["passed"] else 1)


if __name__ == "__main__":
    main()
