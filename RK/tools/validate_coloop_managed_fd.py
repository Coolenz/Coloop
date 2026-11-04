"""Validate the frozen managed reader with real Linux filesystem syscalls on RK.

This is CPU-only. The existing OpenCode binary runs in BUN_BE_BUN mode with a
minimal environment, never an Agent, model, memory client or inference service.
Only this run's owned /tmp directory is created and removed. No production file
is uploaded or edited. Use a new output directory and RK_BOARD_PASSWORD in the
process environment; the existing host.connect() enforces the configured SSH pin.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "rk-opencode/agent/coloop_managed_core.mjs"
RUNNER = Path(__file__).with_name("coloop_managed_fd_runner.mjs")
CONTROLLER = Path(__file__)
MAX_OUTPUT = 2 * 1024 * 1024
CASE_IDS = {
    "regular-ascii",
    "regular-unicode",
    "exact-maximum",
    "empty",
    "oversize",
    "leaf-symlink-inside",
    "leaf-symlink-outside",
    "directory-symlink-inside",
    "directory-symlink-outside",
    "root-symlink",
    "root-ancestor-symlink",
    "hardlink",
    "directory-target",
    "fifo-target",
    "path-replaced-after-open-regular",
    "path-replaced-after-open-symlink",
    "unlinked-after-open",
    "root-replaced-after-file-open",
    "changed-after-bytes-truncate",
    "changed-after-bytes-append",
    "changed-after-bytes-overwrite",
    "changed-after-bytes-grow-past-limit",
    "binary-nul",
    "invalid-utf8",
    "text-control",
    "root-directory-pinned-before-file-open",
    "regular-replaced-between-lstat-and-open",
}


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def valid_remote_directory(value: str) -> bool:
    path = PurePosixPath(value)
    return (
        path.parent == PurePosixPath("/tmp")
        and str(path) == value
        and re.fullmatch(r"coloop-managed-fd-[A-Za-z0-9_-]{8,64}", path.name) is not None
    )


def output_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_json(data: bytes) -> Any:
    if len(data) > MAX_OUTPUT:
        raise RuntimeError("FD_OUTPUT_LIMIT")

    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise RuntimeError("DUPLICATE_FD_OUTPUT_KEY")
            result[key] = value
        return result

    return json.loads(data.decode("utf-8"), object_pairs_hook=pairs)


def run_python(client: Any, script: str, timeout: int = 30) -> Any:
    stdin, stdout, stderr = client.exec_command("python3 -", timeout=timeout)
    stdin.write(script)
    stdin.flush()
    stdin.channel.shutdown_write()
    raw = stdout.read(MAX_OUTPUT + 1)
    diagnostic = stderr.read(MAX_OUTPUT + 1)
    code = stdout.channel.recv_exit_status()
    if code:
        raise RuntimeError("FD_REMOTE_OPERATION_FAILED")
    if diagnostic:
        raise RuntimeError("FD_REMOTE_DIAGNOSTIC_UNEXPECTED")
    return parse_json(raw)


def validate_result(value: Any, source_hash: str, expected_bun: str) -> list[str]:
    errors = []
    if not isinstance(value, dict):
        return ["RESULT_NOT_OBJECT"]
    rows = value.get("results")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        return ["CASE_RESULTS_INVALID"]
    ids = [row.get("id") for row in rows]
    if len(rows) != len(CASE_IDS) or set(ids) != CASE_IDS or len(set(ids)) != len(ids):
        errors.append("CASE_SET_CHANGED")
    if value.get("passed") is not True or value.get("passed_cases") != len(CASE_IDS):
        errors.append("KERNEL_CASE_FAILED")
    if value.get("source_core_sha256") != source_hash:
        errors.append("EXECUTED_CORE_HASH_MISMATCH")
    if value.get("platform") != "linux" or value.get("runtime", {}).get("version") != expected_bun:
        errors.append("WRONG_RUNTIME")
    if value.get("own_fixture_fd_remaining") != 0:
        errors.append("FIXTURE_DESCRIPTOR_LEAK")
    if (
        value.get("no_agent_started") is not True
        or value.get("npu_calls") != 0
        or value.get("permit_issued") is not False
    ):
        errors.append("VALIDATION_SCOPE_CHANGED")
    for row in rows:
        if row.get("passed") is not True or row.get("errors") != []:
            errors.append("CASE_ASSERTION_FAILED:" + str(row.get("id")))
        if (
            any(part in str(row.get("id")) for part in ("replaced", "changed-after", "unlinked"))
            or row.get("id") == "root-directory-pinned-before-file-open"
        ) and row.get("mutation_applied") is not True:
            errors.append("CONTROLLED_MUTATION_MISSING:" + str(row.get("id")))
        if row.get("own_fixture_fd_before") != 0 or row.get("own_fixture_fd_after") != 0:
            errors.append("CASE_DESCRIPTOR_LEAK:" + str(row.get("id")))
        if (
            type(row.get("scanOpenCount")) is not int
            or not 0 <= row["scanOpenCount"] <= 1
            or type(row.get("scanBytes")) is not int
            or not 0 <= row["scanBytes"] <= 65537
        ):
            errors.append("CASE_COUNTER_INVALID:" + str(row.get("id")))
    return sorted(set(errors))


REMOTE_EXECUTE = r"""
import hashlib,json,os,platform,signal,subprocess,time
from pathlib import Path
p=json.loads(PAYLOAD)
base=Path(p['directory'])
if base.parent!=Path('/tmp') or base.is_symlink() or not base.name.startswith('coloop-managed-fd-'):
 raise RuntimeError('FD_PRIVATE_DIRECTORY_REQUIRED')
if json.loads((base/'.owner.json').read_text())['owner_id']!=p['owner_id']:
 raise RuntimeError('FD_OWNER_MISMATCH')
os.umask(0o077)
for name,digest in p['files'].items():
 f=base/name
 if f.is_symlink() or hashlib.sha256(f.read_bytes()).hexdigest()!=digest:
  raise RuntimeError('FD_UPLOAD_HASH_MISMATCH')
runtime=Path(p['runtime'])
env={'PATH':'/usr/bin:/bin','HOME':str(base/'home'),'XDG_CONFIG_HOME':str(base/'home/config'),
 'XDG_DATA_HOME':str(base/'home/data'),'XDG_CACHE_HOME':str(base/'home/cache'),
 'BUN_BE_BUN':'1','BUN_INSTALL_CACHE_DIR':str(base/'home/bun-cache'),
 'LANG':'C.UTF-8','LC_ALL':'C.UTF-8'}
(base/'home').mkdir(mode=0o700)
version=subprocess.run([str(runtime),'--version'],cwd=base,env=env,capture_output=True,timeout=10)
if version.returncode or version.stdout.decode().strip()!=p['expected_bun']:
 raise RuntimeError('FD_UNEXPECTED_BUN_RUNTIME')
started=time.monotonic()
child=subprocess.Popen([str(runtime),str(base/'runner.mjs'),str(base/'core.mjs'),str(base)],
 cwd=base,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
 start_new_session=True)
timed_out=False
try:
 stdout,stderr=child.communicate(timeout=p['timeout'])
except subprocess.TimeoutExpired:
 timed_out=True
 # Popen owns this newly-created session. Never signal an unrelated PID/group.
 if child.poll() is None and os.getpgid(child.pid)==child.pid:
  os.killpg(child.pid,signal.SIGTERM)
 try:stdout,stderr=child.communicate(timeout=5)
 except subprocess.TimeoutExpired:
  if child.poll() is None and os.getpgid(child.pid)==child.pid:os.killpg(child.pid,signal.SIGKILL)
  stdout,stderr=child.communicate(timeout=5)
(base/'stdout.bin').write_bytes(stdout)
(base/'stderr.bin').write_bytes(stderr)
metadata={'returncode':child.returncode,'timeout':timed_out,'pid':child.pid,
 'all_owned_children_reaped':child.poll() is not None,'elapsed_seconds':time.monotonic()-started,
 'stdout_bytes':len(stdout),'stderr_bytes':len(stderr),
 'stdout_sha256':hashlib.sha256(stdout).hexdigest(),'stderr_sha256':hashlib.sha256(stderr).hexdigest(),
 'runtime':{'path':str(runtime),'sha256':hashlib.sha256(runtime.read_bytes()).hexdigest(),
            'bun_version':version.stdout.decode().strip()},
 'kernel':platform.release(),'machine':platform.machine(),
 'minimal_environment_keys':sorted(env),'agent_or_model_launched':False,
 'production_paths_modified':False}
(base/'execution.json').write_text(json.dumps(metadata))
print(json.dumps(metadata))
"""


REMOTE_CLEANUP = r"""
import json,shutil
from pathlib import Path
p=json.loads(PAYLOAD)
base=Path(p['directory'])
safe=(base.parent==Path('/tmp') and base.name.startswith('coloop-managed-fd-')
      and base.resolve()==base and not base.is_symlink())
if not safe or json.loads((base/'.owner.json').read_text())['owner_id']!=p['owner_id']:
 raise RuntimeError('FD_CLEANUP_SCOPE_MISMATCH')
alive=[]
for process in Path('/proc').glob('[0-9]*'):
 try:
  if (process/'cwd').resolve()==base:alive.append(int(process.name))
 except (FileNotFoundError,PermissionError,ProcessLookupError):pass
if alive:raise RuntimeError('FD_OWN_PROCESS_STILL_ACTIVE')
shutil.rmtree(base)
print(json.dumps({'owned_directory_removed':not base.exists(),'owned_processes_remaining':0,
                  'production_paths_modified':False}))
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--expected-bun", default="1.4.4")
    args = parser.parse_args()
    if not 5 <= args.timeout <= 120:
        parser.error("timeout must be 5..120 seconds")
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.expected_bun):
        parser.error("expected-bun must be an exact semantic version")
    if not os.environ.get("RK_BOARD_PASSWORD"):
        raise RuntimeError("RK_BOARD_PASSWORD_REQUIRED")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    frozen = {"core.mjs": CORE.read_bytes(), "runner.mjs": RUNNER.read_bytes()}
    sources = {name: sha(value) for name, value in frozen.items()}
    for name, value in frozen.items():
        (output / (name + ".snapshot")).write_bytes(value)
    controller = CONTROLLER.read_bytes()
    (output / "controller.py.snapshot").write_bytes(controller)
    (output / "README.md").write_text(
        "# Managed reader Linux CPU validation\n\n"
        "Run with the Windows host virtualenv and a process-only RK_BOARD_PASSWORD:\n\n"
        "```powershell\n.\\.venv\\Scripts\\python.exe "
        "tools/validate_coloop_managed_fd.py --output-dir logs/NEW_DIRECTORY\n```\n\n"
        "The frozen core and runner snapshots are uploaded to a fresh private /tmp directory. "
        "OpenCode's existing binary runs only as Bun 1.4.4, with a minimal environment. "
        "No Agent, model, memory or permission service is exercised.\n\n"
        "`results.json` separates real descriptor reads from checkedSnapshot text rejection. "
        "Callbacks synchronize mutations of real Linux files. The two open/lstat wrappers "
        "retain real handles, flags and stat results: they are controlled interposition, "
        "not evidence of every uncontrolled race or kernel compromise.\n\n"
        "Runtime output contains fixture hashes and counts, not fixture bodies. "
        "Inputs are public synthetic bytes defined in runner.mjs.snapshot. "
        "All owned fixture descriptors must close; the owned remote process and directory "
        "must be reaped/removed. These 27 CPU cases are independent of the fixed native40 "
        "and policy128 scores.\n",
        encoding="utf-8",
    )
    owner = secrets.token_hex(16)
    manifest: dict[str, Any] = {
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "source_files": sources,
        "controller_sha256": sha(controller),
        "expected_cases": sorted(CASE_IDS),
        "scope": "Real Linux descriptor and checkedSnapshot CPU validation; no Agent/NPU/permit",
        "npu_calls": 0,
        "passed": False,
    }
    client = None
    remote = None
    errors = []
    try:
        spec = importlib.util.spec_from_file_location("rk_fd_host", ROOT / "rk-opencode/host.py")
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        client = host.connect()
        remote = run_python(
            client,
            "import json,os,tempfile\nfrom pathlib import Path\n"
            "os.umask(0o077)\np=Path(tempfile.mkdtemp(prefix='coloop-managed-fd-',dir='/tmp'))\n"
            + "(p/'.owner.json').write_text(json.dumps({'owner_id':"
            + repr(owner)
            + "}))\n"
            + "print(json.dumps(str(p)))\n",
        )
        if not isinstance(remote, str) or not valid_remote_directory(remote):
            raise RuntimeError("INVALID_REMOTE_FD_DIRECTORY")
        sftp = client.open_sftp()
        try:
            for name, value in frozen.items():
                with sftp.open(remote + "/" + name, "wb") as stream:
                    stream.write(value)
                sftp.chmod(remote + "/" + name, 0o600)
            payload = {
                "directory": remote,
                "owner_id": owner,
                "files": sources,
                "runtime": host.REMOTE + "/bin/opencode",
                "expected_bun": args.expected_bun,
                "timeout": args.timeout,
            }
            execution = run_python(
                client,
                REMOTE_EXECUTE.replace("PAYLOAD", repr(json.dumps(payload))),
                timeout=args.timeout + 35,
            )
            manifest["execution"] = execution
            output_json(output / "execution.json", execution)
            for name in ("stdout.bin", "stderr.bin"):
                target = output / name
                sftp.get(remote + "/" + name, str(target))
                if sha(target.read_bytes()) != execution[name.split(".")[0] + "_sha256"]:
                    raise RuntimeError("FD_DOWNLOADED_OUTPUT_HASH_MISMATCH")
            result = parse_json((output / "stdout.bin").read_bytes())
            output_json(output / "results.json", result)
            errors.extend(validate_result(result, sources["core.mjs"], args.expected_bun))
            if execution["returncode"] or execution["timeout"]:
                errors.append("FD_RUNTIME_FAILED")
            if not execution["all_owned_children_reaped"]:
                errors.append("FD_RUNTIME_NOT_REAPED")
            if execution["stderr_bytes"]:
                errors.append("FD_RUNTIME_DIAGNOSTIC_UNEXPECTED")
        finally:
            sftp.close()
    except Exception as error:
        errors.append(str(error) if isinstance(error, RuntimeError) else type(error).__name__)
    finally:
        if client and remote:
            try:
                cleanup = run_python(
                    client,
                    REMOTE_CLEANUP.replace(
                        "PAYLOAD", repr(json.dumps({"directory": remote, "owner_id": owner}))
                    ),
                )
                manifest["cleanup"] = cleanup
                if not cleanup["owned_directory_removed"] or cleanup["owned_processes_remaining"]:
                    errors.append("FD_CLEANUP_INCOMPLETE")
            except Exception:
                errors.append("FD_CLEANUP_FAILED")
        if client:
            client.close()
        manifest["errors"] = sorted(set(errors))
        manifest["passed"] = not errors and "execution" in manifest
        manifest["finished_utc"] = datetime.now(timezone.utc).isoformat()
        output_json(output / "manifest.json", manifest)
    print(json.dumps({"passed": manifest["passed"], "output_dir": str(output), "errors": errors}))
    return 0 if manifest["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
