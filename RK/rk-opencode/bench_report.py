"""Portable benchmark verification and timing aggregation, independent of machine clocks."""

import json
from pathlib import Path
import statistics


def read_json(path, default=None):
    return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else default


def read_lines(path):
    return (
        [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if path.exists()
        else []
    )


def distribution(values):
    values = list(values)
    return {
        "count": len(values),
        "total_ms": sum(values),
        "median_ms": statistics.median(values) if values else None,
        "min_ms": min(values) if values else None,
        "max_ms": max(values) if values else None,
    }


def verify_calls(events, code):
    calls = [
        e["part"]["state"]
        for e in events
        if e.get("type") == "tool_use"
        and e.get("part", {}).get("tool") == "rk_desktop_desktop"
        and e["part"].get("state", {}).get("status") == "completed"
    ]
    return verify_sequence(calls, code)


def verify_trace(events, code):
    """Use actual compact runner events without presenting them as OpenCode calls."""
    calls = []
    for event in events:
        if event.get("type") == "observe":
            calls.append({"input": {"op": "observe"}, "output": event["observation"]})
        elif event.get("type") == "act":
            calls.append({"input": event["input"], "output": event["output"]})
    result = verify_sequence(calls, code)
    result["tool_calls"] = sum(e.get("type") == "act" for e in events)
    result["automatic_observations"] = sum(e.get("type") == "observe" for e in events)
    return result


def verify_sequence(calls, code):
    phase, latest, apply_id = 0, None, None
    for call in calls:
        args = call.get("input", {})
        try:
            output = call.get("output", {})
            if isinstance(output, str):
                output = json.loads(output)
        except (TypeError, ValueError):
            continue
        if args.get("op") == "observe":
            latest = output
            if phase == 2 and any(
                "Applied: " + code == t.get("name") for t in output.get("targets", [])
            ):
                phase = 3
            if phase == 4 and output.get("window_open") is False:
                phase = 5
            continue
        if args.get("op") != "act" or output.get("executed") is not True:
            continue
        if not latest or args.get("observation_id") != latest.get("observation_id"):
            continue
        if phase == 0 and args.get("action") == "type" and args.get("text") == code:
            phase = 1
        elif phase == 1 and args.get("action") == "click":
            target = next(
                (t for t in latest.get("targets", []) if t.get("id") == args.get("target_id")), {}
            )
            if target.get("name") == "Apply":
                phase, apply_id = 2, output.get("action_id")
        elif (
            phase == 3
            and args.get("action") == "hotkey"
            and (args.get("keys", "").upper() == "ALT+F4")
        ):
            phase = 4
        latest = None  # every action consumes an observation
    return {
        "passed": phase == 5,
        "phase": phase,
        "tool_calls": len(calls),
        "apply_action_id": apply_id,
    }


def summarize(folder):
    folder = Path(folder)
    manifest = read_json(folder / "manifest.json", {})
    fixture = read_json(folder / "fixture-state.json", {})
    agent = read_json(folder / "agent-status.json", {})
    requests = read_lines(folder / "model-requests.jsonl")
    actions = read_lines(folder / "hid-actions.jsonl")
    observations = read_lines(folder / "observer/observations.jsonl")
    events = read_lines(folder / "opencode.jsonl")
    warm = read_json(folder / "ocr-warm.json", {}).get("samples", [])
    runner = manifest.get("runner", "opencode")
    workflow = (
        verify_trace(read_lines(folder / "agent-trace.jsonl"), manifest.get("code", ""))
        if runner in ("compact", "opencode-fast")
        else verify_calls(events, manifest.get("code", ""))
    )
    checks = {
        "harness_no_error": not manifest.get("error"),
        "fixture_applied_correct_value": fixture.get("applied") is True
        and fixture.get("code_matches") is True
        and fixture.get("value") == manifest.get("code")
        and fixture.get("clicks") == 1,
        "fixture_closed": fixture.get("closed") is True,
        "fixture_exit_zero": manifest.get("fixture_exit_code") == 0,
        "agent_exit_zero": agent.get("exit_code") == 0 and not agent.get("timed_out", True),
        "agent_verified_apply_then_closed": workflow["passed"],
        "model_timings_collected": bool(requests) and not any(r.get("error") for r in requests),
        "observer_no_errors": bool(observations) and not any(r.get("error") for r in observations),
        "hid_actions_executed": len(actions) >= 3 and all(a.get("executed") for a in actions),
    }
    if runner == "opencode-fast":
        checks["real_opencode_mcp_actions"] = verify_fast_opencode_calls(events)
    rounds = [
        {
            "round": i + 1,
            "request_id": r["id"],
            "input_tokens": r.get("input_tokens"),
            "output_tokens": r.get("output_tokens"),
            "elapsed_ms": r["elapsed_seconds"] * 1000,
            **r.get("inference", {}),
        }
        for i, r in enumerate(requests)
    ]
    stages = {
        name: distribution(
            o.get("snapshot", {}).get(name, 0)
            for o in observations
            if name in o.get("snapshot", {})
        )
        for name in ("capture_ms", "uia_ms", "ocr_ms", "ocr_engine_ms", "image_save_ms")
    }
    stages.update(
        model_request=distribution(r["elapsed_ms"] for r in rounds),
        model_prefill=distribution(r.get("prefill_ms", 0) for r in rounds),
        model_generate=distribution(r.get("generate_ms", 0) for r in rounds),
        pc_observe_validate=distribution(o["elapsed_ms"] for o in observations),
        hid=distribution(a.get("hid_ms", 0) for a in actions),
        hid_validation_roundtrip=distribution(a.get("validation_ms", 0) for a in actions),
        ocr_warm=distribution(s["wall_ms"] for s in warm),
    )
    result = {
        "run_id": manifest.get("run_id"),
        "passed": all(checks.values()),
        "checks": checks,
        "workflow": workflow,
        "agent_seconds": agent.get("agent_seconds"),
        "setup_seconds": manifest.get("setup_seconds"),
        "model_start_seconds": manifest.get("model_start_seconds"),
        "window_open_ms": manifest.get("window_open_ms"),
        "task_to_window_exit_seconds": manifest.get("task_to_window_exit_seconds"),
        "ocr_startup_ms": manifest.get("observer_health", {}).get("ocr_startup_ms"),
        "perception": manifest.get("perception"),
        "runner": runner,
        "stages": stages,
        "model_rounds": rounds,
        "first_live_ocr_ms": next(
            (o["snapshot"]["ocr_ms"] for o in observations if "ocr_ms" in o.get("snapshot", {})),
            None,
        ),
        "notes": [
            "Durations use local monotonic clocks; no PC/board wall-clock subtraction.",
            "Stage rows overlap: PC validation includes capture/UIA/OCR; do not add them.",
            "Window opening is performed by the harness; type/Apply/close by the agent.",
            "Warm OCR repeats the first screenshot after the live task.",
        ],
    }
    (folder / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report = [
        "# RK3588 Agent testbench",
        "",
        f"结果：{'PASS' if result['passed'] else 'FAIL'}",
        f"任务耗时（含 {runner} 编排）：{result['agent_seconds']} 秒。",
        "流程：测试台打开窗口 → 模型读 OCR 验证码 → USB 输入 → Apply → 观察验证 → USB 关闭 → 观察关闭。",
        "",
        "| 阶段 | 次数 | 总耗时 ms | 中位数 ms |",
        "|---|---:|---:|---:|",
    ]
    for name, stats in stages.items():
        median = stats["median_ms"]
        report.append(
            f"| {name} | {stats['count']} | {stats['total_ms']:.1f} | "
            + (f"{median:.1f}" if median is not None else "—")
            + " |"
        )
    report.extend(
        [
            "",
            "| 模型轮次 | 新增输入 token | 复用 KV token | 输出 token | 预填充 ms | 生成 ms | 请求 ms |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for r in rounds:
        report.append(
            f"| {r['round']} | {r['input_tokens']} | {r.get('kv_before', 0)} | "
            f"{r['output_tokens']} | {r.get('prefill_ms', 0):.1f} | "
            f"{r.get('generate_ms', 0):.1f} | {r['elapsed_ms']:.1f} |"
        )
    report.extend(
        [
            "",
            "验收：",
            "",
            *[f"- {key}: {value}" for key, value in checks.items()],
            "",
            "口径：开窗由测试台完成；OCR-only 模式只向模型提供 OCR 文字，UIA 用于焦点校验。",
            "表中阶段有包含关系，不能全部相加；冷启动与任务分开。不同机器只关联 ID，不相减时钟。",
        ]
    )
    (folder / "report.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    return result


def verify_fast_opencode_calls(events):
    calls = [
        e["part"]["state"]
        for e in events
        if e.get("type") == "tool_use" and e.get("part", {}).get("tool") == "rk_desktop_fast_step"
    ]
    if len(calls) != 3 or any(c.get("status") != "completed" for c in calls):
        return False
    try:
        outputs = [json.loads(c["output"]) for c in calls]
    except (KeyError, TypeError, ValueError):
        return False
    return (
        all(o.get("action", {}).get("executed") is True for o in outputs)
        and outputs[-1].get("task_verified_complete") is True
        and outputs[-1].get("observation", {}).get("window_open") is False
    )
