"""Download and verify PP-OCRv5 mobile models from RapidOCR's pinned registry."""
import hashlib
import importlib.metadata
import json
from pathlib import Path

import rapidocr
import requests
import yaml

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "deployment/screen-ocr/models"
KEYS = {
    "det": "ch_PP-OCRv5_det_mobile",
    "rec": "ch_PP-OCRv5_rec_mobile",
}


def main():
    registry = yaml.safe_load((Path(rapidocr.__file__).parent / "default_models.yaml").read_text(encoding="utf-8"))
    # The 3.10 registry has a top-level onnxruntime section.
    models = registry["onnxruntime"]["PP-OCRv5"]
    DEST.mkdir(parents=True, exist_ok=True)
    manifest = {"rapidocr": importlib.metadata.version("rapidocr"), "models": {}}
    for task, key in KEYS.items():
        info = models[task][key]
        target = DEST / (key + ".onnx")
        digest = info["SHA256"]
        if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            print("Downloading", info["model_dir"], flush=True)
            partial = target.with_suffix(".partial")
            with requests.get(info["model_dir"], stream=True, timeout=(15, 90)) as response:
                response.raise_for_status()
                with partial.open("wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        output.write(chunk)
            actual = hashlib.sha256(partial.read_bytes()).hexdigest()
            if actual != digest:
                raise RuntimeError(f"SHA256 mismatch: {target.name}: {actual}")
            partial.replace(target)
        manifest["models"][task] = {"file": str(target), "url": info["model_dir"], "sha256": digest, "bytes": target.stat().st_size}
        print("Verified", target.name, target.stat().st_size, flush=True)
    (DEST.parent / "model-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
