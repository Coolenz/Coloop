"""Exercise a real isolated OpenCode question -> Coloop -> RK -> answer loop.

Uses the installed OpenCode 1.19.5 and existing NPU bridge through pinned SSH.
Only synthetic question data is exported. No existing OpenCode session/config,
model weights, runtime, desktop tool, plugin or persistent memory is modified.
Requires RK_BOARD_PASSWORD in the process environment and a running, connected
Coloop coordinator. Use a new --output-dir for each run.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import select
import socketserver
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request

from coloop_agent import (
    AdapterError, LocalJsonClient, OpenCodeAdapter, canonical_json, coordinator_client, parse_json,
)

ROOT = Path(__file__).resolve().parents[1]
OFFLINE = "仅在本地离线分析，不上传任何数据"
SKIP = "取消本次操作并保持当前状态"
QUESTION = "请选择本次合成开发任务的处理方式。"
QUESTION_ARGUMENTS = {
    "questions": [{
        "question": QUESTION, "header": "处理方式",
        "options": [{"label": OFFLINE, "description": ""}, {"label": SKIP, "description": ""}],
        "multiple": False, "custom": False,
    }],
}


def remote_json(client: Any, script: str, timeout: int = 30) -> Any:
    stdin, stdout, _ = client.exec_command("python3 -", timeout=timeout)
    stdin.write(script)
    stdin.flush()
    stdin.channel.shutdown_write()
    data = stdout.read(2 * 1024 * 1024 + 1)
    if stdout.channel.recv_exit_status():
        raise AdapterError("REMOTE_OPERATION_FAILED")
    return parse_json(data)


@contextmanager
def forward(client: Any, remote_port: int, before_close=None):
    stopping = threading.Event()
    transport = client.get_transport()

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            channel = None
            try:
                channel = transport.open_channel(
                    "direct-tcpip", ("127.0.0.1", remote_port), self.client_address
                )
                while not stopping.is_set():
                    readable, _, _ = select.select([self.request, channel], [], [], 0.5)
                    for source in readable:
                        chunk = source.recv(65536)
                        if not chunk:
                            return
                        (channel if source is self.request else self.request).sendall(chunk)
            except (OSError, EOFError):
                pass
            finally:
                if channel is not None:
                    channel.close()

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True
        block_on_close = False

    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        if before_close is not None:
            before_close()
        stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


class SmokeHttp(LocalJsonClient):
    """The async prompt endpoint returns 204; the adapter itself still requires 200."""

    def send(self, method: str, path: str, body: Any = None) -> Any:
        headers = {"Accept": "application/json", "Authorization": self.authorization}
        data = None if body is None else canonical_json(body).encode("utf-8")
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=15) as response:
                if response.status == 204:
                    return None
                if response.status != 200:
                    raise AdapterError("SMOKE_HTTP_STATUS")
                return parse_json(response.read(2 * 1024 * 1024 + 1))
        except (HTTPError, URLError, OSError) as error:
            raise AdapterError("SMOKE_HTTP_UNAVAILABLE") from error


class RecordingOpenCode(LocalJsonClient):
    def __init__(self, url: str, authorization: str):
        super().__init__(url, authorization, timeout=15)
        self.replies: list[dict[str, Any]] = []

    def request(self, method: str, path: str, body: Any = None) -> Any:
        result = super().request(method, path, body)
        if method == "POST" and path.startswith("/question/"):
            self.replies.append({"path": path, "body": body, "accepted": result is True})
        return result


class RecordingCoordinator:
    def __init__(self, client: LocalJsonClient):
        self.client = client
        self.calls: list[dict[str, Any]] = []

    def request(self, method: str, path: str, body: Any = None) -> Any:
        result = self.client.request(method, path, body)
        self.calls.append({"event": body, "decision": result})
        return result


def sanitize(value: Any, secrets: list[str]) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if key.lower() in (
                "authorization", "apikey", "api_key", "password", "token", "headers"
            ) else sanitize(item, secrets)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize(item, secrets) for item in value]
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[REDACTED]")
    return value


BOOTSTRAP = r'''
import json,os,secrets,socket,subprocess,tempfile,sys,time,urllib.request
from pathlib import Path
root=Path('/home/cat/rk-opencode')
sys.path.insert(0,str(root/'agent'))
from memory_client import MemoryClient
memory=MemoryClient(root)
activity='coloop-real-opencode-'+secrets.token_hex(12)
state=memory.request('/activity',{'session_id':activity,'active':True},timeout=5)
if state['active_sessions']!=1:
 memory.request('/activity',{'session_id':activity,'active':False},timeout=5)
 raise SystemExit(2)
memory.request('/ready-for-foreground',{},timeout=185)
key=(root/'.runtime/api-key').read_text().strip()
health_request=urllib.request.Request('http://127.0.0.1:8088/health',headers={'Authorization':'Bearer '+key})
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(health_request,timeout=5) as response:
 health=json.load(response)
if not (health.get('ready') is True and health.get('privacy_metadata_only') is True and health.get('model')=='qwen35-4b-rkllm'):
 raise RuntimeError('PRIVATE_MODEL_SERVICE_REQUIRED')
resources={}
for line in Path('/proc/meminfo').read_text().splitlines():
 name,value=line.split(':',1)
 if name in ('MemTotal','MemAvailable','SwapFree'): resources[name]=value.strip()
temps=[]
for path in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
 try: temps.append(float(path.read_text())/1000)
 except (OSError,ValueError): pass
resources['max_temperature_c']=max(temps) if temps else None
temporary=Path(tempfile.mkdtemp(prefix='coloop-opencode-',dir=root/'.runtime'))
for name in ('workspace','config','data','cache','logs'): (temporary/name).mkdir()
config=CONFIG_JSON
(temporary/'config.json').write_text(json.dumps(config,ensure_ascii=False))
with socket.socket() as allocator:
 allocator.bind(('127.0.0.1',0)); port=allocator.getsockname()[1]
password=secrets.token_urlsafe(32)
env={
 'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),'HOME':str(temporary),
 'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','OPENCODE_CONFIG':str(temporary/'config.json'),
 'XDG_CONFIG_HOME':str(temporary/'config'),'XDG_DATA_HOME':str(temporary/'data'),
 'XDG_CACHE_HOME':str(temporary/'cache'),'OPENCODE_SERVER_USERNAME':'opencode',
 'OPENCODE_SERVER_PASSWORD':password,'RK_AGENT_API_KEY':key,
}
for flag in ('AUTOUPDATE','MODELS_FETCH','LSP_DOWNLOAD','DEFAULT_PLUGINS','PROJECT_CONFIG',
             'AUTOCOMPACT','PRUNE','CLAUDE_CODE'): env['OPENCODE_DISABLE_'+flag]='true'
version=subprocess.run([str(root/'bin/opencode'),'--version'],env=env,check=True,capture_output=True,text=True).stdout.strip()
offsets={name:(root/'logs'/name).stat().st_size if (root/'logs'/name).exists() else 0
 for name in ('requests.jsonl','worker.log','bridge.log')}
with (temporary/'logs/server.log').open('wb') as log:
 process=subprocess.Popen([str(root/'bin/opencode'),'serve','--hostname=127.0.0.1','--port='+str(port),
  '--log-level=ERROR'],cwd=temporary/'workspace',env=env,stdin=subprocess.DEVNULL,
  stdout=log,stderr=log,start_new_session=True)
print(json.dumps({'directory':str(temporary/'workspace'),'temporary':str(temporary),
 'pid':process.pid,'port':port,'password':password,'activity':activity,'version':version,'log_offsets':offsets,
 'resources_before':resources,'model_health':{key:health[key] for key in ('model','context','runtime','worker_protocol','privacy_metadata_only') if key in health}}))
'''


def guarded_bootstrap() -> str:
    body = BOOTSTRAP.replace("CONFIG_JSON", repr(config()))
    # A failed startup must release its scheduling mark and its own process group.
    return "process=None\nactivity=None\ntry:\n" + "".join(
        " " + line + "\n" for line in body.splitlines()
    ) + r'''
except BaseException:
 if process is not None:
  try:
   import signal
   os.killpg(process.pid,signal.SIGTERM)
  except (OSError,ProcessLookupError): pass
 if activity is not None:
  try: memory.request('/activity',{'session_id':activity,'active':False},timeout=5)
  except Exception: pass
 raise SystemExit(2)
'''


def config() -> dict[str, Any]:
    return {
        "autoupdate": False, "share": "disabled", "enabled_providers": ["rkllm"],
        "model": "rkllm/qwen35-4b-rkllm", "small_model": "rkllm/qwen35-4b-rkllm",
        "default_agent": "coloop-question-smoke", "plugin": [], "mcp": {},
        "permission": {"*": "deny", "question": "allow"},
        "compaction": {"auto": False, "prune": False},
        "provider": {"rkllm": {
            "npm": "@ai-sdk/openai-compatible", "name": "Existing local RK NPU",
            "options": {"baseURL": "http://127.0.0.1:8088/v1",
                        "apiKey": "{env:RK_AGENT_API_KEY}", "timeout": 190000,
                        "headers": {"X-RK-Privacy": "metadata-only", "X-RK-Cache": "off"}},
            "models": {"qwen35-4b-rkllm": {
                "name": "Existing Qwen3.5-4B", "tool_call": True, "reasoning": False,
                "limit": {"context": 16384, "output": 384},
                "options": {"maxTokens": 384},
                "headers": {"X-RK-Privacy": "metadata-only", "X-RK-Cache": "off"},
            }},
        }},
        "agent": {
            "title": {"disable": True}, "summary": {"disable": True},
            "coloop-question-smoke": {
                "description": "Isolated synthetic question coordination verification",
                "mode": "primary", "steps": 3,
                "permission": {"*": "deny", "question": "allow"},
                "prompt": "Use question exactly once with the questions provided by the user. "
                "Copy every label and empty description exactly. After the question tool returns, "
                "finish with {\"answer\":\"the exact selected option label\"}. "
                "Return one valid JSON tool action or answer per turn. "
                "Do not call any other tool or ask a second question.",
            },
        },
    }


def collect_messages(messages: Any) -> tuple[list[dict[str, Any]], list[str]]:
    tools, final = [], []
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict):
            continue
        for part in message.get("parts", []):
            if part.get("type") == "tool":
                tools.append(part)
            elif part.get("type") == "text" and message.get("info", {}).get("role") == "assistant":
                final.append(part.get("text", ""))
    return tools, final


def cleanup(client: Any, startup: dict[str, Any]) -> dict[str, Any]:
    script = r'''
import hashlib,json,os,signal,sys,time
from pathlib import Path
root=Path('/home/cat/rk-opencode'); startup=STARTUP_JSON
report={}; pid=startup['pid']; process=Path('/proc')/str(pid)
if process.exists():
 args=(process/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
 if str(root/'bin/opencode') not in args or 'serve' not in args or Path(os.readlink(process/'cwd'))!=Path(startup['directory']) or os.getpgid(pid)!=pid:
  report['process_cleanup']='IDENTITY_MISMATCH'
 else:
  os.killpg(pid,signal.SIGTERM)
  for _ in range(30):
   if not process.exists(): break
   time.sleep(.1)
  report['process_cleanup']='terminated_own_process_group'
sys.path.insert(0,str(root/'agent'))
from memory_client import MemoryClient
MemoryClient(root).request('/activity',{'session_id':startup['activity'],'active':False},timeout=5)
report['activity_released']=True
allowed={'id','privacy','started_at','prompt_bytes','input_tokens','output_tokens','elapsed_seconds','finish_reason','error_code','inference'}
for name,offset in startup['log_offsets'].items():
 path=root/'logs'/name
 with path.open('rb') as stream: stream.seek(offset); data=stream.read()
 row={'added_bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
 if name=='requests.jsonl':
  records=[json.loads(line) for line in data.splitlines() if line.strip()]
  row['record_count']=len(records)
  row['metadata_only']=all(value.get('privacy')=='metadata-only' and set(value)<=allowed for value in records)
 report[name]=row
print(json.dumps(report))
'''.replace("STARTUP_JSON", repr(startup))
    return remote_json(client, script)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--workspace", default=str(ROOT))
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    if not 30 <= args.timeout <= 600:
        parser.error("--timeout must be in 30..600")
    args.output_dir.mkdir(parents=True, exist_ok=False)
    report: dict[str, Any] = {
        "source": "real-opencode-session", "synthetic_only": True,
        "cloud_used": False, "model_or_runtime_replaced": False, "passed": False,
    }
    startup: dict[str, Any] = {}
    secrets: list[str] = []
    messages: Any = []
    client = None
    recording = None
    coordinating = None
    try:
        if not os.environ.get("RK_BOARD_PASSWORD"):
            raise AdapterError("RK_BOARD_PASSWORD_REQUIRED")
        coordinator = coordinator_client(args.connection)
        secrets.append(coordinator.authorization.removeprefix("Bearer "))
        coordinator.request("GET", "/health")
        spec = importlib.util.spec_from_file_location("rk_host", ROOT / "rk-opencode/host.py")
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        client = host.connect()
        startup = remote_json(client, guarded_bootstrap(), timeout=210)
        secrets.append(startup["password"])
        report["opencode_version"] = startup["version"]
        report["resources_before"] = startup["resources_before"]
        report["model_health"] = startup["model_health"]
        if startup["version"] != "1.19.5":
            raise AdapterError("OPENCODE_VERSION_MISMATCH")
        http = None

        def close_own_session():
            nonlocal messages
            if not http or "session_id" not in report or report.get("own_session_deleted"):
                return
            query = "?" + urlencode({"directory": startup["directory"]})
            path = "/session/" + quote(report["session_id"], safe="")
            try:
                messages = http.send("GET", path + "/message" + query)
                http.send("POST", path + "/abort" + query)
                http.send("DELETE", path + query)
                report["own_session_deleted"] = True
            except AdapterError as error:
                report["session_cleanup_error"] = error.code

        with forward(client, startup["port"], close_own_session) as url:
            basic = base64.b64encode(("opencode:" + startup["password"]).encode()).decode()
            authorization = "Basic " + basic
            http = SmokeHttp(url, authorization)
            deadline = time.monotonic() + args.timeout
            while True:
                try:
                    if http.send("GET", "/global/health").get("healthy") is True:
                        break
                except AdapterError:
                    pass
                if time.monotonic() >= deadline:
                    raise AdapterError("OPENCODE_START_TIMEOUT")
                time.sleep(.5)
            query = "?" + urlencode({"directory": startup["directory"]})
            session = http.send("POST", "/session" + query, {
                "title": "Coloop synthetic coordination verification",
                "permission": [{"permission": "*", "pattern": "*", "action": "deny"},
                               {"permission": "question", "pattern": "*", "action": "allow"}],
            })
            session_id = session["id"]
            report["session_id"] = session_id
            message_path = "/session/" + quote(session_id, safe="") + "/message" + query
            recording = RecordingOpenCode(url, authorization)
            coordinating = RecordingCoordinator(coordinator)
            adapter = OpenCodeAdapter(recording, coordinating, startup["directory"], args.workspace)
            http.send("POST", "/session/" + quote(session_id, safe="") + "/prompt_async" + query, {
                "agent": "coloop-question-smoke",
                "model": {"providerID": "rkllm", "modelID": "qwen35-4b-rkllm"},
                "parts": [{"type": "text", "text": "Call question now using exactly these arguments: "
                           + canonical_json(QUESTION_ARGUMENTS)}],
            })
            while time.monotonic() < deadline:
                pending = adapter.pending("question")
                own = [value for value in pending if value["sessionID"] == session_id]
                if own:
                    report["actual_pending"] = own
                    break
                messages = http.send("GET", message_path)
                time.sleep(.5)
            if not report.get("actual_pending"):
                raise AdapterError("REAL_QUESTION_NOT_OBSERVED")
            adapter.poll_once()
            if adapter.last_error or len(recording.replies) != 1:
                raise AdapterError(adapter.last_error or "REAL_QUESTION_NOT_CONSUMED")
            while time.monotonic() < deadline:
                messages = http.send("GET", message_path)
                tools, texts = collect_messages(messages)
                done = [part for part in tools if part.get("tool") == "question"
                        and part.get("state", {}).get("status") == "completed"]
                status = http.send("GET", "/session/status" + query).get(session_id, {})
                if done and any(OFFLINE in text for text in texts) and status.get("type", "idle") == "idle":
                    break
                time.sleep(.5)
            tools, texts = collect_messages(messages)
            report["question_tool_completed"] = any(
                part.get("tool") == "question" and part.get("state", {}).get("status") == "completed"
                and OFFLINE in canonical_json(part.get("state", {}).get("output", ""))
                for part in tools
            )
            report["only_question_tool"] = bool(tools) and all(part.get("tool") == "question" for part in tools)
            report["one_reply_accepted"] = len(recording.replies) == 1 and recording.replies[0]["accepted"]
            report["selected_offline"] = recording.replies[0]["body"] == {"answers": [[OFFLINE]]}
            report["final_answer_contains_selection"] = any(OFFLINE in text for text in texts)
            report["pending_consumed"] = not any(
                value["sessionID"] == session_id for value in adapter.pending("question")
            )
            report["passed"] = all(report.get(key) is True for key in (
                "question_tool_completed", "only_question_tool", "one_reply_accepted",
                "selected_offline", "final_answer_contains_selection", "pending_consumed",
            ))
            http.send("POST", "/session/" + quote(session_id, safe="") + "/abort" + query)
            http.send("DELETE", "/session/" + quote(session_id, safe="") + query)
            report["own_session_deleted"] = True
    except Exception as error:
        report["failure_code"] = error.code if isinstance(error, AdapterError) else type(error).__name__
    finally:
        if client is not None:
            if startup:
                try:
                    report["cleanup"] = cleanup(client, startup)
                    scans = report["cleanup"]
                    report["private_model_logs"] = (
                        scans["requests.jsonl"]["metadata_only"] and scans["worker.log"]["added_bytes"] == 0
                    )
                    report["passed"] = report["passed"] and report["private_model_logs"]
                except Exception as error:
                    report["cleanup_error"] = type(error).__name__
                    report["passed"] = False
            client.close()
        for name, value in (
            ("messages.json", messages), ("coordinator.json", coordinating.calls if coordinating else []),
            ("replies.json", recording.replies if recording else []), ("report.json", report),
            ("summary.json", report), ("config.json", config()),
        ):
            (args.output_dir / name).write_text(
                json.dumps(sanitize(value, secrets), ensure_ascii=False, indent=2), encoding="utf-8"
            )
    print(canonical_json({"passed": report["passed"], "output_dir": str(args.output_dir),
                          "failure_code": report.get("failure_code")}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
