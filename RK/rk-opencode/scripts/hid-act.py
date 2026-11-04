"""Execute one observation-bound HID action; never enables a desktop session itself."""

import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(os.environ.get("RK_AGENT_ROOT", Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(ROOT / "agent"))
from desktop import DesktopTools  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--capabilities", action="store_true")
    modes.add_argument("--observe", action="store_true")
    modes.add_argument("--step", action="store_true", help="Act and return a fresh observation")
    parser.add_argument("--compact", action="store_true",
                        help="Use persistent compact/delta views and verified local fill_form")
    parser.add_argument("--reset-view", action="store_true", help="Begin a new task with --observe --compact")
    parser.add_argument("--detail", choices=("auto", "full"), default="auto")
    args = parser.parse_args()
    if (args.reset_view or args.detail != "auto") and not args.compact:
        parser.error("--reset-view and --detail require --compact")
    if args.reset_view and not args.observe:
        parser.error("--reset-view requires --observe")
    tool = DesktopTools(ROOT)
    if args.compact and not args.capabilities:
        from hid_workflow import HIDWorkflow
        workflow = HIDWorkflow(ROOT, tool)
    if args.capabilities or args.observe:
        if args.observe and args.compact:
            value = workflow.call({"op": "observe"}, reset=args.reset_view, detail=args.detail)
        else:
            value = tool.call({"op": "capabilities" if args.capabilities else "observe"})
            if args.compact:
                from hid_workflow import HID_TOOL
                value["inputSchema"] = HID_TOOL["inputSchema"]
                value["workflow"] = {"operation": "fill_form", "max_fields": 4,
                    "max_characters_per_field": 64, "text": "single-line US-layout ASCII; empty clears",
                    "requires": "UIA Edit identity/value readback and latest compact observation",
                    "request_fields": ["op", "observation_id", "fields[{target_id,text}]", "submit_target_id?"],
                    "business_result": "must be checked in the returned observation"}
        print(json.dumps(value, ensure_ascii=False), flush=True)
        return
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ValueError("Action exceeds 8192 bytes")
    action = json.loads(raw)
    if not isinstance(action, dict):
        raise ValueError("Expected action object")
    value = (workflow.call(action, detail=args.detail) if args.compact
             else tool.step(action) if args.step else tool.call(action))
    print(json.dumps(value, ensure_ascii=False), flush=True)
    if value.get("ok") is False:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
