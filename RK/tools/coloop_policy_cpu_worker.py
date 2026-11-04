"""Private Linux CPU-only policy runner; uploaded by drive_coloop_policy_linux.py."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import time


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    path.chmod(0o600)


def main():
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / "upload-manifest.json").read_bytes())
    for name, expected in manifest["files"].items():
        path = root / name
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise RuntimeError("UPLOAD_PATH_INVALID")
        if digest(path.read_bytes()) != expected:
            raise RuntimeError("UPLOAD_HASH_CHANGED")
    runtime = Path(manifest["runtime"])
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": str(root),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "BUN_BE_BUN": "1",
    }
    version = (
        subprocess.run(
            [str(runtime), "--version"], env=env, capture_output=True, timeout=10, check=True
        )
        .stdout.decode("ascii")
        .strip()
    )
    command = [str(runtime), str(root / "policy-bundle.mjs")]
    inputs = [json.loads(line) for line in (root / "remote-inputs.jsonl").read_bytes().splitlines()]
    execution = {
        "layer": "policy",
        "agent_started": False,
        "npu_calls": 0,
        "source_verification_simulated_for_policy_only": True,
        "linux_snapshot_open_exercised": False,
        "runtime_version": version,
        "runtime_sha256": digest(runtime.read_bytes()),
        "platform": platform.platform(),
        "python_version": platform.python_version(),
        "command": command,
        "environment": env,
        "remote_input_sha256": digest((root / "remote-inputs.jsonl").read_bytes()),
        "upload_verified_files": len(manifest["files"]),
        "records": [],
    }
    started = time.monotonic()
    with (root / "receipts.jsonl").open("w", encoding="utf-8") as saved:
        for index, public in enumerate(inputs):
            before = time.monotonic()
            process = subprocess.Popen(
                command,
                cwd=root,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            timed_out = False
            try:
                stdout, stderr = process.communicate(
                    json.dumps(public, ensure_ascii=False).encode("utf-8"), timeout=25
                )
            except subprocess.TimeoutExpired:
                timed_out = True
                process.kill()
                stdout, stderr = process.communicate()
            record = {
                "case_id": public["case_id"],
                "pid": process.pid,
                "returncode": process.returncode,
                "timeout": timed_out,
                "wall_seconds": time.monotonic() - before,
                "stdout_sha256": digest(stdout),
                "stderr_sha256": digest(stderr),
                "stderr_bytes": len(stderr),
                "child_reaped": process.poll() is not None,
            }
            execution["records"].append(record)
            try:
                if process.returncode or timed_out or len(stdout) > 2 * 1024 * 1024:
                    raise ValueError("CPU_DRIVER_FAILED")
                receipt = json.loads(stdout)
                if receipt.get("case_id") != public["case_id"]:
                    raise ValueError("CPU_RECEIPT_INVALID")
            except (ValueError, AttributeError):
                receipt = {
                    "case_id": public["case_id"],
                    "status": "error",
                    "error_code": "CPU_DRIVER_FAILED",
                }
            saved.write(json.dumps(receipt, ensure_ascii=False, allow_nan=False) + "\n")
            saved.flush()
            save(root / "execution.json", execution)
            print(
                json.dumps(
                    {
                        "completed": index + 1,
                        "planned": len(inputs),
                        "case_id": public["case_id"],
                        "status": receipt.get("status"),
                        "runtime": version if index == 0 else None,
                    }
                ),
                flush=True,
            )
            # The first real case is the Bun/Ed25519 compatibility smoke.
            # Do not start the rest if the runtime itself could not run this driver.
            if index == 0 and receipt.get("status") != "completed":
                break
    execution["wall_seconds"] = time.monotonic() - started
    execution["all_children_reaped"] = all(row["child_reaped"] for row in execution["records"])
    save(root / "execution.json", execution)
    return 0 if len(execution["records"]) == len(inputs) else 1


if __name__ == "__main__":
    sys.exit(main())
