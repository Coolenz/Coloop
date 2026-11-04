import json
from pathlib import Path
import sys
import urllib.request

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from model_profiles import health_matches, load_profile  # noqa: E402

try:
    key = (root / ".runtime/api-key").read_text().strip()
    req = urllib.request.Request(
        "http://127.0.0.1:8088/health", headers={"Authorization": "Bearer " + key}
    )
    with urllib.request.urlopen(req, timeout=2) as response:
        health = json.load(response)
        if not health_matches(health, load_profile()):
            raise ValueError("Running worker differs from the selected model profile")
except Exception:
    sys.exit(1)
