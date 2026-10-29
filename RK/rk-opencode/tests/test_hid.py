from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from hid import keyboard_report, text_reports, mouse_report


class HIDTests(unittest.TestCase):
    def test_key_and_text_reports_release_keys(self):
        self.assertEqual(keyboard_report("CTRL+A"), bytes([1, 0, 4, 0, 0, 0, 0, 0]))
        self.assertEqual(keyboard_report("ALT+F4"), bytes([4, 0, 61, 0, 0, 0, 0, 0]))
        self.assertEqual(text_reports("A!")[-1], bytes(8))
        self.assertEqual(text_reports("!")[0][:3], bytes([2, 0, 30]))
        with self.assertRaises(ValueError):
            text_reports("中文")
        with self.assertRaises(ValueError):
            keyboard_report("WIN+R")

    def test_absolute_mouse_maps_edges_and_rejects_outside(self):
        screen = [-100, 0, 200, 100]
        self.assertEqual(struct.unpack("<BHHb", mouse_report(-100, 0, screen)), (0, 0, 0, 0))
        self.assertEqual(
            struct.unpack("<BHHb", mouse_report(99, 99, screen, 1)), (1, 32767, 32767, 0)
        )
        with self.assertRaises(ValueError):
            mouse_report(100, 0, screen)


if __name__ == "__main__":
    unittest.main()
