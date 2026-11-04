"""Real selected-model HTTP + OpenCode random-file capability validation on the board."""

import datetime
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "agent"))
from model_profiles import health_matches, load_profile, running_model  # noqa: E402
from memory_client import MemoryClient  # noqa: E402


def main():
    profile = load_profile()
    health = running_model(ROOT)
    if not health_matches(health, profile):
        raise RuntimeError("Start the selected model profile before validation")
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime(
        "%Y%m%d-%H%M%S"
    )
    nonce = secrets.token_hex(6)
    folder = ROOT / "logs" / ("model-profile-" + stamp + "-" + nonce)
    folder.mkdir()
    probe = ROOT / "workspace" / ("model-profile-" + nonce + ".txt")
    probe.parent.mkdir(exist_ok=True)
    token = "RK_MODEL_" + secrets.token_hex(8)
    text = "VERIFICATION_TOKEN=" + token + "\n"
    probe.write_text(text, encoding="utf-8")
    (folder / "probe.txt").write_text(text, encoding="utf-8")
    key = (ROOT / ".runtime/api-key").read_text().strip()
    result = {"profile": profile, "health": health, "file_token": token, "passed": False}
    lease = "model-profile-validation-" + nonce
    memory = None

    def query(label, prompt, tokens=24, model=None):
        body = {"model": model or health["model"], "max_tokens": tokens,
                "messages": [{"role": "user", "content": prompt}]}
        (folder / (label + "-request.json")).write_text(
            json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        request = urllib.request.Request(
            "http://127.0.0.1:8088/v1/chat/completions", data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                     "X-RK-Cache": "off"},
        )
        try:
            response = urllib.request.urlopen(request, timeout=180)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read().decode("utf-8")
            (folder / (label + "-response.json")).write_text(raw, encoding="utf-8")
            return response.status, json.loads(raw)

    try:
        config = ROOT / ".runtime/memory-config.json"
        if config.exists() and json.loads(config.read_text()).get("enabled"):
            memory = MemoryClient(ROOT)
            memory.request("/activity", {"session_id": lease, "active": True})
            memory.request("/ready-for-foreground", {}, timeout=185)
        status, value = query("short", "What is 2+3? Answer only the digit.")
        result["short_correct"] = (
            status == 200 and value["choices"][0]["message"]["content"].strip() == "5"
        )
        status, value = query("utf8", "请原样输出这四个字，不要其他文字：你好世界")
        result["utf8_correct"] = (
            status == 200 and value["choices"][0]["message"]["content"].strip() == "你好世界"
        )
        status, _ = query("unknown-model", "hello", model="unregistered-model")
        result["wrong_model_rejected"] = status == 400
        status, _ = query("output-limit", "hello", tokens=health["max_output"] + 1)
        result["output_limit_rejected"] = status == 400
        prompt = (
            f"Read {probe.name} with the read tool. "
            "Report the exact VERIFICATION_TOKEN from its contents."
        )
        (folder / "prompt.txt").write_text(prompt, encoding="utf-8")
        with (folder / "opencode.jsonl").open("wb") as output, (
            folder / "opencode.stderr"
        ).open("wb") as errors:
            process = subprocess.run(
                ["timeout", "240", "bash", "scripts/opencode.sh", "run", "--format", "json",
                 "--agent", "rk-local", prompt], cwd=ROOT, stdout=output, stderr=errors,
                env={**os.environ, "RK_AGENT_PROFILE": profile["profile"]}, timeout=250,
            )
        events = []
        for line in (folder / "opencode.jsonl").read_text(encoding="utf-8").splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
        calls = [e for e in events if e.get("type") == "tool_use"
                 and e.get("part", {}).get("tool") == "read"
                 and e.get("part", {}).get("state", {}).get("status") == "completed"]
        answer = "\n".join(
            e.get("part", {}).get("text", "") for e in events if e.get("type") == "text"
        )
        result.update(exit_code=process.returncode, read_completed=bool(calls),
                      final_answer=answer, file_token_correct=token in answer)
        result["passed"] = all(result[k] for k in (
            "short_correct", "utf8_correct", "wrong_model_rejected", "output_limit_rejected",
            "read_completed", "file_token_correct",
        )) and process.returncode == 0
    finally:
        probe.unlink(missing_ok=True)
        if memory is not None:
            memory.request("/activity", {"session_id": lease, "active": False})
        (folder / "result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps({"result_dir": str(folder), **result}, ensure_ascii=False), flush=True)
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
