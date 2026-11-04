"""One real no-attach OpenCode mini task through its in-process SDK fetch.

Requires a connected Coloop and RK_BOARD_PASSWORD. Run serially with other NPU
work. Stock noninteractive ``run --format json`` denies the question tool, so
this smoke uses the stock ``--mini`` PTY path, without overriding permissions.
The terminal receives no approval keystrokes. This is a functionality smoke,
not the 20-sample latency benchmark. Source logs stay in a private board folder.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import threading
import time
from typing import Any
from uuid import uuid4

from bench_coloop_hooks import (
    HOOK_PLUGIN,
    ROOT,
    RecordingProxy,
    bootstrap_script,
    is_success_receipt,
    memory_status,
    question_arguments,
    receipt_duration,
    resource_sample,
    reverse_forward,
    source_config,
)
from coloop_agent import AdapterError, canonical_json, coordinator_client
from smoke_coloop_opencode import OFFLINE, remote_json, sanitize


# This guardian owns the PTY for the lifetime of the isolated mini process.
# Only terminal cursor-position replies are injected; no Enter/choice input.
RUNNER_SOURCE = r'''
import fcntl,hashlib,json,os,pty,select,signal,struct,subprocess,sys,termios,time
from pathlib import Path
base=Path(__file__).resolve().parent
process=None; stopping=False; replies=0; total=0; kept=0; digest=hashlib.sha256()
def save(**values):
 state={'runner_pid':os.getpid(),'source_pid':process.pid if process else None,
        'terminal_cursor_replies':replies,'approval_keys_sent':0,
        'log_bytes':total,'log_kept_bytes':kept,'log_sha256':digest.hexdigest(),**values}
 path=base/'state.next';path.write_text(json.dumps(state));os.replace(path,base/'state.json')
def stop(*_):
 global stopping
 stopping=True
 if process and process.poll() is None:
  try:os.killpg(process.pid,signal.SIGTERM)
  except ProcessLookupError:pass
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
def controlling_terminal():fcntl.ioctl(slave,termios.TIOCSCTTY,0)
prompt=(base/'prompt.txt').read_text()
command=[os.environ['INTERNAL_OPENCODE_BIN'],'--mini','--prompt',prompt,
         '--agent','coloop-question-smoke','--log-level=ERROR']
deadline=time.monotonic()+int(os.environ['INTERNAL_SMOKE_TIMEOUT'])
with (base/'logs/terminal.log').open('wb') as log:
 try:
  process=subprocess.Popen(command,cwd=base/'workspace',stdin=slave,stdout=slave,
    stderr=slave,env=os.environ.copy(),start_new_session=True,preexec_fn=controlling_terminal)
  os.close(slave);slave=-1
  birth=Path('/proc')/str(process.pid)/'stat'
  save(running=True,source_start_ticks=birth.read_text().rsplit(')',1)[1].split()[19])
  tail=b''
  while process.poll() is None:
   if time.monotonic()>=deadline:stop()
   if stopping:break
   if select.select([master],[],[],.2)[0]:
    try:data=os.read(master,65536)
    except OSError:break
    if not data:break
    total+=len(data);digest.update(data)
    amount=min(len(data),max(0,2097152-kept))
    if amount:log.write(data[:amount]);log.flush();kept+=amount
    probe=tail+data
    for _ in range(probe.count(b'\x1b[6n')):
     os.write(master,b'\x1b[1;1R');replies+=1
    tail=probe[-3:]
   save(running=True,source_start_ticks=birth.read_text().rsplit(')',1)[1].split()[19])
 finally:
  stop()
  if process:
   try:process.wait(timeout=4)
   except subprocess.TimeoutExpired:
    os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=3)
  if slave!=-1:os.close(slave)
  os.close(master)
  save(running=False,exit_code=process.returncode if process else None)
'''


class ObservationClient:
    """Keep only synthetic result predicates; relay decisions unchanged."""

    def __init__(self, client):
        self.client = client
        self.authorization = client.authorization
        self.lock = threading.Lock()
        self.parts: dict[str, bool] = {}
        self.tool_completed_offline = False

    def request(self, method, path, body=None):
        response = self.client.request(method, path, body)
        if method == "POST" and isinstance(body, dict):
            payload = body.get("payload", {})
            if isinstance(payload, dict):
                with self.lock:
                    if body.get("kind") == "tool.after" and payload.get("tool") == "question":
                        self.tool_completed_offline |= (
                            payload.get("state") == "completed"
                            and OFFLINE in str(payload.get("text", ""))
                        )
                    if body.get("kind") == "message" and payload.get("role") == "assistant":
                        # protocol.decode unwraps the model's {"answer": label}
                        # into OpenCode assistant content=label before this hook.
                        self.parts[str(payload.get("partId"))] = payload.get("text") == OFFLINE
        return response

    def snapshot(self):
        with self.lock:
            return {
                "question_tool_completed_with_offline": self.tool_completed_offline,
                "assistant_final_exact_offline": any(self.parts.values()),
            }


def internal_bootstrap(root, model_port, hook_port, token, source_id, plugin, timeout):
    # Reuse the frozen benchmark's strict private SDK/config/lease preparation.
    # Deliberately discard its TCP serve spawn and its exception tail.
    prepared = bootstrap_script(root, model_port, hook_port, token, str(ROOT), source_id, plugin)
    marker = " stage='source_spawn'\n"
    if prepared.count(marker) != 1:
        raise AdapterError("ISOLATION_BOOTSTRAP_INTERFACE_CHANGED")
    prefix = prepared.split(marker, 1)[0]
    prefix = prefix.replace("prefix='coloop-hooks-bench-'", "prefix='coloop-internal-smoke-'")
    prefix = prefix.replace("activity='coloop-hooks-bench-'", "activity='coloop-internal-smoke-'")
    tail = r'''
 stage='internal_pty_spawn'
 os.umask(0o077)
 (temporary/'runner.py').write_text(RUNNER_TEXT)
 (temporary/'prompt.txt').write_text(PROMPT_TEXT)
 env.update({'TERM':'xterm-256color','INTERNAL_OPENCODE_BIN':str(root/'bin/opencode'),
             'INTERNAL_SMOKE_TIMEOUT':str(__TIMEOUT_VALUE__)})
 with (temporary/'logs/guardian.log').open('wb') as log:
  process=subprocess.Popen(['/usr/bin/python3',str(temporary/'runner.py')],cwd=temporary,
    env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 for _ in range(50):
  if (temporary/'state.json').exists():break
  if process.poll() is not None:raise RuntimeError('PTY_GUARDIAN_EXITED')
  time.sleep(.1)
 if not (temporary/'state.json').exists():raise RuntimeError('PTY_GUARDIAN_START_TIMEOUT')
 state=json.loads((temporary/'state.json').read_text())
 print(json.dumps({'temporary':str(temporary),'directory':str(temporary/'workspace'),
   'pid':state['source_pid'],'runner_pid':process.pid,'source_start_ticks':state.get('source_start_ticks'),
   'activity':activity,'version':version,'log_offsets':offsets,'resources_before':resources,
   'model_health':{k:health.get(k) for k in ('model','context','privacy_metadata_only')},
   'memory_before':before,'connection_mode':oct(connection.stat().st_mode&0o777),
   'plugin_sdk_cache':cache}))
except BaseException as failure:
 cleanup_result={}
 if process is not None:
  try:
   import signal
   os.killpg(process.pid,signal.SIGTERM);cleanup_result['guardian_terminated']=True
  except OSError:pass
 if activity is not None:
  try:memory.request('/activity',{'session_id':activity,'active':False},timeout=5);cleanup_result['activity_released']=True
  except Exception:pass
 if temporary is not None:(temporary/'connection.json').unlink(missing_ok=True)
 import re
 reason=str(failure)
 if not re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}',reason):reason='BOOTSTRAP_'+type(failure).__name__.upper()
 print(json.dumps({'startup_failed':True,'stage':stage,'reasonCode':reason,'cleanup':cleanup_result}))
'''
    prompt = "Call question now using exactly these arguments: " + canonical_json(question_arguments(1))
    script = prefix + tail.replace("RUNNER_TEXT", repr(RUNNER_SOURCE)).replace(
        "PROMPT_TEXT", repr(prompt)
    ).replace("__TIMEOUT_VALUE__", str(timeout))
    compile(script, "<internal-hook-bootstrap>", "exec")
    return script


def process_snapshot(client, startup):
    script = r'''
import hashlib,json,os
from pathlib import Path
startup=STARTUP; base=Path(startup['temporary']);p=Path('/proc')/str(startup['pid'])
state=json.loads((base/'state.json').read_text()) if (base/'state.json').exists() else {}
result={'state':state,'source_alive':False,'tcp_listeners':None,'socket_fd_count':None}
if p.exists():
 stat=(p/'stat').read_text().rsplit(')',1)[1].split()
 if stat[19]!=startup['source_start_ticks']:raise RuntimeError('SOURCE_IDENTITY_CHANGED')
 args=(p/'cmdline').read_bytes().split(b'\0')
 result['source_alive']=stat[0]!='Z'
 result['mini_no_attach']=b'--mini' in args and b'--attach' not in args and b'serve' not in args
 result['correct_cwd']=Path(os.readlink(p/'cwd'))==Path(startup['directory'])
 inodes=set()
 for fd in (p/'fd').iterdir():
  try:target=os.readlink(fd)
  except FileNotFoundError:continue
  if target.startswith('socket:['):inodes.add(target[8:-1])
 listeners=0
 for name in ('tcp','tcp6'):
  for line in (p/'net'/name).read_text().splitlines()[1:]:
   parts=line.split()
   if parts[9] in inodes and parts[3]=='0A':listeners+=1
 result.update(tcp_listeners=listeners,socket_fd_count=len(inodes))
print(json.dumps(result))
'''.replace("STARTUP", repr(startup))
    return remote_json(client, script)


def cleanup_internal(client, root, startup):
    script = r'''
import hashlib,json,os,signal,sys,time
from pathlib import Path
root=Path(ROOT_DIR);startup=STARTUP;report={};base=Path(startup['temporary'])
for name in ('pid','runner_pid'):
 pid=startup[name];p=Path('/proc')/str(pid)
 if not p.exists():report[name]='already_exited';continue
 args=(p/'cmdline').read_bytes().split(b'\0');cwd=Path(os.readlink(p/'cwd'))
 if name=='pid':
  ticks=(p/'stat').read_text().rsplit(')',1)[1].split()[19]
  valid=(str(root/'bin/opencode').encode() in args and b'--mini' in args and
         cwd==Path(startup['directory']) and ticks==startup['source_start_ticks'])
 else:valid=str(base/'runner.py').encode() in args and cwd==base
 if not valid or os.getpgid(pid)!=pid:report[name]='IDENTITY_MISMATCH';continue
 os.killpg(pid,signal.SIGTERM);report[name]='terminated_own_process_group'
for _ in range(50):
 if not (Path('/proc')/str(startup['pid'])).exists():break
 time.sleep(.1)
report['source_exited']=not (Path('/proc')/str(startup['pid'])).exists()
sys.path.insert(0,str(root/'agent'))
from memory_client import MemoryClient
MemoryClient(root).request('/activity',{'session_id':startup['activity'],'active':False},timeout=5)
report['activity_released']=True
(base/'connection.json').unlink(missing_ok=True);report['connection_removed']=True
allowed={'id','privacy','started_at','prompt_bytes','input_tokens','output_tokens','elapsed_seconds','finish_reason','error_code','inference'}
for name,offset in startup['log_offsets'].items():
 with (root/'logs'/name).open('rb') as stream:stream.seek(offset);data=stream.read()
 row={'added_bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
 if name=='requests.jsonl':
  records=[json.loads(line) for line in data.splitlines() if line.strip()]
  row.update(record_count=len(records),metadata_only=all(v.get('privacy')=='metadata-only' and set(v)<=allowed for v in records))
 report[name]=row
print(json.dumps(report))
'''.replace("ROOT_DIR", repr(root)).replace("STARTUP", repr(startup))
    return remote_json(client, script)


def result_predicates(records, observed):
    approvals = [r for r in records if r.get("kind") == "approval"]
    receipts = [r for r in records if is_success_receipt(r)]
    selected = False
    # reasonCode can evolve independently; source, action and exact bound choice cannot.
    if len(approvals) == 1:
        decision = approvals[0].get("decision", {})
        selected = (
            decision.get("decision") == "select" and decision.get("source") == "rk"
            and decision.get("choiceId") == "1" and approvals[0].get("offlineChoiceId") == "1"
        )
    consumed = (
        len(receipts) == 1 and len(approvals) == 1
        and receipts[0].get("relatedEventId") == approvals[0].get("eventId")
        and receipts[0].get("originalDigest") == approvals[0].get("originalDigest")
        and receipt_duration(receipts[0]) is not None
    )
    return {
        **observed, "actual_approval_count": len(approvals), "actual_receipt_count": len(receipts),
        "rk_selected_offline": selected, "pending_verified_consumed_by_native_sdk": consumed,
        "asked_to_consumed_ms": receipt_duration(receipts[0]) if len(receipts) == 1 else None,
        "source_idle_seen": any(r.get("state") == "idle" for r in records),
        "approval_failure_seen": any(r.get("state") in ("approval.pending", "approval.failed") for r in records),
    }


def functionality_passed(result):
    return all(result.get(k) is True for k in (
        "question_tool_completed_with_offline", "assistant_final_exact_offline",
        "rk_selected_offline", "pending_verified_consumed_by_native_sdk", "source_idle_seen",
    )) and result.get("approval_failure_seen") is False


def argument_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=240, help="Whole one-task budget, 30..600s")
    return parser


def write_progress(output_dir, report, started, *, event_count=0, snapshot_count=0):
    """Export an explicit metadata allowlist, never a copy of source payloads."""
    result = report.get("result", {})
    row = {
        "phase": report.get("phase", "initializing"),
        "elapsed_seconds": time.monotonic() - started,
        "passed": report.get("passed") is True,
        "hook_event_count": event_count,
        "process_snapshot_count": snapshot_count,
        "result": {k: result[k] for k in (
            "actual_approval_count", "actual_receipt_count", "rk_selected_offline",
            "pending_verified_consumed_by_native_sdk", "question_tool_completed_with_offline",
            "assistant_final_exact_offline", "source_idle_seen", "approval_failure_seen",
            "asked_to_consumed_ms",
        ) if k in result},
    }
    if "failure_code" in report:
        row["failure_code"] = report["failure_code"]
    temporary = output_dir / "progress.next"
    temporary.write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output_dir / "progress.json")


def main():
    parser = argument_parser()
    args = parser.parse_args()
    if not 30 <= args.timeout <= 600:
        parser.error("--timeout must be in 30..600")
    args.output_dir.mkdir(parents=True, exist_ok=False)
    report: dict[str, Any] = {
        "passed": False, "source": "real-opencode-mini-internal-fetch", "synthetic_only": True,
        "source_tcp_server": False, "source_attach": False, "permission_override": False,
        "source_format": "PTY mini (stock run --format json denies question)",
        "approval_keystrokes_sent": 0, "ocr_used": False, "python_approval_reply": False,
        "performance_acceptance": False, "performance_note": "one functionality task, not p95",
        "native_plugin_sha256": hashlib.sha256(HOOK_PLUGIN.read_bytes()).hexdigest(),
    }
    client = None
    startup = {}
    proxy = None
    coordinator = None
    resources, snapshots = [], []
    secrets = []
    started = time.monotonic()
    source_id = "internal-hook-smoke-" + uuid4().hex
    remote_root = ""
    write_progress(args.output_dir, report, started)
    try:
        if not os.environ.get("RK_BOARD_PASSWORD"):
            raise AdapterError("RK_BOARD_PASSWORD_REQUIRED")
        coordinator = coordinator_client(args.connection)
        secrets.append(coordinator.authorization.removeprefix("Bearer "))
        coordinator.request("GET", "/health")
        observer = ObservationClient(coordinator)
        spec = importlib.util.spec_from_file_location("rk_internal_host", ROOT / "rk-opencode/host.py")
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        cfg = json.loads((ROOT / "config/board.json").read_text(encoding="utf-8-sig"))
        remote_root = cfg.get("agent_dir", host.REMOTE)
        if remote_root != host.REMOTE:
            raise AdapterError("PINNED_AGENT_ROOT_REQUIRED")
        report["phase"] = "connecting_pinned_ssh"
        write_progress(args.output_dir, report, started)
        client = host.connect()
        with RecordingProxy(observer) as proxy, reverse_forward(client, proxy.port) as hook_port:
            report["phase"] = "starting_private_internal_source"
            write_progress(args.output_dir, report, started)
            startup = remote_json(client, internal_bootstrap(
                remote_root, cfg.get("agent_port", 8088), hook_port, secrets[0], source_id,
                HOOK_PLUGIN.read_text(encoding="utf-8"), args.timeout,
            ), timeout=210)
            if startup.get("startup_failed"):
                report["bootstrap_diagnostics"] = startup
                code = startup.get("reasonCode", "BOOTSTRAP_FAILED")
                startup = {}
                raise AdapterError(code)
            report.update({k: startup[k] for k in (
                "version", "model_health", "memory_before", "connection_mode", "plugin_sdk_cache",
            )})
            if startup["version"] != "1.19.5" or startup["connection_mode"] != "0o600":
                raise AdapterError("ISOLATED_SOURCE_CONFIGURATION_MISMATCH")
            report["phase"] = "waiting_for_native_internal_fetch_consumption"
            write_progress(args.output_dir, report, started)
            while time.monotonic() - started < args.timeout:
                resource = resource_sample(client, remote_root)
                resources.append(resource)
                if (resource.get("max_temperature_c") or 0) >= 80:
                    raise AdapterError("THERMAL_LIMIT")
                snapshot = process_snapshot(client, startup)
                snapshots.append(snapshot)
                if snapshot.get("tcp_listeners", 0):
                    raise AdapterError("UNEXPECTED_SOURCE_TCP_LISTENER")
                records = [r for r in proxy.snapshot() if r.get("sourceId") == source_id]
                report["result"] = result_predicates(records, observer.snapshot())
                write_progress(args.output_dir, report, started,
                               event_count=len(records), snapshot_count=len(snapshots))
                if functionality_passed(report["result"]):
                    break
                if report["result"]["approval_failure_seen"]:
                    raise AdapterError("NATIVE_APPROVAL_FAILED")
                if report["result"]["actual_approval_count"] > 1:
                    raise AdapterError("SOURCE_REPEATED_QUESTION")
                if any(r.get("kind") == "closed" for r in records):
                    raise AdapterError("INTERNAL_SOURCE_CLOSED_BEFORE_COMPLETION")
                if not snapshot["source_alive"]:
                    raise AdapterError("INTERNAL_SOURCE_EXITED_EARLY")
                time.sleep(.5)
            else:
                raise AdapterError("INTERNAL_SOURCE_TIMEOUT")
            report["phase"] = "checking_memory_and_process_evidence"
            write_progress(args.output_dir, report, started,
                           event_count=len(records), snapshot_count=len(snapshots))
            report["memory_after"] = memory_status(client, remote_root)
            report["no_long_term_memory_writes"] = all(
                startup["memory_before"].get(k) == report["memory_after"].get(k)
                for k in ("active_facts", "archived_versions", "capsules", "jobs")
            )
            live = [s for s in snapshots if s.get("source_alive")]
            report["no_source_tcp_listener_verified"] = bool(live) and all(
                s.get("tcp_listeners") == 0 and s.get("mini_no_attach") is True
                and s.get("correct_cwd") is True for s in live
            )
            report["passed"] = (
                functionality_passed(report["result"]) and report["no_long_term_memory_writes"]
                and report["no_source_tcp_listener_verified"]
            )
            # Stop while the reverse relay remains available for plugin disposal.
            report["phase"] = "cleaning_up"
            write_progress(args.output_dir, report, started,
                           event_count=len(records), snapshot_count=len(snapshots))
            report["cleanup"] = cleanup_internal(client, remote_root, startup)
    except Exception as error:
        report["failure_code"] = error.code if isinstance(error, AdapterError) else type(error).__name__
        report["phase"] = "failed"
        write_progress(args.output_dir, report, started,
                       snapshot_count=len(snapshots))
    finally:
        if client and startup and "cleanup" not in report:
            try:
                report["cleanup"] = cleanup_internal(client, remote_root, startup)
            except Exception as error:
                report["cleanup_error"] = type(error).__name__
                report["passed"] = False
        records = proxy.snapshot() if proxy else []
        if coordinator:
            # Cleanup only scopes emitted by this isolated source, after it exits.
            latest = {}
            for row in records:
                if row.get("sourceId") == source_id:
                    latest[tuple(row.get(k) for k in ("instanceId", "sessionId", "taskId"))] = row
            closed, failed = 0, 0
            for row in latest.values():
                if row.get("kind") == "closed":
                    continue
                event = {k: row[k] for k in ("sourceId", "instanceId", "sessionId", "taskId")}
                event.update(version=1, source="opencode", sequence=row["sequence"] + 1,
                             eventId="cleanup-" + uuid4().hex, kind="closed", workspace=str(ROOT), payload={})
                try:
                    coordinator.request("POST", "/v1/hooks", event)
                    closed += 1
                except AdapterError:
                    failed += 1
            report["cleanup_scope_events"] = {"closed": closed, "failed": failed}
            if failed:
                report["passed"] = False
        if client:
            client.close()
        cleanup = report.get("cleanup", {})
        report["private_model_logs"] = (
            cleanup.get("requests.jsonl", {}).get("metadata_only") is True
            and cleanup.get("worker.log", {}).get("added_bytes") == 0
        )
        report["passed"] = (
            report["passed"] and report["private_model_logs"]
            and cleanup.get("source_exited") is True and cleanup.get("activity_released") is True
            and cleanup.get("connection_removed") is True
        )
        report["elapsed_seconds"] = time.monotonic() - started
        report["phase"] = "completed" if report["passed"] else "failed"
        write_progress(args.output_dir, report, started,
                       event_count=len(records), snapshot_count=len(snapshots))
        report["private_board_directory"] = startup.get("temporary")
        for name, value in (("summary.json", report), ("hook-records.json", records),
                            ("process-snapshots.json", snapshots), ("resources.json", resources),
                            ("config.json", source_config("<private-plugin-copy>"))):
            (args.output_dir / name).write_text(
                json.dumps(sanitize(value, secrets), ensure_ascii=False, indent=2), encoding="utf-8"
            )
    print(canonical_json({"passed": report["passed"], "output_dir": str(args.output_dir),
                          "failure_code": report.get("failure_code")}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
