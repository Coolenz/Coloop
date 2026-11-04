"""Install the shared HID skill and clients without model/service/USB reconfiguration."""

import argparse
import datetime
import hashlib
import json
from pathlib import Path
import shlex
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SOURCES = (
    "agent/hid.py", "agent/desktop.py", "agent/compact.py", "scripts/hid-act.py",
    "agent/hid_workflow.py", "agent/observation_view.py",
    "agent/hid_agent.py", "agent/fast_desktop.py", "scripts/hid-agent.py", "scripts/hid-agent.sh",
    "skills/rk-hid-desktop/references/agent.md",
    "pc/observations.py",
    "skills/rk-hid-desktop/SKILL.md",
    "scripts/setup-hid-skill.py",
)
BINDINGS = {"rk-desktop": "rk_desktop_desktop", "rk-desktop-fast": "rk_desktop_fast_step"}


def merge_prompts(current, template):
    """Change only existing HID agent prompts, never permissions/model/plugin settings."""
    value = json.loads(json.dumps(current))
    for name, tool in BINDINGS.items():
        agent = value.get("agent", {}).get(name)
        if not agent or agent.get("permission", {}).get(tool) != "allow":
            raise ValueError("Missing established HID agent/tool permission: " + name)
        agent["prompt"] = template["agent"][name]["prompt"]
    return value


def install(client, folder, *, opencode_compat=False):
    from host import REMOTE
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime(
        "%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    backup = REMOTE + "/.runtime/hid-skill-backup-" + stamp
    manifest = {"backup": backup, "files": {}, "installed": False, "mcp_required": False,
                "opencode_compat_updated": opencode_compat,
                "model_restarted": False, "usb_reconfigured": False}
    with client.open_sftp() as sftp:
        try:
            with sftp.open(REMOTE + "/.runtime/desktop-session.json") as f:
                session = json.load(f)
            if session.get("execute_hid") is True:
                raise RuntimeError("Active HID session; finish that session before installing")
        except FileNotFoundError:
            pass
        sftp.mkdir(backup, mode=0o700)
        payloads = {name: (ROOT / name).read_bytes() for name in SOURCES}
        if opencode_compat:
            template = json.loads((ROOT / "opencode-qwen.json").read_text(encoding="utf-8"))
            with sftp.open(REMOTE + "/opencode-qwen.json", "rb") as f:
                current = json.load(f)
            payloads["opencode-qwen.json"] = json.dumps(
                merge_prompts(current, template), ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        # Prepare/verify all files before replacing any live source.
        for name, data in payloads.items():
            target = REMOTE + "/" + name
            parent = REMOTE
            for part in name.split("/")[:-1]:
                parent += "/" + part
                try:
                    sftp.stat(parent)
                except FileNotFoundError:
                    sftp.mkdir(parent)
            old = None
            try:
                with sftp.open(target, "rb") as f:
                    old = f.read()
                with sftp.open(backup + "/" + name.replace("/", "__"), "wb") as f:
                    f.write(old)
            except FileNotFoundError:
                pass
            digest = hashlib.sha256(data).hexdigest()
            manifest["files"][name] = {
                "before_sha256": hashlib.sha256(old).hexdigest() if old is not None else None,
                "after_sha256": digest,
            }
            with sftp.open(target + ".pending", "wb") as f:
                f.write(data)
            sftp.chmod(target + ".pending", 0o600)
            with sftp.open(target + ".pending", "rb") as f:
                if hashlib.sha256(f.read()).hexdigest() != digest:
                    raise RuntimeError("Uploaded checksum mismatch: " + name)
        (folder / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        for name in payloads:
            target = REMOTE + "/" + name
            sftp.posix_rename(target + ".pending", target)
            with sftp.open(target, "rb") as f:
                if hashlib.sha256(f.read()).hexdigest() != manifest["files"][name]["after_sha256"]:
                    raise RuntimeError("Installed checksum mismatch: " + name)
    _, out, err = client.exec_command(
        "cd " + shlex.quote(REMOTE) + " && python3 scripts/hid-act.py --capabilities")
    capabilities = json.loads(out.read())
    if out.channel.recv_exit_status():
        raise RuntimeError("Installed capability query failed")
    manifest.update(installed=True, capabilities=capabilities)
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main():
    from host import connect
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--opencode-compat", action="store_true",
                        help="Also update existing OpenCode compatibility prompts; not needed for HID")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=False)
    with connect() as client:
        result = install(client, args.output_dir, opencode_compat=args.opencode_compat)
    print(json.dumps({"installed": result["installed"], "backup": result["backup"],
                      "evidence": str(args.output_dir)}))


if __name__ == "__main__":
    main()
