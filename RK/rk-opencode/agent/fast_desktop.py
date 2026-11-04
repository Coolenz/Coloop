"""Compact, automatically observed desktop steps for real OpenCode MCP sessions."""

import argparse
import copy
import json
import os
from pathlib import Path
import time

from compact import BenchmarkTask, compact_observation, STEP_TOOL
from desktop import DesktopTools
from hid_workflow import HIDWorkflow, HID_TOOL

FAST_TOOL = copy.deepcopy(STEP_TOOL)
FAST_TOOL["name"] = "step"
FAST_TOOL["description"] = (
    "RK desktop Agent step; compact/delta observations are automatic. Default op=act. "
    "Use op=fill_form with fields and optional submit_target_id for verified local batches; "
    "op=observe refreshes data, optional detail=full. Stop after any failure."
)
FAST_TOOL["inputSchema"]["required"] = []
FAST_TOOL["inputSchema"]["properties"].update({
    "op": {"type": "string", "enum": ["act", "fill_form", "observe"]},
    "fields": HID_TOOL["inputSchema"]["oneOf"][2]["properties"]["fields"],
    "submit_target_id": {"type": "integer"},
    "detail": {"type": "string", "enum": ["auto", "full"]},
})


def benchmark_folder(root):
    value = os.environ.get("RK_DESKTOP_BENCH_DIR")
    if not value:
        return None
    folder = Path(value).resolve()
    if folder.parent != (root / "logs").resolve() or not folder.name.startswith("testbench-"):
        raise ValueError("Invalid desktop benchmark log directory")
    return folder


def trace(root, event):
    folder = benchmark_folder(root)
    if folder:
        with (folder / "agent-trace.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps({**event, "at": time.time()}, ensure_ascii=False) + "\n")


def observe_initial(root, desktop=None):
    if not benchmark_folder(root):
        workflow = HIDWorkflow(root, desktop)
        if workflow.desktop.acquire_window().get("state") == "planned":
            raise RuntimeError("Plan-only session cannot acquire foreground")
        view = workflow.call({"op": "observe"}, reset=True)
        observation = workflow.snapshot()
        path = root / ".runtime/fast-desktop-initial.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(observation, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
        return view
    observation = (desktop or DesktopTools(root)).call({"op": "observe"})
    path = root / ".runtime/fast-desktop-initial.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(observation, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)
    trace(root, {"type": "observe", "origin": "opencode_plugin", "observation": observation})
    return compact_observation(observation)


class FastDesktop:
    def __init__(self, root):
        self.root = Path(root)
        self.desktop = DesktopTools(root)
        self.task = None
        self.observed = None
        self.initial_id = None
        self.failed = False
        self.workflow = HIDWorkflow(self.root, self.desktop)

    def call(self, args):
        bench = benchmark_folder(self.root)
        initial = json.loads(
            (self.root / ".runtime/fast-desktop-initial.json").read_text(encoding="utf-8")
        )
        if initial["observation_id"] != self.initial_id:
            self.observed = initial
            session = json.loads((self.root / ".runtime/desktop-session.json").read_text())
            if self.observed.get("session_id") != session.get("session_id"):
                raise ValueError("Initial observation belongs to another desktop session")
            self.task = BenchmarkTask(self.observed) if bench else None
            self.initial_id = initial["observation_id"]
            self.failed = False
        if self.failed:
            raise ValueError(
                "Previous step failed; send a new user message to obtain a fresh observation"
            )
        if not bench:
            try:
                result = self.workflow.call({"op": "act", **args})
            except (ValueError, OSError, RuntimeError):
                self.failed = True
                raise
            self.failed = result.get("ok") is False or bool(result.get("observation_error"))
            return result
        if self.task:
            try:
                self.task.validate_action(args, self.observed)
            except ValueError:
                self.failed = True
                raise
        try:
            result = self.desktop.step({**args, "op": "act"})
        except (ValueError, OSError, RuntimeError):
            self.failed = True
            raise
        action = result["action"]
        trace(self.root, {"type": "act", "input": {**args, "op": "act"}, "output": action})
        output = {
            "action": {k: action[k] for k in ("executed", "state", "action_id") if k in action}
        }
        if result.get("observation_error"):
            self.failed = True
            output["observation_error"] = result["observation_error"]
            output["next"] = (
                "Input already sent; stop and report this observation failure. Do not retry input."
            )
            return output
        if "observation" not in result:
            output["next"] = "Plan only; no input was sent. Report the plan and stop."
            return output
        observed = result["observation"]
        trace(self.root, {"type": "observe", "origin": "after_action", "observation": observed})
        if self.task:
            for attempt in range(3):
                if self.task.effect_visible(observed):
                    break
                if attempt == 2:
                    self.failed = True
                    raise ValueError(
                        "Input sent but expected effect not observed; do not retry input"
                    )
                time.sleep(0.2)
                observed = self.desktop.call({"op": "observe"})
                trace(
                    self.root, {"type": "observe", "origin": "effect_poll", "observation": observed}
                )
            self.task.phase += 1
            output["task_verified_complete"] = self.task.phase == 3
            if self.task.phase == 3:
                trace(self.root, {"type": "complete", "verified_by": "opencode_mcp_tool"})
        self.observed = observed
        output["observation"] = compact_observation(observed)
        return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observe", action="store_true", required=True)
    parser.parse_args()
    os.umask(0o077)
    root = Path(os.environ["RK_AGENT_ROOT"])
    print(json.dumps(observe_initial(root), ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
