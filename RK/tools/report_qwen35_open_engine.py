"""Summarize saved engine experiments; do not treat process success as answer correctness."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import statistics
import sys


def row(folder, result):
    engine, workload, repeat = result["id"].split("-")
    metrics = result["metrics"]
    if result["kind"] == "rkllm":
        prefill = metrics.get("prefill", {})
        generate = metrics.get("generate", {})
        input_tokens = prefill.get("tokens")
        tokens = generate.get("tokens")
        tps = tokens * 1000 / generate["ms"] if tokens and generate.get("ms") else None
        prefill_ms = prefill.get("ms")
        extra = {}
    else:
        timings = metrics.get("timings", {})
        input_tokens = metrics.get("prompt_tokens")
        tokens = metrics.get("completion_tokens")
        tps = metrics.get("wall_decode_tps")
        prefill_ms = timings.get("prefill_ms")
        extra = {
            "native_decode_tps": timings.get("decode_tokens_per_second"),
            "acceptance": timings.get("spec_acceptance"),
            "finish_reason": metrics.get("finish_reason"),
            "ttft_ms": timings.get("ttft_ms"),
        }
    timing = (folder / result["id"] / "time.txt").read_text(errors="replace")
    rss = re.search(r"Maximum resident set size \(kbytes\): (\d+)", timing)
    return {
        "engine": engine,
        "workload": workload,
        "repeat": int(repeat),
        "return_code": result["return_code"],
        "abort": result["abort"],
        "correct": result.get("correct"),
        "answer": result["answer"],
        "input_tokens": input_tokens,
        "output_tokens": tokens,
        "decode_tokens": tokens if result["kind"] == "rkllm" else tokens - 1 if tokens else None,
        "output_token_definition": (
            "SDK Generate token count" if result["kind"] == "rkllm" else "CLI completion_tokens"
        ),
        "decode_tps": tps,
        "prefill_ms": prefill_ms,
        "process_wall_seconds": result["wall_seconds"],
        "peak_rss_gib": int(rss[1]) / 1024**2 if rss else None,
        "max_temperature_c": max(
            (s["max_temperature_c"] or 0 for s in result["samples"]), default=None
        ),
        **extra,
    }


def main():
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    args = parser.parse_args()
    report = {"session": str(args.session.resolve()), "suites": {}, "speed": {}, "quality": {}}
    for suite in ("smoke", "timing"):
        folder = args.session / suite
        path = folder / "results.json"
        if not path.exists():
            continue
        rows = [row(folder, r) for r in json.loads(path.read_text(encoding="utf-8"))]
        plan = json.loads((folder / "plan.json").read_text(encoding="utf-8"))
        cases = {c["id"]: c for c in plan["cases"]}
        for item in rows:
            case = cases[f"{item['engine']}-{item['workload']}-{item['repeat']}"]
            item["context"] = case["context"]
            item["requested_tokens"] = case["tokens"]
            item["prompt_sha256"] = hashlib.sha256(case["prompt"].encode("utf-8")).hexdigest()
        report.setdefault("completeness", {})[suite] = {
            "expected_cases": len(cases),
            "completed_cases": len(rows),
            "all_processes_successful": all(r["return_code"] == 0 and not r["abort"] for r in rows),
            "all_cases_completed": len(rows) == len(cases),
        }
        report["suites"][suite] = rows
        alignment = {}
        for workload in sorted({r["workload"] for r in rows}):
            selected = [r for r in rows if r["workload"] == workload]
            hashes = sorted({r["prompt_sha256"] for r in selected})
            contexts = sorted({r["context"] for r in selected})
            prefill = sorted({r["input_tokens"] for r in selected if r["input_tokens"] is not None})
            decode = sorted(
                {r["decode_tokens"] for r in selected if r["decode_tokens"] is not None}
            )
            alignment[workload] = {
                "prompt_sha256": hashes,
                "contexts": contexts,
                "prefill_token_counts": prefill,
                "decode_token_counts": decode,
                "same_prompt_and_context": len(hashes) == len(contexts) == 1,
            }
        report.setdefault("input_alignment", {})[suite] = alignment
        pairs = []
        plain = {(r["workload"], r["repeat"]): r for r in rows if r["engine"] == "open"}
        for item in rows:
            key = (item["workload"], item["repeat"])
            if item["engine"] == "mtp1" and key in plain:
                pairs.append(
                    {
                        "workload": key[0],
                        "repeat": key[1],
                        "same_text": item["answer"] == plain[key]["answer"],
                    }
                )
        report.setdefault("mtp_text_comparison", {})[suite] = pairs
        if suite == "smoke":
            for engine in sorted({r["engine"] for r in rows}):
                selected = [r for r in rows if r["engine"] == engine]
                report["quality"][engine] = {
                    "passed": sum(r["correct"] is True for r in selected),
                    "total": len(selected),
                }
        else:
            for engine in sorted({r["engine"] for r in rows}):
                report["speed"][engine] = {}
                for workload in ("english", "chinese", "long"):
                    selected = [
                        r
                        for r in rows
                        if r["engine"] == engine
                        and r["workload"] == workload
                        and r["return_code"] == 0
                        and not r["abort"]
                        and r["decode_tps"]
                    ]
                    if selected:
                        report["speed"][engine][workload] = {
                            "median_decode_tps": statistics.median(
                                r["decode_tps"] for r in selected
                            ),
                            "median_process_seconds": statistics.median(
                                r["process_wall_seconds"] for r in selected
                            ),
                            "median_prefill_ms": statistics.median(
                                r["prefill_ms"] for r in selected
                            ),
                            "output_tokens": [r["output_tokens"] for r in selected],
                            "runs": len(selected),
                            "peak_rss_gib": max(r["peak_rss_gib"] for r in selected),
                            "max_temperature_c": max(r["max_temperature_c"] for r in selected),
                        }
    (args.session / "summary.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    lines = [
        "# Qwen3.5-4B 本机解码速度",
        "",
        "每项取重复运行的中位数；单位 tok/s。上下文、题目和实际输出数见 summary.json。",
        "",
        "| 引擎 | 英文 | 中文 | 较长输入后 |",
        "| --- | ---: | ---: | ---: |",
    ]
    for engine in ("rkllm130", "rkllm131", "open", "mtp1"):
        values = report["speed"].get(engine, {})
        cells = [
            f"{values[w]['median_decode_tps']:.2f}" if w in values else "未完成"
            for w in ("english", "chinese", "long")
        ]
        lines.append("| " + engine + " | " + " | ".join(cells) + " |")
    (args.session / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(
        json.dumps({k: v for k, v in report.items() if k != "suites"}, ensure_ascii=False, indent=2)
    )


if __name__ == "__main__":
    main()
