"""Generate a dedicated OpenCode entry with the short Windows skill preloaded."""

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from model_profiles import load_profile, opencode_config  # noqa: E402


def make_config(root=ROOT):
    config = opencode_config(load_profile(root=root), root=root)
    skill = (root / "skills/rk-windows-desktop/SKILL.md").read_text(encoding="utf-8")
    prompt = skill.split("---", 2)[2].strip()
    config["default_agent"] = "rk-windows"
    config["agent"] = {
        "rk-windows": {
            "mode": "primary", "description": "Window-scoped Windows software input",
            "prompt": prompt, "steps": 12,
            "permission": {"*": "deny", "rk_windows_desktop": "allow"},
        },
        "title": {"disable": True}, "summary": {"disable": True},
    }
    config["mcp"] = {"rk_windows": {
        "type": "local", "enabled": True,
        "command": ["python3", "{env:RK_AGENT_ROOT}/agent/mcp_server.py", "--mode", "windows"],
    }}
    config["plugin"] = ["file://{env:RK_AGENT_ROOT}/plugins/windows-desktop.mjs"]
    return config


if __name__ == "__main__":
    target = ROOT / ".runtime/opencode-windows.json"
    target.parent.mkdir(exist_ok=True)
    temporary = target.with_suffix(".pending")
    temporary.write_text(json.dumps(make_config(), ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)
    print(target)
