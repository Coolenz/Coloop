"""Real NPU transport smoke. Requires the bridge to be running on the board."""

import json
from pathlib import Path
import urllib.request

root = Path(__file__).resolve().parents[1]
key = (root / ".runtime/api-key").read_text().strip()
headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}


def request(path, body=None):
    req = urllib.request.Request(
        "http://127.0.0.1:8088" + path,
        data=json.dumps(body, ensure_ascii=False).encode() if body else None,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=240) as response:
        return response.read().decode()


health = json.loads(request("/health"))
print(json.dumps(health))
print(request("/v1/models"))
print(
    request(
        "/v1/chat/completions",
        {
            "model": health["model"],
            "max_tokens": 256,
            "messages": [{"role": "user", "content": "What is 2 + 3? Answer briefly."}],
        },
    )
)
