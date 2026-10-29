"""Install the lockfile-pinned, pure-JavaScript OpenCode plugin SDK cache over USB SSH."""

import hashlib
import json
from pathlib import Path
import shlex
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def install(client):
    sys.path.insert(0, str(ROOT))
    from host import REMOTE, VERSION, command

    source = ROOT / ".cache/plugin-sdk"
    lock = (ROOT / "plugins/package-lock.json").read_bytes()
    if (source / "package-lock.json").read_bytes() != lock:
        raise RuntimeError("Run scripts/prepare-plugin-deps.ps1 to refresh the SDK cache")
    for name in ("plugin", "sdk"):
        package = json.loads(
            (source / f"node_modules/@opencode-ai/{name}/package.json").read_text(encoding="utf-8")
        )
        if package["version"] != VERSION:
            raise RuntimeError("Plugin SDK version differs from OpenCode")
    files = [p for p in source.rglob("*") if p.is_file()]
    if any(p.suffix.lower() in (".node", ".exe") for p in files):
        raise RuntimeError("Refusing to copy native Windows binaries into the board SDK cache")
    archive = ROOT / ".cache/plugin-sdk.tgz"
    with tarfile.open(archive, "w:gz") as output:
        for path in files:
            output.add(path, arcname=path.relative_to(source).as_posix(), recursive=False)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    expected_lock = hashlib.sha256(lock).hexdigest()
    remote_archive = REMOTE + "/.runtime/plugin-sdk.tgz"
    with client.open_sftp() as sftp:
        sftp.put(str(archive), remote_archive)
    script = f"""
import hashlib, json, tarfile
from pathlib import Path
archive = Path({remote_archive!r})
root = Path({REMOTE + "/.runtime/config/opencode"!r})
assert hashlib.sha256(archive.read_bytes()).hexdigest() == {checksum!r}
root.mkdir(parents=True, exist_ok=True)
existing = root / 'package.json'
if existing.exists():
    dependencies = json.loads(existing.read_text()).get('dependencies', {{}})
    if dependencies != {{'@opencode-ai/plugin': {VERSION!r}}}:
        raise RuntimeError('Existing OpenCode config dependencies need an explicit merge')
with tarfile.open(archive) as source:
    for member in source.getmembers():
        target = (root / member.name).resolve()
        if root.resolve() not in target.parents or not member.isfile():
            raise RuntimeError('Unsafe SDK archive member')
        if member.name not in ('package.json', 'package-lock.json') and not member.name.startswith('node_modules/'):
            raise RuntimeError('Unexpected SDK archive member')
    source.extractall(root)
assert hashlib.sha256((root/'package-lock.json').read_bytes()).hexdigest() == {expected_lock!r}
print('OpenCode plugin SDK ready: {VERSION}; offline dependency cache installed')
"""
    command(client, "python3 -c " + shlex.quote(script))


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT))
    from host import connect

    with connect() as client:
        install(client)
