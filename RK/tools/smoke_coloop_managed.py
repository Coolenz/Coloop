"""Real managed coloop_read -> RK signed once permit -> immutable snapshot -> final nonce.

Only synthetic files are used. The Python controller never replies to a permission.
The installed production managed profile, native plugin, SDK and NPU all stay real.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request
from urllib.error import HTTPError
import re
from typing import Any
from urllib.parse import quote, urlencode

from bench_coloop_hooks import (
    ROOT,
    RecordingProxy,
    guarded_forward,
    reverse_forward,
    source_http_ready,
    BenchmarkHttp,
    is_success_receipt,
    receipt_binding_verified,
    receipt_duration,
)
from coloop_agent import AdapterError, coordinator_client
from smoke_coloop_opencode import cleanup, collect_messages, remote_json, sanitize


class Monitor:
    def __init__(self, client):
        self.client = client
        self.authorization = client.authorization
        self.reviews: list[dict] = []
        self.hooks: list[dict] = []

    def request(self, method, path, body=None):
        response = self.client.request(method, path, body)
        if isinstance(body, dict):
            if path == "/v1/hooks/review":
                self.reviews.append({"event": body, "response": response})
            elif path == "/v1/hooks":
                self.hooks.append(body)
        return response


def bootstrap(hook_port: int) -> str:
    return r"""
import hashlib,json,os,secrets,socket,subprocess,tempfile,time,sys
from pathlib import Path
root=Path('/home/cat/rk-opencode');sys.path.insert(0,str(root/'agent'))
from memory_client import MemoryClient
memory=MemoryClient(root);activity='coloop-managed-smoke-'+secrets.token_hex(12)
state=memory.request('/activity',{'session_id':activity,'active':True},timeout=5)
if state['active_sessions']!=1:
 memory.request('/activity',{'session_id':activity,'active':False},timeout=5)
 raise RuntimeError('OTHER_FOREGROUND_ACTIVITY')
process=None;temporary=None
try:
 memory.request('/ready-for-foreground',{},timeout=185)
 before=memory.request('/call',{'op':'status'},timeout=10)
 outer=json.loads((root/'.runtime/coloop-hook/connection.json').read_text())
 managed=outer['managed'];workspace=Path(managed['root'])
 temporary=Path(tempfile.mkdtemp(prefix='coloop-managed-smoke-',dir=root/'.runtime'))
 test=workspace/('coloop-eval-'+secrets.token_hex(10));test.mkdir(mode=0o700)
 nonce='RK_VERIFY_'+secrets.token_hex(16)
 content=('PUBLIC_EVAL_SOURCE\n'+nonce+'\n').encode().replace(b'\\n',b'\n')
 (test/'nonce.txt').write_bytes(content)
 outer['url']='http://127.0.0.1:HOOK_PORT'
 connection=temporary/'connection.json'
 fd=os.open(str(connection),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(outer,f)
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 password=secrets.token_urlsafe(32)
 offsets={name:(root/'logs'/name).stat().st_size if (root/'logs'/name).exists() else 0 for name in ('requests.jsonl','worker.log','bridge.log')}
 env={'PATH':os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin'),
  'HOME':str(temporary),'COLOOP_MANAGED_CONNECTION':str(connection),
  'OPENCODE_SERVER_PASSWORD':password,'LANG':'C.UTF-8','LC_ALL':'C.UTF-8'}
 with (temporary/'server.log').open('wb') as log:
  process=subprocess.Popen(['bash',str(root/'scripts/coloop-managed.sh'),'serve','--hostname=127.0.0.1','--port='+str(port)],cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 print(json.dumps({'temporary':str(temporary),'directory':str(workspace),'pid':process.pid,'port':port,'password':password,'activity':activity,'log_offsets':offsets,'enrollment_id':managed['enrollmentId'],'relative_path':str((test/'nonce.txt').relative_to(workspace)),'nonce':nonce,'snapshot_sha256':hashlib.sha256(content).hexdigest(),'snapshot_bytes':len(content),'memory_before':before}))
except BaseException:
 if process is not None:
  import signal
  try:os.killpg(process.pid,signal.SIGTERM)
  except OSError:pass
 memory.request('/activity',{'session_id':activity,'active':False},timeout=5)
 if temporary is not None:(temporary/'connection.json').unlink(missing_ok=True)
 raise
""".replace("HOOK_PORT", str(hook_port))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    if not 30 <= args.timeout <= 600:
        parser.error("timeout must be 30..600")
    args.output_dir.mkdir(parents=True, exist_ok=False)
    report: dict[str, Any] = {
        "passed": False,
        "source": "production-managed-opencode-npu",
        "synthetic_only": True,
        "source_model_scripted": False,
        "python_permission_reply": False,
    }
    client = None
    startup: dict = {}
    monitor = proxy = http = None
    messages = []
    secrets: list[str] = []
    started = time.monotonic()
    try:
        if not os.environ.get("RK_BOARD_PASSWORD"):
            raise AdapterError("RK_BOARD_PASSWORD_REQUIRED")
        coordinator = coordinator_client(args.connection)
        secrets.append(coordinator.authorization.removeprefix("Bearer "))
        monitor = Monitor(coordinator)
        spec = importlib.util.spec_from_file_location(
            "rk_managed_host", ROOT / "rk-opencode/host.py"
        )
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        client = host.connect()
        with RecordingProxy(monitor) as proxy, reverse_forward(client, proxy.port) as hook_port:
            startup = remote_json(client, bootstrap(hook_port), timeout=210)
            secrets.append(startup["password"])
            oracle_path = args.output_dir / "oracle.json"
            oracle_path.write_text(
                json.dumps(
                    {"nonce": startup["nonce"], "snapshot_sha256": startup["snapshot_sha256"]}
                ),
                encoding="utf-8",
            )
            oracle_path.chmod(0o600)
            report["memory_before"] = startup["memory_before"]
            report["source_health"] = source_http_ready(client, startup)
            with guarded_forward(client, startup["port"]) as url:
                auth = (
                    "Basic "
                    + base64.b64encode(("opencode:" + startup["password"]).encode()).decode()
                )
                http = BenchmarkHttp(url, auth)
                query = "?" + urlencode({"directory": startup["directory"]})
                session = http.send(
                    "POST",
                    "/session" + query,
                    {
                        "title": "Synthetic signed snapshot read",
                        "permission": [
                            {"permission": "*", "pattern": "*", "action": "deny"},
                            {"permission": "coloop_read", "pattern": "*", "action": "ask"},
                        ],
                    },
                )
                report["session_id"] = session["id"]
                path = "/session/" + quote(session["id"], safe="")
                prompt = (
                    "Call coloop_read exactly once with this path: "
                    + startup["relative_path"]
                    + ". After the tool result, return only the exact line beginning RK_VERIFY_. Do not call another tool. Never invent file contents."
                )
                (args.output_dir / "input.json").write_text(
                    json.dumps(
                        {"prompt": prompt, "oracle_not_in_prompt": startup["nonce"] not in prompt}
                    ),
                    encoding="utf-8",
                )
                tick = time.monotonic()
                request_body = {
                    "agent": "rk-coloop-managed",
                    "model": {"providerID": "rkllm", "modelID": "qwen35-4b-rkllm"},
                    "parts": [{"type": "text", "text": prompt}],
                }

                def prompt_sync():
                    request = Request(
                        url + path + "/message" + query,
                        data=json.dumps(request_body, ensure_ascii=False).encode(),
                        headers={"Authorization": auth, "Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        with http.opener.open(request, timeout=args.timeout + 15) as response:
                            response.read(2 * 1024 * 1024)
                        return {"success": True}
                    except HTTPError as error:
                        raw = error.read(32768).decode("utf-8", errors="replace")
                        return {
                            "success": False,
                            "http_status": error.code,
                            "codes": sorted(
                                set(
                                    re.findall(
                                        r"\b(?:MANAGED|UNSAFE|PRIVATE|PINNED|INVALID)[A-Z_]+\b", raw
                                    )
                                )
                            ),
                            "error_json": sanitize(json.loads(raw), secrets)
                            if raw.startswith("{")
                            else "non-JSON error",
                        }

                executor = ThreadPoolExecutor(max_workers=1)
                prompt_job = executor.submit(prompt_sync)
                while time.monotonic() - tick < args.timeout:
                    messages = http.send("GET", path + "/message" + query)
                    tools, texts = collect_messages(messages)
                    state = http.send("GET", "/session/status" + query).get(session["id"], {})
                    receipts = [
                        r
                        for r in proxy.snapshot()
                        if r.get("sessionId") == session["id"] and is_success_receipt(r)
                    ]
                    failed = any(message.get("info", {}).get("error") for message in messages)
                    if prompt_job.done():
                        report["source_prompt_result"] = prompt_job.result()
                        if not report["source_prompt_result"]["success"]:
                            report["failure_code"] = "SOURCE_PROMPT_FAILED"
                            break
                    if (
                        failed
                        or (
                            tools
                            and all(
                                t.get("state", {}).get("status") in ("completed", "error")
                                for t in tools
                            )
                            and texts
                        )
                    ) and state.get("type", "idle") == "idle":
                        if failed or receipts:
                            break
                    time.sleep(0.1)
                executor.shutdown(wait=False, cancel_futures=True)
                report["task_total_ms"] = (time.monotonic() - tick) * 1000
                tools, texts = collect_messages(messages)
                done = [
                    tool
                    for tool in tools
                    if tool.get("tool") == "coloop_read"
                    and tool.get("state", {}).get("status") == "completed"
                ]
                actual = json.loads(done[0]["state"]["output"]) if len(done) == 1 else {}
                approvals = [
                    r
                    for r in proxy.snapshot()
                    if r.get("sessionId") == session["id"] and r.get("kind") == "approval"
                ]
                receipts = [
                    r
                    for r in proxy.snapshot()
                    if r.get("sessionId") == session["id"] and is_success_receipt(r)
                ]
                review = monitor.reviews[0]["response"] if len(monitor.reviews) == 1 else {}
                permit = review.get("decision", {}).get("permit", {})
                pending = http.send("GET", "/permission" + query)
                report.update(
                    tool_attempted=bool(tools),
                    only_managed_tool=bool(tools)
                    and all(t.get("tool") == "coloop_read" for t in tools),
                    tool_completed=len(done) == 1,
                    final_nonce_exact=texts == [startup["nonce"]],
                    output_nonce_present=startup["nonce"] in actual.get("text", ""),
                    snapshot_sha_matches=actual.get("sha256") == startup["snapshot_sha256"],
                    returned_sha_matches=actual.get("returnedSha256")
                    == hashlib.sha256(actual.get("text", "").encode()).hexdigest(),
                    permit_present=bool(permit)
                    and permit.get("sha256") == startup["snapshot_sha256"],
                    one_signed_allow=review.get("decision", {}).get("decision") == "allow"
                    and review.get("decision", {}).get("source") == "rk",
                    receipt_binding_verified=receipt_binding_verified(approvals, receipts),
                    pending_consumed=not any(
                        item.get("sessionID") == session["id"] for item in pending
                    ),
                    asked_to_consumed_ms=receipt_duration(receipts[0])
                    if len(receipts) == 1
                    else None,
                )
                report["passed"] = all(
                    report.get(key) is True
                    for key in (
                        "only_managed_tool",
                        "tool_completed",
                        "final_nonce_exact",
                        "output_nonce_present",
                        "snapshot_sha_matches",
                        "returned_sha_matches",
                        "permit_present",
                        "one_signed_allow",
                        "receipt_binding_verified",
                        "pending_consumed",
                    )
                )
                http.send("POST", path + "/abort" + query)
                http.send("DELETE", path + query)
                report["own_session_deleted"] = True
            report["memory_after"] = remote_json(
                client,
                "import sys,json\nfrom pathlib import Path\nr=Path('/home/cat/rk-opencode');sys.path.insert(0,str(r/'agent'))\nfrom memory_client import MemoryClient\nprint(json.dumps(MemoryClient(r).request('/call',{'op':'status'},timeout=10)))",
            )
            report["no_memory_writes"] = report["memory_before"] == report["memory_after"]
            report["passed"] &= report["no_memory_writes"]
    except Exception as error:
        report["failure_code"] = (
            error.code if isinstance(error, AdapterError) else type(error).__name__
        )
    finally:
        if client and startup:
            try:
                report["cleanup"] = cleanup(client, startup)
                script = (
                    "import json,subprocess\nfrom pathlib import Path\nr=Path('/home/cat/rk-opencode')\np=subprocess.run(['python3',str(r/'agent/coloop_managed_activity.py'),'--root',str(r),'--owner-pid',"
                    + repr(str(startup["pid"]))
                    + ",'--enrollment-id',"
                    + repr(startup["enrollment_id"])
                    + ",'--release-owner'],capture_output=True,text=True,timeout=15)\nPath("
                    + repr(startup["temporary"] + "/connection.json")
                    + ").unlink(missing_ok=True)\nprint(json.dumps({'owner_lease_cleanup':p.returncode==0,'connection_removed':True}))"
                )
                report["managed_cleanup"] = remote_json(client, script, timeout=20)
                report["private_model_logs"] = (
                    report["cleanup"]["requests.jsonl"]["metadata_only"]
                    and report["cleanup"]["worker.log"]["added_bytes"] == 0
                )
                diagnostics = remote_json(
                    client,
                    "import json,re\nfrom pathlib import Path\np=Path("
                    + repr(startup["temporary"] + "/server.log")
                    + ")\ns=p.read_text(errors='replace')[-20000:]\nprint(json.dumps({'codes':sorted(set(re.findall(r'\\b(?:MANAGED|UNSAFE|PRIVATE|PINNED|RK_PERMIT|INVALID_MANAGED)[A-Z_]*\\b',s))),'bytes':p.stat().st_size}))",
                )
                report["source_log_diagnostics"] = diagnostics
                report["passed"] &= (
                    report["private_model_logs"]
                    and report["managed_cleanup"]["owner_lease_cleanup"]
                )
            except Exception as error:
                report["cleanup_error"] = type(error).__name__
                report["passed"] = False
            client.close()
        report["elapsed_seconds"] = time.monotonic() - started
        for name, value in [
            ("summary.json", report),
            ("messages.json", messages),
            ("hook-records.json", proxy.snapshot() if proxy else []),
            ("review-receipts.json", monitor.reviews if monitor else []),
            ("hooks.json", monitor.hooks if monitor else []),
        ]:
            (args.output_dir / name).write_text(
                json.dumps(sanitize(value, secrets), ensure_ascii=False, indent=2), encoding="utf-8"
            )
    print(
        json.dumps(
            {
                "passed": report["passed"],
                "output_dir": str(args.output_dir),
                "failure_code": report.get("failure_code"),
            }
        )
    )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
