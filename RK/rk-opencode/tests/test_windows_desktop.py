import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
sys.path.insert(0, str(ROOT / "pc"))
from windows_desktop import validate_arguments, WindowsDesktopTools  # noqa: E402
from windows_service import WindowsDesktop  # noqa: E402
from observations import ObservationRegistry  # noqa: E402


class WindowsDesktopTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        self.file = self.folder / "sample.txt"
        self.file.write_text("test", encoding="utf-8")
        self.service = WindowsDesktop.__new__(WindowsDesktop)
        self.service.folder = self.folder
        self.service.registry = ObservationRegistry()
        self.service.execute = True
        self.service.allowed_files = {self.file.resolve()}
        self.service.file_app = "fixture.exe"
        self.service.used_requests = set()
        self.service.input = Mock()
        self.live = {
            "window": "Lab", "window_open": True, "rect": [0, 0, 500, 500],
            "screen": [0, 0, 1920, 1080], "_handle": 100, "_focus": "edit", "_focus_type": "Edit",
            "targets": [{"id": 0, "name": "Input", "type": "Edit", "source": "uia",
                         "rect": [10, 20, 200, 60], "enabled": True, "value": "old",
                         "_runtime_id": "edit"}],
        }
        self.service.snapshot = Mock(side_effect=lambda: copy.deepcopy(self.live))
        self.obs = self.service.registry.observe(copy.deepcopy(self.live))

    def call(self, args, request_id="request"):
        return self.service.measured_call("/windows", {
            **args, "session_id": self.service.registry.session_id, "request_id": request_id,
        })

    def action(self, op="fill", **kwargs):
        return {"op": op, "observation_id": self.obs["observation_id"], **kwargs}

    def test_numeric_strings_and_unicode_preserved_but_numbers_and_controls_rejected(self):
        for text in ("-00123.4500", "中文数据🙂", ""):
            validate_arguments(self.action(target_id=0, text=text))
        for text in (123.45, "line\nnext", "x\t", "\ud800"):
            with self.assertRaises((ValueError, UnicodeError)):
                validate_arguments(self.action(target_id=0, text=text))
        with self.assertRaises(ValueError):
            validate_arguments(self.action(target_id=True, text="x"))

    def test_plan_never_injects_or_opens(self):
        self.service.execute = False
        result = self.call(self.action(target_id=0, text="x"))
        self.assertEqual(result["state"], "planned")
        self.service.input.click.assert_not_called()
        with patch("windows_service.subprocess.Popen") as process:
            self.call({"op": "open_file", "path": str(self.file)})
        process.assert_not_called()

    def test_fill_verifies_literal_value_and_returns_fresh_id(self):
        text = "中文-00123.4500"
        self.service.input.type.side_effect = lambda *_args, **_kw: self.live["targets"][0].update(
            value=text)
        result = self.call(self.action(target_id=0, text=text))
        self.assertTrue(result["value_verified"])
        self.assertNotEqual(result["observation"]["observation_id"], self.obs["observation_id"])
        self.service.input.type.assert_called_once_with(100, text, replace=True)
        log = (self.folder / "windows-actions.jsonl").read_text()
        self.assertNotIn(text, log)
        self.assertNotIn("_runtime_id", json.dumps(result))

    def test_uncertain_input_is_consumed_without_retry(self):
        self.service.input.type.side_effect = OSError("partial input")
        args = self.action(target_id=0, text="x")
        result = self.call(args)
        self.assertEqual(result["state"], "outcome_unknown")
        with self.assertRaises(ValueError):
            self.call(args)
        with self.assertRaises(ValueError):
            self.call(args, "new-request")
        self.service.input.type.assert_called_once()

    def test_focus_failure_after_click_prevents_typing(self):
        self.service.poll = Mock(side_effect=ValueError("focus changed"))
        result = self.call(self.action(target_id=0, text="x"))
        self.assertEqual(result["state"], "outcome_unknown")
        self.service.input.type.assert_not_called()

    def test_verification_failure_retains_input_sent(self):
        self.service.poll = Mock(side_effect=[self.live, ValueError("value differs")])
        result = self.call(self.action(target_id=0, text="x"))
        self.assertTrue(result["executed"])
        self.assertIn("observation_error", result)
        self.assertNotIn("value_verified", result)

    def test_changed_window_or_covered_target_prevents_input(self):
        self.live["targets"][0]["_occluded"] = True
        with self.assertRaises(ValueError):
            self.call(self.action(target_id=0, text="x"))
        self.service.input.click.assert_not_called()

    def test_open_scope_extension_and_request_replay(self):
        with patch("windows_service.subprocess.Popen") as process:
            result = self.call({"op": "open_file", "path": str(self.file)})
            self.assertEqual(result["state"], "open_requested")
            process.assert_called_once_with(["fixture.exe", str(self.file.resolve())])
            with self.assertRaises(ValueError):
                self.call({"op": "open_file", "path": str(self.file)})
        other = self.folder / "other.txt"
        other.write_text("outside")
        with self.assertRaises(ValueError):
            self.call({"op": "open_file", "path": str(other)}, "other")
        executable = self.folder / "bad.exe"
        executable.write_bytes(b"test")
        self.service.allowed_files.add(executable.resolve())
        with self.assertRaises(ValueError):
            self.call({"op": "open_file", "path": str(executable)}, "bad")

    def test_stale_session_rejected(self):
        with self.assertRaises(ValueError):
            self.service.measured_call("/windows", {"op": "observe", "session_id": "old"})

    def test_client_blocks_replay_after_unknown_outcome_until_new_user_turn(self):
        runtime = self.folder / ".runtime"
        runtime.mkdir()
        (runtime / "windows-desktop-key").write_text("test-key")
        (runtime / "windows-desktop-session.json").write_text(
            json.dumps({"session_id": "test", "window": "中文窗口"}, ensure_ascii=False),
            encoding="utf-8")
        marker = runtime / "windows-desktop-turn"
        marker.write_text("turn1")
        tool = WindowsDesktopTools(self.folder)
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch("windows_desktop.urllib.request.urlopen", return_value=response) as request:
            with patch("windows_desktop.json.load", return_value={"state": "outcome_unknown"}):
                tool.call(self.action(target_id=0, text="x"))
                with self.assertRaisesRegex(RuntimeError, "new user message"):
                    tool.call({"op": "observe"})
                self.assertEqual(request.call_count, 1)
                marker.write_text("turn2")
                tool.call({"op": "observe"})
                self.assertEqual(request.call_count, 2)

    def test_typing_utf16_includes_surrogate_pair_without_numeric_conversion(self):
        from windows_input import text_inputs

        text = "中文🙂-00123.4500"
        reports = text_inputs(text)
        units = bytes().join(int(x.ki.wScan).to_bytes(2, "little") for x in reports[::2])
        self.assertEqual(units.decode("utf-16-le"), text)
        self.assertTrue(all(x.ki.dwFlags == 6 for x in reports[1::2]))

    def test_form_preflight_rejects_bad_submit_before_typing(self):
        with self.assertRaises(ValueError):
            self.call(self.action("fill_form", fields=[{"target_id": 0, "text": "x"}], submit=99))
        self.service.input.click.assert_not_called()

    def test_form_fills_once_and_stops_before_submit_after_value_failure(self):
        self.live["targets"].append({"id": 1, "name": "Apply", "type": "Button", "source": "uia",
                                    "rect": [210, 20, 290, 60], "enabled": True, "_runtime_id": "apply"})
        self.obs = self.service.registry.observe(copy.deepcopy(self.live))
        self.service.poll = Mock(side_effect=[self.live, ValueError("value mismatch")])
        result = self.call(self.action("fill_form", fields=[{"target_id": 0, "text": "x"}], submit=1))
        self.assertEqual(result["state"], "partial")
        self.assertFalse(result["batch_complete"])
        self.service.input.click.assert_called_once()  # Focus click only, no submit/replay.
        self.service.input.type.assert_called_once()

    def test_form_preserves_exact_strings_and_submits_once(self):
        self.live["targets"].append({"id": 1, "name": "Apply", "type": "Button", "source": "uia",
                                    "rect": [210, 20, 290, 60], "enabled": True, "_runtime_id": "apply"})
        self.obs = self.service.registry.observe(copy.deepcopy(self.live))
        self.service.input.type.side_effect = lambda _handle, text, **_kw: self.live["targets"][0].update(value=text)
        args = self.action("fill_form", fields=[{"target_id": 0, "text": "中文-001.4500"}], submit=1)
        result = self.call(args)
        self.assertTrue(result["batch_complete"])
        self.assertEqual(result["filled"], [0])
        self.assertEqual(result["submitted"], 1)
        self.assertEqual(self.live["targets"][0]["value"], "中文-001.4500")
        self.assertEqual(self.service.input.click.call_count, 2)
        with self.assertRaises(ValueError):
            self.call(args)

    def test_form_schema_rejects_repeated_fields_nonliteral_numbers_and_oversized_batches(self):
        for fields in ([{"target_id": 0, "text": 12}],
                       [{"target_id": 0, "text": "x"}] * 2,
                       [{"target_id": n, "text": "x"} for n in range(5)]):
            with self.assertRaises(ValueError):
                validate_arguments(self.action("fill_form", fields=fields))

    def test_model_view_baseline_survives_the_context_to_mcp_process_boundary(self):
        runtime = self.folder / ".runtime"
        runtime.mkdir()
        (runtime / "windows-desktop-key").write_text("test")
        (runtime / "windows-desktop-session.json").write_text(json.dumps({"session_id": "test"}))
        (runtime / "windows-desktop-turn").write_text("one-user-message")
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        first = {"observation_id": "a", "window": "Lab", "targets": [
            {"id": 1, "name": "Text", "type": "Edit", "value": "old"},
            {"id": 2, "name": "Ready", "type": "Text"},
        ]}
        second = copy.deepcopy(first)
        second["observation_id"] = "b"
        second["targets"][0]["value"] = "中文"
        with patch("windows_desktop.urllib.request.urlopen", return_value=response):
            with patch("windows_desktop.json.load", side_effect=[first, {
                "state": "input_sent", "executed": True, "input_ms": 3, "observation": second,
            }]):
                initial = WindowsDesktopTools(self.folder, model_view=True).call({"op": "observe"})
                self.assertEqual(initial["view"], "full")
                output = WindowsDesktopTools(self.folder, model_view=True).call({
                    "op": "fill", "observation_id": "a", "target_id": 1, "text": "中文"})
        self.assertEqual(output["observation"]["view"], "delta")
        self.assertEqual(output["observation"]["base"], "a")
        self.assertEqual(output["observation"]["set"], [[1, "Edit", "Text", "中文"]])
        self.assertNotIn("input_ms", output)


if __name__ == "__main__":
    unittest.main()
