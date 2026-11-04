"""Link the credential provider into the existing Mem0 service without moving secrets."""

import datetime
import hashlib
import json
from pathlib import Path
import shlex
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from host import connect, REMOTE  # noqa: E402

FILES = (
    "agent/private_memory.py", "agent/mem0_engine.py", "agent/memory_client.py",
    "agent/mcp_server.py", "scripts/memoryctl.py", "opencode-qwen.json",
)


def execute(client, command):
    _, stdout, stderr = client.exec_command("bash -lc " + shlex.quote(command), timeout=20)
    data, errors = stdout.read().decode(), stderr.read().decode()
    if stdout.channel.recv_exit_status():
        raise RuntimeError("Private memory deployment step failed: " + errors[:300])
    return data


def main():
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime(
        "%Y%m%d-%H%M%S"
    )
    output = ROOT.parent / "logs" / ("private-memory-deploy-" + stamp)
    output.mkdir(parents=True, exist_ok=False)
    local_hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}
    lease = "private-memory-install-" + uuid.uuid4().hex
    with connect() as client:
        with client.open_sftp() as sftp:
            config_path = REMOTE + "/.runtime/memory-config.json"
            with sftp.open(config_path) as stream:
                original = stream.read()
            config = json.loads(original)
            if not config.get("enabled"):
                raise RuntimeError("Existing Mem0 must be active before linking private memory")
            snapshot = {}
            for name in FILES:
                try:
                    with sftp.open(REMOTE + "/" + name) as stream:
                        snapshot[name] = stream.read()
                except FileNotFoundError:
                    snapshot[name] = None
            # Preserve the exact deployed base before any changes, including concurrent work.
            for name, data in snapshot.items():
                if data is not None:
                    target = output / "before" / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
            (output / "memory-config-before.json").write_bytes(original)
        code = (
            "import sys,json; sys.path.insert(0,'agent'); from memory_client import MemoryClient; "
            "m=MemoryClient('.'); x=m.request('/activity',"
            + repr({"session_id": lease, "active": True})
            + "); print(json.dumps(x))"
        )
        activity = json.loads(execute(client, "cd " + shlex.quote(REMOTE) + " && python3 -c " + shlex.quote(code)))
        if activity["active_sessions"] != 1:
            release = code.replace("'active': True", "'active': False")
            execute(client, "cd " + shlex.quote(REMOTE) + " && python3 -c " + shlex.quote(release))
            raise RuntimeError("Another foreground session is active; existing Mem0 was not stopped")
        backup = REMOTE + "/.runtime/private-memory-backup-" + stamp
        execute(client, "mkdir -m 700 " + shlex.quote(backup))
        stopped = False
        try:
            execute(client, "cd " + shlex.quote(REMOTE) + " && bash scripts/stop-memory.sh")
            stopped = True
            with client.open_sftp() as sftp:
                for name, before in snapshot.items():
                    if before is not None:
                        with sftp.open(REMOTE + "/" + name) as current:
                            if current.read() != before:
                                raise RuntimeError("Deployed source changed during installation: " + name)
                        with sftp.open(backup + "/" + name.replace("/", "__"), "wb") as stream:
                            stream.write(before)
                    sftp.put(str(ROOT / name), REMOTE + "/" + name + ".private-memory-new")
                with sftp.open(config_path) as current:
                    if current.read() != original:
                        raise RuntimeError("Mem0 configuration changed during installation")
                with sftp.open(backup + "/memory-config.json", "wb") as stream:
                    stream.write(original)
                config["private_credentials"] = {"enabled": True,
                    "project": config.get("project", "rk"), "user": config.get("user", "local")}
                with sftp.open(config_path + ".private-memory-new", "w") as stream:
                    stream.write(json.dumps(config, ensure_ascii=False))
                for name in FILES:
                    sftp.posix_rename(REMOTE + "/" + name + ".private-memory-new", REMOTE + "/" + name)
                sftp.posix_rename(config_path + ".private-memory-new", config_path)
                sftp.chmod(config_path, 0o600)
            execute(client, "cd " + shlex.quote(REMOTE) + " && bash scripts/start-memory.sh")
            stopped = False
            verify = (
                "import json,sys; sys.path.insert(0,'agent'); from memory_client import MemoryClient; "
                "m=MemoryClient('.'); print(json.dumps(m.call({'op':'sync_private'})))"
            )
            status = json.loads(execute(client, "cd " + shlex.quote(REMOTE) + " && python3 -c " + shlex.quote(verify)))
            if not status["private_memory"]["available"]:
                raise RuntimeError("Private memory provider was not ready after restart")
            manifest = {"deployed": True, "time_zone": "Asia/Shanghai", "backup": backup,
                        "source_sha256": local_hashes, "status": status,
                        "ordinary_config_preserved": {k: v for k, v in config.items()
                                                      if k != "private_credentials"} == {
                            k: v for k, v in json.loads(original).items()
                            if k != "private_credentials"}}
            (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            print(json.dumps({"deployed": True, "evidence": str(output), "private_memory": status["private_memory"]}))
        finally:
            if stopped:
                # Keep recoverable inputs; never replace or delete the memory data directory.
                execute(client, "cd " + shlex.quote(REMOTE) + " && bash scripts/start-memory.sh")


if __name__ == "__main__":
    main()
