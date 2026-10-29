"""Upload a verified local embedder, back up legacy data, and stage Mem0 migration."""

import argparse
import hashlib
import json
from pathlib import Path
import secrets
import shlex
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from host import connect, command, REMOTE  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--activate", action="store_true", help="Enable Mem0 after staging and validation"
    )
    args = parser.parse_args()
    local = ROOT / ".cache/memory-model"
    manifest = json.loads((local / "manifest.json").read_text(encoding="utf-8"))
    with connect() as client:
        if args.activate:
            command(
                client,
                f"cd {REMOTE} && .venv-memory/bin/python scripts/validate-memory.py --activate",
            )
            return
        command(
            client,
            f"cd {REMOTE} && .venv-memory/bin/python -c 'import mem0, fastembed, onnxruntime'",
        )
        with client.open_sftp() as sftp:
            command(client, "mkdir -p " + shlex.quote(REMOTE + "/.runtime/memory-model"))
            for name, info in manifest["files"].items():
                source = local / name
                if hashlib.sha256(source.read_bytes()).hexdigest() != info["sha256"]:
                    raise ValueError("Embedding file checksum mismatch")
                sftp.put(str(source), REMOTE + "/.runtime/memory-model/" + name)
            sftp.put(str(local / "manifest.json"), REMOTE + "/.runtime/memory-model/manifest.json")
            key_path = REMOTE + "/.runtime/memory-key"
            try:
                sftp.stat(key_path)
            except FileNotFoundError:
                with sftp.open(key_path, "w") as output:
                    output.write(secrets.token_hex(32))
                sftp.chmod(key_path, 0o600)
            config = {
                "enabled": False,
                "auto_maintain": False,
                "idle_seconds": 120,
                "project": "rk",
                "user": "local",
                "data_dir": ".runtime/mem0-v2",
                "embedding_model": "BAAI/bge-small-zh-v1.5",
                "embedding_dims": 512,
                "embedding_dir": ".runtime/memory-model",
                "context_bytes": 1200,
                "compress_min_items": 8,
                "upstream": "mem0ai==2.2.1",
                "embedding_revision": manifest["revision"],
            }
            config_path = REMOTE + "/.runtime/memory-config.json"
            try:
                with sftp.open(config_path) as current:
                    old = json.load(current)
                if old.get("enabled"):
                    raise RuntimeError(
                        "Mem0 is already active; staging must not overwrite its configuration"
                    )
            except FileNotFoundError:
                pass
            with sftp.open(config_path, "w") as output:
                output.write(json.dumps(config))
            sftp.chmod(config_path, 0o600)
        checks = "\n".join(
            f"assert hashlib.sha256((home/{name!r}).read_bytes()).hexdigest()=={info['sha256']!r}"
            for name, info in manifest["files"].items()
        )
        command(
            client,
            "python3 -c "
            + shlex.quote(
                "import hashlib; from pathlib import Path; home=Path("
                + repr(REMOTE + "/.runtime/memory-model")
                + ")\n"
                + checks
            ),
        )
        command(
            client,
            f"cd {REMOTE} && bash scripts/start-memory.sh --staging && python3 scripts/migrate-memory.py",
        )


if __name__ == "__main__":
    main()
