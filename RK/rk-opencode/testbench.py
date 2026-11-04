"""Windows end-to-end OCR / RK3588 model / physical USB HID benchmark."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.request

from bench_report import summarize
from host import ROOT, REMOTE, connect, command, hid_action
from model_profiles import load_profile


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def pc_request(path, body=None):
    key = (ROOT / ".runtime/desktop-key").read_text().strip()
    request = urllib.request.Request(
        "http://127.0.0.1:8091" + path,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def wait_for(check, timeout, process=None):
    deadline = time.perf_counter() + timeout
    while time.perf_counter() < deadline:
        if process and process.poll() is not None:
            raise RuntimeError(f"Child process exited early ({process.returncode})")
        value = check()
        if value:
            return value
        time.sleep(0.2)
    raise TimeoutError("Timed out waiting for testbench readiness")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--perception", choices=("ocr", "hybrid"), default="ocr")
    parser.add_argument(
        "--runner", choices=("compact", "opencode", "opencode-fast"), default="opencode-fast"
    )
    parser.add_argument(
        "--code", help="Optional fixed 8-digit fixture input for repeatable comparisons"
    )
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--profile", default="qwen35-4b")
    parser.add_argument("--ocr-repeats", type=int, choices=range(1, 21), default=7)
    parser.add_argument("--wait-start", action="store_true", help="Wait for <run>/start.signal")
    parser.add_argument("--enable-hid", action="store_true", help="Configure USB HID if absent")
    args = parser.parse_args()
    profile = load_profile(args.profile)
    model_env = "RK_AGENT_PROFILE=" + shlex.quote(args.profile) + " "
    if args.code and (len(args.code) != 8 or not args.code.isascii() or not args.code.isdigit()):
        parser.error("--code must contain exactly 8 ASCII digits")
    if os.name != "nt":
        parser.error("Run on the Windows PC attached to the board")
    try:
        with socket.create_connection(("127.0.0.1", 8091), timeout=1):
            parser.error("A PC companion is already running on 8091; stop that session first")
    except OSError:
        pass
    run_id = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)
    folder = ROOT / "logs" / ("testbench-" + run_id)
    folder.mkdir(parents=True, exist_ok=False)
    title = "RK Agent Bench " + run_id
    manifest = {
        "run_id": run_id,
        "title": title,
        "code": args.code if args.code else f"{secrets.randbelow(100000000):08d}",
        "perception": args.perception,
        "runner": args.runner,
        "model_profile": args.profile,
        "source_sha256": {},
    }
    for name in (
        "pc/observer.py",
        "pc/observations.py",
        "pc/AgentLab.cs",
        "agent/desktop.py",
        "agent/compact.py",
        "agent/fast_desktop.py",
        "agent/mcp_server.py",
        "agent/hid.py",
        "bridge/server.py",
        "src/worker.cpp",
        "opencode-qwen.json",
        "model_profiles.py",
        "testbench.py",
        "bench_report.py",
        "scripts/bench-agent.py",
        "scripts/bench-compact.py",
        "plugins/desktop-fast.mjs",
    ):
        manifest["source_sha256"][name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    for name in ("model-profiles/" + args.profile + ".json", profile["agent_config"]):
        manifest["source_sha256"][name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    write_json(folder / "manifest.json", manifest)
    print("TESTBENCH_DIR=" + str(folder), flush=True)
    print("Allowed test window: " + title, flush=True)
    setup_start = time.perf_counter()
    companion, fixture, client = None, None, None
    started_model = False
    task_start = None
    stop = ROOT / ".runtime/desktop-stop"
    try:
        client = connect()
        _, stdout, _ = client.exec_command("test -w /dev/hidg0 && test -w /dev/hidg1")
        if stdout.channel.recv_exit_status():
            if not args.enable_hid:
                raise RuntimeError("USB HID is not ready; rerun with --enable-hid")
            client.close()
            hid_action("hid-enable")
            client = connect()
        # Do not start a second NPU model over another application's worker.
        _, stdout, _ = client.exec_command(
            "cd " + shlex.quote(REMOTE) + " && " + model_env
            + "python3 scripts/check-health.py >/dev/null 2>&1"
        )
        started_model = stdout.channel.recv_exit_status() != 0
        if started_model:
            _, stdout, _ = client.exec_command(
                "ps -eo comm= | grep -E 'rkllm|qwen35|llm_demo' || true"
            )
            running = stdout.read().decode().strip()
            if running:
                started_model = False
                raise RuntimeError("Another NPU model process is present: " + running)
            tick = time.perf_counter()
            command(
                client, "cd " + shlex.quote(REMOTE) + " && " + model_env + "bash scripts/start.sh"
            )
            manifest["model_start_seconds"] = time.perf_counter() - tick
        manifest["started_model"] = started_model
        compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
        executable = folder / "RKAgentBench.exe"
        subprocess.run(
            [
                str(compiler),
                "/nologo",
                "/target:winexe",
                "/out:" + str(executable),
                "/reference:System.Windows.Forms.dll",
                "/reference:System.Drawing.dll",
                "/reference:System.Web.Extensions.dll",
                str(ROOT / "pc/AgentLab.cs"),
            ],
            check=True,
        )
        write_json(
            folder / "fixture-config.json",
            {"folder": str(folder), "title": title, "code": manifest["code"]},
        )
        companion_log = (folder / "companion.log").open("w", encoding="utf-8")
        companion = subprocess.Popen(
            [
                sys.executable,
                "-u",
                str(ROOT / "desktop_host.py"),
                "--title",
                title,
                "--ocr",
                "--execute-hid",
                "--perception",
                args.perception,
                "--observer-dir",
                str(folder / "observer"),
                "--fixture-state",
                str(folder / "fixture-state.json"),
            ],
            stdout=companion_log,
            stderr=companion_log,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )

        def session_ready():
            try:
                value = json.loads((ROOT / ".runtime/desktop-session.json").read_text())
                return value if value.get("window") == title and value.get("execute_hid") else None
            except (OSError, ValueError):
                return None

        session = wait_for(session_ready, 90, companion)
        manifest["observer_health"] = pc_request("/health")
        manifest["setup_seconds"] = time.perf_counter() - setup_start
        tick = time.perf_counter()
        fixture = subprocess.Popen([str(executable), str(folder / "fixture-config.json")])
        wait_for(lambda: (folder / "fixture-state.json").exists(), 15, fixture)
        manifest["window_open_ms"] = (time.perf_counter() - tick) * 1000
        print("Fixture ready. Keep this test window foreground during the task.", flush=True)
        if args.wait_start:
            print("Waiting for " + str(folder / "start.signal"), flush=True)
            wait_for(lambda: (folder / "start.signal").exists(), 600, fixture)
        else:
            time.sleep(1)
        write_json(folder / "manifest.json", manifest)
        remote_folder = REMOTE + "/logs/testbench-" + run_id
        command(client, "mkdir -p " + shlex.quote(remote_folder))
        with client.open_sftp() as sftp:
            for name, expected in manifest["source_sha256"].items():
                with sftp.open(REMOTE + "/" + name, "rb") as source:
                    actual = hashlib.sha256(source.read()).hexdigest()
                if actual != expected:
                    raise RuntimeError("Board source differs; deploy first: " + name)
            with sftp.open(remote_folder + "/agent-input.json", "w") as output:
                output.write(json.dumps({"desktop_session_id": session["session_id"]}))
        task_start = time.perf_counter()

        def watch_fixture():
            fixture.wait()
            if not manifest.get("harness_cleanup_required"):
                manifest["task_to_window_exit_seconds"] = time.perf_counter() - task_start

        watcher = threading.Thread(target=watch_fixture, daemon=True)
        watcher.start()
        command(
            client,
            "cd "
            + shlex.quote(REMOTE)
            + " && " + model_env + "python3 scripts/"
            + ("bench-compact.py" if args.runner == "compact" else "bench-agent.py")
            + " --run-id "
            + shlex.quote(run_id)
            + " --timeout "
            + str(args.timeout)
            + (" --fast" if args.runner == "opencode-fast" else ""),
        )
        # Post-task profiling deliberately excludes the live agent's duration.
        try:
            write_json(
                folder / "ocr-warm.json", pc_request("/profile-ocr", {"repeats": args.ocr_repeats})
            )
        except (OSError, ValueError) as error:
            manifest["ocr_profile_error"] = str(error)
        with client.open_sftp() as sftp:
            for name in (
                "agent-status.json",
                "model-requests.jsonl",
                "hid-actions.jsonl",
                "prompt.txt",
                "agent-input.json",
            ) + (
                ("agent-trace.jsonl",)
                if args.runner == "compact"
                else (
                    (
                        "opencode.jsonl",
                        "opencode.stderr",
                        "agent-trace.jsonl",
                        "opencode-export.json",
                    )
                    if args.runner == "opencode-fast"
                    else ("opencode.jsonl", "opencode.stderr")
                )
            ):
                sftp.get(remote_folder + "/" + name, str(folder / name))
            if args.runner == "compact":
                for name in sftp.listdir(remote_folder):
                    if name.startswith(("request-", "response-")) and name.endswith(".json"):
                        sftp.get(remote_folder + "/" + name, str(folder / name))
        if fixture.poll() is not None:
            watcher.join(timeout=1)
        manifest["fixture_exit_code"] = fixture.poll()
    except Exception as error:
        manifest["error"] = str(error)
        print("Testbench error: " + str(error), flush=True)
    finally:
        # Preserve whether the agent closed it before any harness cleanup.
        if fixture and fixture.poll() is None:
            manifest["harness_cleanup_required"] = True
            fixture.terminate()
            fixture.wait(timeout=5)
        if companion:
            stop.touch()
            try:
                companion.wait(timeout=10)
            except subprocess.TimeoutExpired:
                companion.terminate()
                companion.wait(timeout=5)
                manifest["companion_forced_stop"] = True
            companion_log.close()
        if client:
            if started_model:
                try:
                    command(client, "cd " + shlex.quote(REMOTE) + " && bash scripts/stop-model.sh")
                except Exception as error:
                    manifest["model_cleanup_error"] = str(error)
            client.close()
        write_json(folder / "manifest.json", manifest)
    result = summarize(folder)
    print(
        json.dumps(
            {
                "passed": result["passed"],
                "agent_seconds": result["agent_seconds"],
                "checks": result["checks"],
                "report": str(folder / "report.md"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
