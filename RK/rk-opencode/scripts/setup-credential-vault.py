"""Install an isolated root-owned credential service; never modifies Mem0 or model files."""

import datetime
import hashlib
import json
from pathlib import Path
import shlex
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from host import command, connect, REMOTE, sudo  # noqa: E402


def main():
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime(
        "%Y%m%d-%H%M%S"
    )
    output = ROOT.parent / "logs" / ("credential-vault-deploy-" + stamp)
    output.mkdir(parents=True, exist_ok=False)
    sources = {
        "credential_vault.py": ROOT / "agent/credential_vault.py",
        "credential_client.py": ROOT / "agent/credential_client.py",
        "credential_memory_client.py": ROOT / "agent/credential_memory_client.py",
        "hid.py": ROOT / "agent/hid.py",
        "rk-credential-vault.service": ROOT / "scripts/rk-credential-vault.service",
    }
    manifest = {"time_zone": "Asia/Shanghai", "sources": {}, "installed": False}
    for name, source in sources.items():
        manifest["sources"][name] = hashlib.sha256(source.read_bytes()).hexdigest()
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    with connect() as client:
        command(client, "/usr/bin/python3 -I -c 'import cryptography; print(cryptography.__version__)'")
        stage = REMOTE + "/.runtime/credential-install-" + uuid.uuid4().hex
        command(client, "mkdir -m 700 " + shlex.quote(stage))
        with client.open_sftp() as sftp:
            for name, source in sources.items():
                sftp.put(str(source), stage + "/" + name)
        for name in sources:
            destination = (
                "/etc/systemd/system/" + name if name.endswith(".service")
                else "/usr/local/lib/rk-credential-vault/" + name
            )
            sudo(client, ["install", "-D", "--backup=numbered", "-m", "644",
                          stage + "/" + name, destination])
        # Reuse the established desktop lock without replacing its inode or contents.
        command(client, "python3 -c " + shlex.quote(
            "from pathlib import Path; "
            f"p=Path({REMOTE + '/.runtime/hid.lock'!r}); "
            "p.touch(exist_ok=True)"
        ))
        sudo(client, ["systemctl", "daemon-reload"])
        sudo(client, ["systemctl", "enable", "--now", "rk-credential-vault.service"])
        sudo(client, ["systemctl", "restart", "rk-credential-vault.service"])
        command(client, "systemctl is-active rk-credential-vault.service")
        command(client, "python3 -c " + shlex.quote(
            "import json,subprocess,time\n"
            "for attempt in range(20):\n"
            " r=subprocess.run(['/usr/bin/python3','-I',"
            "'/usr/local/lib/rk-credential-vault/credential_client.py'],"
            "input=b'{\"op\":\"status\"}\\n',capture_output=True)\n"
            " if r.returncode==0 and json.loads(r.stdout).get('ok') is True:\n"
            "  print('vault_ready=True'); break\n"
            " time.sleep(0.2)\n"
            "else: raise SystemExit('vault_not_ready')"
        ))
        # Ordinary cat/OpenCode read cannot access the encryption key or database.
        command(client, "test ! -r /var/lib/rk-credential-vault/master.key && "
                "test ! -r /var/lib/rk-credential-vault/vault.sqlite3 && "
                "printf 'private_files_inaccessible=True\\n'")
    manifest["installed"] = True
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("Deployment evidence: " + str(output))


if __name__ == "__main__":
    main()
