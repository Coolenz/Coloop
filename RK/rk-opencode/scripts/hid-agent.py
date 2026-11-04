"""Native RK desktop Agent; local model + context policy + USB HID, without MCP."""

import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time
import uuid

ROOT = Path(os.environ.get("RK_AGENT_ROOT", Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(ROOT / "agent"))
from hid_agent import DesktopAgent, LocalModel  # noqa: E402
from memory_client import MemoryClient  # noqa: E402


def run_one(goal, verification=None, folder=None):
    folder = folder or ROOT / "logs" / ("hid-agent-" + datetime.datetime.now().strftime(
        "%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4])
    folder = folder.resolve()
    if folder.parent != (ROOT / "logs").resolve() or not folder.name.startswith("hid-agent-"):
        raise ValueError("Use a fresh hid-agent-* directory under this application's logs")
    folder.mkdir(mode=0o700, exist_ok=False)
    status = {"model_finished": False, "task_verified": False, "mcp_used": False,
              "input_backend": "rk_usb_hid", "memory_content_read_or_written": False,
              "samples": [], "runner_pid": os.getpid()}
    stop = threading.Event()
    memory = None
    active = False
    lease = "hid-agent:" + uuid.uuid4().hex

    def save(name, value):
        (folder / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

    def emit(event):
        with (folder / "agent-trace.jsonl").open("a", encoding="utf-8") as output:
            output.write(json.dumps(event, ensure_ascii=False) + "\n")
        print(json.dumps({"event": event["type"], "folder": str(folder)}, ensure_ascii=False), flush=True)

    def abort(*_):
        raise TimeoutError("Agent stopped: signal, 240-second budget or 80C limit")

    def monitor():
        while not stop.wait(1):
            temperatures = [int(p.read_text()) / 1000
                            for p in Path("/sys/class/thermal").glob("thermal_zone*/temp")]
            if temperatures:
                status["samples"].append({"at": time.time(), "max_c": max(temperatures)})
                if max(temperatures) >= 80:
                    os.kill(os.getpid(), signal.SIGTERM)
                    return

    save("task.json", {"goal": goal, "verification": verification})
    agent = model = None
    handlers = {s: signal.getsignal(s) for s in (signal.SIGALRM, signal.SIGTERM)}
    started = time.monotonic()
    try:
        with (ROOT / ".runtime/hid-agent.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            model = LocalModel(ROOT, folder)
            config = ROOT / ".runtime/memory-config.json"
            if config.exists() and json.loads(config.read_text()).get("enabled"):
                memory = MemoryClient(ROOT)
                active = True
                memory.request("/activity", {"session_id": lease, "active": True}, timeout=5)
                memory.request("/ready-for-foreground", {}, timeout=185)
                model.before_request = lambda: memory.request(
                    "/activity", {"session_id": lease, "active": True}, timeout=5)
            for s in handlers:
                signal.signal(s, abort)
            signal.alarm(240)
            threading.Thread(target=monitor, daemon=True).start()
            agent = DesktopAgent(ROOT, model, emit)
            status.update(agent.run(goal, verification))
    except BaseException as error:
        status["error"] = str(error)
    finally:
        signal.alarm(0)
        stop.set()
        for s, handler in handlers.items():
            signal.signal(s, handler)
        if active:
            try:
                memory.request("/activity", {"session_id": lease, "active": False}, timeout=5)
                status["lease_released"] = True
            except Exception as error:
                status["lease_release_error"] = str(error)
        if agent:
            try:
                save("final.raw.json", agent.workflow.snapshot())
            except Exception as error:
                status["final_observation_error"] = str(error)
        ids = set()
        for path in folder.glob("response-*.json"):
            ids.add(json.loads(path.read_text(encoding="utf-8"))["id"].removeprefix("chatcmpl-"))
        records = []
        for line in (ROOT / "logs/requests.jsonl").read_text(encoding="utf-8").splitlines():
            try:
                entry = json.loads(line)
                if entry.get("id") in ids:
                    records.append(entry)
            except ValueError:
                pass
        save("model-metrics.json", records)
        status.update(elapsed_seconds=time.monotonic() - started, model_requests=len(records))
        save("status.json", status)
    print(json.dumps({"folder": str(folder), **{k: status.get(k) for k in (
        "model_finished", "task_verified", "answer", "error", "elapsed_seconds")}}, ensure_ascii=False), flush=True)
    return not status.get("error") and status.get("model_finished") is True and status.get("task_verified") is not False


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--verify-file", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--interactive", action="store_true")
    args = parser.parse_args()
    if args.interactive:
        if args.prompt_file or args.verify_file or args.output_dir:
            parser.error("Interactive mode starts a fresh task/log directory for each message")
        while True:
            try:
                goal = input("RK desktop > ")
            except EOFError:
                return
            if goal.strip().lower() in ("exit", "quit"):
                return
            if goal.strip():
                run_one(goal)
    else:
        if not args.prompt_file:
            parser.error("Provide --prompt-file or --interactive")
        verified = json.loads(args.verify_file.read_text(encoding="utf-8")) if args.verify_file else None
        raise SystemExit(0 if run_one(args.prompt_file.read_text(encoding="utf-8"), verified, args.output_dir) else 1)


if __name__ == "__main__":
    main()
