"""USB HID reports for the project's fixed keyboard/absolute-mouse descriptors."""

import os
import math
from pathlib import Path
import select
import struct
import signal
import threading
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
    "INSERT": 73,
    "PAGEUP": 75,
    "DELETE": 76,
    "PAGEDOWN": 78,
    "CAPSLOCK": 57,
    "PRINTSCREEN": 70,
    "SCROLLLOCK": 71,
    "PAUSE": 72,
    "MENU": 101,
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


MODIFIERS = {"CTRL": 1, "SHIFT": 2, "ALT": 4, "WIN": 8}
ALIASES = {"CONTROL": "CTRL", "ESCAPE": "ESC", "RETURN": "ENTER", "DEL": "DELETE",
           "PGUP": "PAGEUP", "PGDN": "PAGEDOWN", "GUI": "WIN"}
BUTTONS = {"left": 1, "right": 2, "middle": 4}
POINTER_ACTIONS = {"move", "hover", "click", "double_click", "drag", "scroll"}
HID_ACTIONS = ("move", "hover", "click", "double_click", "drag", "scroll", "hotkey", "type")
TEXT_LIMIT = 64
SCROLL_LIMIT = 32
DRAG_MIN_MS, DRAG_MAX_MS, DRAG_DEFAULT_MS = 100, 3000, 500
REPORT_INTERVAL = 0.025  # at most 40 motion reports/sec, independent of pixel distance


def hid_capabilities():
    """Declared protocol only: querying this does not open a device or authorize input."""
    return {
        "name": "rk-usb-hid", "version": 1, "skill": "rk-hid-desktop",
        "mcp_required": False,
        "entrypoints": {"primary": "board_local_python_or_cli", "cli": "scripts/hid-act.py",
                        "python": "desktop.DesktopTools.call/step", "mcp": "optional_adapter"},
        "backend": "board_usb_gadget", "readiness": "not_checked",
        "actions": list(HID_ACTIONS), "buttons": list(BUTTONS),
        "text": {"layout": "US ASCII", "max_characters": TEXT_LIMIT,
                 "preserves": ["leading_spaces", "trailing_spaces", "LF", "TAB"]},
        "keyboard": {"modifiers": list(MODIFIERS), "keys": list(KEYS),
                     "aliases": dict(ALIASES), "max_ordinary_keys": 6},
        "pointer": {"requires_target_id": True, "drag_requires_end_target_id": True,
                    "optional_points": "original_screenshot_pixels_within_target",
                    "display_count": 1, "absolute_range": [0, 32767]},
        "drag": {"min_duration_ms": DRAG_MIN_MS, "max_duration_ms": DRAG_MAX_MS,
                 "default_duration_ms": DRAG_DEFAULT_MS, "timing": "nominal_not_realtime"},
        "wheel": {"axis": "vertical", "unit": "detent", "positive": "up",
                  "max_abs_steps": SCROLL_LIMIT},
        "unsupported": ["horizontal_wheel", "unicode_text", "cross_call_press_release"],
        "requires": ["authorized_session", "latest_observation", "foreground_window",
                     "one_use_validation", "shared_input_lock", "per_report_guard"],
    }


def keyboard_report(chord):
    if not isinstance(chord, str):
        raise ValueError("keys must be a chord string")
    parts = [ALIASES.get(p, p) for p in chord.upper().split("+")]
    if len(set(parts)) != len(parts) or any(not p for p in parts):
        raise ValueError("Empty or duplicate key in chord")
    mask = 0
    usages = []
    for part in parts:
        if part in MODIFIERS:
            mask |= MODIFIERS[part]
        elif part in KEYS:
            usages.append(KEYS[part])
        else:
            raise ValueError("Unsupported key; entire chord rejected")
    if len(usages) > 6:
        raise ValueError("Keyboard report supports at most six non-modifier keys")
    return bytes([mask, 0, *usages, *([0] * (6 - len(usages)))])


def text_reports(text):
    if not isinstance(text, str) or not 1 <= len(text) <= TEXT_LIMIT:
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
                "Direct HID text supports US-layout ASCII only; Unicode needs a separate channel"
            )
        reports.extend([bytes([shift, 0, usage, 0, 0, 0, 0, 0]), bytes(8)])
    return reports


def mouse_report(x, y, screen, buttons=0, wheel=0):
    if (len(screen) != 4 or any(type(n) is not int for n in screen)
            or any(type(n) not in (int, float) or not math.isfinite(n) for n in (x, y))):
        raise ValueError("Mouse coordinates must be finite physical pixels")
    left, top, width, height = screen
    if width <= 1 or height <= 1 or not left <= x < left + width or not top <= y < top + height:
        raise ValueError("Click is outside the physical screen")
    if (type(buttons) is not int or not 0 <= buttons <= 7
            or type(wheel) is not int or not -8 <= wheel <= 8):
        raise ValueError("Unsupported mouse report")
    return struct.pack(
        "<BHHb",
        buttons,
        round((x - left) * 32767 / (width - 1)),
        round((y - top) * 32767 / (height - 1)),
        wheel,
    )


def validate_action(action):
    """Validate the complete request before reserving an observation or opening HID."""
    kind = action.get("action")
    if not isinstance(kind, str):
        raise ValueError("action must be a string")
    allowed = {"op", "action", "observation_id", "consume"}
    if kind in POINTER_ACTIONS:
        allowed |= {"target_id", "point"}
        for key in ("target_id", "end_target_id") if kind == "drag" else ("target_id",):
            if type(action.get(key)) is not int or action[key] < 0:
                raise ValueError(f"{kind} requires observed {key}")
        if kind in ("click", "double_click", "drag"):
            allowed.add("button")
            if (not isinstance(action.get("button", "left"), str)
                    or action.get("button", "left") not in BUTTONS):
                raise ValueError("button must be left, right or middle")
        if kind == "drag":
            allowed |= {"end_target_id", "end_point", "duration_ms"}
            duration = action.get("duration_ms", DRAG_DEFAULT_MS)
            if type(duration) is not int or not DRAG_MIN_MS <= duration <= DRAG_MAX_MS:
                raise ValueError("drag duration_ms must be 100..3000")
        if kind == "scroll":
            allowed.add("steps")
            if type(action.get("steps")) is not int or not 1 <= abs(action["steps"]) <= SCROLL_LIMIT:
                raise ValueError("scroll steps must be signed 1..32 detents; positive is up")
        for key in ("point", "end_point"):
            if key in action:
                value = action[key]
                if (not isinstance(value, list) or len(value) != 2
                        or any(type(n) is not int or n < 0 for n in value)):
                    raise ValueError("point must be two non-negative screenshot pixel integers")
    elif kind == "hotkey":
        allowed.add("keys")
        keyboard_report(action.get("keys"))
    elif kind == "type":
        allowed.add("text")
        text_reports(action.get("text"))
    else:
        raise ValueError("Unsupported HID action")
    if set(action) - allowed:
        raise ValueError("Unexpected fields for this HID action")


def pointer_reports(action, validated):
    """Return a bounded full gesture, never a cross-call button-down state."""
    x, y = validated["center"]
    screen = validated["screen"]
    neutral = mouse_report(x, y, screen)
    reports = [neutral]
    kind = action["action"]
    button = BUTTONS[action.get("button", "left")]
    if kind in ("click", "double_click"):
        for _ in range(2 if kind == "double_click" else 1):
            reports.extend([mouse_report(x, y, screen, button), neutral])
    elif kind == "drag":
        end_x, end_y = validated["end_center"]
        count = math.ceil(action.get("duration_ms", DRAG_DEFAULT_MS) / (REPORT_INTERVAL * 1000))
        reports.append(mouse_report(x, y, screen, button))
        for i in range(1, count + 1):
            reports.append(mouse_report(x + (end_x - x) * i / count,
                                        y + (end_y - y) * i / count, screen, button))
        neutral = mouse_report(end_x, end_y, screen)
        reports.append(neutral)
    elif kind == "scroll":
        # One HID wheel unit = one detent. Windows decides lines/pages per detent.
        remaining = action["steps"]
        while remaining:
            step = max(-8, min(8, remaining))
            reports.append(mouse_report(x, y, screen, wheel=step))
            remaining -= step
        reports.append(neutral)
    return reports, neutral


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
    def send(path, reports, neutral, check=None):
        fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
        previous = None
        attempted = False
        handlers = {}
        def interrupted(signum, frame):
            raise InterruptedError("HID action cancelled by process signal")
        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGTERM, signal.SIGHUP) if hasattr(signal, "SIGHUP") else (signal.SIGTERM,):
                handlers[sig] = signal.signal(sig, interrupted)
        try:
            for report in reports:
                tick = time.monotonic()
                if not select.select([], [fd], [], 2)[1]:
                    raise TimeoutError("USB host did not consume HID input")
                releasing = (len(report) == 8 and report == bytes(8)) or (
                    previous is not None and len(report) == 6 and previous[0] != 0
                    and report[0] == 0 and report[-1] == 0 and report[1:5] == previous[1:5]
                )
                if check and not releasing:
                    check(report)
                if len(report) == 6:
                    # On cancellation release at the last attempted position, never jump
                    # to a drag's planned destination while releasing.
                    neutral = bytes([0]) + report[1:5] + bytes([0])
                attempted = True
                if os.write(fd, report) != len(report):
                    raise OSError("Incomplete HID report")
                previous = report
                time.sleep(max(0, REPORT_INTERVAL - (time.monotonic() - tick)))
        finally:
            # Every action tries to release all keys/buttons, including error paths.
            try:
                if attempted:
                    if not select.select([], [fd], [], 1)[1]:
                        raise TimeoutError("USB host did not consume release; input state unknown")
                    if os.write(fd, neutral) != len(neutral):
                        raise OSError("Incomplete HID release; input state unknown")
            finally:
                os.close(fd)
                for sig, handler in handlers.items():
                    signal.signal(sig, handler)

    def execute(self, action, validated, check=None):
        validate_action(action)
        if action["action"] in POINTER_ACTIONS:
            reports, neutral = pointer_reports(action, validated)
            self.send(self.node("hid.rk_mouse"), reports, neutral, check)
        elif action["action"] == "hotkey":
            self.send(
                self.node("hid.rk_keyboard"), [keyboard_report(action["keys"]), bytes(8)],
                bytes(8), check
            )
        elif action["action"] == "type":
            self.send(self.node("hid.rk_keyboard"), text_reports(action["text"]), bytes(8), check)
        else:
            raise ValueError("Unsupported action")
