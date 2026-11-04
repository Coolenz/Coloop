"""Shared capability discovery, native skill binding, and permission-preserving install."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
from desktop import DesktopTools, DESKTOP_TOOL  # noqa: E402
from compact import STEP_TOOL, compact_observation  # noqa: E402
from hid import hid_capabilities, validate_action  # noqa: E402
from mcp_server import MCPServer  # noqa: E402

spec = importlib.util.spec_from_file_location("hid_install", ROOT / "scripts/setup-hid-skill.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class HIDSkillTests(unittest.TestCase):
    def test_auto_observation_preserves_actual_edit_value_without_inventing_it(self):
        result = compact_observation({"targets": [
            {"id": 0, "name": "Input", "type": "Edit", "value": " 001\n23 ",
             "rect": [0, 0, 100, 100]},
            {"id": 1, "name": "Input", "type": "Edit"},
        ]})
        self.assertEqual(result["targets"][0]["value"], " 001\n23 ")
        self.assertNotIn("rect", result["targets"][0])
        self.assertNotIn("value", result["targets"][1])

    def test_capabilities_never_contact_pc_or_open_hid_or_grant_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            tool = DesktopTools(folder)
            with patch.object(tool, "pc") as pc, patch("desktop.HIDController") as controller:
                result = tool.call({"op": "capabilities"})
                with self.assertRaises(ValueError):
                    tool.call({"op": "capabilities", "text": "wrong"})
            pc.assert_not_called()
            controller.assert_not_called()
        self.assertEqual(result["readiness"], "not_checked")
        self.assertEqual(result["actions"], result["inputSchema"]["properties"]["action"]["enum"])
        self.assertEqual(result["actions"], STEP_TOOL["inputSchema"]["properties"]["action"]["enum"])

    def test_declared_limits_are_actual_validation_boundaries(self):
        c = hid_capabilities()
        for kind, field, limit in (("type", "text", c["text"]["max_characters"]),
                                   ("scroll", "steps", c["wheel"]["max_abs_steps"]),
                                   ("drag", "duration_ms", c["drag"]["max_duration_ms"])):
            action = {"action": kind, field: " " * limit if kind == "type" else limit}
            if kind != "type":
                action["target_id"] = 0
            if kind == "drag":
                action["end_target_id"] = 0
            validate_action(action)
            action[field] = " " * (limit + 1) if kind == "type" else limit + 1
            with self.assertRaises(ValueError):
                validate_action(action)

    def test_mcp_and_cli_publish_the_same_contract(self):
        server = MCPServer(ROOT, "desktop")
        response = server.dispatch({"method": "tools/call", "params": {
            "name": "desktop", "arguments": {"op": "capabilities"}}})
        mcp = json.loads(response["content"][0]["text"])
        process = subprocess.run([sys.executable, str(ROOT / "scripts/hid-act.py"), "--capabilities"],
                                 capture_output=True, check=True)
        self.assertEqual(mcp, json.loads(process.stdout))
        self.assertEqual(mcp["inputSchema"], DESKTOP_TOOL["inputSchema"])

    def test_direct_cli_runs_with_mcp_imports_blocked(self):
        code = (
            "import builtins,runpy,sys\n"
            "original=builtins.__import__\n"
            "def guarded(name,*args,**kwargs):\n"
            " if name.split('.')[0] in ('mcp_server','fast_desktop'): "
            "raise ImportError('MCP is unavailable for this direct entry')\n"
            " return original(name,*args,**kwargs)\n"
            "builtins.__import__=guarded\n"
            "sys.argv=[sys.argv[1],'--capabilities']+sys.argv[2:]\n"
            "runpy.run_path(sys.argv[0],run_name='__main__')\n"
        )
        result = subprocess.run([sys.executable, "-c", code, str(ROOT / "scripts/hid-act.py")],
                                capture_output=True, check=True)
        capability = json.loads(result.stdout)
        self.assertFalse(capability["mcp_required"])
        self.assertEqual(capability["backend"], "board_usb_gadget")
        result = subprocess.run([sys.executable, "-c", code, str(ROOT / "scripts/hid-act.py"), "--compact"],
                                capture_output=True, check=True)
        capability = json.loads(result.stdout)
        self.assertFalse(capability["mcp_required"])
        self.assertEqual(capability["inputSchema"]["oneOf"][2]["properties"]["op"]["const"], "fill_form")

    def test_install_updates_only_existing_hid_prompts(self):
        template = json.loads((ROOT / "opencode-qwen.json").read_text(encoding="utf-8"))
        before = json.loads(json.dumps(template))
        before["agent"]["rk-local"]["prompt"] = "Other concurrent task"
        for name in installer.BINDINGS:
            before["agent"][name]["prompt"] = "Old HID instructions"
        after = installer.merge_prompts(before, template)
        for name in installer.BINDINGS:
            reference = "references/agent.md" if name == "rk-desktop-fast" else "SKILL.md"
            self.assertIn("{file:{env:RK_AGENT_ROOT}/skills/rk-hid-desktop/" + reference + "}",
                          after["agent"][name]["prompt"])
            after["agent"][name]["prompt"] = before["agent"][name]["prompt"]
        self.assertEqual(after, before)
        self.assertNotEqual(before, template)
        before["agent"]["rk-desktop"]["permission"]["rk_desktop_desktop"] = "deny"
        with self.assertRaises(ValueError):
            installer.merge_prompts(before, template)


if __name__ == "__main__":
    unittest.main()
