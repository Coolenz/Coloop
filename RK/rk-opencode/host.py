"""Windows-side deployment helper. Requires paramiko; credentials are never saved."""

import argparse
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import shlex
import sys
import tarfile
import time
import urllib.request

import paramiko

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
VERSION = "1.19.5"
ARCHIVE_SHA256 = "fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b"
REMOTE = "/home/cat/rk-opencode"


def download():
    archive = ROOT / f".cache/opencode-linux-arm64-v{VERSION}.tar.gz"
    archive.parent.mkdir(exist_ok=True)
    if archive.exists() and hashlib.sha256(archive.read_bytes()).hexdigest() == ARCHIVE_SHA256:
        print("Verified OpenCode archive already cached")
        return
    url = f"https://github.com/anomalyco/opencode/releases/download/v{VERSION}/opencode-linux-arm64.tar.gz"
    temporary = archive.with_suffix(".part")
    with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
        import shutil

        shutil.copyfileobj(response, output)
    if hashlib.sha256(temporary.read_bytes()).hexdigest() != ARCHIVE_SHA256:
        raise ValueError("Downloaded OpenCode archive checksum mismatch")
    temporary.replace(archive)
    print(f"Downloaded and verified OpenCode {VERSION}")


class PinnedKey(paramiko.MissingHostKeyPolicy):
    def __init__(self, expected):
        self.expected = expected.removeprefix("SHA256:")

    def missing_host_key(self, client, hostname, key):
        actual = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip("=")
        if actual != self.expected:
            raise paramiko.SSHException("Board SSH host fingerprint does not match configured pin")


def connect():
    cfg = json.loads((ROOT.parent / "config/board.json").read_text(encoding="utf-8-sig"))
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(PinnedKey(cfg["host_key_sha256"]))
    password = os.environ.get("RK_BOARD_PASSWORD") or getpass.getpass("Board password: ")
    os.environ["RK_BOARD_PASSWORD"] = password
    client.connect(
        cfg["host"],
        port=cfg.get("ssh_port", 22),
        username=cfg["user"],
        password=password,
        allow_agent=False,
        look_for_keys=False,
        timeout=10,
    )
    client.get_transport().set_keepalive(20)
    return client


def command(client, text):
    _, stdout, _ = client.exec_command("bash -lc " + shlex.quote(text))
    stdout.channel.set_combine_stderr(True)
    for line in stdout:
        print(line, end="", flush=True)
    rc = stdout.channel.recv_exit_status()
    if rc:
        raise RuntimeError(f"Board command failed ({rc})")


def sudo(client, arguments):
    secret = os.environ.get("RK_BOARD_PASSWORD")
    if not secret:
        raise RuntimeError("Connect first to provide the session credential")
    stdin, stdout, _ = client.exec_command("sudo -S -p '' -- " + shlex.join(arguments))
    stdout.channel.set_combine_stderr(True)
    stdin.write(secret + "\n")
    stdin.flush()
    stdin.channel.shutdown_write()
    for line in stdout:
        print(line, end="", flush=True)
    if stdout.channel.recv_exit_status():
        raise RuntimeError("Board sudo action failed")


def hid_action(action):
    script = REMOTE + "/scripts/usb-hid.py"
    with connect() as client:
        if action == "hid-status":
            command(client, "python3 " + shlex.quote(script) + " status")
            return
        mode = "apply" if action == "hid-enable" else "rollback"
        sudo(
            client,
            [
                "systemd-run",
                "--unit=rk-opencode-hid-" + mode + "-" + str(int(time.time())),
                "--no-block",
                "/usr/bin/python3",
                script,
                mode,
            ],
        )
    print(
        "USB setup started; reconnecting if needed. New enable operations have a 120-second rollback.",
        flush=True,
    )
    for attempt in range(30):
        time.sleep(2)
        try:
            with connect() as client:
                if mode == "apply":
                    _, stdout, _ = client.exec_command("test -c /dev/hidg0 && test -c /dev/hidg1")
                    if stdout.channel.recv_exit_status():
                        continue
                    sudo(client, ["python3", script, "confirm"])
                command(client, "python3 " + shlex.quote(script) + " status")
                return
        except (OSError, paramiko.SSHException):
            continue
    raise RuntimeError(
        "USB reconnect not confirmed; wait for automatic rollback and inspect board status"
    )


def upload(client, binary):
    command(
        client, "mkdir -p " + REMOTE + "/{src,bridge,scripts,tests,workspace,logs,.runtime,bin}"
    )
    # A running worker uses the executable being rebuilt and may hold the model lock.
    command(
        client,
        f"if [ -f {REMOTE}/scripts/stop-model.sh ]; then bash {REMOTE}/scripts/stop-model.sh; fi",
    )
    with client.open_sftp() as sftp:
        paths = list(ROOT.glob("opencode*.json")) + [
            ROOT / name
            for name in ("host.py", "desktop_host.py", "testbench.py", "bench_report.py", "requirements-memory.txt")
        ]
        for folder in ("src", "bridge", "scripts", "tests", "agent", "pc", "plugins"):
            if (ROOT / folder).exists():
                paths.extend(
                    p
                    for p in (ROOT / folder).rglob("*")
                    if p.is_file() and "__pycache__" not in p.parts
                )
        for document in ("README.md", "VALIDATION.md", "THIRD_PARTY_NOTICES.md"):
            if (ROOT / document).exists():
                paths.append(ROOT / document)
        for path in paths:
            target = REMOTE + "/" + path.relative_to(ROOT).as_posix()
            parent = str(Path(target).parent).replace("\\", "/")
            try:
                sftp.stat(parent)
            except FileNotFoundError:
                command(client, "mkdir -p " + shlex.quote(parent))
            sftp.put(str(path), target)
        if binary:
            archive = ROOT / f".cache/opencode-linux-arm64-v{VERSION}.tar.gz"
            if hashlib.sha256(archive.read_bytes()).hexdigest() != ARCHIVE_SHA256:
                raise ValueError("OpenCode archive checksum mismatch")
            extracted = ROOT / ".cache/opencode"
            with tarfile.open(archive) as tar:
                members = [
                    m for m in tar.getmembers() if m.isfile() and Path(m.name).name == "opencode"
                ]
                if len(members) != 1:
                    raise ValueError("Unexpected archive contents")
                with tar.extractfile(members[0]) as src, extracted.open("wb") as dst:
                    import shutil

                    shutil.copyfileobj(src, dst)
            last = [time.monotonic()]

            def progress(done, total):
                if time.monotonic() - last[0] > 10:
                    print(f"OpenCode upload {100 * done / total:.0f}%", flush=True)
                    last[0] = time.monotonic()

            sftp.put(str(extracted), REMOTE + "/bin/opencode.pending", callback=progress)
            digest = hashlib.sha256(extracted.read_bytes()).hexdigest()
            command(
                client,
                f"printf '%s  %s\\n' '{digest}' '{REMOTE}/bin/opencode.pending' | sha256sum -c - && "
                f"chmod 755 {REMOTE}/bin/opencode.pending && mv {REMOTE}/bin/opencode.pending {REMOTE}/bin/opencode",
            )
    if (ROOT / ".cache/plugin-sdk/node_modules/@opencode-ai/plugin/package.json").exists():
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "rk_plugin_deps", ROOT / "scripts/install-plugin-deps.py"
        )
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        installer.install(client)
    command(client, f"cd {REMOTE} && bash scripts/build.sh && bin/opencode --version")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=[
            "download",
            "deploy",
            "exec",
            "fetch-logs",
            "hid-status",
            "hid-enable",
            "hid-rollback",
        ],
    )
    parser.add_argument("--binary", action="store_true")
    parser.add_argument("--script", type=Path)
    args = parser.parse_args()
    if args.action == "download":
        download()
        return
    if args.action.startswith("hid-"):
        hid_action(args.action)
        return
    with connect() as client:
        if args.action == "deploy":
            upload(client, args.binary)
        elif args.action == "exec":
            if not args.script:
                parser.error("--script is required")
            command(client, args.script.read_text(encoding="utf-8-sig"))
        else:
            (ROOT / "logs").mkdir(exist_ok=True)
            with client.open_sftp() as sftp:
                # Config debug dumps can contain resolved credentials. Fetch only known logs.
                allowed = {
                    "agent-status.json",
                    "requests.jsonl",
                    "worker.log",
                    "bridge.log",
                    "opencode-smoke.jsonl",
                    "opencode-smoke.stderr",
                    "opencode-chat.jsonl",
                    "memory-status.json",
                    "desktop-status.json",
                    "desktop-actions.jsonl",
                    "agent-resource-status.json",
                }
                for filename in sftp.listdir(REMOTE + "/logs"):
                    if filename in allowed:
                        sftp.get(REMOTE + "/logs/" + filename, str(ROOT / "logs" / filename))
                    elif filename.startswith(
                        (
                            "memory-20",
                            "desktop-plan-20",
                            "desktop-hid-20",
                            "agent-20",
                            "kv-cache-20",
                            "kv-probe-20",
                        )
                    ):
                        directory = ROOT / "logs" / filename
                        directory.mkdir(exist_ok=True)
                        remote = REMOTE + "/logs/" + filename
                        for child in sftp.listdir(remote):
                            if child in {
                                "status.json",
                                "opencode.jsonl",
                                "opencode.stderr",
                                "final-observation.json",
                                "write.jsonl",
                                "write.stderr",
                                "read-new-session.jsonl",
                                "read-new-session.stderr",
                                "probe.txt",
                                "results.json",
                                "summary.json",
                                "summary-corrected.json",
                                "inputs.json",
                                "runtime-1.3.0.log",
                                "runtime-1.3.1.log",
                                "worker.cpp",
                                "probe.py",
                                *{
                                    f"{mode}-{i}-request.json"
                                    for mode in ("off", "auto")
                                    for i in (1, 2, 3)
                                },
                            }:
                                sftp.get(remote + "/" + child, str(directory / child))


if __name__ == "__main__":
    main()
