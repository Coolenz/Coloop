"""One model description shared by launchers, the bridge and OpenCode.

Profiles describe local RKLLM assets; they never download weights or grant tools.
"""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent
WORKER_PROTOCOL = 3
PROFILE_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}")
MODEL_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}")


def _integer(value, name, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{name} must be an integer in {low}..{high}")
    return value


def _path(base, value):
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("Profile paths must be non-empty strings without NUL")
    path = Path(value).expanduser()
    return (base / path).resolve()


def _stat(path):
    try:
        value = path.stat()
        return [value.st_size, value.st_mtime_ns]
    except FileNotFoundError:
        return None


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def load_profile(name=None, *, root=ROOT, environ=None):
    """Resolve a named JSON profile and the supported process-only overrides."""
    env = os.environ if environ is None else environ
    if name is None:
        name = env.get("RK_AGENT_PROFILE", "qwen35-4b")
    if not isinstance(name, str) or not PROFILE_NAME.fullmatch(name):
        raise ValueError("Invalid RK_AGENT_PROFILE name")
    root = Path(root).resolve()
    path = root / "model-profiles" / (name + ".json")
    spec = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(spec, dict) or type(spec.get("version")) is not int or spec["version"] != 1:
        raise ValueError("Model profile version must be 1")
    allowed = {
        "version", "model_id", "name", "app", "model", "runtime", "include", "lock",
        "runtime_version", "context_limit", "context", "max_output", "default_output",
        "prompt_format", "thinking", "native_cache", "cache_mode", "embed_flash",
        "base_domain_id", "n_keep", "agent_config",
    }
    if set(spec) - allowed:
        raise ValueError(f"Unknown model profile fields: {sorted(set(spec) - allowed)}")
    model_id = env.get("RK_AGENT_MODEL_ID", spec.get("model_id"))
    if not isinstance(model_id, str) or not MODEL_NAME.fullmatch(model_id):
        raise ValueError("Invalid model_id")
    for field in ("name", "runtime_version"):
        if not isinstance(spec.get(field), str) or not spec[field].strip():
            raise ValueError(f"Missing profile field: {field}")
    prompt_format = spec.get("prompt_format")
    if prompt_format not in ("embedded", "deepseek-r1"):
        raise ValueError("prompt_format must be embedded or deepseek-r1")
    for field in ("thinking", "native_cache"):
        if type(spec.get(field)) is not bool:
            raise ValueError(f"{field} must be a boolean")
    if spec["native_cache"] and prompt_format != "embedded":
        raise ValueError("Native cache requires the embedded model template")
    if prompt_format == "deepseek-r1" and not spec["thinking"]:
        raise ValueError("The prefixed DeepSeek R1 format requires thinking")
    limit = _integer(spec.get("context_limit"), "context_limit", 512, 262144)
    context = _integer(spec.get("context"), "context", 512, limit)
    if "RKLLM_CONTEXT" in env:
        context = _integer(int(env["RKLLM_CONTEXT"]), "RKLLM_CONTEXT", 512, limit)
    maximum = _integer(spec.get("max_output"), "max_output", 1, 2048)
    maximum = min(maximum, context - 1)
    default_output = _integer(spec.get("default_output"), "default_output", 1, maximum)
    cache_mode = env.get("RK_AGENT_CACHE_MODE", spec.get("cache_mode", "off"))
    if cache_mode not in ("off", "native") or (
        cache_mode == "native" and not spec["native_cache"]
    ):
        raise ValueError("Requested cache mode is not supported by this model profile")
    app = _path(root, env.get("RKLLM_APP", spec.get("app")))
    model = _path(app, env.get("RKLLM_MODEL", spec.get("model")))
    runtime = _path(app, env.get("RKLLM_RUNTIME", spec.get("runtime", "lib")))
    include = _path(app, spec.get("include", "include"))
    lock = _path(app, spec.get("lock"))
    config_name = spec.get("agent_config", "opencode-qwen.json")
    if config_name not in ("opencode.json", "opencode-qwen.json"):
        raise ValueError("agent_config must name an established permission template")
    n_keep = _integer(spec.get("n_keep", 0), "n_keep", 0, limit - 1)
    n_keep = min(n_keep, context // 2 if context <= 2048 else context - 1)
    result = {
        **spec, "profile": name, "model_id": model_id, "app": str(app),
        "model": str(model), "runtime": str(runtime), "include": str(include),
        "lock": str(lock), "context": context, "max_output": maximum,
        "default_output": default_output, "cache_mode": cache_mode, "n_keep": n_keep,
        "agent_config": config_name,
        "embed_flash": _integer(spec.get("embed_flash", 0), "embed_flash", 0, 1),
        "base_domain_id": _integer(spec.get("base_domain_id", 0), "base_domain_id", 0, 255),
    }
    # Identity is configuration + asset file metadata, not a weight checksum/quality claim.
    result["fingerprint"] = _digest({
        "profile": result, "model_stat": _stat(model),
        "header_stat": _stat(include / "rkllm.h"),
        "runtime_stat": _stat(runtime / "librkllmrt.so"),
        "sources": {
            str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (root / "src/worker.cpp", root / "bridge/server.py",
                      root / "bridge/protocol.py", root / "model_profiles.py") if p.is_file()
        },
    })
    return result


def check_assets(profile):
    for path in (
        profile["model"], str(Path(profile["include"]) / "rkllm.h"),
        str(Path(profile["runtime"]) / "librkllmrt.so"),
    ):
        if not Path(path).is_file() or Path(path).stat().st_size == 0:
            raise ValueError(f"Required local model asset missing or empty: {path}")


def build_signature(profile, root=ROOT):
    sources = [Path(root) / "src/worker.cpp", Path(profile["include"]) / "rkllm.h",
               Path(profile["runtime"]) / "librkllmrt.so"]
    return _digest({
        "protocol": WORKER_PROTOCOL,
        "files": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
    })


def opencode_config(profile, root=ROOT, *, managed=False):
    """Change model routing only; retain the template's tools/plugins/permissions."""
    template = "opencode-coloop-managed.json" if managed else profile["agent_config"]
    config = json.loads((Path(root) / template).read_text(encoding="utf-8-sig"))
    provider = config["provider"]["rkllm"]
    model = copy.deepcopy(next(iter(provider["models"].values())))
    output = min(model["limit"]["output"], profile["max_output"]) if managed else profile[
        "default_output"
    ]
    # The bridge strips reasoning; OpenCode receives final text/tool actions only.
    model.update(name=profile["name"], reasoning=False)
    model["limit"] = {"context": profile["context"], "output": output}
    model["options"]["maxTokens"] = output
    provider["models"] = {profile["model_id"]: model}
    config["model"] = config["small_model"] = "rkllm/" + profile["model_id"]
    return config


def health_matches(health, profile):
    return health.get("ready") is True and all(health.get(k) == v for k, v in {
        "model": profile["model_id"], "context": profile["context"],
        "cache_mode": profile["cache_mode"], "profile_fingerprint": profile["fingerprint"],
        "worker_protocol": WORKER_PROTOCOL,
    }.items())


def config_path(profile, root=ROOT):
    folder = Path(root) / ".runtime"
    folder.mkdir(exist_ok=True)
    path = folder / f"opencode-{profile['profile']}-{profile['fingerprint']}.json"
    data = json.dumps(opencode_config(profile, root), ensure_ascii=False, indent=2)
    if not path.exists() or path.read_text(encoding="utf-8") != data:
        descriptor, pending = tempfile.mkstemp(dir=folder, suffix=".pending")
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(data)
            os.replace(pending, path)
        finally:
            Path(pending).unlink(missing_ok=True)
    return path


def running_model(root=ROOT):
    """Read the authenticated live route on each call, including long-lived Mem0 jobs."""
    key = (Path(root) / ".runtime/api-key").read_text().strip()
    request = urllib.request.Request(
        "http://127.0.0.1:8088/health", headers={"Authorization": "Bearer " + key}
    )
    with urllib.request.urlopen(request, timeout=2) as response:
        health = json.load(response)
    model_id = health.get("model")
    if health.get("ready") is not True or not isinstance(model_id, str) or not MODEL_NAME.fullmatch(
        model_id
    ):
        raise ValueError("No ready local model route")
    _integer(health.get("context"), "running context", 512, 262144)
    _integer(health.get("max_output", 2048), "running max_output", 1, 2048)
    return health


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=[
        "show", "shell", "check", "config", "config-path", "build-signature",
    ])
    parser.add_argument("--profile")
    parser.add_argument("--managed", action="store_true")
    args = parser.parse_args()
    try:
        profile = load_profile(args.profile)
        if args.action == "shell":
            values = {
                "RK_AGENT_PROFILE": profile["profile"], "RKLLM_APP": profile["app"],
                "RKLLM_MODEL": profile["model"], "RKLLM_RUNTIME": profile["runtime"],
                "RKLLM_INCLUDE": profile["include"], "RK_AGENT_MODEL_ID": profile["model_id"],
                "RKLLM_CONTEXT": str(profile["context"]),
                "RK_AGENT_CACHE_MODE": profile["cache_mode"],
            }
            print("\n".join(k + "=" + shlex.quote(v) for k, v in values.items()))
        elif args.action == "check":
            check_assets(profile)
            print(f"Local assets present: {profile['profile']} (not an inference validation)")
        elif args.action == "build-signature":
            print(build_signature(profile))
        elif args.action == "config-path":
            print(config_path(profile))
        else:
            value = (
                opencode_config(profile, managed=args.managed)
                if args.action == "config" else profile
            )
            print(json.dumps(value, ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError) as error:
        parser.exit(2, str(error) + "\n")


if __name__ == "__main__":
    main()
