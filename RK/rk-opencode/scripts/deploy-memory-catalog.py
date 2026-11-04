"""Incremental catalog service update with idle check, full backup and source rollback."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from host import connect, REMOTE  # noqa: E402

FILES = ("agent/mem0_engine.py", "agent/memory_service.py")


def execute(client, source, timeout=60):
    _, stdout, stderr = client.exec_command(
        "cd " + shlex.quote(REMOTE) + " && " + source, timeout=timeout)
    output, error = stdout.read().decode(), stderr.read().decode()
    if stdout.channel.recv_exit_status():
        raise RuntimeError("Memory catalog deployment step failed: " + error[-500:])
    return output


def main():
    if not os.environ.get("RK_BOARD_PASSWORD"):
        # Existing user-authorized local configuration; never print or persist this value.
        instructions = (ROOT.parent / "AGENTS.md").read_text(encoding="utf-8")
        match = re.search(r"SSH / sudo 密码：`([^`]+)`", instructions)
        if not match:
            raise RuntimeError("No existing board credential available")
        os.environ["RK_BOARD_PASSWORD"] = match.group(1)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    output = ROOT / "logs" / ("memory-catalog-deploy-" + stamp)
    output.mkdir(parents=True, exist_ok=False)
    backup = REMOTE + "/.runtime/memory-catalog-backup-" + stamp
    report = {"passed": False, "backup": backup, "files": {}, "isolated_validation": None}
    with connect() as client:
        code = ("import sys,json;sys.path.insert(0,'agent');from memory_client import MemoryClient;"
                "c=MemoryClient('.');h=c.request('/health');"
                "assert not h['busy'],'Memory maintenance is active';"
                "a=c.request('/activity',{'session_id':'catalog-deployment','active':True});"
                "assert a['active_sessions']==1,'Other foreground task is active';print('idle')")
        try:
            execute(client, "python3 -c " + shlex.quote(code))
        except Exception:
            release = "import sys;sys.path.insert(0,'agent');from memory_client import MemoryClient;MemoryClient('.').request('/activity',{'session_id':'catalog-deployment','active':False})"
            execute(client, "python3 -c " + shlex.quote(release))
            raise
        stopped = False
        changed = False
        originals = {}
        try:
            with client.open_sftp() as sftp:
                for name in FILES:
                    with sftp.open(REMOTE + "/" + name, "rb") as stream:
                        originals[name] = stream.read()
                    target = output / "before" / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(originals[name])
                    report["files"][name] = {
                        "before": hashlib.sha256(originals[name]).hexdigest(),
                        "after": hashlib.sha256((ROOT / name).read_bytes()).hexdigest()}
            # Reject unrelated deployed changes outside the explicitly modified methods.
            import ast
            modified = {"__init__", "get", "set", "browse", "revise", "call"}
            additions = {"init_catalog", "checked_tags", "descriptor", "catalog", "get_many", "write_descriptor"}
            for name in FILES:
                before_tree = ast.parse(originals[name].decode())
                after_tree = ast.parse((ROOT / name).read_text(encoding="utf-8"))
                def unaffected(tree):
                    for node in ast.walk(tree):
                        if isinstance(node, ast.ClassDef):
                            node.body = [part for part in node.body if not isinstance(part, ast.FunctionDef)
                                         or part.name not in modified | additions]
                    tree.body = [node for node in tree.body if not (
                        isinstance(node, ast.Import) and any(alias.name == "unicodedata" for alias in node.names))]
                    return ast.dump(tree)
                if unaffected(before_tree) != unaffected(after_tree):
                    raise RuntimeError("Unrelated deployed source differs: " + name)
            execute(client, "bash scripts/stop-memory.sh")
            stopped = True
            backup_code = ("import json,shutil;from pathlib import Path;"
                "r=Path('.').resolve();b=Path(" + repr(backup) + ");"
                "assert b.parent==r/'.runtime';b.mkdir(mode=0o700);"
                "c=r/'.runtime/memory-config.json';cfg=json.loads(c.read_text());"
                "d=(r/cfg.get('data_dir','.runtime/mem0-v2')).resolve();"
                "assert r in d.parents and d!=r;"
                "shutil.copytree(d,b/'store');shutil.copy2(c,b/'memory-config.json');"
                "[(b/Path(n).name).write_bytes((r/n).read_bytes()) for n in " + repr(FILES) + "]")
            execute(client, "python3 -c " + shlex.quote(backup_code), timeout=60)
            with client.open_sftp() as sftp:
                for name in FILES:
                    with sftp.open(REMOTE + "/" + name, "rb") as stream:
                        if stream.read() != originals[name]:
                            raise RuntimeError("Concurrent source modification detected")
                    stage = REMOTE + "/" + name + ".catalog-new"
                    sftp.put(str(ROOT / name), stage)
                    sftp.posix_rename(stage, REMOTE + "/" + name)
                    changed = True
                sftp.put(str(ROOT / "scripts/validate-memory-catalog.py"), REMOTE + "/scripts/validate-memory-catalog.py")
            execute(client, "bash scripts/start-memory.sh")
            stopped = False
            check = ("import sys,json;sys.path.insert(0,'agent');from memory_client import MemoryClient;"
                     "c=MemoryClient('.');h=c.request('/health');"
                     "assert 'tag_catalog_v1' in h['capabilities'];"
                     "x=c.call({'op':'get_many','ids':['catalog-nonexistent-validation-id']});"
                     "assert x['missing']==['catalog-nonexistent-validation-id'];print(json.dumps(h))")
            report["health"] = json.loads(execute(client, "python3 -c " + shlex.quote(check)))
            validation = execute(client, ".venv-memory/bin/python scripts/validate-memory-catalog.py", timeout=60)
            report["isolated_validation"] = json.loads(validation.strip().splitlines()[-1])
            assert report["isolated_validation"]["passed"]
            report["passed"] = True
        except Exception:
            if originals and (stopped or changed):
                if not stopped:
                    execute(client, "bash scripts/stop-memory.sh")
                with client.open_sftp() as sftp:
                    for name, data in originals.items():
                        with sftp.open(REMOTE + "/" + name, "wb") as stream:
                            stream.write(data)
                execute(client, "bash scripts/start-memory.sh")
            raise
        finally:
            release = "import sys;sys.path.insert(0,'agent');from memory_client import MemoryClient;MemoryClient('.').request('/activity',{'session_id':'catalog-deployment','active':False})"
            try:
                execute(client, "python3 -c " + shlex.quote(release))
            except Exception:
                report["lease_release_failed"] = True
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps({"passed": report["passed"], "report": str(output / "report.json")}))


if __name__ == "__main__":
    main()
