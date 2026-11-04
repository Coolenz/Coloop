"""Bundle current product policy code, then drive one fixed-suite policy case.

Only local Node/TypeScript and snapshot pure functions are exercised. No SSH,
source Agent, model inference, permit or model-visible file release occurs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT.parent / "Coloop"
NODE = Path("C:/nodejs/node.exe")
SOURCES = [APP / "tests/approval-policy-driver.ts"] + sorted(
    set((APP / "src/main").rglob("*.ts"))
    | set((APP / "src/shared").rglob("*.ts"))
    | set((ROOT / "rk-opencode/agent").glob("coloop_managed*.mjs"))
    | {Path(__file__).resolve()}
)


def bundle() -> Path:
    before = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in SOURCES}
    fingerprint = hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()
    folder = ROOT / "tmp/coloop-approval-policy-driver"
    folder.mkdir(parents=True, exist_ok=True)
    result = folder / (fingerprint + ".mjs")
    if not result.is_file():
        build = subprocess.run(
            [
                str(NODE),
                str(APP / "node_modules/esbuild/bin/esbuild"),
                str(SOURCES[0]),
                "--bundle",
                "--platform=node",
                "--format=esm",
                "--target=node24",
                "--outfile=" + str(result),
                "--log-level=error",
            ],
            cwd=APP,
            capture_output=True,
        )
        if build.returncode:
            raise RuntimeError("POLICY_BUILD_FAILED")
        source = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in SOURCES}
        if source != before:
            raise RuntimeError("POLICY_SOURCE_CHANGED_DURING_BUILD")
        (folder / (fingerprint + ".sources.json")).write_text(
            json.dumps(
                {
                    "source_verification_simulated_for_policy_only": True,
                    "npu_calls": 0,
                    "files": source,
                    "bundle_sha256": hashlib.sha256(result.read_bytes()).hexdigest(),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    return result


def pinned_bundle(path: Path) -> Path:
    path = path.resolve()
    if not path.is_relative_to((ROOT / "tmp/coloop-approval-policy-driver").resolve()):
        raise RuntimeError("POLICY_BUNDLE_OUTSIDE_CACHE")
    metadata = json.loads(path.with_suffix(".sources.json").read_text(encoding="utf-8"))
    if hashlib.sha256(path.read_bytes()).hexdigest() != metadata.get("bundle_sha256"):
        raise RuntimeError("POLICY_BUNDLE_CHANGED")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-only", action="store_true")
    parser.add_argument(
        "--bundle", type=Path, help="Pin one built product revision for the entire suite"
    )
    args = parser.parse_args()
    try:
        artifact = pinned_bundle(args.bundle) if args.bundle else bundle()
        if args.build_only:
            print(json.dumps({"bundle": str(artifact), "npu_calls": 0}))
            return 0
        request = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(request) > 1024 * 1024:
            raise RuntimeError("POLICY_INPUT_LIMIT")
        process = subprocess.run(
            [str(NODE), str(artifact)], input=request, capture_output=True, cwd=APP, timeout=25
        )
        if process.returncode:
            raise RuntimeError("POLICY_DRIVER_FAILED")
        sys.stdout.buffer.write(process.stdout)
        return 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(
            json.dumps(
                {
                    "error_code": str(error)
                    if isinstance(error, RuntimeError)
                    else type(error).__name__
                }
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
