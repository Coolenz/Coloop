"""USB HID reports for the project's fixed keyboard/absolute-mouse descriptors."""

import os
from pathlib import Path
import select
import struct
import time


KEYS = {
    "ENTER": 40,
    "ESC": 41,
    "BACKSPACE": 42,
    "TAB": 43,
    "SPACE": 44,
    "RIGHT": 79,
    "LEFT": 80,
    "DOWN": 81,
    "UP": 82,
    "HOME": 74,
    "END": 77,
}
KEYS.update({chr(65 + i): 4 + i for i in range(26)})
KEYS.update({"F" + str(i + 1): 58 + i for i in range(12)})
KEYS.update({str(i): 29 + i for i in range(1, 10)})
KEYS["0"] = 39
# HID usage 50 is the non-US key; skip it for the US keyboard layout.
PUNCTUATION = {
    "-": 45,
    "=": 46,
    "[": 47,
    "]": 48,
    "\\": 49,
    ";": 51,
    "'": 52,
    "`": 53,
    ",": 54,
    ".": 55,
    "/": 56,
    " ": 44,
    "\n": 40,
    "\t": 43,
}
SHIFTED = dict(zip('!@#$%^&*()_+{}|:"~<>?', "1234567890-=[]\\;'`,./"))


def keyboard_report(chord):
    if not isinstance(chord, str):
        raise ValueError("keys must be a chord string")
    parts = chord.upper().split("+")
    modifiers = {"CTRL": 1, "SHIFT": 2, "ALT": 4}
    mask = 0
    for part in parts[:-1]:
        if part not in modifiers:
            raise ValueError("Supported modifiers: CTRL, SHIFT, ALT")
        mask |= modifiers[part]
    if parts[-1] not in KEYS:
        raise ValueError("Unsupported key")
    return bytes([mask, 0, KEYS[parts[-1]], 0, 0, 0, 0, 0])


def text_reports(text):
    if not isinstance(text, str) or not 1 <= len(text) <= 64:
        raise ValueError("HID text must be 1..64 ASCII characters")
    reports = []
    for char in text:
        shift = 0
        if char in SHIFTED:
            shift, char = 2, SHIFTED[char]
        elif "A" <= char <= "Z":
            shift = 2
        usage = (
            KEYS.get(char.upper()) if char.isascii() and char.isalnum() else PUNCTUATION.get(char)
        )
        if usage is None:
            raise ValueError(
                "Direct HID text supports US-layout ASCII; use IME/clipboard for Chinese"
            )
        reports.extend([bytes([shift, 0, usage, 0, 0, 0, 0, 0]), bytes(8)])
    return reports


def mouse_report(x, y, screen, buttons=0, wheel=0):
    left, top, width, height = screen
    if width <= 1 or height <= 1 or not left <= x < left + width or not top <= y < top + height:
        raise ValueError("Click is outside the physical screen")
    if buttons not in (0, 1, 2) or not -8 <= wheel <= 8:
        raise ValueError("Unsupported mouse report")
    return struct.pack(
        "<BHHb",
        buttons,
        round((x - left) * 32767 / (width - 1)),
        round((y - top) * 32767 / (height - 1)),
        wheel,
    )


class HIDController:
    @staticmethod
    def node(function):
        dev = Path("/sys/kernel/config/usb_gadget/rockchip/functions") / function / "dev"
        if not dev.exists():
            raise RuntimeError("USB HID is not configured; run the explicit HID setup first")
        major, minor = map(int, dev.read_text().strip().split(":"))
        for path in Path("/dev").glob("hidg*"):
            stat = path.stat()
            if os.major(stat.st_rdev) == major and os.minor(stat.st_rdev) == minor:
                return path
        raise RuntimeError("HID character device unavailable")

    @staticmethod
    def send(path, reports, neutral):
        fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
        try:
            for report in reports:
                if not select.select([], [fd], [], 2)[1]:
                    raise TimeoutError("USB host did not consume HID input")
                if os.write(fd, report) != len(report):
                    raise OSError("Incomplete HID report")
                time.sleep(0.025)
        finally:
            # Every action tries to release all keys/buttons, including error paths.
            try:
                if select.select([], [fd], [], 1)[1]:
                    os.write(fd, neutral)
            finally:
                os.close(fd)

    def execute(self, action, validated):
        if action["action"] == "click":
            x, y = validated["center"]
            neutral = mouse_report(x, y, validated["screen"])
            reports = [neutral, mouse_report(x, y, validated["screen"], buttons=1), neutral]
            self.send(self.node("hid.rk_mouse"), reports, neutral)
        elif action["action"] == "hotkey":
            self.send(
                self.node("hid.rk_keyboard"), [keyboard_report(action["keys"]), bytes(8)], bytes(8)
            )
        elif action["action"] == "type":
            self.send(self.node("hid.rk_keyboard"), text_reports(action["text"]), bytes(8))
        else:
            raise ValueError("Unsupported action")
