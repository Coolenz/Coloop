"""Actual HTTP/SSH/Windows fixture checks; --model adds real RK OpenCode decisions."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "agent"))
from host import connect  # noqa: E402
from windows_desktop import WindowsDesktopTools  # noqa: E402


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def wait_for(check, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.2)
    raise TimeoutError("Fixture readiness timed out")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", action="store_true")
    parser.add_argument("--ocr", action="store_true", help="Exercise the existing OCR/UIA collector")
    parser.add_argument("--batch", action="store_true", help="Use fill_form for the two inputs and Apply")
    parser.add_argument("--prepare-window", action="store_true",
                        help="Open the fixture before the model; model validates fill/fill/click")
    parser.add_argument("--hold", action="store_true", help="Hold verified window for visual QA")
    args = parser.parse_args()
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime(
        "%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
    folder = ROOT / "logs" / ("windows-desktop-" + stamp)
    folder.mkdir(parents=True)
    print("RUN_DIR=" + str(folder), flush=True)
    title = "RK Windows Lab " + stamp
    nonce = secrets.token_hex(5)
    expected_text = "窗口文本测试 RK-" + nonce[:4]
    expected_number = "-00123.4500"
    file = folder / "窗口数据.txt"
    write(file, {"title": title, "nonce": nonce, "folder": str(folder)})
    exe = folder / "WindowsDesktopLab.exe"
    compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    subprocess.run([str(compiler), "/nologo", "/target:winexe", "/out:" + str(exe),
                    "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
                    "/reference:System.Web.Extensions.dll", str(ROOT / "pc/WindowsDesktopLab.cs")],
                   check=True)
    sources = [*ROOT.glob("pc/windows*.py"), ROOT / "pc/observer.py",
               ROOT / "pc/observations.py", ROOT / "pc/WindowsDesktopLab.cs",
               ROOT / "agent/windows_desktop.py", ROOT / "agent/windows_config.py",
               ROOT / "agent/observation_view.py",
               ROOT / "agent/mcp_server.py", ROOT / "plugins/windows-desktop.mjs",
               ROOT / "skills/rk-windows-desktop/SKILL.md", ROOT / "windows_host.py",
               ROOT / "scripts/windows-agent.sh", Path(__file__).resolve()]
    manifest = {"mode": "real-rk-opencode" if args.model else "native-tools", "title": title,
                "prepared_window": args.prepare_window,
                "ocr": args.ocr, "batch": args.batch,
                "expected_text": expected_text, "expected_number": expected_number,
                "file_sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                "source_sha256": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                                  for p in sources}}
    write(folder / "manifest.json", manifest)
    for source in sources:
        snapshot = folder / "sources" / source.relative_to(ROOT)
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        snapshot.write_bytes(source.read_bytes())
    status = {"passed": False}
    companion = None
    client = None
    try:
        with (folder / "companion.log").open("w", encoding="utf-8") as log:
            command = [
                sys.executable, "-u", str(ROOT / "windows_host.py"), "--title", title,
                "--execute", "--allow-file", str(file), "--file-app", str(exe),
                "--output-dir", str(folder / "observer"), "--install",
            ]
            if args.ocr:
                command.append("--ocr")
            companion = subprocess.Popen(command, stdout=log, stderr=log,
                                         creationflags=subprocess.CREATE_NO_WINDOW)
        def ready():
            if companion.poll() is not None:
                raise RuntimeError("Companion failed; inspect companion.log")
            try:
                value = json.loads((ROOT / ".runtime/windows-desktop-session.json").read_text(
                    encoding="utf-8"))
                return value.get("window") == title and not value.get("stopped")
            except (OSError, ValueError):
                return False
        wait_for(ready, 45)
        client = connect()
        # Assert authentication at the real HTTP boundary without exposing its key.
        try:
            urllib.request.urlopen("http://127.0.0.1:8093/health", timeout=3)
            raise AssertionError("Unauthenticated request was accepted")
        except urllib.error.HTTPError as error:
            status["unauthenticated_status"] = error.code
            if error.code != 403:
                raise
        started = time.perf_counter()
        tool = WindowsDesktopTools(ROOT)
        trace = []
        if args.model:
            # Drain existing work before capturing the initial observation, so waiting for
            # another native call cannot expire that observation. This probe has no tools.
            probe = """import json,time,urllib.request,urllib.error
from pathlib import Path
root=Path('/home/cat/rk-opencode')
def rpc(port,key,path,body):
    request=urllib.request.Request('http://127.0.0.1:'+str(port)+path,
        headers={'Authorization':'Bearer '+key,'Content-Type':'application/json',
                 'X-RK-Privacy':'metadata-only','X-RK-Cache':'off'},
        data=json.dumps(body).encode())
    with urllib.request.urlopen(request,timeout=185) as response: return json.load(response)
config=root/'.runtime/memory-config.json'
if config.exists() and json.loads(config.read_text()).get('enabled'):
    memory_key=(root/'.runtime/memory-key').read_text().strip()
    rpc(8092,memory_key,'/activity',{'session_id':LEASE,'active':True})
    rpc(8092,memory_key,'/ready-for-foreground',{})
key=(root/'.runtime/api-key').read_text().strip()
started=time.monotonic()
while True:
    if max(int(p.read_text()) for p in Path('/sys/class/thermal').glob('thermal_zone*/temp'))>=80000:
        raise RuntimeError('Temperature limit reached')
    try:
        result=rpc(8088,key,'/v1/chat/completions',{'model':'qwen35-4b-rkllm',
            'messages':[{'role':'user','content':'Reply OK.'}],'max_tokens':1})
        print(json.dumps({'ready':True,'wait_seconds':time.monotonic()-started,'usage':result.get('usage')}))
        break
    except urllib.error.HTTPError as error:
        if error.code!=429 or time.monotonic()-started>180: raise
        time.sleep(1)
"""
            script = "LEASE=" + repr("windows-smoke:" + stamp) + "\n" + probe
            _, out, err = client.exec_command("python3 -c " + shlex.quote(script))
            probe_output, probe_error = out.read().decode(), err.read().decode()
            (folder / "model-ready.json").write_text(probe_output, encoding="utf-8")
            if out.channel.recv_exit_status():
                raise RuntimeError("Model readiness probe failed: " + probe_error)
            if args.prepare_window:
                opened = tool.call({"op": "open_file", "path": str(file)})
                write(folder / "prepared-window.json", opened)
                print("PREPARED_WINDOW; activate only this fixture, then create foreground.signal",
                      flush=True)
                wait_for(lambda: (folder / "foreground.signal").exists(), 180)
                tool = WindowsDesktopTools(ROOT)
                write(folder / "prepared-observation.json", tool.call({"op": "observe"}))
            started = time.perf_counter()  # Exclude readiness and manual foreground preparation.
            prompt = (
                ("文件已在前台测试窗口打开。" if args.prepare_window else f"打开文件 {file}。")
                + f"将 Text 输入框完整替换为“{expected_text}”，"
                f"将 Number 输入框完整替换为“{expected_number}”，然后点击 Apply。"
                "请检查界面结果，并在最终回答准确返回界面上的 File code。不要关闭窗口。"
            )
            if args.batch:
                prompt += " 请用一次 fill_form 完成两个输入框填写和点击提交。"
            write(folder / "input.json", {"prompt": prompt})
            remote_folder = "/home/cat/rk-opencode/logs/windows-desktop-" + stamp
            # Only reuse a healthy existing Qwen service; this test never switches someone else's model.
            _, out, _ = client.exec_command(
                "cd /home/cat/rk-opencode && RK_AGENT_PROFILE=qwen35-4b python3 scripts/check-health.py")
            if out.channel.recv_exit_status():
                raise RuntimeError("Matching Qwen service is not ready; no model was started/switched")
            _, out, _ = client.exec_command("mkdir -p " + shlex.quote(remote_folder))
            if out.channel.recv_exit_status():
                raise RuntimeError("Cannot create remote evidence directory")
            command = ("echo $$ > " + shlex.quote(remote_folder + "/runner.pid")
                       + "; cd /home/cat/rk-opencode; exec timeout 550s bash scripts/windows-agent.sh "
                       + "run --format json " + shlex.quote(prompt))
            channel = client.get_transport().open_session()
            channel.set_combine_stderr(True)
            channel.exec_command("setsid --wait bash -c " + shlex.quote(command))
            channel.shutdown_write()  # OpenCode reads piped stdin until EOF even with a prompt.
            chunks = []
            requests_start = None
            with client.open_sftp() as sftp:
                requests_start = sftp.stat("/home/cat/rk-opencode/logs/requests.jsonl").st_size
            last_check = 0
            temperatures = []
            while not channel.exit_status_ready() or channel.recv_ready():
                if channel.recv_ready():
                    chunks.append(channel.recv(65536))
                    (folder / "opencode.jsonl").write_bytes(b"".join(chunks))
                    events = []
                    for line in b"".join(chunks).decode("utf-8", errors="replace").splitlines():
                        try:
                            events.append(json.loads(line))
                        except ValueError:
                            pass
                    tool_errors = [e for e in events if e.get("type") == "tool_use"
                                   and e.get("part", {}).get("state", {}).get("status") == "error"]
                    if tool_errors:
                        with client.open_sftp() as sftp:
                            with sftp.open(remote_folder + "/runner.pid") as pid_file:
                                pid = int(pid_file.read())
                        client.exec_command("kill -TERM -- -" + str(pid))
                        status["stopped_on_tool_error"] = True
                if time.monotonic() - last_check > 5:
                    _, thermal, _ = client.exec_command("cat /sys/class/thermal/thermal_zone*/temp")
                    temps = [int(t) / 1000 for t in thermal.read().split()]
                    temperatures.append({"elapsed": time.perf_counter() - started, "max_c": max(temps)})
                    if max(temps) >= 80 or time.perf_counter() - started > 600:
                        with client.open_sftp() as sftp:
                            with sftp.open(remote_folder + "/runner.pid") as pid_file:
                                pid = int(pid_file.read())
                        client.exec_command("kill -TERM -- -" + str(pid))
                        raise RuntimeError("Model test stopped at its timeout/temperature limit")
                    last_check = time.monotonic()
                time.sleep(0.05)
            raw = b"".join(chunks).decode("utf-8", errors="replace")
            (folder / "opencode.jsonl").write_text(raw, encoding="utf-8")
            write(folder / "temperatures.json", temperatures)
            status["model_exit_code"] = channel.recv_exit_status()
            with client.open_sftp() as sftp:
                with sftp.open("/home/cat/rk-opencode/logs/requests.jsonl") as requests:
                    requests.seek(requests_start)
                    rows = [json.loads(line) for line in requests.read().decode().splitlines()]
                rows = [r for r in rows if r.get("tools") == ["rk_windows_desktop"]]
                (folder / "model-requests.jsonl").write_text(
                    "\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
            final_text = []
            for line in raw.splitlines():
                try:
                    event = json.loads(line)
                    if event.get("type") == "text":
                        final_text.append(event.get("part", {}).get("text", ""))
                except ValueError:
                    pass
            status["returned_file_code"] = bool(final_text) and nonce in final_text[-1]
            status["final_answer"] = final_text[-1] if final_text else None
            if status["model_exit_code"]:
                raise RuntimeError("OpenCode model run failed")
        else:
            def call(payload):
                tick = time.perf_counter()
                result = tool.call(payload)
                trace.append({"input": payload, "output": result,
                              "wall_ms": (time.perf_counter() - tick) * 1000})
                write(folder / "tool-trace.json", trace)
                if result.get("state") in ("planned", "outcome_unknown") or result.get("observation_error"):
                    raise RuntimeError("Action not verified: " + json.dumps(result, ensure_ascii=False))
                return result if payload["op"] == "observe" else result["observation"]
            if args.prepare_window:
                opened = tool.call({"op": "open_file", "path": str(file)})
                write(folder / "prepared-window.json", opened)
                print("PREPARED_WINDOW; activate only this fixture, then create foreground.signal",
                      flush=True)
                wait_for(lambda: (folder / "foreground.signal").exists(), 180)
                tool = WindowsDesktopTools(ROOT)
                started = time.perf_counter()
                observed = call({"op": "observe"})
            else:
                observed = call({"op": "open_file", "path": str(file)})
            if not any(t["name"] == "File code: " + nonce for t in observed["targets"]):
                raise AssertionError("Opened file's independent random code was not observed")
            def target(name, kind):
                matches = [t for t in observed["targets"] if t["name"] == name and t["type"] == kind]
                if len(matches) != 1:
                    raise ValueError("Target is not unique: " + name)
                return matches[0]["id"]
            if args.batch:
                observed = call({"op": "fill_form", "observation_id": observed["observation_id"],
                                 "fields": [{"target_id": target("Text", "Edit"), "text": expected_text},
                                            {"target_id": target("Number", "Edit"), "text": expected_number}],
                                 "submit": target("Apply", "Button")})
            else:
                observed = call({"op": "fill", "observation_id": observed["observation_id"],
                                 "target_id": target("Text", "Edit"), "text": expected_text})
                observed = call({"op": "type", "observation_id": observed["observation_id"], "text": "-追加"})
                expected_text += "-追加"
                observed = call({"op": "fill", "observation_id": observed["observation_id"],
                                 "target_id": target("Number", "Edit"), "text": expected_number})
                observed = call({"op": "hotkey", "observation_id": observed["observation_id"], "keys": "TAB"})
                observed = call({"op": "click", "observation_id": observed["observation_id"],
                                 "target_id": target("Apply", "Button")})
        status["task_seconds"] = time.perf_counter() - started
        actual = json.loads((folder / "lab-result.json").read_text(encoding="utf-8-sig"))
        observed = tool.call({"op": "observe"})
        write(folder / "final-observation.json", observed)
        status.update(application_result=actual,
                      values_match=actual["text"] == expected_text and actual["number"] == expected_number,
                      applied_once=actual["clicks"] == 1,
                      observed_applied=any(t["name"] == "Applied: " + nonce for t in observed["targets"]))
        status["passed"] = (status["values_match"] and status["applied_once"]
                            and status["observed_applied"] and (not args.model or status["returned_file_code"]))
        write(folder / "status.json", status)
        print(json.dumps(status, ensure_ascii=False), flush=True)
        if args.hold:
            print("HOLD_FOR_VISUAL_QA; create release.signal to close", flush=True)
            wait_for(lambda: (folder / "release.signal").exists(), 180)
    except Exception as error:
        status.update(error=str(error))
        print(json.dumps(status, ensure_ascii=False), flush=True)
        if args.hold:
            print("HOLD_FAILED_FOR_VISUAL_QA; create release.signal to close", flush=True)
            try:
                wait_for(lambda: (folder / "release.signal").exists(), 120)
            except TimeoutError:
                pass
    finally:
        write(folder / "status.json", status)
        if companion:
            (ROOT / ".runtime/windows-desktop-stop").touch()
            try:
                companion.wait(timeout=8)
            except subprocess.TimeoutExpired:
                companion.terminate()
                companion.wait(timeout=5)
        result_path = folder / "lab-result.json"
        if result_path.exists():
            result = json.loads(result_path.read_text(encoding="utf-8-sig"))
            try:
                os.kill(int(result["pid"]), signal.SIGTERM)
            except OSError:
                pass
        if client:
            if args.model:
                leases = ["windows-smoke:" + stamp]
                output = folder / "opencode.jsonl"
                if output.exists():
                    for line in output.read_text(encoding="utf-8").splitlines():
                        try:
                            event = json.loads(line)
                            if isinstance(event.get("sessionID"), str):
                                leases.append("windows:" + event["sessionID"])
                        except ValueError:
                            pass
                script = ("import sys;sys.path.insert(0,'/home/cat/rk-opencode/agent');"
                          "from memory_client import MemoryClient;"
                          "client=MemoryClient('/home/cat/rk-opencode');"
                          + "[client.request('/activity',{'session_id':s,'active':False}) for s in "
                          + repr(sorted(set(leases))) + "]")
                _, done, _ = client.exec_command("python3 -c " + shlex.quote(script))
                done.channel.recv_exit_status()
            client.close()
    raise SystemExit(0 if status["passed"] else 1)


if __name__ == "__main__":
    main()
