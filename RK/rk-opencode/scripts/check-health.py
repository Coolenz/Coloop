import json
import os
from pathlib import Path
import sys
import urllib.request

root = Path(__file__).resolve().parents[1]
try:
    key = (root / ".runtime/api-key").read_text().strip()
    req = urllib.request.Request(
        "http://127.0.0.1:8088/health", headers={"Authorization": "Bearer " + key}
    )
    with urllib.request.urlopen(req, timeout=2) as response:
        health = json.load(response)
        if not health.get("ready"):
            raise ValueError("worker unavailable")
        if health.get("model") != os.environ.get("RK_AGENT_MODEL_ID", "qwen35-4b-rkllm"):
            raise ValueError("different model profile is already running")
        default_context = 16384 if health.get("model") == "qwen35-4b-rkllm" else 4096
        expected_context = int(os.environ.get("RKLLM_CONTEXT", default_context))
        if health.get("context") != expected_context:
            raise ValueError("running context differs from the requested profile; restart bridge")
        expected_cache = os.environ.get(
            "RK_AGENT_CACHE_MODE", "native" if health.get("model") == "qwen35-4b-rkllm" else "off"
        )
        if health.get("cache_mode") != expected_cache or health.get("worker_protocol") != 2:
            raise ValueError("worker/cache protocol changed; rebuild and restart bridge")
except Exception:
    sys.exit(1)
