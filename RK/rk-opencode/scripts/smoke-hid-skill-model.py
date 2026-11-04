"""Board-side real OpenCode/NPU consumer for the isolated HID skill smoke test."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(os.environ.get("RK_AGENT_ROOT", Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(ROOT))
from model_profiles import health_matches, load_profile, opencode_config  # noqa: E402


def memory(path, body, timeout=5):
    config = json.loads((ROOT / ".runtime/memory-config.json").read_text())
    if not config.get("enabled"):
        return
    key = (ROOT / ".runtime/memory-key").read_text().strip()
    request = urllib.request.Request("http://127.0.0.1:8092" + path,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        data=json.dumps(body).encode())
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--protocol-text", help="Test real MCP/USB/value return without model inference")
    args = parser.parse_args()
    folder = args.output_dir.resolve()
    if folder.parent != (ROOT / "logs").resolve() or not folder.name.startswith("hid-skill-"):
        raise ValueError("Use this run's isolated evidence directory")
    key = (ROOT / ".runtime/api-key").read_text().strip()
    request = urllib.request.Request("http://127.0.0.1:8088/health",
                                     headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(request, timeout=2) as response:
        health = json.load(response)
    if not health_matches(health, load_profile()):
        raise RuntimeError("Matching service not ready; no model was started or replaced")
    config = opencode_config(load_profile())
    # Benchmark isolation: keep the production HID skill, explicitly remove memory
    # tools/plugin from this temporary test config. Normal agent permissions stay intact.
    config["default_agent"] = "rk-desktop-fast"
    config["agent"] = {name: config["agent"][name] for name in ("rk-desktop", "rk-desktop-fast")}
    for name, agent in config["agent"].items():
        tool = "rk_desktop_desktop" if name == "rk-desktop" else "rk_desktop_fast_step"
        agent["permission"] = {"*": "deny", tool: "allow"}
        agent["prompt"] += "\nThis isolated test has no memory tool."
    config["agent"].update(title={"disable": True}, summary={"disable": True})
    config["mcp"].pop("rk_memory", None)
    config["plugin"] = ["file://{env:RK_AGENT_ROOT}/plugins/desktop-fast.mjs"]
    path = folder / "opencode-test.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    env = {**os.environ, "RK_AGENT_ROOT": str(ROOT), "RK_AGENT_API_KEY": key,
           "OPENCODE_CONFIG": str(path), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    for name in ("AUTOUPDATE", "MODELS_FETCH", "LSP_DOWNLOAD", "DEFAULT_PLUGINS", "PROJECT_CONFIG",
                 "AUTOCOMPACT", "PRUNE", "CLAUDE_CODE"):
        env["OPENCODE_DISABLE_" + name] = "true"
    for name in ("CONFIG", "DATA", "CACHE"):
        env["XDG_" + name + "_HOME"] = str(ROOT / ".runtime" / name.lower())
    skill = (ROOT / "skills/rk-hid-desktop/SKILL.md").read_text(encoding="utf-8").strip()
    debug = subprocess.run([str(ROOT / "bin/opencode"), "debug", "config"],
                           cwd=ROOT / "workspace", env=env, capture_output=True, timeout=45)
    if debug.returncode:
        raise RuntimeError("OpenCode native config expansion failed")
    resolved = json.loads(debug.stdout)
    loaded = {name: skill in resolved["agent"][name]["prompt"]
              for name in ("rk-desktop", "rk-desktop-fast")}
    (folder / "native-skill-load.json").write_text(json.dumps({
        "skill_sha256": hashlib.sha256(skill.encode()).hexdigest(), "loaded": loaded,
        "memory_disabled_for_test": "rk_memory" not in config["mcp"],
    }, indent=2), encoding="utf-8")  # Never save debug config: it includes the API key.
    if not all(loaded.values()):
        raise RuntimeError("HID skill was not expanded for both desktop agents")
    if args.protocol_text is not None:
        sys.path.insert(0, str(ROOT / "agent"))
        from fast_desktop import observe_initial
        from mcp_server import MCPServer
        observed = observe_initial(ROOT)
        value = MCPServer(ROOT, "desktop-fast").dispatch({"method": "tools/call", "params": {
            "name": "step", "arguments": {"observation_id": observed["observation_id"],
                                           "action": "type", "text": args.protocol_text}}})
        (folder / "protocol.json").write_text(json.dumps(value), encoding="utf-8")
        raise SystemExit(1 if value.get("isError") else 0)
    lease = "hid-skill-smoke:" + uuid.uuid4().hex
    process = None
    report = {"passed": False, "samples": [], "model_restarted": False}
    try:
        memory("/activity", {"session_id": lease, "active": True})
        memory("/ready-for-foreground", {}, timeout=185)
        with (folder / "opencode.jsonl").open("wb") as out, (folder / "opencode.stderr").open("wb") as err:
            process = subprocess.Popen([str(ROOT / "bin/opencode"), "run", "--format", "json",
                                        "--agent", "rk-desktop-fast",
                                        args.prompt_file.read_text(encoding="utf-8")],
                cwd=ROOT / "workspace", env=env, stdin=subprocess.DEVNULL,
                stdout=out, stderr=err, start_new_session=True)
            started, sampled = time.monotonic(), 0
            while process.poll() is None:
                elapsed = time.monotonic() - started
                if elapsed > 240:
                    raise TimeoutError("HID model smoke exceeded 240 seconds")
                if elapsed - sampled >= 2:
                    temps = [int(p.read_text()) / 1000
                             for p in Path("/sys/class/thermal").glob("thermal_zone*/temp")]
                    report["samples"].append({"elapsed": elapsed, "max_c": max(temps)})
                    if max(temps) >= 80:
                        raise RuntimeError("HID model smoke reached the 80C test limit")
                    sampled = elapsed
                lines = (folder / "opencode.jsonl").read_text(encoding="utf-8", errors="replace").splitlines()
                for line in lines:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if (event.get("type") == "tool_use"
                            and event.get("part", {}).get("state", {}).get("status") == "error"):
                        raise RuntimeError("OpenCode tool failed; stopping without replay")
                time.sleep(0.1)
            report.update(exit_code=process.returncode, elapsed=time.monotonic() - started,
                          passed=process.returncode == 0)
    finally:
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        memory("/activity", {"session_id": lease, "active": False})
        (folder / "model-run.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
