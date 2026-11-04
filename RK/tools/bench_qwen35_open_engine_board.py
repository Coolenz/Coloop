"""Bounded, serial board-only comparison; refuses an already occupied model lock.

Run from a new experiment directory with a frozen plan.json. This script never stops
an existing model service, changes clocks, calls memory APIs or executes model output.
"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time


def snapshot():
    temperatures = []
    for path in Path("/sys/class/thermal").glob("thermal_zone*/temp"):
        try:
            temperatures.append(int(path.read_text()) / 1000)
        except (OSError, ValueError):
            pass
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.split(":")[0] in ("MemAvailable", "SwapFree", "SwapTotal"):
            memory[line.split(":")[0]] = int(line.split()[1])
    frequencies = {}
    for path in list(Path("/sys/class/devfreq").glob("*/cur_freq")) + list(
        Path("/sys/devices/system/cpu/cpufreq").glob("policy*/scaling_cur_freq")
    ):
        try:
            frequencies[str(path)] = int(path.read_text())
        except (OSError, ValueError):
            pass
    return {
        "max_temperature_c": max(temperatures, default=None),
        "memory_kib": memory,
        "frequencies": frequencies,
    }


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def parse_result(kind, stdout, stderr):
    if kind == "rkllm":
        metrics = {}
        for stage in ("Prefill", "Generate"):
            match = re.search(
                r"I rkllm:\s+" + stage + r"\s+([\d.]+)\s+(\d+)"
                r"\s+([\d.]+)\s+([\d.]+)",
                stdout + stderr,
            )
            if match:
                metrics[stage.lower()] = {
                    "ms": float(match[1]),
                    "tokens": int(match[2]),
                    "native_tps": float(match[4]),
                }
        answer = stdout.split("Answer: ", 1)[-1].split("\nI rkllm:", 1)[0].strip()
        return {"metrics": metrics, "answer": answer}
    if kind == "open":
        decoder = json.JSONDecoder()
        for match in re.finditer(r"\{", stderr):
            try:
                value, _ = decoder.raw_decode(stderr[match.start() :])
            except ValueError:
                continue
            if isinstance(value, dict) and "timings" in value and "completion_tokens" in value:
                # Full decode elapsed includes sampling/dispatch; keep native kernel metric too.
                elapsed = value["timings"].get("decode_ms", 0)
                value["wall_decode_tps"] = (
                    (value["completion_tokens"] - 1) * 1000 / elapsed
                    if elapsed and value["completion_tokens"] > 1
                    else None
                )
                return {"metrics": value, "answer": stdout.strip()}
        return {"metrics": {}, "answer": stdout.strip()}
    return {"metrics": {}, "answer": ""}


def run_case(case, folder, environment):
    case_dir = folder / case["id"]
    case_dir.mkdir(exist_ok=False)
    started = time.monotonic()
    samples = []
    abort = None
    with (case_dir / "stdout.txt").open("wb") as out, (case_dir / "stderr.txt").open("wb") as err:
        argv = ["/usr/bin/time", "-v", "-o", str(case_dir / "time.txt"), "--"] + case["argv"]
        process = subprocess.Popen(
            argv,
            cwd=case["cwd"],
            env=environment | case.get("env", {}),
            stdout=out,
            stderr=err,
            start_new_session=True,
        )
        try:
            while process.poll() is None:
                sample = snapshot() | {"seconds": round(time.monotonic() - started, 3)}
                samples.append(sample)
                if (sample["max_temperature_c"] or 0) >= 80:
                    abort = "temperature >= 80 C"
                if sample["memory_kib"].get("MemAvailable", 0) < 512 * 1024:
                    abort = "MemAvailable < 512 MiB"
                if time.monotonic() - started >= case.get("timeout", 600):
                    abort = "wall timeout"
                if abort:
                    break
                if len(samples) % 8 == 1:
                    emit(
                        {
                            "event": "progress",
                            "case": case["id"],
                            "pid": process.pid,
                            "seconds": sample["seconds"],
                            "temperature": sample["max_temperature_c"],
                        }
                    )
                time.sleep(2)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    stdout = (case_dir / "stdout.txt").read_text(errors="replace")
    stderr = (case_dir / "stderr.txt").read_text(errors="replace")
    result = {
        "id": case["id"],
        "kind": case["kind"],
        "return_code": process.returncode,
        "abort": abort,
        "wall_seconds": round(time.monotonic() - started, 3),
        "samples": samples,
        **parse_result(case["kind"], stdout, stderr),
    }
    if "expected" in case:
        result["correct"] = result["answer"].strip() == case["expected"]
    if "expected_json" in case:
        try:
            result["correct"] = json.loads(result["answer"]) == case["expected_json"]
        except ValueError:
            result["correct"] = False
    (case_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    emit(
        {k: v for k, v in result.items() if k not in ("samples", "metrics", "answer")}
        | {"event": "finished", "answer_preview": result["answer"][:160]}
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args()

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt("Experiment interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    folder = args.plan.resolve().parent
    data = args.plan.read_bytes()
    plan = json.loads(data)
    lock_path = Path(plan["project_dir"]) / ".qwen35-4b-inference.lock"
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(75, "Existing Qwen inference lock is occupied; no experiment started.\n")
        # Other engine instances may use different locks; reject them by executable identity.
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                executable = (entry / "exe").resolve().name
            except OSError:
                continue
            if executable in (
                "open_rknpu2_lm_infer",
                "qwen35",
                "llama-server",
                "llama-cli",
            ) or executable.startswith("rkllm-worker"):
                raise RuntimeError(f"Another inference process is present: {entry.name}")
        environment = dict(
            os.environ, LANG="C.UTF-8", LC_ALL="C.UTF-8", XDG_CACHE_HOME=plan["cache_dir"]
        )
        results = []
        manifest = {
            "plan_sha256": hashlib.sha256(data).hexdigest(),
            "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "initial": snapshot(),
            "note": "Fixed clocks unchanged; no memory APIs/tools; each run starts cold KV",
        }
        (folder / "execution.json").write_text(json.dumps(manifest, indent=2))
        for case in plan["cases"]:
            result = run_case(case, folder, environment)
            results.append(result)
            (folder / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
            if result["abort"]:
                raise RuntimeError(result["abort"])
            if result["return_code"] and not case.get("allow_failure", False):
                raise RuntimeError(f"Case failed: {case['id']}")


if __name__ == "__main__":
    main()
