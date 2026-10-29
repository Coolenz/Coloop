"""Fetch a revision-pinned Chinese ONNX embedder, with per-file hashes and license."""

import hashlib
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPO = "Qdrant/bge-small-zh-v1.5"
FILES = (
    "model_optimized.onnx",
    "tokenizer.json",
    "tokenizer_config.json",
    "config.json",
    "special_tokens_map.json",
    "vocab.txt",
    "README.md",
)


def main():
    folder = ROOT / ".cache/memory-model"
    folder.mkdir(parents=True, exist_ok=True)
    manifest_path = folder / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        revision = manifest["revision"]
    else:
        with urllib.request.urlopen(
            "https://huggingface.co/api/models/" + REPO, timeout=30
        ) as response:
            model = json.load(response)
        revision = model["sha"]
        manifest = {"repo": REPO, "revision": revision, "license": "MIT", "files": {}}
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    for name in FILES:
        target = folder / name
        previous = manifest["files"].get(name)
        if (
            previous
            and target.exists()
            and hashlib.sha256(target.read_bytes()).hexdigest() == previous["sha256"]
        ):
            continue
        url = f"https://huggingface.co/{REPO}/resolve/{revision}/{name}"
        try:
            response = urllib.request.urlopen(url, timeout=60)
        except urllib.error.HTTPError as error:
            if error.code == 404 and name != "model_optimized.onnx":
                continue
            raise
        temporary = target.with_suffix(target.suffix + ".part")
        last = time.monotonic()
        with response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                if time.monotonic() - last > 20:
                    print(f"{name}: {output.tell() / 1048576:.1f} MiB", flush=True)
                    last = time.monotonic()
        temporary.replace(target)
        manifest["files"][name] = {
            "bytes": target.stat().st_size,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        }
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(name, target.stat().st_size, flush=True)
    print("Pinned embedding model ready: " + revision, flush=True)


if __name__ == "__main__":
    main()
