"""Benchmark native OpenCode hooks through real Coloop and the existing RK NPU.

Only synthetic tasks are used. The source plugin, source session, source process,
SSH forwarding and connection file are private to this run. Observation load is
labelled synthetic; real approval consumption must originate in OpenCode itself.
The benchmark never answers an approval from Python. Requires a connected Coloop
and RK_BOARD_PASSWORD in the process environment. Wait for the main task before
running this against the shared single-NPU service.

The --timeout budget covers the WHOLE multi-task experiment (default 1200s,
30..1800s), including source model planning, approvals and source final answers.
It does not change the coordinator's per-review timeout, the model service's
per-request timeout, the 80C guard, or the separate Qwen single-smoke policy.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import math
import os
from pathlib import Path
import select
import socket
import socketserver
import statistics
import threading
import time
from typing import Any
from urllib.parse import quote, urlencode
from uuid import uuid4
from urllib.error import HTTPError, URLError

from paramiko import SSHException

from coloop_agent import (
    AdapterError,
    LocalJsonClient,
    canonical_json,
    coordinator_client,
    parse_json,
)
from smoke_coloop_opencode import (
    OFFLINE,
    QUESTION_ARGUMENTS,
    SmokeHttp,
    cleanup,
    collect_messages,
    config,
    remote_json,
    sanitize,
)


ROOT = Path(__file__).resolve().parents[1]
HOOK_PLUGIN = ROOT / "rk-opencode/plugins/coloop-hook.mjs"
INGEST_P95_MS = 100
RULE_P95_MS = 150
CONSUMED_P95_MS = 3500
SOURCE_STAGE_INITIAL_PROMPT = (
    "Call question exactly once using the user's JSON arguments. "
    "Copy every label and empty description unchanged. Return one JSON tool action. Do not answer yet."
)
SOURCE_STAGE_FINAL_PROMPT = (
    'The question tool completed. Copy its selected label into {"answer":"<selected label>"}. '
    "Return only that JSON answer. Never call any tool again."
)
# Test-only source guidance. It never writes tool arguments, tool results, user
# messages or model answers, and contains no expected option label.
SOURCE_STAGE_FIXTURE = r"""// TEST ONLY: isolated approval benchmark source-stage guidance.
const INITIAL = __INITIAL_PROMPT__;
const FINAL = __FINAL_PROMPT__;
export default async function () {
  const sessions = new Map(), calls = new Map();
  function clear(sessionID) {
    sessions.delete(sessionID);
    for (const [key, owner] of calls) if (owner.sessionID === sessionID) calls.delete(key);
  }
  return {
    "chat.message": async (input) => {
      clear(input.sessionID);
      if (input.agent === "coloop-question-smoke") {
        if (sessions.size >= 64) throw new Error("TEST_FIXTURE_SCOPE_LIMIT");
        sessions.set(input.sessionID, { sessionID: input.sessionID, phase: "initial" });
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const owner = sessions.get(input.sessionID);
      if (owner) output.system.splice(0, output.system.length, owner.phase === "final" ? FINAL : INITIAL);
    },
    "tool.execute.before": async (input) => {
      const owner = sessions.get(input.sessionID);
      if (owner && input.tool === "question") calls.set(input.callID, owner);
    },
    "tool.execute.after": async (input, output) => {
      const owner = calls.get(input.callID); calls.delete(input.callID);
      if (!owner || owner !== sessions.get(input.sessionID) || input.tool !== "question") return;
      const answers = output?.metadata?.answers;
      if (typeof output?.output === "string" && output.output.length > 0 &&
          Array.isArray(answers) && answers.length === 1 && Array.isArray(answers[0]) &&
          answers[0].length === 1 && typeof answers[0][0] === "string" && answers[0][0].length > 0)
        owner.phase = "final";
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted" || event.type === "session.error")
        clear(event.properties?.sessionID ?? event.properties?.info?.id);
    },
    dispose: async () => { sessions.clear(); calls.clear(); },
  };
}
""".replace("__INITIAL_PROMPT__", json.dumps(SOURCE_STAGE_INITIAL_PROMPT)).replace(
    "__FINAL_PROMPT__", json.dumps(SOURCE_STAGE_FINAL_PROMPT)
)


def source_fixture_manifest() -> dict[str, Any]:
    return {
        "test_only": True,
        "name": "coloop-benchmark-source-stage",
        "code_sha256": hashlib.sha256(SOURCE_STAGE_FIXTURE.encode("utf-8")).hexdigest(),
        "system_prompts": {
            "initial": SOURCE_STAGE_INITIAL_PROMPT,
            "final": SOURCE_STAGE_FINAL_PROMPT,
        },
        "phase_trigger": "real question tool.execute.after with one nonempty native answer",
        "expected_answer_injected": False,
        "tool_calls_or_answers_fabricated": False,
        "messages_or_tool_results_modified": False,
        "production_hook_modified": False,
    }


def question_arguments(index: int) -> dict[str, Any]:
    value = json.loads(canonical_json(QUESTION_ARGUMENTS))
    if index % 2:
        value["questions"][0]["options"].reverse()
    return value


class BenchmarkHttp(SmokeHttp):
    def __init__(self, url: str, authorization: str):
        super().__init__(url, authorization)
        self.errors: list[dict[str, Any]] = []

    def send(self, method: str, path: str, body: Any = None) -> Any:
        try:
            return super().send(method, path, body)
        except AdapterError as error:
            cause = error.__cause__
            row = {"method": method, "path": path.split("?", 1)[0]}
            if isinstance(cause, HTTPError):
                raw = cause.read(16385)
                row.update(
                    status=cause.code,
                    body_bytes=len(raw),
                    body_sha256=hashlib.sha256(raw).hexdigest(),
                )
                code = "SOURCE_HTTP_STATUS_" + str(cause.code)
            else:
                timed_out = isinstance(cause, (TimeoutError, socket.timeout)) or (
                    isinstance(cause, URLError)
                    and isinstance(cause.reason, (TimeoutError, socket.timeout))
                )
                code = "SOURCE_HTTP_TIMEOUT" if timed_out else "SOURCE_HTTP_UNAVAILABLE"
                row["cause"] = type(cause).__name__
            self.errors.append({**row, "reasonCode": code})
            raise AdapterError(code) from error


def percentile(values: list[float], quantile: float) -> float | None:
    """Nearest rank; do not interpolate a tiny sample into apparent precision."""
    if not values:
        return None
    if not 0 < quantile <= 1 or any(not math.isfinite(v) or v < 0 for v in values):
        raise ValueError("INVALID_METRIC")
    return sorted(values)[max(0, math.ceil(len(values) * quantile) - 1)]


def distribution(values: list[float]) -> dict[str, Any]:
    return {
        "n": len(values),
        "p50_ms": statistics.median(values) if values else None,
        "p95_ms": percentile(values, 0.95),
        "max_ms": max(values) if values else None,
    }


def timing_pass(rows: list[dict[str, Any]], key: str, expected: int, limit: float) -> bool:
    if len(rows) != expected or not rows or not all(row.get("success") is True for row in rows):
        return False
    values = [row.get(key) for row in rows]
    if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in values):
        return False
    value = percentile(values, 0.95)
    return value is not None and value <= limit


def metadata_event(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        return {}
    payload = body.get("payload", {})
    approval = payload.get("approval", {}) if isinstance(payload, dict) else {}
    result = {
        key: body.get(key)
        for key in (
            "sourceId",
            "instanceId",
            "sessionId",
            "taskId",
            "sequence",
            "eventId",
            "kind",
        )
    }
    if isinstance(payload, dict):
        state = payload.get("state")
        if state in (
            "idle",
            "busy",
            "running",
            "completed",
            "error",
            "closed",
            "compacted",
            "approval.completed",
            "approval.pending",
            "approval.failed",
            "approval.replied",
        ):
            result["state"] = state
        metrics = payload.get("metrics")
        if isinstance(metrics, dict):
            result["plugin_metrics"] = {
                key: value
                for key, value in metrics.items()
                if type(value) in (int, float, bool)
                or key
                in (
                    "decision",
                    "source",
                    "reasonCode",
                    "originalDigest",
                    "requestId",
                )
            }
        for key in ("originalDigest", "relatedEventId", "reasonCode"):
            if key in payload:
                result[key] = payload[key]
    if isinstance(approval, dict) and approval:
        result["approvalId"] = approval.get("id")
        result["originalDigest"] = approval.get("originalDigest")
        choices = approval.get("choices")
        if isinstance(choices, list):
            result["choiceOrderDigest"] = hashlib.sha256(
                canonical_json(choices).encode()
            ).hexdigest()
            result["offlineChoiceId"] = next(
                (
                    choice.get("id")
                    for choice in choices
                    if isinstance(choice, dict) and choice.get("label") == OFFLINE
                ),
                None,
            )
    return result


class RecordingProxy:
    """Private relay; decisions are exclusively the real Coloop response."""

    def __init__(self, client: LocalJsonClient):
        self.client = client
        self.records: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def handle_request(self):
                started = time.perf_counter_ns()
                status, result = 500, {"error": "BENCH_RELAY_UNAVAILABLE"}
                body = None
                record: dict[str, Any] = {"path": self.path}
                try:
                    if self.headers.get("Origin") is not None or not hmac.compare_digest(
                        self.headers.get("Authorization", ""), owner.client.authorization
                    ):
                        status, result = 401, {"error": "UNAUTHORIZED"}
                    else:
                        if self.command == "POST":
                            length = int(self.headers.get("Content-Length", "0"))
                            if not 0 < length <= 131072:
                                raise AdapterError("BENCH_BODY_LIMIT")
                            body = parse_json(self.rfile.read(length))
                            record.update(metadata_event(body))
                            record["body_bytes"] = length
                        result = owner.client.request(self.command, self.path, body)
                        status = 200
                        if isinstance(result, dict):
                            record["response_metrics"] = result.get("metrics")
                            record["contextRef"] = result.get("contextRef")
                            decision = result.get("decision")
                            if isinstance(decision, dict):
                                record["decision"] = {
                                    key: decision.get(key)
                                    for key in (
                                        "decision",
                                        "choiceId",
                                        "reasonCode",
                                        "source",
                                    )
                                }
                except (AdapterError, ValueError, OSError) as error:
                    status = 502
                    result = {
                        "error": error.code
                        if isinstance(error, AdapterError)
                        else "BENCH_RELAY_ERROR"
                    }
                record["status"] = status
                record["elapsed_ms"] = (time.perf_counter_ns() - started) / 1_000_000
                with owner.lock:
                    owner.records.append(record)
                data = canonical_json(result).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (OSError, BrokenPipeError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    @property
    def port(self):
        return self.server.server_port

    def snapshot(self):
        with self.lock:
            return list(self.records)


@contextmanager
def reverse_forward(client: Any, local_port: int):
    """Bind only board loopback and connect only this private PC relay."""
    transport = client.get_transport()
    stopped = threading.Event()
    workers: list[threading.Thread] = []

    def relay(channel):
        local = None
        try:
            local = socket.create_connection(("127.0.0.1", local_port), timeout=5)
            local.settimeout(None)
            while not stopped.is_set():
                readable, _, _ = select.select([channel, local], [], [], 0.25)
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    (local if source is channel else channel).sendall(data)
        except (OSError, EOFError, SSHException):
            pass
        finally:
            channel.close()
            if local:
                local.close()

    def accept(channel, _origin, _destination):
        worker = threading.Thread(target=relay, args=(channel,), daemon=True)
        workers.append(worker)
        worker.start()

    port = transport.request_port_forward("127.0.0.1", 0, handler=accept)
    try:
        yield port
    finally:
        stopped.set()
        transport.cancel_port_forward("127.0.0.1", port)
        for worker in workers:
            worker.join(timeout=1)


def source_config(plugin_path: str, fixture_path: str | None = None) -> dict[str, Any]:
    value = config()
    value["plugin"] = ["file://" + plugin_path]
    value["default_agent"] = "coloop-question-smoke"
    value["agent"]["coloop-question-smoke"]["prompt"] = (
        "If history contains a completed question tool result, never call question again. "
        'Copy its selected option label and finish with exactly {"answer":"<label>"}. '
        "That result is the final user answer; no confirmation is needed. "
        "Otherwise call question exactly once with the user's arguments, "
        "preserving every label and empty description. Do not call other tools."
    )
    if fixture_path is not None:
        value["plugin"].append("file://" + fixture_path)
        value["agent"]["coloop-question-smoke"]["prompt"] = SOURCE_STAGE_INITIAL_PROMPT
    return value


@contextmanager
def guarded_forward(client: Any, remote_port: int, before_close=None):
    """SSH failures on an owned source become fixed benchmark errors, not tracebacks."""
    stopped = threading.Event()
    transport = client.get_transport()

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            channel = None
            try:
                channel = transport.open_channel(
                    "direct-tcpip", ("127.0.0.1", remote_port), self.client_address
                )
                while not stopped.is_set():
                    readable, _, _ = select.select([self.request, channel], [], [], 0.25)
                    for source in readable:
                        chunk = source.recv(65536)
                        if not chunk:
                            return
                        (channel if source is self.request else self.request).sendall(chunk)
            except (OSError, EOFError, SSHException):
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
        if before_close:
            before_close()
        stopped.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def source_process_state(client: Any, startup: dict[str, Any]) -> dict[str, Any]:
    return remote_json(
        client,
        "import json\nfrom pathlib import Path\np=Path('/proc')/"
        + repr(str(startup["pid"]))
        + "\nexists=p.exists()\nstate=(p/'stat').read_text().rsplit(')',1)[1].split()[0] if exists else None\nprint(json.dumps({'exists':exists,'state':state,'alive':exists and state!='Z'}))",
    )


def source_http_ready(client: Any, startup: dict[str, Any]) -> dict[str, Any]:
    authorization = (
        "Basic " + base64.b64encode(("opencode:" + startup["password"]).encode()).decode()
    )
    script = (
        r"""
import json,urllib.request,urllib.error,time
from pathlib import Path
started=time.monotonic(); attempts=0; last='SOURCE_HEALTH_UNAVAILABLE'
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
while time.monotonic()-started<20:
 attempts+=1
 process=Path('/proc')/str(SOURCE_PID)
 if not process.exists() or (process/'stat').read_text().rsplit(')',1)[1].split()[0]=='Z':
  last='SOURCE_PROCESS_EXITED';break
 try:
  request=urllib.request.Request(SOURCE_URL,headers={'Authorization':SOURCE_AUTH})
  with opener.open(request,timeout=1) as response:value=json.load(response)
  print(json.dumps({'healthy':value.get('healthy') is True,'version':value.get('version'),'ready_ms':(time.monotonic()-started)*1000,'attempts':attempts}));break
 except urllib.error.HTTPError as error:
  last='SOURCE_HEALTH_HTTP_'+str(error.code);break
 except Exception as error:
  last='SOURCE_HEALTH_'+type(error).__name__.upper()
  time.sleep(.1)
else:pass
if 'value' not in locals():print(json.dumps({'healthy':False,'reasonCode':last,'attempts':attempts,'ready_ms':(time.monotonic()-started)*1000}))
""".replace("SOURCE_PID", str(startup["pid"]))
        .replace("SOURCE_URL", repr("http://127.0.0.1:" + str(startup["port"]) + "/global/health"))
        .replace("SOURCE_AUTH", repr(authorization))
    )
    result = remote_json(client, script, timeout=25)
    if result.get("healthy") is not True or result.get("version") != "1.19.5":
        raise AdapterError(result.get("reasonCode", "SOURCE_HEALTH_MISMATCH"))
    return result


def bootstrap_script(
    root: str,
    service_port: int,
    hook_port: int,
    token: str,
    workspace: str,
    source_id: str,
    plugin_text: str,
    *,
    stage_fixture: bool = False,
) -> str:
    script = r"""
import json,os,secrets,socket,subprocess,tempfile,sys,time,urllib.request,hashlib,shutil
from pathlib import Path
root=Path(ROOT_DIR); process=None; activity=None; temporary=None; stage='memory_claim'; state={}
try:
 sys.path.insert(0,str(root/'agent'))
 from memory_client import MemoryClient
 memory=MemoryClient(root)
 activity='coloop-hooks-bench-'+secrets.token_hex(12)
 state=memory.request('/activity',{'session_id':activity,'active':True},timeout=5)
 if state['active_sessions']!=1: raise RuntimeError('OTHER_FOREGROUND_ACTIVITY')
 stage='memory_drain'
 memory.request('/ready-for-foreground',{},timeout=185)
 stage='memory_status'
 before=memory.request('/call',{'op':'status'},timeout=10)
 stage='model_health'
 key=(root/'.runtime/api-key').read_text().strip()
 request=urllib.request.Request('http://127.0.0.1:MODEL_PORT/health',headers={'Authorization':'Bearer '+key})
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=5) as response:health=json.load(response)
 if not (health.get('ready') is True and health.get('privacy_metadata_only') is True and health.get('model')=='qwen35-4b-rkllm'):raise RuntimeError('PRIVATE_MODEL_SERVICE_REQUIRED')
 resources={}
 for line in Path('/proc/meminfo').read_text().splitlines():
  name,value=line.split(':',1)
  if name in ('MemTotal','MemAvailable','SwapFree'):resources[name]=value.strip()
 temps=[]
 for p in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
  try:temps.append(float(p.read_text())/1000)
  except (OSError,ValueError):pass
 resources['max_temperature_c']=max(temps) if temps else None
 if temps and max(temps)>=80:raise RuntimeError('THERMAL_LIMIT')
 temporary=Path(tempfile.mkdtemp(prefix='coloop-hooks-bench-',dir=root/'.runtime'))
 for name in ('workspace','config','data','cache','logs'):(temporary/name).mkdir()
 stage='private_sdk_cache'
 sdk_source=root/'.runtime/config/opencode';sdk_target=temporary/'config/opencode'
 expected_lock=EXPECTED_SDK_LOCK
 if hashlib.sha256((sdk_source/'package-lock.json').read_bytes()).hexdigest()!=expected_lock:raise RuntimeError('PINNED_PLUGIN_SDK_LOCK_MISMATCH')
 if json.loads((sdk_source/'package.json').read_text()).get('dependencies')!={'@opencode-ai/plugin':'1.19.5'}:raise RuntimeError('PINNED_PLUGIN_SDK_DEPENDENCIES_MISMATCH')
 modules=sdk_source/'node_modules';files=[p for p in modules.rglob('*') if p.is_file()]
 if not files or any(p.is_symlink() or p.suffix.lower() in ('.node','.exe','.dll','.so','.dylib') for p in files):raise RuntimeError('PURE_JS_PLUGIN_SDK_REQUIRED')
 for name in ('plugin','sdk'):
  if json.loads((modules/'@opencode-ai'/name/'package.json').read_text()).get('version')!='1.19.5':raise RuntimeError('PINNED_PLUGIN_SDK_VERSION_MISMATCH')
 sdk_target.mkdir()
 for name in ('package.json','package-lock.json'):shutil.copy2(sdk_source/name,sdk_target/name)
 shutil.copytree(modules,sdk_target/'node_modules')
 cache={'version':'1.19.5','files':len(files),'lock_sha256':expected_lock,'pure_js':True,'isolated_copy':True}
 stage='private_hook_configuration'
 plugin=temporary/'coloop-hook.mjs';plugin.write_text(PLUGIN_TEXT)
 connection=temporary/'connection.json'
 fd=os.open(str(connection),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as stream:json.dump({'url':'http://127.0.0.1:HOOK_PORT','token':HOOK_TOKEN,'workspace':WORKSPACE,'sourceId':SOURCE_ID},stream)
 config=CONFIG_JSON
 config['plugin']=['file://'+str(plugin)]
 if STAGE_FIXTURE_ENABLED:
  fixture=temporary/'coloop-benchmark-source-stage.mjs';fixture.write_text(STAGE_FIXTURE_CODE)
  if hashlib.sha256(fixture.read_bytes()).hexdigest()!=STAGE_FIXTURE_SHA:raise RuntimeError('TEST_FIXTURE_HASH_MISMATCH')
  config['plugin'].append('file://'+str(fixture))
 (temporary/'config.json').write_text(json.dumps(config,ensure_ascii=False))
 with socket.socket() as allocator:allocator.bind(('127.0.0.1',0));port=allocator.getsockname()[1]
 password=secrets.token_urlsafe(32)
 env={'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),'HOME':str(temporary),
  'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','OPENCODE_CONFIG':str(temporary/'config.json'),
  'XDG_CONFIG_HOME':str(temporary/'config'),'XDG_DATA_HOME':str(temporary/'data'),
  'XDG_CACHE_HOME':str(temporary/'cache'),'OPENCODE_SERVER_USERNAME':'opencode',
  'OPENCODE_SERVER_PASSWORD':password,'RK_AGENT_API_KEY':key,'COLOOP_HOOK_CONNECTION':str(connection)}
 for flag in ('AUTOUPDATE','MODELS_FETCH','LSP_DOWNLOAD','DEFAULT_PLUGINS','PROJECT_CONFIG','AUTOCOMPACT','PRUNE','CLAUDE_CODE'):env['OPENCODE_DISABLE_'+flag]='true'
 stage='opencode_version'
 version=subprocess.run([str(root/'bin/opencode'),'--version'],env=env,check=True,capture_output=True,text=True).stdout.strip()
 offsets={name:(root/'logs'/name).stat().st_size if (root/'logs'/name).exists() else 0 for name in ('requests.jsonl','worker.log','bridge.log')}
 stage='source_spawn'
 with (temporary/'logs/server.log').open('wb') as log:
  process=subprocess.Popen([str(root/'bin/opencode'),'serve','--hostname=127.0.0.1','--port='+str(port),'--log-level=ERROR'],cwd=temporary/'workspace',env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 stage='source_spawn_check'
 time.sleep(.15)
 if process.poll() is not None:raise RuntimeError('SOURCE_PROCESS_EXITED')
 print(json.dumps({'directory':str(temporary/'workspace'),'temporary':str(temporary),'pid':process.pid,'port':port,'password':password,'activity':activity,'version':version,'log_offsets':offsets,'resources_before':resources,'model_health':{k:health.get(k) for k in ('model','context','runtime','worker_protocol','privacy_metadata_only')},'memory_before':before,'connection_mode':oct(connection.stat().st_mode&0o777),'plugin_sdk_cache':cache,'source_spawn_checked':True}))
except BaseException as failure:
 cleanup_result={'activity_released':False,'process_terminated':False,'connection_removed':False}
 if process is not None:
  try:
   import signal
   os.killpg(process.pid,signal.SIGTERM)
   cleanup_result['process_terminated']=True
  except OSError:pass
 if activity is not None:
  try:
   memory.request('/activity',{'session_id':activity,'active':False},timeout=5)
   cleanup_result['activity_released']=True
  except Exception:pass
 if temporary is not None:
  try:
   (temporary/'connection.json').unlink(missing_ok=True)
   cleanup_result['connection_removed']=True
  except OSError:pass
 import re
 message=str(failure)
 reason=message if re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}',message) else 'BOOTSTRAP_'+type(failure).__name__.upper()
 print(json.dumps({'startup_failed':True,'stage':stage,'reasonCode':reason,'active_sessions_after_claim':state.get('active_sessions'),'temporary':str(temporary) if temporary is not None else None,'cleanup':cleanup_result}))
"""
    replacements = {
        "ROOT_DIR": repr(root),
        "MODEL_PORT": str(service_port),
        "HOOK_PORT": str(hook_port),
        "HOOK_TOKEN": repr(token),
        "WORKSPACE": repr(workspace),
        "SOURCE_ID": repr(source_id),
        "PLUGIN_TEXT": repr(plugin_text),
        "CONFIG_JSON": repr(
            source_config("placeholder", "fixture-placeholder" if stage_fixture else None)
        ),
        "STAGE_FIXTURE_ENABLED": repr(stage_fixture),
        "STAGE_FIXTURE_CODE": repr(SOURCE_STAGE_FIXTURE),
        "STAGE_FIXTURE_SHA": repr(source_fixture_manifest()["code_sha256"]),
        "EXPECTED_SDK_LOCK": repr(
            hashlib.sha256(
                (ROOT / "rk-opencode/plugins/package-lock.json").read_bytes()
            ).hexdigest()
        ),
    }
    for key, value in replacements.items():
        script = script.replace(key, value)
    compile(script, "<private-hook-bootstrap>", "exec")
    return script


def resource_sample(client, root: str) -> dict[str, Any]:
    return remote_json(
        client,
        r"""
import json
from pathlib import Path
temps=[]
for p in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
 try:temps.append(float(p.read_text())/1000)
 except (OSError,ValueError):pass
memory={}
for line in Path('/proc/meminfo').read_text().splitlines():
 name,value=line.split(':',1)
 if name in ('MemAvailable','SwapFree'):memory[name]=value.strip()
print(json.dumps({'max_temperature_c':max(temps) if temps else None,'memory':memory}))
""",
    )


def memory_status(client, root: str) -> dict[str, Any]:
    return remote_json(
        client,
        "import json,sys\nfrom pathlib import Path\nroot=Path("
        + repr(root)
        + ")\nsys.path.insert(0,str(root/'agent'))\n"
        "from memory_client import MemoryClient\n"
        "print(json.dumps(MemoryClient(root).request('/call',{'op':'status'},timeout=10)))",
    )


def envelope(source: str, instance: str, sequence: int, kind="message", **payload):
    return {
        "version": 1,
        "source": "opencode",
        "sourceId": source,
        "instanceId": instance,
        "sessionId": "bench-ingest-session",
        "taskId": "bench-ingest-task",
        "sequence": sequence,
        "eventId": "event-" + uuid4().hex,
        "kind": kind,
        "workspace": str(ROOT),
        "payload": payload,
    }


def valid_receipt(receipt: Any, event: dict[str, Any]) -> bool:
    return (
        isinstance(receipt, dict)
        and receipt.get("version") == 1
        and all(
            receipt.get(key) == event[key]
            for key in ("sourceId", "instanceId", "eventId", "sequence")
        )
        and type(receipt.get("contextBytes")) is int
        and 0 <= receipt["contextBytes"] <= 8192
        and type(receipt.get("contextEvents")) is int
        and 0 <= receipt["contextEvents"] <= 16
    )


def is_success_receipt(record: dict[str, Any]) -> bool:
    return (
        record.get("kind") == "status"
        and record.get("state") == "approval.completed"
        and record.get("status") == 200
    )


def source_completion_ready(complete, state, records, session_id):
    """Business idle can precede the plugin's independently queued consumption receipt."""
    return (
        complete is True
        and state.get("type", "idle") == "idle"
        and any(row.get("sessionId") == session_id and is_success_receipt(row) for row in records)
    )


def receipt_duration(record: dict[str, Any]) -> float | None:
    value = record.get("plugin_metrics", {}).get("hookToConsumedMs")
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def receipt_binding_verified(approvals: list[dict], receipts: list[dict]) -> bool:
    if len(approvals) != 1 or len(receipts) != 1:
        return False
    event_id = approvals[0].get("eventId")
    digest = approvals[0].get("originalDigest")
    return (
        isinstance(event_id, str)
        and bool(event_id)
        and isinstance(digest, str)
        and bool(digest)
        and receipts[0].get("relatedEventId") == event_id
        and receipts[0].get("originalDigest") == digest
    )


def local_audit_offsets(connection: Path) -> dict[str, int]:
    return {str(p): p.stat().st_size for p in connection.parent.glob("*.jsonl") if p.is_file()}


def check_local_audits(connection: Path, offsets: dict[str, int], canary: str):
    rows = []
    for path in connection.parent.glob("*.jsonl"):
        with path.open("rb") as stream:
            stream.seek(offsets.get(str(path), 0))
            data = stream.read()
        rows.append(
            {
                "path": str(path),
                "added_bytes": len(data),
                "canary_occurrences": data.count(canary.encode()),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
    return {"files": rows, "passed": all(row["canary_occurrences"] == 0 for row in rows)}


def context_checks(client: LocalJsonClient, source: str, tracked: dict):
    """Actual HTTP budget and scope checks; no NPU and no manufactured approvals."""
    checks = {}
    first = envelope(source, "context-" + uuid4().hex, 1, text="First task evidence")

    def send(event):
        key = tuple(event[name] for name in ("sourceId", "instanceId", "sessionId", "taskId"))
        result = client.request("POST", "/v1/hooks", event)
        tracked[key] = event
        return result

    initial = send(first)
    duplicate = send(first)
    checks["duplicate_event_is_idempotent"] = duplicate.get("duplicate") is True and duplicate.get(
        "contextEvents"
    ) == initial.get("contextEvents")
    conflict = {**first, "payload": {"text": "Changed text for same ID"}}
    try:
        client.request("POST", "/v1/hooks", conflict)
        checks["conflicting_event_rejected"] = False
    except AdapterError:
        checks["conflicting_event_rejected"] = True
    task_b = {
        **first,
        "taskId": "task-b",
        "eventId": "event-" + uuid4().hex,
        "payload": {"text": "Separate task evidence"},
    }
    second = send(task_b)
    checks["task_isolation"] = second.get("contextEvents") == 1
    session_b = {**task_b, "sessionId": "session-b", "eventId": "event-" + uuid4().hex}
    third = send(session_b)
    checks["session_isolation"] = third.get("contextEvents") == 1
    huge = {
        **first,
        "sequence": 2,
        "eventId": "event-" + uuid4().hex,
        "payload": {"text": "Long synthetic data " * 1000},
    }
    bounded = send(huge)
    checks["oversized_context_omitted_within_budget"] = (
        type(bounded.get("contextBytes")) is int
        and bounded["contextBytes"] <= 8192
        and type(bounded.get("contextEvents")) is int
        and bounded["contextEvents"] <= 16
    )
    closed = {
        **huge,
        "kind": "closed",
        "sequence": 3,
        "eventId": "event-" + uuid4().hex,
        "payload": {},
    }
    send(closed)
    replay = {**first, "sequence": 4, "eventId": "event-" + uuid4().hex}
    try:
        client.request("POST", "/v1/hooks", replay)
        checks["closed_scope_replay_rejected"] = False
    except AdapterError:
        checks["closed_scope_replay_rejected"] = True
    checks["ttl_unit_test_required"] = True
    return {
        "checks": checks,
        "passed": all(checks.values()),
        "ttl_measured": False,
        "ttl_note": "300 second expiry is tested with a fake clock in service unit tests; not claimed as an elapsed real-hardware test",
    }


def summarize_result(report, samples, ingests, rules, args):
    measured = [row for row in samples if not row["warmup"]]
    report["actual_samples"] = len(measured)
    report["actual_hook_samples"] = len(ingests)
    report["failed_samples"] = sum(row.get("success") is not True for row in measured)
    report["cold_first"] = samples[0] if samples else None
    report["ingest"] = distribution([row["elapsed_ms"] for row in ingests])
    report["rules"] = distribution([row["elapsed_ms"] for row in rules])
    report["asked_to_consumed"] = distribution(
        [
            row["asked_to_consumed_ms"]
            for row in measured
            if row.get("asked_to_consumed_ms") is not None
        ]
    )
    report["task_total"] = distribution([row["task_total_ms"] for row in measured])
    report["targets_passed"] = {
        "ingest": timing_pass(ingests, "elapsed_ms", args.hook_samples, INGEST_P95_MS),
        "rules": timing_pass(rules, "elapsed_ms", 10, RULE_P95_MS),
        "asked_to_consumed": timing_pass(
            measured, "asked_to_consumed_ms", args.samples, CONSUMED_P95_MS
        ),
        "required_sample_sizes": (
            len(measured) >= 20
            and len(measured) == args.samples
            and len(samples) == args.samples + args.warmup
            and sum(row["warmup"] is True for row in samples) == args.warmup == 1
            and len(ingests) >= 100
            and len(ingests) == args.hook_samples
            and len(rules) == 10
        ),
    }
    report["functionalityPassed"] = (
        "failure_code" not in report
        and len(samples) == args.samples + args.warmup
        and all(row.get("success") is True for row in samples)
        and len(ingests) == args.hook_samples
        and all(row.get("success") is True for row in ingests)
        and len(rules) == 10
        and all(row.get("success") is True for row in rules)
        and report.get("context_isolation", {}).get("passed") is True
        and report.get("no_long_term_memory_writes") is True
        and report.get("all_own_sessions_deleted") is True
        and report.get("private_model_logs") is True
        and report.get("remote_connection_removed") is True
        and report.get("local_audit_scan", {}).get("passed") is True
        and report.get("synthetic_scope_cleanup", {}).get("failed") == 0
    )
    report["performancePassed"] = all(report["targets_passed"].values())
    report["passed"] = (
        report["functionalityPassed"] and report["performancePassed"] and not args.pilot
    )


def experiment_timeout(value: str) -> int:
    try:
        seconds = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("whole-experiment timeout must be an integer") from error
    if not 30 <= seconds <= 1800:
        raise argparse.ArgumentTypeError("whole-experiment timeout must be in 30..1800 seconds")
    return seconds


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--hook-samples", type=int, default=100)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument(
        "--timeout",
        type=experiment_timeout,
        default=1200,
        help="WHOLE experiment budget, 30..1800 seconds (default: 1200); per-review/model timeouts remain unchanged",
    )
    parser.add_argument(
        "--pilot",
        action="store_true",
        help="Check functionality with a small sample; never claim formal performance acceptance",
    )
    return parser


def main() -> int:
    parser = argument_parser()
    args = parser.parse_args()
    if not 1 <= args.samples <= 50 or not 1 <= args.hook_samples <= 1000 or args.warmup != 1:
        parser.error("samples must be 1..50, hook-samples 1..1000, warmup must be 1")
    args.output_dir.mkdir(parents=True, exist_ok=False)
    report: dict[str, Any] = {
        "passed": False,
        "source": "native-opencode-plugin",
        "synthetic_only": True,
        "ocr_used": False,
        "approval_python_polling": False,
        "cloud_used": False,
        "warmup_separate": True,
        "warmup_note": "model already ready before experiment; first sample is not a model cold boot",
        "thresholds_ms": {
            "ingest_p95": INGEST_P95_MS,
            "rule_p95": RULE_P95_MS,
            "asked_to_consumed_p95": CONSUMED_P95_MS,
        },
        "requested_samples": args.samples,
        "requested_hook_samples": args.hook_samples,
        "pilot": args.pilot,
        "question_order": "alternating-index-parity",
        "whole_experiment_budget_seconds": args.timeout,
        "source_fixture": source_fixture_manifest(),
    }
    startup: dict[str, Any] = {}
    client = None
    proxy = None
    secrets: list[str] = []
    samples: list[dict[str, Any]] = []
    ingests: list[dict[str, Any]] = []
    rules: list[dict[str, Any]] = []
    messages: list[dict[str, Any]] = []
    resources = []
    own_sessions: list[str] = []
    injected: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    coordinator = None
    http = None
    canary = "HookCanary_" + uuid4().hex
    audit_offsets = local_audit_offsets(args.connection)
    started = time.monotonic()
    deadline = started + args.timeout
    try:
        if not os.environ.get("RK_BOARD_PASSWORD"):
            raise AdapterError("RK_BOARD_PASSWORD_REQUIRED")
        if not HOOK_PLUGIN.is_file():
            raise AdapterError("NATIVE_HOOK_PLUGIN_REQUIRED")
        coordinator = coordinator_client(args.connection)
        secrets += [coordinator.authorization.removeprefix("Bearer "), canary]
        coordinator.request("GET", "/health")
        spec = importlib.util.spec_from_file_location("rk_hook_host", ROOT / "rk-opencode/host.py")
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        cfg = json.loads((ROOT / "config/board.json").read_text(encoding="utf-8-sig"))
        remote_root = cfg.get("agent_dir", host.REMOTE)
        if remote_root != host.REMOTE:
            raise AdapterError("BENCHMARK_PINNED_AGENT_ROOT_REQUIRED")
        report["phase"] = "connecting_pinned_ssh"
        client = host.connect()
        source_id = "hook-bench-" + uuid4().hex
        with RecordingProxy(coordinator) as proxy, reverse_forward(client, proxy.port) as hook_port:
            token = coordinator.authorization.removeprefix("Bearer ")
            report["phase"] = "starting_isolated_source"
            startup = remote_json(
                client,
                bootstrap_script(
                    remote_root,
                    cfg.get("agent_port", 8088),
                    hook_port,
                    token,
                    str(ROOT),
                    source_id,
                    HOOK_PLUGIN.read_text(encoding="utf-8"),
                    stage_fixture=True,
                ),
                timeout=210,
            )
            if startup.get("startup_failed"):
                report["bootstrap_diagnostics"] = startup
                reason = startup.get("reasonCode", "BOOTSTRAP_FAILED")
                startup = {}
                raise AdapterError(reason)
            secrets.append(startup["password"])
            report.update(
                {
                    key: startup[key]
                    for key in (
                        "version",
                        "resources_before",
                        "model_health",
                        "memory_before",
                        "connection_mode",
                        "plugin_sdk_cache",
                        "source_spawn_checked",
                    )
                }
            )
            if startup["version"] != "1.19.5" or startup["connection_mode"] != "0o600":
                raise AdapterError("ISOLATED_SOURCE_CONFIGURATION_MISMATCH")
            report["phase"] = "checking_source_http_readiness"
            report["source_health"] = source_http_ready(client, startup)

            def close_sessions():
                if not http:
                    return
                query = "?" + urlencode({"directory": startup["directory"]})
                for session_id in list(own_sessions):
                    try:
                        path = "/session/" + quote(session_id, safe="")
                        http.send("POST", path + "/abort" + query)
                        http.send("DELETE", path + query)
                        own_sessions.remove(session_id)
                    except AdapterError:
                        pass

            with guarded_forward(client, startup["port"], close_sessions) as url:
                basic = base64.b64encode(("opencode:" + startup["password"]).encode()).decode()
                http = BenchmarkHttp(url, "Basic " + basic)
                startup_deadline = min(deadline, time.monotonic() + 15)
                while True:
                    state = source_process_state(client, startup)
                    if not state["alive"]:
                        report["source_process_state"] = state
                        raise AdapterError("SOURCE_PROCESS_EXITED")
                    try:
                        if http.send("GET", "/global/health").get("healthy") is True:
                            break
                    except AdapterError:
                        pass
                    if time.monotonic() >= startup_deadline:
                        raise AdapterError("OPENCODE_START_TIMEOUT")
                    time.sleep(0.1)
                query = "?" + urlencode({"directory": startup["directory"]})
                report["phase"] = "observation_ingest_load"
                load_instance = "load-" + uuid4().hex
                for index in range(args.hook_samples):
                    item = envelope(
                        source_id + "-load",
                        load_instance,
                        index + 1,
                        text="Synthetic local development observation " + str(index),
                    )
                    tick = time.perf_counter_ns()
                    result = coordinator.request("POST", "/v1/hooks", item)
                    injected[
                        tuple(
                            item[name] for name in ("sourceId", "instanceId", "sessionId", "taskId")
                        )
                    ] = item
                    metrics = result.get("metrics", {}) if isinstance(result, dict) else {}
                    elapsed = (time.perf_counter_ns() - tick) / 1_000_000
                    ingests.append(
                        {
                            "sample": index,
                            "source": "synthetic-ingest-load",
                            "success": valid_receipt(result, item),
                            "elapsed_ms": elapsed,
                            "metrics": metrics,
                            "contextBytes": result.get("contextBytes"),
                            "contextEvents": result.get("contextEvents"),
                        }
                    )
                secret = envelope(
                    source_id + "-privacy", "privacy-" + uuid4().hex, 1, text="password=" + canary
                )
                coordinator.request("POST", "/v1/hooks", secret)
                injected[
                    tuple(
                        secret[name] for name in ("sourceId", "instanceId", "sessionId", "taskId")
                    )
                ] = secret
                for index in range(10):
                    report["phase"] = "deterministic_rule_review"
                    approval = {
                        "kind": "permission",
                        "id": "rule-" + uuid4().hex,
                        "sessionId": "bench-ingest-session",
                        "originalDigest": hashlib.sha256(str(index).encode()).hexdigest(),
                        "tool": "read",
                        "patterns": [str(ROOT / ".env")],
                    }
                    item = envelope(
                        source_id + "-rules",
                        "rules-" + uuid4().hex,
                        1,
                        "approval",
                        approval=approval,
                    )
                    tick = time.perf_counter_ns()
                    result = coordinator.request("POST", "/v1/hooks/review", item)
                    injected[
                        tuple(
                            item[name] for name in ("sourceId", "instanceId", "sessionId", "taskId")
                        )
                    ] = item
                    decision = result.get("decision", {})
                    rules.append(
                        {
                            "sample": index,
                            "source": "synthetic-rule-request",
                            "success": decision.get("decision") == "deny"
                            and decision.get("source") == "policy",
                            "elapsed_ms": (time.perf_counter_ns() - tick) / 1_000_000,
                        }
                    )

                report["context_isolation"] = context_checks(
                    coordinator, source_id + "-context", injected
                )
                if not report["context_isolation"]["passed"]:
                    raise AdapterError("HOOK_CONTEXT_CHECK_FAILED")
                for index in range(args.warmup + args.samples):
                    if time.monotonic() >= deadline:
                        raise AdapterError("BENCHMARK_TIMEOUT")
                    resource = resource_sample(client, remote_root)
                    resources.append({"sample": index, **resource})
                    if (resource.get("max_temperature_c") or 0) >= 80:
                        raise AdapterError("THERMAL_LIMIT")
                    report["phase"] = "creating_source_session"
                    session = http.send(
                        "POST",
                        "/session" + query,
                        {
                            "title": "Synthetic native hook approval benchmark " + str(index),
                            "permission": [
                                {"permission": "*", "pattern": "*", "action": "deny"},
                                {"permission": "question", "pattern": "*", "action": "allow"},
                            ],
                        },
                    )
                    session_id = session["id"]
                    own_sessions.append(session_id)
                    task_start = time.perf_counter_ns()
                    report["phase"] = "submitting_source_prompt"
                    arguments = question_arguments(index)
                    expected_index = index % 2
                    arguments_hash = hashlib.sha256(canonical_json(arguments).encode()).hexdigest()
                    http.send(
                        "POST",
                        "/session/" + quote(session_id, safe="") + "/prompt_async" + query,
                        {
                            "agent": "coloop-question-smoke",
                            "model": {"providerID": "rkllm", "modelID": "qwen35-4b-rkllm"},
                            "parts": [
                                {
                                    "type": "text",
                                    "text": "Call question now using exactly these arguments: "
                                    + canonical_json(arguments),
                                }
                            ],
                        },
                    )
                    path = "/session/" + quote(session_id, safe="")
                    report["phase"] = "waiting_for_native_hook_consumption"
                    current_messages = []
                    complete = False
                    source_error = False
                    while time.monotonic() < deadline:
                        current_messages = http.send("GET", path + "/message" + query)
                        tools, texts = collect_messages(current_messages)
                        complete = (
                            bool(tools)
                            and all(part.get("tool") == "question" for part in tools)
                            and any(
                                part.get("state", {}).get("status") == "completed"
                                and OFFLINE
                                in canonical_json(part.get("state", {}).get("output", ""))
                                for part in tools
                            )
                            and any(OFFLINE in text for text in texts)
                        )
                        state = http.send("GET", "/session/status" + query).get(session_id, {})
                        if source_completion_ready(complete, state, proxy.snapshot(), session_id):
                            break
                        source_error = any(
                            message.get("info", {}).get("error") for message in current_messages
                        )
                        if source_error and state.get("type", "idle") == "idle":
                            break
                        failures = [
                            r
                            for r in proxy.snapshot()
                            if r.get("sessionId") == session_id
                            and r.get("state") in ("approval.failed", "approval.pending")
                        ]
                        repeated_questions = (
                            sum(
                                r.get("sessionId") == session_id and r.get("kind") == "approval"
                                for r in proxy.snapshot()
                            )
                            > 1
                        )
                        if failures or repeated_questions:
                            break
                        time.sleep(0.05)
                    source_records = [
                        r
                        for r in proxy.snapshot()
                        if r.get("sourceId") == source_id and r.get("sessionId") == session_id
                    ]
                    receipts = [r for r in source_records if is_success_receipt(r)]
                    approvals = [r for r in source_records if r.get("kind") == "approval"]
                    bound_receipt = receipt_binding_verified(approvals, receipts)
                    pending = http.send("GET", "/question" + query)
                    consumed = not any(p.get("sessionID") == session_id for p in pending)
                    duration = receipt_duration(receipts[0]) if len(receipts) == 1 else None
                    selected = (
                        len(approvals) == 1
                        and approvals[0].get("decision", {}).get("decision") == "select"
                        and approvals[0].get("decision", {}).get("source") == "rk"
                        and approvals[0].get("offlineChoiceId") == str(expected_index)
                        and approvals[0].get("decision", {}).get("choiceId") == str(expected_index)
                    )
                    row = {
                        "sample": index,
                        "warmup": index < args.warmup,
                        "sessionId": session_id,
                        "success": bool(
                            complete
                            and consumed
                            and selected
                            and len(receipts) == 1
                            and duration is not None
                            and bound_receipt
                        ),
                        "asked_to_consumed_ms": duration,
                        "task_total_ms": (time.perf_counter_ns() - task_start) / 1_000_000,
                        "receipt_count": len(receipts),
                        "approval_count": len(approvals),
                        "receipt_binding_verified": bound_receipt,
                        "source_hook_kinds": sorted(
                            {r.get("kind") for r in source_records if r.get("kind")}
                        ),
                        "pending_consumed": consumed,
                        "source_error": source_error,
                        "source": "real-native-opencode-plugin",
                        "expected_offline_index": expected_index,
                        "question_arguments_sha256": arguments_hash,
                        "original_pending_digest": approvals[0].get("originalDigest")
                        if len(approvals) == 1
                        else None,
                        "actual_offline_choice_id": approvals[0].get("offlineChoiceId")
                        if len(approvals) == 1
                        else None,
                    }
                    samples.append(row)
                    messages.append(
                        {"sample": index, "sessionId": session_id, "messages": current_messages}
                    )
                    http.send("POST", path + "/abort" + query)
                    http.send("DELETE", path + query)
                    own_sessions.remove(session_id)
                    closed_deadline = min(deadline, time.monotonic() + 2)
                    while time.monotonic() < closed_deadline:
                        if any(
                            r.get("sourceId") == source_id
                            and r.get("sessionId") == session_id
                            and r.get("kind") == "closed"
                            and r.get("status") == 200
                            for r in proxy.snapshot()
                        ):
                            break
                        time.sleep(0.05)
                    row["source_closed_hook_seen"] = any(
                        r.get("sourceId") == source_id
                        and r.get("sessionId") == session_id
                        and r.get("kind") == "closed"
                        and r.get("status") == 200
                        for r in proxy.snapshot()
                    )
                    row["source_hook_kinds"] = sorted(
                        {
                            r.get("kind")
                            for r in proxy.snapshot()
                            if r.get("sourceId") == source_id
                            and r.get("sessionId") == session_id
                            and r.get("status") == 200
                            and r.get("kind")
                        }
                    )
                    row["all_native_observation_hooks_seen"] = {
                        "message",
                        "tool.before",
                        "tool.after",
                        "status",
                        "approval",
                        "closed",
                    } <= set(row["source_hook_kinds"])
                    row["success"] = (
                        row["success"]
                        and row["source_closed_hook_seen"]
                        and row["all_native_observation_hooks_seen"]
                    )
                    (args.output_dir / "progress.json").write_text(
                        json.dumps(
                            {
                                "completed": len(samples),
                                "requested_including_warmup": args.samples + args.warmup,
                                "samples": [
                                    {
                                        key: sample.get(key)
                                        for key in (
                                            "sample",
                                            "warmup",
                                            "success",
                                            "asked_to_consumed_ms",
                                            "expected_offline_index",
                                        )
                                    }
                                    for sample in samples
                                ],
                            },
                            indent=2,
                        ),
                        encoding="utf-8",
                    )
                    if not row["success"]:
                        raise AdapterError("REAL_HOOK_SAMPLE_FAILED")
                report["memory_after"] = memory_status(client, remote_root)
                before, after = startup["memory_before"], report["memory_after"]
                report["no_long_term_memory_writes"] = all(
                    before.get(key) == after.get(key)
                    for key in ("active_facts", "archived_versions", "capsules", "jobs")
                )
                report["all_own_sessions_deleted"] = not own_sessions
                report["phase"] = "completed_source_samples"
        measured = [row for row in samples if not row["warmup"]]
        report["cold_first"] = samples[0] if samples else None
        report["ingest"] = distribution([row["elapsed_ms"] for row in ingests])
        report["rules"] = distribution([row["elapsed_ms"] for row in rules])
        report["asked_to_consumed"] = distribution(
            [
                row["asked_to_consumed_ms"]
                for row in measured
                if row["asked_to_consumed_ms"] is not None
            ]
        )
        report["task_total"] = distribution([row["task_total_ms"] for row in measured])
        report["targets_passed"] = {
            "ingest": timing_pass(ingests, "elapsed_ms", args.hook_samples, INGEST_P95_MS),
            "rules": timing_pass(rules, "elapsed_ms", 10, RULE_P95_MS),
            "asked_to_consumed": timing_pass(
                measured, "asked_to_consumed_ms", args.samples, CONSUMED_P95_MS
            ),
            "required_sample_sizes": args.hook_samples >= 100 and args.samples >= 20,
        }
        report["passed"] = (
            all(report["targets_passed"].values())
            and report["no_long_term_memory_writes"]
            and report["all_own_sessions_deleted"]
        )
    except Exception as error:
        report["failure_code"] = (
            error.code if isinstance(error, AdapterError) else type(error).__name__
        )
        if client and startup:
            try:
                report["source_process_state"] = source_process_state(client, startup)
            except Exception:
                report["source_process_state"] = {"unknown": True}
    finally:
        if http is not None:
            report["source_http_errors"] = http.errors
        measured = [row for row in samples if not row["warmup"]]
        report["actual_samples"] = len(measured)
        report["actual_hook_samples"] = len(ingests)
        report["failed_samples"] = sum(row.get("success") is not True for row in measured)
        report["cold_first"] = samples[0] if samples else None
        report["ingest"] = distribution([row["elapsed_ms"] for row in ingests])
        report["rules"] = distribution([row["elapsed_ms"] for row in rules])
        report["asked_to_consumed"] = distribution(
            [
                row["asked_to_consumed_ms"]
                for row in measured
                if row["asked_to_consumed_ms"] is not None
            ]
        )
        report["task_total"] = distribution([row["task_total_ms"] for row in measured])
        if coordinator:
            released = failed = 0
            for item in injected.values():
                if item["kind"] == "closed":
                    continue
                closed = {
                    **item,
                    "kind": "closed",
                    "sequence": item["sequence"] + 1,
                    "eventId": "close-" + uuid4().hex,
                    "payload": {},
                }
                try:
                    coordinator.request("POST", "/v1/hooks", closed)
                    released += 1
                except AdapterError:
                    failed += 1
            report["synthetic_scope_cleanup"] = {"released": released, "failed": failed}
            if failed:
                report["passed"] = False
        if client:
            if startup:
                try:
                    report["cleanup"] = cleanup(client, startup)
                    report["private_model_logs"] = (
                        report["cleanup"]["requests.jsonl"]["metadata_only"]
                        and report["cleanup"]["worker.log"]["added_bytes"] == 0
                    )
                    report["passed"] = report["passed"] and report["private_model_logs"]
                    remote_json(
                        client,
                        "from pathlib import Path\np=Path("
                        + repr(startup["temporary"] + "/connection.json")
                        + ")\np.unlink(missing_ok=True)\nprint('{}')",
                    )
                    report["remote_connection_removed"] = True
                except Exception as error:
                    report["cleanup_error"] = type(error).__name__
                    report["passed"] = False
            client.close()
        report["local_audit_scan"] = check_local_audits(args.connection, audit_offsets, canary)
        report["passed"] = report["passed"] and report["local_audit_scan"]["passed"]
        report["elapsed_seconds"] = time.monotonic() - started
        report["native_plugin_sha256"] = (
            hashlib.sha256(HOOK_PLUGIN.read_bytes()).hexdigest() if HOOK_PLUGIN.exists() else None
        )
        summarize_result(report, samples, ingests, rules, args)
        records = proxy.snapshot() if proxy else []
        for name, value in (
            ("summary.json", report),
            ("samples.json", samples),
            ("ingest.json", ingests),
            ("rules.json", rules),
            ("hook-records.json", records),
            ("messages.json", messages),
            ("resources.json", resources),
            (
                "config.json",
                source_config("<private-plugin-copy>", "<private-test-stage-fixture-copy>"),
            ),
        ):
            (args.output_dir / name).write_text(
                json.dumps(sanitize(value, secrets), ensure_ascii=False, indent=2), encoding="utf-8"
            )
    print(
        canonical_json(
            {
                "passed": report["passed"],
                "output_dir": str(args.output_dir),
                "failure_code": report.get("failure_code"),
                "functionalityPassed": report.get("functionalityPassed"),
                "performancePassed": report.get("performancePassed"),
                "pilot": args.pilot,
            }
        )
    )
    return 0 if report["passed"] or (args.pilot and report["functionalityPassed"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
