"""Run fixed product policy cases on Linux through the OpenCode binary's Bun mode.

Only public inputs, synthetic fixture bytes and a pinned product bundle are
uploaded. The sealed independent oracle stays on Windows. This does not start
OpenCode Agent services, model workers, memory services or NPU inference.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import shlex
import time

import paramiko

from board_remote import PinnedKey
import drive_coloop_approval_policy as bundler
import eval_coloop_approvals as evaluation

ROOT = Path(__file__).resolve().parents[1]
WORKER = Path(__file__).with_name("coloop_policy_cpu_worker.py")


def remap_input(public: dict, remote: str) -> tuple[dict, dict]:
    """Map only known fixture aliases; adversarial literal paths remain unchanged."""
    aliases = public["aliases"]
    mapped = {
        name: str(PurePosixPath(remote) / "fixtures" / public["case_id"] / name.lower())
        for name in ("WORKSPACE", "OUTSIDE", "AUX")
    }

    def replace(value):
        if isinstance(value, str):
            for name, prefix in aliases.items():
                if (
                    value == prefix
                    or value.startswith(prefix + "/")
                    or value.startswith(prefix + "\\")
                ):
                    return mapped[name] + value[len(prefix) :].replace("\\", "/")
            return value
        if isinstance(value, list):
            return [replace(item) for item in value]
        if isinstance(value, dict):
            return {key: replace(item) for key, item in value.items()}
        return value

    result = replace(public)
    result["request_template"] = public["request_template"]
    return result, {key: {"local": aliases[key], "remote": mapped[key]} for key in mapped}


def verify_remote_evidence(output: Path) -> dict:
    """Bind Linux traces to mapped public inputs without altering sealed inputs."""
    upload = evaluation.json_read(output / "upload-manifest.json")
    execution = evaluation.json_read(output / "execution.json")
    inputs = [
        evaluation.parse_json_bytes(line)
        for line in (output / "case-inputs.jsonl").read_bytes().splitlines()
    ]
    mapped = [
        evaluation.parse_json_bytes(line)
        for line in (output / "remote-inputs.jsonl").read_bytes().splitlines()
    ]
    pathmap = evaluation.json_read(output / "pathmap.json")
    problems = []
    if (
        evaluation.sha((output / "remote-inputs.jsonl").read_bytes())
        != upload["remote_input_sha256"]
    ):
        problems.append("REMOTE_INPUT_HASH_CHANGED")
    if execution["remote_input_sha256"] != upload["remote_input_sha256"]:
        problems.append("EXECUTION_INPUT_HASH_MISMATCH")
    if len(mapped) != len(inputs):
        problems.append("REMOTE_INPUT_COUNT_CHANGED")
    model_attempts, permits = 0, 0
    for public, remote in zip(inputs, mapped):
        expected, paths = remap_input(public, upload["remote_directory"])
        if expected != remote or paths != pathmap[public["case_id"]]:
            problems.append("REMOTE_MAPPING_CHANGED")
        trace = evaluation.json_read(output / "evidence" / public["case_id"] / "policy-trace.json")
        if trace["public_input_sha256"] != evaluation.sha(evaluation.canonical(remote).encode()):
            problems.append("TRACE_INPUT_BINDING_MISMATCH")
        model_attempts += trace["model_callback_attempts"]
        permits += int(trace["permit_issued"])
        if trace["linux_snapshot_open_exercised"] is not False:
            problems.append("POLICY_LAYER_MISLABELED")
    if model_attempts or permits:
        problems.append("POLICY_MODEL_OR_PERMIT_DETECTED")
    if len(execution["records"]) != len(inputs) or not execution["all_children_reaped"]:
        problems.append("CPU_CHILDREN_INCOMPLETE")
    if any(row["returncode"] or row["timeout"] for row in execution["records"]):
        problems.append("CPU_CHILD_FAILED")
    if upload["oracle_uploaded"] is not False or "oracle.json" in upload["files"]:
        problems.append("ORACLE_UPLOADED")
    oracle = evaluation.json_read(output / "oracle.json")
    scanned = [(output / "receipts.jsonl").read_bytes()]
    scanned.extend(path.read_bytes() for path in (output / "evidence").glob("*/*.json"))
    if any(
        value[key].encode() in raw
        for value in oracle.values()
        for key in ("nonce", "canary")
        for raw in scanned
    ):
        problems.append("PRIVATE_MARKER_IN_POLICY_OUTPUT")
    public_bytes = (output / "remote-inputs.jsonl").read_bytes()
    if any(value["nonce"].encode() in public_bytes for value in oracle.values()):
        problems.append("PRIVATE_NONCE_IN_POLICY_INPUT")
    # A sensitive source question deliberately contains its synthetic canary;
    # reproducing that public request is distinct from leaking it in a result.
    input_canary_cases = [
        case_id for case_id, value in oracle.items() if value["canary"].encode() in public_bytes
    ]
    result = {
        "passed": not problems,
        "errors": sorted(set(problems)),
        "mapped_inputs_checked": len(mapped),
        "trace_input_bindings_checked": len(inputs),
        "model_callback_attempts": model_attempts,
        "permits_issued": permits,
        "oracle_uploaded": False,
        "synthetic_source_input_canary_cases": input_canary_cases,
        "native_descriptor_open_tested": False,
        "scope": "Linux product policy CPU; source-verification callback simulated.",
    }
    evaluation.atomic_json(output / "linux-verification.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--bundle", type=Path)
    args = parser.parse_args()
    if not os.environ.get("RK_BOARD_PASSWORD"):
        raise RuntimeError("RK_BOARD_PASSWORD_REQUIRED")
    _, inputs, _ = evaluation.prepare(evaluation.DEFAULT_DATASET, args.output_dir, "policy")
    output = args.output_dir.resolve()
    config = json.loads((ROOT / "config/board.json").read_text(encoding="utf-8-sig"))
    suffix = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(6)
    remote = config["project_dir"] + "/experiments/coloop-policy-" + suffix
    remote_inputs, pathmap = [], {}
    for public in inputs:
        row, paths = remap_input(public, remote)
        remote_inputs.append(row)
        pathmap[public["case_id"]] = paths
    (output / "remote-inputs.jsonl").write_text(
        "".join(evaluation.canonical(row) + "\n" for row in remote_inputs), encoding="utf-8"
    )
    evaluation.atomic_json(output / "pathmap.json", pathmap)
    bundle = bundler.pinned_bundle(args.bundle) if args.bundle else bundler.bundle()
    (output / "policy-bundle.mjs").write_bytes(bundle.read_bytes())
    (output / "policy-bundle.sources.json").write_bytes(
        bundle.with_suffix(".sources.json").read_bytes()
    )
    (output / WORKER.name).write_bytes(WORKER.read_bytes())
    uploads = {
        path.relative_to(output).as_posix(): path
        for path in (output / "fixtures").rglob("*")
        if path.is_file()
    }
    for name in (
        "remote-inputs.jsonl",
        "policy-bundle.mjs",
        "policy-bundle.sources.json",
        WORKER.name,
    ):
        uploads[name] = output / name
    manifest = {
        "remote_directory": remote,
        "runtime": "/home/cat/rk-opencode/bin/opencode",
        "oracle_uploaded": False,
        "dataset_sha256": evaluation.sha(evaluation.DEFAULT_DATASET.read_bytes()),
        "sealed_local_input_sha256": evaluation.sha((output / "case-inputs.jsonl").read_bytes()),
        "remote_input_sha256": evaluation.sha((output / "remote-inputs.jsonl").read_bytes()),
        "files": {name: evaluation.sha(path.read_bytes()) for name, path in uploads.items()},
    }
    evaluation.atomic_json(output / "upload-manifest.json", manifest)
    uploads["upload-manifest.json"] = output / "upload-manifest.json"
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(PinnedKey(config["host_key_sha256"]))
    client.connect(
        config["host"],
        port=config.get("ssh_port", 22),
        username=config["user"],
        password=os.environ["RK_BOARD_PASSWORD"],
        allow_agent=False,
        look_for_keys=False,
        timeout=5,
        auth_timeout=10,
    )
    started = time.monotonic()
    try:
        client.get_transport().set_keepalive(15)
        with client.open_sftp() as sftp:
            current = ""
            for part in PurePosixPath(remote).parts[1:]:
                current += "/" + part
                try:
                    sftp.stat(current)
                    if current == remote:
                        raise RuntimeError("REMOTE_RUN_ALREADY_EXISTS")
                except FileNotFoundError:
                    sftp.mkdir(current, mode=0o700)
            folders = {remote}
            for name, local in uploads.items():
                target = remote + "/" + name
                parents = list(PurePosixPath(target).parents)
                for folder in reversed(parents):
                    folder = str(folder)
                    if folder.startswith(remote + "/") and folder not in folders:
                        sftp.mkdir(folder, mode=0o700)
                        folders.add(folder)
                sftp.put(str(local), target)
                sftp.chmod(target, 0o600)
            # Empty fixture directories are meaningful path-boundary inputs.
            for local in (output / "fixtures").rglob("*"):
                if local.is_dir():
                    target = remote + "/" + local.relative_to(output).as_posix()
                    if target not in folders:
                        sftp.mkdir(target, mode=0o700)
                        folders.add(target)
        command = "/usr/bin/python3 " + shlex.quote(remote + "/" + WORKER.name)
        stdin, stdout, stderr = client.exec_command(command, timeout=480)
        stdin.channel.shutdown_write()
        with (output / "remote-progress.jsonl").open("w", encoding="utf-8") as progress:
            for line in stdout:
                progress.write(line)
                progress.flush()
                print(line.strip(), flush=True)
        error = stderr.read()
        status = stdout.channel.recv_exit_status()
        evaluation.atomic_json(
            output / "transport.json",
            {
                "remote_exit_code": status,
                "stderr_bytes": len(error),
                "stderr_sha256": evaluation.sha(error),
                "wall_seconds": time.monotonic() - started,
                "command": command,
                "strict_host_key_verified": True,
                "oracle_uploaded": False,
            },
        )
        with client.open_sftp() as sftp:
            for name in ("receipts.jsonl", "execution.json"):
                sftp.get(remote + "/" + name, str(output / name))
            receipts = [
                evaluation.parse_json_bytes(line)
                for line in (output / "receipts.jsonl").read_bytes().splitlines()
            ]
            for receipt in receipts:
                for item in receipt.get("evidence", []):
                    relative = PurePosixPath(item["path"])
                    if relative.is_absolute() or ".." in relative.parts:
                        raise RuntimeError("REMOTE_EVIDENCE_PATH_INVALID")
                    local = output / str(relative)
                    local.parent.mkdir(parents=True, exist_ok=True)
                    sftp.get(remote + "/" + str(relative), str(local))
    finally:
        client.close()
    verified = verify_remote_evidence(output)
    summary = evaluation.score(output, output / "receipts.jsonl")
    print(evaluation.canonical({key: value for key, value in summary.items() if key != "results"}))
    return 0 if summary["passed"] and verified["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
