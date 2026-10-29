"""Real model + OpenCode + PC observer test, optionally including physical USB HID."""

import argparse
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
from desktop import DesktopTools  # noqa: E402 - locate the adjacent board-side module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hid", action="store_true")
    parser.add_argument(
        "--expected", help="Verifier-only expected lab code; never put into the model prompt"
    )
    args = parser.parse_args()
    if args.hid and not args.expected:
        parser.error("--hid requires --expected for independent verification")
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime(
        "%Y%m%d-%H%M%S"
    )
    folder = ROOT / "logs" / ("desktop-" + ("hid-" if args.hid else "plan-") + stamp)
    folder.mkdir(parents=True, exist_ok=False)
    prompt = (
        "Observe RK Agent Lab. Read the Code label. Input is currently focused and empty. "
        "Type only that code into Input using act type, then observe. "
        "Click Apply using the new observation, then observe to verify Applied equals the code. "
        "Do not store this temporary code in memory. Finish after verification."
        if args.hid
        else "Observe RK Agent Lab and plan a click on Apply using act click. "
        "This session is plan only. After the tool returns planned, report it and stop. "
        "Do not claim a click was actually sent."
    )
    status = {"mode": "hid" if args.hid else "plan", "prompt": prompt, "status": "running"}
    stdout_log = (folder / "opencode.jsonl").open("w", encoding="utf-8")
    stderr_log = (folder / "opencode.stderr").open("w", encoding="utf-8")
    process = subprocess.Popen(
        [
            "bash",
            str(ROOT / "scripts/opencode.sh"),
            "run",
            "--format",
            "json",
            "--agent",
            "rk-desktop",
            prompt,
        ],
        cwd=ROOT,
        stdout=stdout_log,
        stderr=stderr_log,
        text=True,
        start_new_session=True,
    )
    try:
        process.wait(timeout=600)
        stdout_log.flush()
        stderr_log.flush()
        status["exit_code"] = process.returncode
        stdout = (folder / "opencode.jsonl").read_text(encoding="utf-8")
        events = []
        for line in stdout.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
        calls = [
            e["part"]["state"]
            for e in events
            if e.get("type") == "tool_use"
            and e.get("part", {}).get("tool") == "rk_desktop_desktop"
            and e["part"].get("state", {}).get("status") == "completed"
        ]
        actions = [x for x in calls if x.get("input", {}).get("op") == "act"]
        observed = DesktopTools(ROOT).call({"op": "observe"})
        (folder / "final-observation.json").write_text(
            json.dumps(observed, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        output = "\n".join(str(x.get("output", "")) for x in actions)
        status.update(
            exit_code=process.returncode,
            completed_tool_calls=len(calls),
            action_calls=len(actions),
            status="completed",
        )
        if args.hid:
            status["observed_application_result"] = any(
                x["name"] == "Applied: " + args.expected for x in observed["targets"]
            )
            last_action = max(
                (i for i, call in enumerate(calls) if call.get("input", {}).get("op") == "act"),
                default=-1,
            )
            status["agent_observed_application_result"] = any(
                call.get("input", {}).get("op") == "observe"
                and "Applied: " + args.expected in str(call.get("output", ""))
                for call in calls[last_action + 1 :]
            )
            status["passed"] = (
                process.returncode == 0
                and len(actions) >= 2
                and "input_sent" in output
                and status["observed_application_result"]
                and status["agent_observed_application_result"]
            )
        else:
            status["plan_returned"] = "planned" in output
            status["input_sent"] = "input_sent" in output
            status["passed"] = (
                process.returncode == 0
                and bool(actions)
                and status["plan_returned"]
                and not status["input_sent"]
            )
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        status["exit_code"] = process.returncode
        status.update(status="timed_out", passed=False)
    except (OSError, ValueError, RuntimeError) as error:
        status.update(status="failed", passed=False, error=str(error))
    finally:
        stdout_log.close()
        stderr_log.close()
        (folder / "status.json").write_text(
            json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (ROOT / "logs/desktop-status.json").write_text(
            json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    print(json.dumps(status, ensure_ascii=False))
    raise SystemExit(0 if status.get("passed") else 1)


if __name__ == "__main__":
    main()
