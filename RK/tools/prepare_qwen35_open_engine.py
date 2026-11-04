"""Prepare a pinned alternative Qwen3.5-4B engine; never alter existing RKLLM assets."""

import argparse
import hashlib
import json
import tarfile
import urllib.request

from prepare_qwen35 import ROOT, digest, fetch_model

VERSION = "v0.10.0"
ENGINE_REPO = "happyme531/open_rknpu2_lm_infer"
MODEL_REPO = "happyme531/Qwen3.5-4B-W4A8-Mixed-QQQ-Rot"
MODEL_REVISION = "ddb89f693b9773852f4ee5a496b4f124a6e28613"
DEST = ROOT / "downloads/qwen35-open-engine-v0.10.0"
MODEL_DIR = DEST / "model"
ASSETS = {
    "linux-aarch64": (5773668, "e12576ec8cec7751941568023c3948b8bb22add2794ab28b059fbd57b854c489"),
    "source": (2397053, "a88aaf72fd849e3aef7690a43b8c1e75642e2c0a054afef6a3268456a247a874"),
}


def get(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def verified_write(target, data, sha256=None, blob_id=None, size=None):
    if size is not None and len(data) != size:
        raise ValueError(f"Size mismatch: {target.name}")
    if sha256 and hashlib.sha256(data).hexdigest() != sha256:
        raise ValueError(f"SHA256 mismatch: {target.name}")
    if blob_id:
        header = f"blob {len(data)}\0".encode()
        if hashlib.sha1(header + data).hexdigest() != blob_id:
            raise ValueError(f"Git blob mismatch: {target.name}")
    if target.exists():
        if target.read_bytes() != data:
            raise ValueError(f"Refusing to replace different asset: {target}")
        return
    temporary = target.with_name(target.name + ".partial")
    temporary.write_bytes(data)
    temporary.replace(target)


def sources():
    DEST.mkdir(parents=True, exist_ok=True)
    manifest = {"engine_repository": ENGINE_REPO, "release": VERSION, "files": {}}
    for platform, (size, checksum) in ASSETS.items():
        name = f"open_rknpu2_lm_infer-{VERSION}-{platform}.tar.gz"
        target = DEST / name
        url = f"https://github.com/{ENGINE_REPO}/releases/download/{VERSION}/{name}"
        if not target.exists():
            verified_write(target, get(url), sha256=checksum, size=size)
        if target.stat().st_size != size or digest(target) != checksum:
            raise ValueError(f"Invalid existing archive: {target}")
        manifest["files"][name] = {"bytes": size, "sha256": checksum, "url": url}
        destination = (
            ROOT / "third_party/open-rknpu2-lm-infer-v0.10.0"
            if platform == "source"
            else DEST / "runtime"
        )
        if not destination.exists():
            destination.mkdir(parents=True)
            with tarfile.open(target) as archive:
                archive.extractall(destination, filter="data")
        # An interrupted extraction must not silently pass on a later invocation.
        with tarfile.open(target) as archive:
            for member in archive.getmembers():
                if member.isfile():
                    local = destination / member.name
                    with archive.extractfile(member) as stream:
                        expected = hashlib.sha256(stream.read()).hexdigest()
                    if not local.is_file() or digest(local) != expected:
                        raise ValueError(f"Extracted archive mismatch: {local}")
        print(f"Verified {name}", flush=True)
    tag = json.loads(get(f"https://api.github.com/repos/{ENGINE_REPO}/git/ref/tags/{VERSION}"))
    manifest["tag_object"] = tag["object"]
    (DEST / "engine-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def models(workers, mirror):
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(
        get(f"https://huggingface.co/api/models/{MODEL_REPO}/revision/{MODEL_REVISION}?blobs=true")
    )
    if metadata["sha"] != MODEL_REVISION:
        raise ValueError("Model revision mismatch")
    (DEST / "upstream-model-metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    manifest = {
        "repository": MODEL_REPO,
        "revision": MODEL_REVISION,
        "license": "Apache-2.0",
        "quantization": "mixed W4A8/W8A8 QQQ rotation",
        "engine": VERSION,
        "files": {},
    }
    # Include all root metadata and shards, including vision/MTP; no evaluation datasets.
    for entry in metadata["siblings"]:
        name = entry["rfilename"]
        if "/" in name or name == ".gitattributes":
            continue
        target = MODEL_DIR / name
        if "lfs" in entry:
            spec = {"bytes": entry["lfs"]["size"], "sha256": entry["lfs"]["sha256"]}
            fetch_model(
                name,
                spec,
                workers,
                mirror,
                destination=MODEL_DIR,
                repository=MODEL_REPO,
                revision=MODEL_REVISION,
            )
        else:
            url = f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{name}"
            data = get(url)
            verified_write(target, data, blob_id=entry["blobId"], size=entry["size"])
            spec = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        manifest["files"][name] = spec
        (DEST / "model-manifest.partial.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )
    (DEST / "model-manifest.partial.json").replace(DEST / "model-manifest.json")
    print("All model files verified", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=["source", "models", "all"], default="all")
    parser.add_argument("--workers", type=int, choices=range(1, 17), default=8)
    parser.add_argument("--mirror", action="store_true")
    args = parser.parse_args()
    if args.stage in ("source", "all"):
        sources()
    if args.stage in ("models", "all"):
        models(args.workers, args.mirror)


if __name__ == "__main__":
    main()
