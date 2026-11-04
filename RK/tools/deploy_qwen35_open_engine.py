"""Install the alternative engine in a separate board directory, without starting inference."""

import argparse
import json
import shlex

from deploy_qwen35 import command, connect, mkdirs, models
from prepare_qwen35 import digest
from prepare_qwen35_open_engine import DEST, MODEL_DIR, MODEL_REPO, MODEL_REVISION, VERSION

SUBDIR = "qwen35-4b-open-v0.10.0"


def runtime(client, remote):
    source = DEST / "runtime" / f"open_rknpu2_lm_infer-{VERSION}-linux-aarch64"
    names = [
        "bin/open_rknpu2_lm_infer",
        "build-info.json",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "README.md",
        "README_zh.md",
    ]
    verified = {}
    with client.open_sftp() as sftp:
        for name in names:
            local = source / name
            checksum = digest(local)
            target = remote + "/" + name
            mkdirs(sftp, target.rsplit("/", 1)[0])
            try:
                sftp.stat(target)
            except FileNotFoundError:
                sftp.put(str(local), target + ".partial")
                command(
                    client,
                    "printf '%s\\n' "
                    + shlex.quote(checksum + "  " + target + ".partial")
                    + " | sha256sum -c -\nmv -- "
                    + shlex.quote(target + ".partial")
                    + " "
                    + shlex.quote(target),
                )
            command(
                client,
                "printf '%s\\n' " + shlex.quote(checksum + "  " + target) + " | sha256sum -c -",
            )
            verified[name] = {"sha256": checksum, "bytes": local.stat().st_size}
        with sftp.open(remote + "/engine-manifest.json", "w") as stream:
            manifest = json.loads((DEST / "engine-manifest.json").read_text())
            manifest["files_verified_on_board"] = verified
            stream.write(json.dumps(manifest, indent=2))
    command(
        client,
        "cd " + shlex.quote(remote) + "\nchmod +x bin/open_rknpu2_lm_infer\n"
        "ldd bin/open_rknpu2_lm_infer\nbin/open_rknpu2_lm_infer --version\n"
        "bin/open_rknpu2_lm_infer run --help",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=["runtime", "models", "all"], default="all")
    args = parser.parse_args()
    client, cfg, _ = connect()
    remote = cfg["project_dir"].rstrip("/") + "/" + SUBDIR
    try:
        if args.stage in ("runtime", "all"):
            runtime(client, remote)
        if args.stage in ("models", "all"):
            manifest = json.loads((DEST / "model-manifest.json").read_text())
            models(
                client,
                remote + "/model",
                destination=MODEL_DIR,
                files=manifest["files"],
                repository=MODEL_REPO,
                revision=MODEL_REVISION,
            )
    finally:
        client.close()


if __name__ == "__main__":
    main()
