"""Launch the Windows software companion and its authenticated reverse SSH tunnel."""

import argparse
import hashlib
import json
from pathlib import Path
import secrets
import shlex
import socket
import subprocess
import threading
import time
import urllib.request

from desktop_host import relay
from host import ROOT, REMOTE, connect


SOURCES = (
    "agent/windows_desktop.py", "agent/windows_config.py", "agent/mcp_server.py",
    "plugins/windows-desktop.mjs", "scripts/windows-agent.sh",
    "skills/rk-windows-desktop/SKILL.md",
    "agent/observation_view.py",
)


def install(client):
    """Copy only this capability; archive changed remote sources before replacing."""
    stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
    with client.open_sftp() as sftp:
        for name in SOURCES:
            target = REMOTE + "/" + name
            data = (ROOT / name).read_bytes()
            try:
                with sftp.open(target, "rb") as source:
                    old = source.read()
            except FileNotFoundError:
                old = None
            if old == data:
                continue
            # mkdir uses quoted paths; no user text is evaluated as shell code.
            parents = [str(Path(target).parent).replace("\\", "/")]
            backup = REMOTE + "/.runtime/windows-backup-" + stamp + "/" + name
            if old is not None:
                parents.append(str(Path(backup).parent).replace("\\", "/"))
            _, stdout, _ = client.exec_command("mkdir -p " + shlex.join(parents))
            if stdout.channel.recv_exit_status():
                raise RuntimeError("Cannot prepare Windows tool deployment")
            if old is not None:
                with sftp.open(backup, "wb") as dest:
                    dest.write(old)
            pending = target + ".windows-pending"
            with sftp.open(pending, "wb") as dest:
                dest.write(data)
            with sftp.open(pending, "rb") as source:
                if hashlib.sha256(source.read()).digest() != hashlib.sha256(data).digest():
                    raise RuntimeError("Windows source upload checksum mismatch")
            sftp.posix_rename(pending, target)


def forward(channel):
    try:
        with socket.create_connection(("127.0.0.1", 8093), timeout=5) as local:
            local.settimeout(None)  # Five seconds limits connection setup, not a verified form batch.
            threading.Thread(target=relay, args=(channel, local), daemon=True).start()
            relay(local, channel)
    finally:
        channel.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--allow-file", action="append", default=[])
    parser.add_argument("--file-app")
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--output-dir", type=Path, default=ROOT / ".runtime/windows-observer")
    parser.add_argument("--install", action="store_true", help="Install/update this RK capability only")
    args = parser.parse_args()
    runtime = ROOT / ".runtime"
    runtime.mkdir(exist_ok=True)
    try:
        with socket.create_connection(("127.0.0.1", 8093), timeout=0.5):
            raise RuntimeError("Port 8093 already has a service; keep the existing session intact")
    except OSError:
        pass
    key = secrets.token_hex(32)
    (runtime / "windows-desktop-key").write_text(key, encoding="utf-8")
    interpreter = ROOT.parent / "deployment/screen-ocr/.venv/Scripts/python.exe"
    cmd = [str(interpreter), "-u", str(ROOT / "pc/windows_service.py"), "--title", args.title,
           "--output-dir", str(args.output_dir)]
    for enabled, flag in ((args.execute, "--execute"), (args.ocr, "--ocr")):
        if enabled:
            cmd.append(flag)
    files = [str(Path(p).resolve(strict=True)) for p in args.allow_file]
    for path in files:
        cmd.extend(["--allow-file", path])
    if args.file_app:
        cmd.extend(["--file-app", args.file_app])
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stop = runtime / "windows-desktop-stop"
    stop.unlink(missing_ok=True)
    with (args.output_dir / "service.log").open("ab", buffering=0) as log:
        process = subprocess.Popen(cmd, stdout=log, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        client, session = None, None
        try:
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    raise RuntimeError("Windows companion exited; inspect its service.log")
                try:
                    request = urllib.request.Request("http://127.0.0.1:8093/health",
                        headers={"Authorization": "Bearer " + key})
                    with urllib.request.urlopen(request, timeout=1) as response:
                        health = json.load(response)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.2)
            client = connect()
            if args.install:
                install(client)
            transport = client.get_transport()
            transport.request_port_forward("127.0.0.1", 8093)
            session = {"session_id": health["session_id"], "window": args.title,
                       "execute": args.execute, "allowed_files": files, "stopped": False}

            def save(value):
                (runtime / "windows-desktop-session.json").write_text(
                    json.dumps(value, ensure_ascii=False), encoding="utf-8")
                with client.open_sftp() as sftp:
                    for name, data in (("windows-desktop-key", key),
                                       ("windows-desktop-session.json", json.dumps(value))):
                        path = REMOTE + "/.runtime/" + name
                        with sftp.open(path, "w") as dest:
                            dest.write(data)
                        sftp.chmod(path, 0o600)

            save(session)
            print("Windows companion ready: " + args.title + "; execute=" + str(args.execute),
                  flush=True)
            while transport.is_active() and not stop.exists() and process.poll() is None:
                channel = transport.accept(0.5)
                if channel:
                    threading.Thread(target=forward, args=(channel,), daemon=True).start()
        except KeyboardInterrupt:
            pass
        finally:
            # Stop accepting inputs before disconnecting; only this child is terminated.
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            if client:
                if session:
                    try:
                        save({**session, "stopped": True})
                    except (OSError, EOFError):
                        pass
                try:
                    client.get_transport().cancel_port_forward("127.0.0.1", 8093)
                finally:
                    client.close()


if __name__ == "__main__":
    main()
