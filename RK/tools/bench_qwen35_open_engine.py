"""Prepare/run/fetch a serial alternative-engine experiment; never stop an existing service."""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import secrets
import shlex
import sys

from deploy_qwen35 import command, connect, mkdirs
from deploy_qwen35_open_engine import SUBDIR
from prepare_qwen35 import ROOT


def create_plan(project, remote, suite, include_131, repetitions, context=16384):
    app = project + "/" + SUBDIR
    executable = app + "/bin/open_rknpu2_lm_infer"
    nonce = "RK" + secrets.token_hex(5).upper()
    prompts = {
        "digit": ("What is 2+3? Answer only the digit.", "5", 24),
        "money": ("20元买3支笔，每支4元，还剩多少元？只输出数字。", "8", 24),
        "json": (
            f'Return only this JSON object, with no markdown: {{"code":"{nonce}","count":3}}',
            {"code": nonce, "count": 3},
            64,
        ),
        "english": (
            "Write a detailed numbered list of 30 practical ways to save electricity "
            "at home. Explain each item in one sentence. Start with item 1 and continue "
            "without an introduction.",
            None,
            128,
        ),
        "chinese": (
            "请列出30条家庭节约用电的方法，每条解释一句，直接从第1条开始，"
            "不要写前言和结语，尽量写完所有条目。",
            None,
            128,
        ),
    }
    rows = "\n".join(
        f"Reference row {i:03}: ordinary household electricity data." for i in range(64)
    )
    prompts["long"] = (rows + "\n" + prompts["english"][0], None, 128)
    cases = []
    engines = ["rkllm130"] + (["rkllm131"] if include_131 else []) + ["open", "mtp1"]
    if suite == "tune":
        cases.append(
            {
                "id": "tune-text",
                "kind": "tune",
                "cwd": app,
                "timeout": 600,
                "argv": [
                    executable,
                    "-m",
                    app + "/model",
                    "-c",
                    str(context),
                    "tune",
                    "--batches",
                    "1,2,128",
                    "--report",
                    remote + "/tune.json",
                ],
                "allow_failure": True,
            }
        )
    else:
        workloads = (
            ["digit", "money", "json"] if suite == "smoke" else ["english", "chinese", "long"]
        )
        for repeat in range(1 if suite == "smoke" else repetitions):
            # Reverse order on alternate repetitions to reduce order/temperature bias.
            for workload in workloads:
                prompt, expected, tokens = prompts[workload]
                for engine in engines if repeat % 2 == 0 else engines[::-1]:
                    name = f"{engine}-{workload}-{repeat + 1}"
                    case = {
                        "id": name,
                        "kind": "rkllm" if engine.startswith("rkllm") else "open",
                        "prompt": prompt,
                        "context": context,
                        "tokens": tokens,
                        "timeout": 600,
                    }
                    if engine.startswith("rkllm"):
                        cwd = project + ("/qwen35-4b-131" if engine == "rkllm131" else "/qwen35-4b")
                        case.update(
                            cwd=cwd,
                            env={"LD_LIBRARY_PATH": cwd + "/lib", "RKLLM_LOG_LEVEL": "1"},
                            argv=[
                                cwd + "/build/qwen35",
                                "--context",
                                str(context),
                                "--tokens",
                                str(tokens),
                                "--prompt",
                                prompt,
                            ],
                        )
                    else:
                        case.update(
                            cwd=app,
                            argv=[
                                executable,
                                "-m",
                                app + "/model",
                                "-c",
                                str(context),
                                "--spec-type",
                                "draft-mtp" if engine == "mtp1" else "none",
                                "--spec-draft-n-max",
                                "1",
                                "run",
                                "--conversation",
                                "--stats",
                                "--temp",
                                "0",
                                "--top-k",
                                "1",
                                "--top-p",
                                "0.95",
                                "--repeat-penalty",
                                "1.1",
                                "-n",
                                str(tokens),
                                "-p",
                                prompt,
                            ],
                        )
                    if isinstance(expected, str):
                        case["expected"] = expected
                    elif isinstance(expected, dict):
                        case["expected_json"] = expected
                    cases.append(case)
    return {
        "project_dir": project,
        "cache_dir": app + "/benchmark-cache",
        "suite": suite,
        "thinking": False,
        "repetitions": repetitions,
        "cases": cases,
        "scope": "Same prompts, different quantization/runtime/templates; native metrics differ",
    }


def fetch_tree(sftp, remote, local):
    import stat

    local.mkdir(parents=True, exist_ok=True)
    for entry in sftp.listdir_attr(remote):
        if stat.S_ISDIR(entry.st_mode):
            fetch_tree(sftp, remote + "/" + entry.filename, local / entry.filename)
        else:
            sftp.get(remote + "/" + entry.filename, str(local / entry.filename))


def main():
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=["prepare", "run", "fetch", "all"], default="all")
    parser.add_argument("--suite", choices=["smoke", "tune", "timing"], default="smoke")
    parser.add_argument("--include-131", action="store_true")
    parser.add_argument("--repetitions", type=int, choices=range(1, 5), default=2)
    parser.add_argument("--context", type=int, default=16384)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if not 512 <= args.context <= 16384:
        parser.error("--context must be in 512..16384")
    if args.include_131 and args.context > 4096:
        parser.error("The existing 1.3.1 comparison executable supports at most 4096 context")
    if args.stage in ("run", "fetch") and args.output_dir is None:
        parser.error("--stage run/fetch requires --output-dir from the prepared experiment")
    stamp = datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d-%H%M%S")
    folder = args.output_dir or ROOT / "logs" / f"qwen35-open-{args.suite}-{stamp}"
    client, cfg, _ = connect()
    remote = cfg["project_dir"].rstrip("/") + "/logs/" + folder.name
    try:
        if args.stage in ("prepare", "all"):
            folder.mkdir(parents=True, exist_ok=False)
            plan = create_plan(
                cfg["project_dir"].rstrip("/"),
                remote,
                args.suite,
                args.include_131,
                args.repetitions,
                args.context,
            )
            data = json.dumps(plan, ensure_ascii=False, indent=2).encode("utf-8")
            (folder / "plan.json").write_bytes(data)
            with client.open_sftp() as sftp:
                mkdirs(sftp, remote)
                sftp.put(str(folder / "plan.json"), remote + "/plan.json")
                sftp.put(
                    str(ROOT / "tools/bench_qwen35_open_engine_board.py"), remote + "/runner.py"
                )
            print("Plan SHA256:", hashlib.sha256(data).hexdigest(), flush=True)
        if args.stage in ("run", "all"):
            command(
                client,
                "python3 -u "
                + shlex.quote(remote + "/runner.py")
                + " --plan "
                + shlex.quote(remote + "/plan.json"),
            )
    finally:
        try:
            if args.stage in ("run", "fetch", "all"):
                with client.open_sftp() as sftp:
                    fetch_tree(sftp, remote, folder)
        finally:
            client.close()
        print("Evidence:", folder, flush=True)


if __name__ == "__main__":
    main()
