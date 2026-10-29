"""Start the Windows observer and its authenticated reverse USB SSH tunnel."""

import argparse
import json
import os
import secrets
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request

import paramiko

from host import ROOT, REMOTE, connect


def relay(source, destination):
    try:
        while data := source.recv(65536):
            destination.sendall(data)
    except (OSError, EOFError):
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except (OSError, EOFError):
            pass


def forward(channel):
    try:
        with socket.create_connection(("127.0.0.1", 8091), timeout=5) as local:
            sender = threading.Thread(target=relay, args=(channel, local), daemon=True)
            sender.start()
            relay(local, channel)
    finally:
        channel.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title", required=True, help="Exact allowed foreground window title")
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--observer-dir")
    parser.add_argument("--fixture-state")
    parser.add_argument("--perception", choices=("hybrid", "ocr"), default="hybrid")
    parser.add_argument(
        "--execute-hid", action="store_true", help="Enable board HID input for this session"
    )
    args = parser.parse_args()
    runtime = ROOT / ".runtime"
    runtime.mkdir(exist_ok=True)
    stop = runtime / "desktop-stop"
    stop.unlink(missing_ok=True)
    key_path = runtime / "desktop-key"
    if not key_path.exists():
        key_path.write_text(secrets.token_hex(32), encoding="utf-8")
    key = key_path.read_text().strip()
    interpreter = ROOT.parent / "deployment/screen-ocr/.venv/Scripts/python.exe"
    if not interpreter.exists():
        raise SystemExit("Install the parent project screen-OCR environment first")
    cmd = [str(interpreter), "-u", str(ROOT / "pc/observer.py"), "--title", args.title]
    if args.ocr:
        cmd.append("--ocr")
    cmd.extend(["--perception", args.perception])
    if args.observer_dir:
        cmd.extend(["--output-dir", args.observer_dir])
    if args.fixture_state:
        cmd.extend(["--fixture-state", args.fixture_state])
    with (runtime / "observer.log").open("ab", buffering=0) as log:
        observer = subprocess.Popen(
            cmd,
            stdout=log,
            stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        client = None
        session = None
        try:
            for _ in range(40):
                if observer.poll() is not None:
                    raise RuntimeError("Observer stopped; see .runtime/observer.log")
                try:
                    request = urllib.request.Request(
                        "http://127.0.0.1:8091/health", headers={"Authorization": "Bearer " + key}
                    )
                    with urllib.request.urlopen(request, timeout=1) as response:
                        health = json.load(response)
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.5)
            else:
                raise RuntimeError("Observer initialization timed out")
            client = connect()
            transport = client.get_transport()
            transport.request_port_forward("127.0.0.1", 8091)
            session = {
                "session_id": health["session_id"],
                "execute_hid": args.execute_hid,
                "window": args.title,
                "started_at": time.time(),
            }
            with client.open_sftp() as sftp:
                for name, value in [
                    ("desktop-key", key),
                    ("desktop-session.json", json.dumps(session)),
                ]:
                    path = REMOTE + "/.runtime/" + name
                    with sftp.open(path, "w") as output:
                        output.write(value)
                    sftp.chmod(path, 0o600)
            (runtime / "desktop-session.json").write_text(
                json.dumps(session, indent=2), encoding="utf-8"
            )
            print(
                "USB SSH observation tunnel ready; mode="
                + ("USB HID" if args.execute_hid else "plan only"),
                flush=True,
            )
            print("Allowed foreground window: " + args.title, flush=True)
            print("Stop with Ctrl+C or scripts/stop-desktop.ps1.", flush=True)
            while transport.is_active() and not stop.exists():
                if observer.poll() is not None:
                    raise RuntimeError("Observer stopped")
                channel = transport.accept(0.5)
                if channel:
                    threading.Thread(target=forward, args=(channel,), daemon=True).start()
        except KeyboardInterrupt:
            pass
        finally:
            if client:
                try:
                    client.get_transport().cancel_port_forward("127.0.0.1", 8091)
                    if session:
                        with client.open_sftp() as sftp:
                            path = REMOTE + "/.runtime/desktop-session.json"
                            with sftp.open(path) as current:
                                active = json.load(current)
                            if active.get("session_id") == session["session_id"]:
                                with sftp.open(path, "w") as output:
                                    output.write(
                                        json.dumps(
                                            {
                                                **session,
                                                "execute_hid": False,
                                                "stopped_at": time.time(),
                                            }
                                        )
                                    )
                except (OSError, EOFError, paramiko.SSHException):
                    pass
                client.close()
            if session:
                path = runtime / "desktop-session.json"
                try:
                    active = json.loads(path.read_text())
                    if active.get("session_id") == session["session_id"]:
                        path.write_text(
                            json.dumps(
                                {**session, "execute_hid": False, "stopped_at": time.time()},
                                indent=2,
                            ),
                            encoding="utf-8",
                        )
                except (OSError, ValueError):
                    pass
            observer.terminate()
            try:
                observer.wait(timeout=5)
            except subprocess.TimeoutExpired:
                observer.kill()
                observer.wait()


if __name__ == "__main__":
    main()
