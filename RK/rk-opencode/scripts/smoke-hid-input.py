"""Controlled Windows fixture -> observation/tunnel -> RK USB HID -> event verification.

No model, clipboard, software input, gadget reconfiguration or automatic replay.
"""

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

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from host import connect, REMOTE  # noqa: E402

SOURCES = ["agent/hid.py", "agent/desktop.py", "agent/compact.py", "scripts/hid-act.py",
           "tests/test_hid.py", "tests/test_desktop.py", "tests/test_observations.py",
           "pc/observations.py"]


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def wait_for(check, timeout=15):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise TimeoutError("Fixture/companion readiness or effect not observed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", required=True)
    parser.add_argument("--deploy", action="store_true", help="Back up and deploy scoped executor sources")
    runners = parser.add_mutually_exclusive_group()
    runners.add_argument("--model", action="store_true", help="Test the preloaded skill with real OpenCode/NPU")
    runners.add_argument("--protocol", action="store_true", help="Test real MCP/USB/value return without NPU")
    runners.add_argument("--direct", action="store_true", help="Test board-local CLI/USB/value return without MCP or NPU")
    parser.add_argument("--wait-start", action="store_true", help="Wait for start.signal after fixture activation")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    folder = args.output_dir.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    for port in (8091,):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                raise RuntimeError("Existing desktop session; refusing to replace it")
        except OSError:
            pass
    result = {"passed": False, "actions": [], "source_sha256": {}, "model_used": False,
              "mcp_used": args.model or args.protocol,
              "input_backend": "rk_usb_hid", "pc_role": "observation_and_validation"}
    for name in SOURCES + ["pc/observer.py", "pc/HIDLab.cs", "scripts/smoke-hid-input.py",
                           "scripts/smoke-hid-skill-model.py", "opencode-qwen.json",
                           "skills/rk-hid-desktop/SKILL.md"]:
        result["source_sha256"][name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    fixture = companion = client = None
    log = (folder / "companion.log").open("w", encoding="utf-8")
    stop = ROOT / ".runtime/desktop-stop"
    try:
        client = connect()
        if args.deploy:
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)
            backup = REMOTE + "/.runtime/hid-backup-" + stamp
            result["board_backup"] = backup
            with client.open_sftp() as sftp:
                sftp.mkdir(backup)
                for name in SOURCES:
                    data = (ROOT / name).read_bytes()
                    digest = hashlib.sha256(data).hexdigest()
                    result["source_sha256"][name] = digest
                    remote = REMOTE + "/" + name
                    try:
                        with sftp.open(remote, "rb") as old:
                            old_data = old.read()
                        with sftp.open(backup + "/" + name.replace("/", "__"), "wb") as out:
                            out.write(old_data)
                    except FileNotFoundError:
                        pass
                    with sftp.open(remote + ".pending", "wb") as out:
                        out.write(data)
                    with sftp.open(remote + ".pending", "rb") as check:
                        if hashlib.sha256(check.read()).hexdigest() != digest:
                            raise RuntimeError("Uploaded checksum mismatch")
                    sftp.posix_rename(remote + ".pending", remote)
        cmd = ("cd " + shlex.quote(REMOTE) + " && python3 -m unittest discover -s tests -p test_hid.py -v")
        _, out, err = client.exec_command(cmd)
        unit_text = out.read().decode() + err.read().decode()
        (folder / "board-hid-tests.txt").write_text(unit_text, encoding="utf-8")
        result["board_unit_exit"] = out.channel.recv_exit_status()
        if result["board_unit_exit"]:
            raise RuntimeError("Board HID unit tests failed")
        compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
        exe = folder / "HIDLab.exe"
        built = subprocess.run([str(compiler), "/nologo", "/target:winexe", "/out:" + str(exe),
                                "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
                                "/reference:System.Web.Extensions.dll", str(ROOT / "pc/HIDLab.cs")],
                               capture_output=True, text=True)
        (folder / "compile.txt").write_text(built.stdout + built.stderr, encoding="utf-8")
        if built.returncode:
            raise RuntimeError("Fixture compilation failed")
        fixture = subprocess.Popen([str(exe), str(folder)])
        def state():
            return json.loads((folder / "state.json").read_text(encoding="utf-8-sig"))
        title = wait_for(state)["title"]
        companion = subprocess.Popen([sys.executable, str(ROOT / "desktop_host.py"), "--title", title,
                                      "--execute-hid", "--observer-dir", str(folder / "observer")],
                                     stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)

        def pc(path):
            key = (ROOT / ".runtime/desktop-key").read_text().strip()
            req = urllib.request.Request("http://127.0.0.1:8091" + path,
                                         headers={"Authorization": "Bearer " + key})
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.load(response)

        wait_for(lambda: pc("/health"))
        wait_for(lambda: json.loads((ROOT / ".runtime/desktop-session.json").read_text()).get("window") == title)
        if args.wait_start:
            print("WAIT_START=" + str(folder / "start.signal"), flush=True)
            wait_for(lambda: (folder / "start.signal").exists(), timeout=120)

        def events():
            path = folder / "events.jsonl"
            return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines()] if path.exists() else []

        def act(kind, name=None, *, expect_stop=False, **fields):
            observed = pc("/observe")
            index = len(result["actions"])
            save(folder / f"observation-{index:02d}.json", observed)
            action = {"op": "act", "action": kind, "observation_id": observed["observation_id"], **fields}
            target = None
            if name:
                targets = [t for t in observed["targets"] if t["name"] == name]
                if len(targets) != 1:
                    raise RuntimeError("Expected unique observed target: " + name)
                target = targets[0]
                action["target_id"] = target["id"]
            if kind == "drag":
                action["end_target_id"] = target["id"]
                r, origin = target["rect"], observed["image_origin"]
                action["point"] = [r[0] + 50 - origin[0], r[1] + 100 - origin[1]]
                action["end_point"] = [r[2] - 50 - origin[0], r[1] + 100 - origin[1]]
            before = len(events())
            started = time.monotonic()
            command = "cd " + shlex.quote(REMOTE) + " && python3 scripts/hid-act.py"
            if args.direct:
                command += " --step"
            _, out, err = client.exec_command(command)
            out.channel.sendall(json.dumps(action).encode())
            out.channel.shutdown_write()
            output, error = out.read().decode(), err.read().decode()
            code = out.channel.recv_exit_status()
            time.sleep(0.2)
            entry = {"input": action, "stdout": output, "stderr": error, "exit": code,
                     "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
                     "events": events()[before:], "state": wait_for(state, timeout=3)}
            result["actions"].append(entry)
            save(folder / "summary.json", result)
            if bool(code) != expect_stop:
                raise RuntimeError("Unexpected action outcome: " + kind + ": " + error)
            sent = json.loads(output) if not code else {}
            if args.direct:
                sent = sent.get("action", {})
            if not expect_stop and sent.get("executed") is not True:
                raise RuntimeError("HID input was not sent")
            return entry

        if args.direct:
            token = "HID_DIRECT_" + secrets.token_hex(4)
            entry = act("type", text=token)
            value = json.loads(entry["stdout"])
            received = any(t.get("value") == token
                           for t in value.get("observation", {}).get("targets", []))
            result.update(expected_text=token, application_value=entry["state"]["value"],
                          direct_returned_actual_value=received,
                          passed=received and entry["state"]["value"] == token)
            print(json.dumps({"passed": result["passed"], "folder": str(folder),
                              "mcp_used": False, "model_used": False}))
            raise SystemExit(0 if result["passed"] else 1)

        if args.model or args.protocol:
            token = "HID_SKILL_" + secrets.token_hex(4)
            prompt = (
                "Type exactly " + token + " into the currently focused empty Literal input using "
                "action type and text. Verify the exact value from the returned observation. "
                "Do not click, type again, store memory or close the window. Finish with a final "
                "JSON answer containing the exact verified text."
            )
            result.update(model_used=args.model, protocol_test=args.protocol, prompt=prompt, expected_text=token)
            remote = REMOTE + "/logs/hid-skill-" + folder.name
            _, out, _ = client.exec_command("mkdir -p " + shlex.quote(remote))
            if out.channel.recv_exit_status():
                raise RuntimeError("Cannot create this test's board evidence directory")
            with client.open_sftp() as sftp:
                sftp.put(str(ROOT / "scripts/smoke-hid-skill-model.py"), remote + "/runner.py")
                with sftp.open(remote + "/prompt.txt", "w") as f:
                    f.write(prompt)
            command = ("RK_AGENT_ROOT=" + shlex.quote(REMOTE) + " python3 "
                       + shlex.quote(remote + "/runner.py") + " --output-dir " + shlex.quote(remote)
                       + " --prompt-file " + shlex.quote(remote + "/prompt.txt"))
            if args.protocol:
                command += " --protocol-text " + shlex.quote(token)
            _, out, err = client.exec_command(command)
            out.channel.shutdown_write()
            runner_out, runner_err = out.read().decode(), err.read().decode()
            result["model_exit"] = out.channel.recv_exit_status()
            (folder / "runner.stdout").write_text(runner_out, encoding="utf-8")
            (folder / "runner.stderr").write_text(runner_err, encoding="utf-8")
            with client.open_sftp() as sftp:
                for name in ("native-skill-load.json", "opencode.jsonl", "opencode.stderr", "model-run.json", "protocol.json"):
                    try:
                        sftp.get(remote + "/" + name, str(folder / name))
                    except FileNotFoundError:
                        pass
            if result["model_exit"]:
                raise RuntimeError("Real OpenCode HID skill run failed; see runner.stderr")
            if args.protocol:
                response = json.loads((folder / "protocol.json").read_text(encoding="utf-8"))
                value = json.loads(response["content"][0]["text"])
                received_value = any(t.get("value") == token
                                     for t in value.get("observation", {}).get("targets", []))
                result.update(application_value=wait_for(state)["value"],
                              mcp_received_actual_value=received_value,
                              passed=received_value and wait_for(state)["value"] == token
                                     and value.get("action", {}).get("executed") is True)
                print(json.dumps({"passed": result["passed"], "folder": str(folder), "model_used": False}))
                raise SystemExit(0 if result["passed"] else 1)
            entries = [json.loads(line) for line in (folder / "opencode.jsonl").read_text(encoding="utf-8").splitlines()
                       if line.startswith("{")]
            texts = [e.get("part", {}).get("text", "") for e in entries if e.get("type") == "text"]
            calls = [e for e in entries if e.get("type") == "tool_use"
                     and e.get("part", {}).get("tool") == "rk_desktop_fast_step"]
            returned = json.loads(calls[0]["part"]["state"].get("output", "{}")) if len(calls) == 1 else {}
            received_value = any(t.get("value") == token
                                 for t in returned.get("observation", {}).get("targets", []))
            result.update(application_value=wait_for(state)["value"],
                          final_answer=texts[-1] if texts else None, tool_calls=len(calls),
                          agent_received_actual_value=received_value)
            result["passed"] = (result["application_value"] == token and len(calls) == 1
                                and received_value and bool(texts) and token in texts[-1]
                                and calls[0]["part"]["state"]["status"] == "completed")
            print(json.dumps({"passed": result["passed"], "folder": str(folder), "model_used": True}))
            raise SystemExit(0 if result["passed"] else 1)

        text = " A1\nB2 "
        typed = act("type", text=text)
        if typed["state"]["value"].replace("\r\n", "\n") != text:
            raise RuntimeError("Literal whitespace/newline mismatch")
        for chord in ("CTRL+HOME", "PAGEDOWN", "PAGEUP", "DELETE", "CTRL+END"):
            entry = act("hotkey", keys=chord)
            expected = {"CTRL+HOME": "Home", "PAGEDOWN": "Next", "PAGEUP": "PageUp",
                        "DELETE": "Delete", "CTRL+END": "End"}[chord]
            if not any(e["name"] == "key_down" and e["data"]["key"] == expected
                       for e in entry["events"]):
                raise RuntimeError("Key event not observed")
        for kind in ("move", "hover"):
            entry = act(kind, "Pointer pad")
            observed = json.loads((folder / f"observation-{len(result['actions']) - 1:02d}.json").read_text(encoding="utf-8"))
            rect = next(t["rect"] for t in observed["targets"] if t["name"] == "Pointer pad")
            expected = [(rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2]
            if max(abs(a - b) for a, b in zip(entry["state"]["cursor"], expected)) > 1:
                raise RuntimeError("Pointer not at observed target center")
        for button in ("left", "right", "middle"):
            entry = act("click", "Pointer pad", button=button)
            if not any(e["name"] == "mouse_up" and e["data"]["button"].lower() == button
                       for e in entry["events"]):
                raise RuntimeError("Click button not observed")
        entry = act("double_click", "Pointer pad")
        if not any(e["name"] == "double_click" for e in entry["events"]):
            raise RuntimeError("Windows double click not observed")
        entry = act("drag", "Pointer pad", duration_ms=500)
        if (not any(e["name"] == "mouse_move" and e["data"]["button"] == "Left" for e in entry["events"])
                or not any(e["name"] == "mouse_up" and e["data"]["x"] > 500 for e in entry["events"])):
            raise RuntimeError("Full drag not observed")
        for steps in (2, -3):
            entry = act("scroll", "Pointer pad", steps=steps)
            total = sum(e["data"]["delta"] for e in entry["events"] if e["name"] == "wheel")
            if total != steps * 120:
                raise RuntimeError("Wheel detent mismatch")
        # Stop only after this run's real button-down, then prove finally released.
        prior = len(events())
        def cancel():
            wait_for(lambda: any(e["name"] == "mouse_down" for e in events()[prior:]))
            time.sleep(0.12)
            stop.touch()
        thread = threading.Thread(target=cancel, daemon=True)
        thread.start()
        entry = act("drag", "Pointer pad", duration_ms=2000, expect_stop=True)
        thread.join(timeout=3)
        if any(entry["state"]["buttons_down"]) or any(entry["state"]["modifiers_down"]):
            raise RuntimeError("Input still held after stop")
        ups = [e for e in entry["events"] if e["name"] == "mouse_up"]
        if not ups or ups[-1]["data"]["x"] >= 600:
            raise RuntimeError("Stopped drag did not release before destination")
        result.update(passed=True, application_effects_verified=True, stopped_drag_released=True)
    except Exception as error:
        result["error"] = str(error)
    finally:
        if companion:
            stop.touch()
            try:
                companion.wait(timeout=8)
            except subprocess.TimeoutExpired:
                companion.terminate()
                companion.wait(timeout=5)
        if fixture:
            fixture.terminate()
            fixture.wait(timeout=5)
        if client:
            client.close()
        log.close()
        save(folder / "summary.json", result)
    print(json.dumps({"passed": result["passed"], "folder": str(folder), "error": result.get("error")}))
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
