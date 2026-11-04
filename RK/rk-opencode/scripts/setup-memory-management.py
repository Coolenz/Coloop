"""Install the unified memory UI relay and update its existing Mem0 provider."""

from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from host import connect, REMOTE, sudo  # noqa: E402


def main():
    subprocess.run([sys.executable, str(ROOT / "scripts/setup-private-memory.py")], check=True)
    with connect() as client:
        staged = REMOTE + "/.runtime/memory-client-" + uuid.uuid4().hex + ".py"
        with client.open_sftp() as sftp:
            sftp.put(str(ROOT / "agent/credential_memory_client.py"), staged)
            sftp.chmod(staged, 0o600)
        sudo(client, ["install", "-D", "--backup=numbered", "-m", "644", staged,
                      "/usr/local/lib/rk-credential-vault/credential_memory_client.py"])
    print("Unified memory management relay installed; model and vault service unchanged")


if __name__ == "__main__":
    main()
