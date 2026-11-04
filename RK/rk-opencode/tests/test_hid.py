from pathlib import Path
from contextlib import ExitStack
import struct
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from hid import HIDController, keyboard_report, text_reports, mouse_report, pointer_reports, validate_action


class HIDTests(unittest.TestCase):
    def test_key_and_text_reports_release_keys(self):
        self.assertEqual(keyboard_report("CTRL+A"), bytes([1, 0, 4, 0, 0, 0, 0, 0]))
        self.assertEqual(keyboard_report("ALT+F4"), bytes([4, 0, 61, 0, 0, 0, 0, 0]))
        self.assertEqual(text_reports("A!")[-1], bytes(8))
        self.assertEqual(text_reports("!")[0][:3], bytes([2, 0, 30]))
        with self.assertRaises(ValueError):
            text_reports("中文")
        self.assertEqual(keyboard_report("WIN+R")[:3], bytes([8, 0, 21]))

    def test_chords_reject_whole_unknown_duplicate_or_overflow(self):
        for chord in ("CTRL+BOGUS+A", "CTRL+CTRL+A", "GUI+WIN+A", "CTRL+", "",
                      "A+B+C+D+E+F+G", "CTRL+ A"):
            with self.subTest(chord=chord), self.assertRaises(ValueError):
                keyboard_report(chord)
        self.assertEqual(keyboard_report("CTRL+SHIFT+PAGEUP")[:3], bytes([3, 0, 75]))
        self.assertEqual(keyboard_report("GUI+DELETE")[:3], bytes([8, 0, 76]))
        self.assertEqual(keyboard_report("PAGEDOWN")[2], 78)
        self.assertEqual(keyboard_report("A+B")[2:4], bytes([4, 5]))

    def test_text_preserves_spaces_tabs_newlines_and_rejects_before_send(self):
        reports = text_reports(" A\n\t ")
        self.assertEqual([r[2] for r in reports[::2]], [44, 4, 40, 43, 44])
        self.assertEqual(len(reports), 10)
        for text in ("a\r\n", "ok中文", "\x00", "x" * 65):
            with self.assertRaises(ValueError):
                text_reports(text)

    def test_motion_click_drag_and_scroll_reports(self):
        validated = {"center": [0, 0], "end_center": [1919, 1079],
                     "screen": [0, 0, 1920, 1080]}
        for kind in ("move", "hover"):
            reports, neutral = pointer_reports({"action": kind}, validated)
            self.assertEqual(reports, [neutral])
        reports, _ = pointer_reports({"action": "double_click", "button": "middle"}, validated)
        self.assertEqual([r[0] for r in reports], [0, 4, 0, 4, 0])
        reports, neutral = pointer_reports({"action": "drag", "duration_ms": 500}, validated)
        self.assertEqual(len(reports), 23)
        self.assertTrue(all(r[0] == 1 for r in reports[1:-1]))
        self.assertEqual(struct.unpack("<BHHb", neutral), (0, 32767, 32767, 0))
        reports, _ = pointer_reports({"action": "scroll", "steps": -19}, validated)
        self.assertEqual([struct.unpack("<BHHb", r)[3] for r in reports], [0, -8, -8, -3, 0])

    def test_semantic_validation_rejects_unsafe_fields(self):
        for action in (
            {"action": "drag", "target_id": 0},
            {"action": "scroll", "target_id": 0, "steps": 0},
            {"action": "scroll", "target_id": 0, "steps": 33},
            {"action": "click", "target_id": True},
            {"action": "click", "target_id": 0, "button": "back"},
            {"action": "move", "target_id": 0, "x": 100},
            {"action": "move", "target_id": 0, "point": [float("nan"), 0]},
            {"action": "press", "keys": "CTRL"},
            {"action": "type", "text": "ok", "keys": "ENTER"},
        ):
            with self.subTest(action=action), self.assertRaises(ValueError):
                validate_action(action)

    def send_fixture(self, reports, neutral, check=None, write_effect=None):
        contexts = ExitStack()
        self.addCleanup(contexts.close)
        stack = contexts.enter_context
        stack(patch("hid.os.open", return_value=5))
        stack(patch("hid.os.O_NONBLOCK", 0x800, create=True))
        stack(patch("hid.select.select", return_value=([], [5], [])))
        stack(patch("hid.time.sleep"))
        close = stack(patch("hid.os.close"))
        write = stack(patch("hid.os.write", side_effect=write_effect or (lambda fd, r: len(r))))
        return write, close

    def test_cancelled_drag_releases_at_last_sent_position(self):
        start = mouse_report(0, 0, [0, 0, 100, 100], 1)
        end = mouse_report(99, 99, [0, 0, 100, 100], 1)
        neutral = mouse_report(99, 99, [0, 0, 100, 100])
        write, close = self.send_fixture([start, end], neutral)
        calls = []
        def check(report):
            calls.append(report)
            if len(calls) == 2:
                raise RuntimeError("stopped")
        with self.assertRaisesRegex(RuntimeError, "stopped"):
            HIDController.send("unused", [start, end], neutral, check)
        self.assertEqual(write.call_args_list[-1].args[1], bytes(6))
        close.assert_called_once_with(5)

    def test_failed_report_and_short_release_surface_unknown_state(self):
        write, close = self.send_fixture([], bytes(8), write_effect=[OSError("write failed"), 8])
        with self.assertRaisesRegex(OSError, "write failed"):
            HIDController.send("unused", [keyboard_report("CTRL+A")], bytes(8))
        self.assertEqual(write.call_args_list[-1].args[1], bytes(8))
        close.assert_called_once()

    def test_release_bypasses_focus_guard_after_focus_changing_hotkey(self):
        write, _ = self.send_fixture([], bytes(8))
        checked = []
        HIDController.send("unused", [keyboard_report("TAB"), bytes(8)], bytes(8), checked.append)
        self.assertEqual(len(checked), 1)
        self.assertEqual(write.call_count, 3)

    def test_cancel_before_first_report_preserves_error_and_does_not_move_cursor(self):
        write, close = self.send_fixture([], bytes(6))
        def check(report):
            raise RuntimeError("stopped before input")
        with self.assertRaisesRegex(RuntimeError, "stopped before input"):
            HIDController.send("unused", [bytes(6)], bytes(6), check)
        write.assert_not_called()
        close.assert_called_once()

    def test_failed_release_is_an_explicit_unknown_outcome(self):
        _, close = self.send_fixture([], bytes(8), write_effect=[8, 0])
        with self.assertRaisesRegex(OSError, "release; input state unknown"):
            HIDController.send("unused", [keyboard_report("CTRL+A")], bytes(8))
        close.assert_called_once()

    def test_process_cancel_signal_releases_keyboard(self):
        import signal
        write, _ = self.send_fixture([], bytes(8))
        def pause(_):
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
        with patch("hid.time.sleep", side_effect=pause):
            with self.assertRaises(InterruptedError):
                HIDController.send("unused", [keyboard_report("CTRL+A")], bytes(8))
        self.assertEqual(write.call_args_list[-1].args[1], bytes(8))

    def test_absolute_mouse_maps_edges_and_rejects_outside(self):
        screen = [-100, 0, 200, 100]
        self.assertEqual(struct.unpack("<BHHb", mouse_report(-100, 0, screen)), (0, 0, 0, 0))
        self.assertEqual(
            struct.unpack("<BHHb", mouse_report(99, 99, screen, 1)), (1, 32767, 32767, 0)
        )
        with self.assertRaises(ValueError):
            mouse_report(100, 0, screen)
        self.assertEqual(mouse_report(0, 0, [0, 0, 10, 10], 7)[0], 7)
        for value in (True, float("inf"), float("nan")):
            with self.assertRaises(ValueError):
                mouse_report(value, 0, screen)


if __name__ == "__main__":
    unittest.main()
