"""Actual board-local form batch -> USB HID -> Windows UIA/value/business verification.

No MCP, OpenCode, clipboard or software input. --agent tests the real native RK Agent/NPU;
the default is a deterministic executor test. Scoped explicit --execute fixture only.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from host import connect, REMOTE  # noqa: E402


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def wait_for(check, timeout=20):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise TimeoutError("Fixture/observer not ready")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", required=True)
    parser.add_argument("--deploy", action="store_true")
    parser.add_argument("--ocr", action="store_true", help="Exercise existing hybrid OCR/UIA collector")
    parser.add_argument("--agent", action="store_true", help="Use real native RK Agent decisions and verification")
    parser.add_argument("--wait-start", action="store_true")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    folder = args.output_dir.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    try:
        with socket.create_connection(("127.0.0.1", 8091), timeout=0.3):
            raise RuntimeError("Existing desktop session; refusing to replace it")
    except OSError:
        pass
    spec = importlib.util.spec_from_file_location("hid_install", ROOT / "scripts/setup-hid-skill.py")
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    names = list(installer.SOURCES) + ["pc/observer.py", "pc/HIDFormLab.cs", "scripts/smoke-hid-workflow.py"]
    result = {"passed": False, "mcp_used": False, "model_used": args.agent, "ocr_enabled": args.ocr,
              "input_backend": "rk_usb_hid", "pc_role": "observation_and_validation",
              "source_sha256": {n: hashlib.sha256((ROOT / n).read_bytes()).hexdigest() for n in names}}
    for name in names:
        target = folder / "sources" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    client = fixture = companion = None
    log = (folder / "companion.log").open("w", encoding="utf-8")
    stop = ROOT / ".runtime/desktop-stop"
    try:
        client = connect()
        if args.deploy:
            result["deployment"] = installer.install(client, folder)
        compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
        exe = folder / "HIDFormLab.exe"
        built = subprocess.run([str(compiler), "/nologo", "/target:winexe", "/out:" + str(exe),
            "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
            "/reference:System.Web.Extensions.dll", str(ROOT / "pc/HIDFormLab.cs")], capture_output=True)
        (folder / "compile.txt").write_bytes(built.stdout + built.stderr)
        if built.returncode:
            raise RuntimeError("Fixture compilation failed")
        fixture_args = [str(exe), str(folder)]
        if args.agent:
            fixture_args.append("--no-activate")
        fixture = subprocess.Popen(fixture_args)
        def state():
            return json.loads((folder / "state.json").read_text(encoding="utf-8-sig"))
        title = wait_for(state)["title"]
        cmd = [sys.executable, str(ROOT / "desktop_host.py"), "--title", title, "--execute-hid",
               "--observer-dir", str(folder / "observer"), "--fixture-state", str(folder / "state.json")]
        if args.ocr:
            cmd.append("--ocr")
        companion = subprocess.Popen(cmd, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
        def health():
            key = (ROOT / ".runtime/desktop-key").read_text().strip()
            req = urllib.request.Request("http://127.0.0.1:8091/health", headers={"Authorization": "Bearer " + key})
            with urllib.request.urlopen(req, timeout=3) as response:
                return json.load(response)
        wait_for(health)
        wait_for(lambda: json.loads((ROOT / ".runtime/desktop-session.json").read_text()).get("window") == title)
        if args.wait_start:
            print("WAIT_START=" + str(folder / "start.signal"), flush=True)
            wait_for(lambda: (folder / "start.signal").exists(), timeout=120)

        if args.agent:
            token = " HID_AGENT_" + secrets.token_hex(4) + " "
            actual_code = state()["code"]  # verifier-only: never insert into the model's task
            goal = ('Replace Edit Text with the exact string ' + json.dumps(token)
                + ' and Edit Number with "-00123.4500". Submit once using Button Apply. '
                'Use one fill_form call. Verify both actual values and that Applied matches Code. '
                'Do not close the window. Final answer must quote all actual values in the format '
                'Text="exact actual value"; Number="exact actual value"; Code="observed Code".')
            checks = {"fields": {"Text": token, "Number": "-00123.4500"},
                      "labels": ["Applied: " + actual_code],
                      "answer_contains": [actual_code, token, "-00123.4500"]}
            save(folder / "agent-input.json", {"goal": goal, "checks": checks})
            marker = secrets.token_hex(6)
            remote = REMOTE + "/logs/hid-agent-" + folder.name + "-" + marker
            inputs = [REMOTE + "/.runtime/hid-agent-" + marker + suffix
                      for suffix in (".prompt.txt", ".verify.json")]
            with client.open_sftp() as sftp:
                for path, data in zip(inputs, (goal.encode(), json.dumps(checks).encode())):
                    with sftp.open(path, "wb") as stream:
                        stream.write(data)
                    sftp.chmod(path, 0o600)
            command = ("cd " + shlex.quote(REMOTE) + " && python3 -u scripts/hid-agent.py --prompt-file "
                + shlex.quote(inputs[0]) + " --verify-file " + shlex.quote(inputs[1])
                + " --output-dir " + shlex.quote(remote))
            print("AGENT_EVIDENCE=" + remote, flush=True)
            _, out, err = client.exec_command(command)
            with (folder / "agent.stdout.jsonl").open("w", encoding="utf-8") as progress:
                for line in out:
                    progress.write(line)
                    progress.flush()
                    print(line, end="", flush=True)
            (folder / "agent.stderr.txt").write_bytes(err.read())
            result["agent_exit"] = out.channel.recv_exit_status()
            evidence = folder / "agent"
            evidence.mkdir()
            with client.open_sftp() as sftp:
                for name in sftp.listdir(remote):
                    sftp.get(remote + "/" + name, str(evidence / name))
                for path in inputs:
                    sftp.remove(path)
            status = json.loads((evidence / "status.json").read_text(encoding="utf-8"))
            actual = wait_for(state)
            save(folder / "application-result.json", actual)
            trace = [json.loads(line) for line in (evidence / "agent-trace.jsonl").read_text(
                encoding="utf-8").splitlines()]
            generated = []
            for path in sorted(evidence.glob("response-*.json")):
                message = json.loads(path.read_text(encoding="utf-8"))["choices"][0]["message"]
                generated.extend(json.loads(call["function"]["arguments"])
                                 for call in message.get("tool_calls", []))
            dispatched = [event["input"] for event in trace if event["type"] == "tool"]
            result.update(native_agent=status, application=actual, expected_text=token,
                          model_arguments_unchanged=generated == dispatched,
                          board_evidence=remote, task=goal)
            result["rk_foreground_acquired"] = any(event.get("type") == "acquire_foreground"
                and event.get("state") == "foreground_verified" and event.get("executed") is True
                for event in trace)
            result["fixture_activation_disabled"] = True
            result["passed"] = (result["agent_exit"] == 0 and status["task_verified"] is True
                and result["rk_foreground_acquired"]
                and generated == dispatched and len(dispatched) >= 1
                and actual["text"] == token and actual["number"] == "-00123.4500"
                and actual["clicks"] == 1 and actual["status"] == "Applied: " + actual_code
                and not any(actual["buttons_down"]) and not any(actual["modifiers_down"]))
            print(json.dumps({"passed": result["passed"], "folder": str(folder),
                              "model_used": True, "mcp_used": False}), flush=True)
            raise SystemExit(0 if result["passed"] else 1)

        def cli(label, flags="", request=None, expected_exit=0):
            started = time.monotonic()
            _, out, err = client.exec_command("cd " + shlex.quote(REMOTE) + " && python3 scripts/hid-act.py --compact " + flags)
            if request is not None:
                out.channel.sendall(json.dumps(request).encode())
            out.channel.shutdown_write()
            raw, errors = out.read(), err.read()
            code = out.channel.recv_exit_status()
            (folder / (label + ".stdout.json")).write_bytes(raw)
            (folder / (label + ".stderr.txt")).write_bytes(errors)
            result[label] = {"exit": code, "elapsed_ms": round((time.monotonic() - started) * 1000, 2)}
            if code != expected_exit:
                raise RuntimeError("Unexpected CLI outcome: " + label + ": " + errors.decode(errors="replace"))
            return json.loads(raw) if raw else None

        first = cli("initial", "--observe --reset-view")
        with client.open_sftp() as sftp:
            with sftp.open(REMOTE + "/.runtime/hid-view.json") as stream:
                cached = json.load(stream)
        raw = cached["observation"]
        save(folder / "initial.raw.json", raw)
        delta = cli("unchanged", "--observe")
        def target(name):
            rows = [t for t in raw["targets"] if t["name"] == name and t["type"] in ("Edit", "Button")]
            if len(rows) != 1:
                raise RuntimeError("Expected unique UIA target: " + name)
            return rows[0]["id"]
        token = " HID_BATCH_" + secrets.token_hex(4) + " "
        request = {"op": "fill_form", "observation_id": delta["observation_id"],
            "fields": [{"target_id": target("Text"), "text": token},
                       {"target_id": target("Number"), "text": "-00123.4500"}], "submit_target_id": target("Apply")}
        save(folder / "request.json", request)
        invalid = json.loads(json.dumps(request))
        invalid["fields"][1]["text"] = "中文"
        before = state()
        cli("reject-unsupported", request=invalid, expected_exit=1)
        after = state()
        if any(after[k] != before[k] for k in ("text", "number", "clicks")):
            raise RuntimeError("Rejected batch changed the fixture")
        final = cli("batch", request=request)
        time.sleep(0.25)
        actual = wait_for(state)
        save(folder / "application-result.json", actual)
        with client.open_sftp() as sftp:
            with sftp.open(REMOTE + "/.runtime/hid-view.json") as stream:
                observed = json.load(stream)["observation"]
        save(folder / "final.raw.json", observed)
        def size(value):
            return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
        result.update(expected_text=token, expected_number="-00123.4500", actual=actual,
            raw_bytes=size(raw), compact_bytes=size(first), unchanged_delta_bytes=size(delta),
            form_tool_requests=1, primitive_actions=final["actions_started"], final=final,
            unsupported_batch_rejected_without_changes=True)
        result["passed"] = (final["ok"] and final["submitted"] and actual["text"] == token
            and actual["number"] == "-00123.4500" and actual["clicks"] == 1
            and not any(actual["buttons_down"]) and not any(actual["modifiers_down"])
            and any(t["name"] == "Applied: " + actual["code"] for t in observed["targets"]))
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
    print(json.dumps({k: result.get(k) for k in ("passed", "error", "raw_bytes", "compact_bytes", "unchanged_delta_bytes")}, ensure_ascii=False))
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
