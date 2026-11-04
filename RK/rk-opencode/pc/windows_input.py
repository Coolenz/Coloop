"""Native SendInput backend. No shell, clipboard, global hooks or extra dependencies."""

import ctypes
from ctypes import wintypes
import struct


class MouseInput(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class KeyboardInput(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t),
    ]


class InputUnion(ctypes.Union):
    _fields_ = [("mi", MouseInput), ("ki", KeyboardInput)]


class Input(ctypes.Structure):
    _anonymous_ = ("data",)
    _fields_ = [("type", wintypes.DWORD), ("data", InputUnion)]


KEYS = {
    "ENTER": 0x0D, "TAB": 0x09, "ESC": 0x1B, "BACKSPACE": 0x08, "SPACE": 0x20,
    "HOME": 0x24, "END": 0x23, "LEFT": 0x25, "UP": 0x26, "RIGHT": 0x27, "DOWN": 0x28,
    **{chr(i): i for i in range(65, 91)}, **{str(i): 48 + i for i in range(10)},
    **{"F" + str(i): 0x6F + i for i in range(1, 13)},
}
MODIFIERS = {"CTRL": 0x11, "SHIFT": 0x10, "ALT": 0x12}


def key_input(key=0, scan=0, flags=0):
    return Input(type=1, ki=KeyboardInput(key, scan, flags, 0, 0))


def chord_inputs(chord):
    parts = chord.upper().split("+")
    if len(parts) > 4 or any(p not in MODIFIERS for p in parts[:-1]):
        raise ValueError("Supported modifiers: CTRL, SHIFT, ALT")
    if len(set(parts)) != len(parts) or parts[-1] not in KEYS:
        raise ValueError("Unsupported or duplicate key")
    keys = [MODIFIERS[p] for p in parts[:-1]] + [KEYS[parts[-1]]]
    result = []
    for key in keys:
        result.append(key_input(key, flags=1 if 0x21 <= key <= 0x28 else 0))
    for key in reversed(keys):
        result.append(key_input(key, flags=2 | (1 if 0x21 <= key <= 0x28 else 0)))
    return result


def text_inputs(text):
    encoded = text.encode("utf-16-le")
    result = []
    for (unit,) in struct.iter_unpack("<H", encoded):
        result.extend([key_input(scan=unit, flags=4), key_input(scan=unit, flags=6)])
    return result


class WindowsInput:
    def __init__(self):
        self.api = ctypes.WinDLL("user32", use_last_error=True)
        self.api.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(Input), ctypes.c_int)
        self.api.SendInput.restype = wintypes.UINT
        self.api.GetForegroundWindow.restype = wintypes.HWND
        self.api.WindowFromPoint.argtypes = (wintypes.POINT,)
        self.api.WindowFromPoint.restype = wintypes.HWND
        self.api.GetAncestor.argtypes = (wintypes.HWND, wintypes.UINT)
        self.api.GetAncestor.restype = wintypes.HWND

    def guard(self, handle, center=None):
        if self.api.GetForegroundWindow() != handle:
            raise ValueError("Foreground changed; no input sent")
        if any(self.api.GetAsyncKeyState(k) & 0x8000 for k in (1, 2, 4, 16, 17, 18, 91, 92)):
            raise ValueError("Release physical modifiers and mouse buttons before automation")
        if center:
            at = self.api.WindowFromPoint(wintypes.POINT(*center))
            if self.api.GetAncestor(at, 2) != handle:
                raise ValueError("Click point is covered by another window")

    def send(self, inputs):
        if not inputs:
            return
        batch = (Input * len(inputs))(*inputs)
        sent = self.api.SendInput(len(batch), batch, ctypes.sizeof(Input))
        if sent != len(batch):
            # Attempt releases only; never replay a partly delivered action.
            releases = [x for x in inputs if x.type == 1 and x.ki.dwFlags & 2]
            releases.append(Input(type=0, mi=MouseInput(0, 0, 0, 4, 0, 0)))
            neutral = (Input * len(releases))(*releases)
            self.api.SendInput(len(neutral), neutral, ctypes.sizeof(Input))
            raise OSError("SendInput inserted only part of the action; outcome unknown")

    def click(self, handle, center):
        self.guard(handle, center)
        left, top, width, height = [self.api.GetSystemMetrics(k) for k in (76, 77, 78, 79)]
        x, y = center
        if width <= 1 or height <= 1 or not left <= x < left + width or not top <= y < top + height:
            raise ValueError("Click outside the physical desktop")
        dx, dy = round((x - left) * 65535 / (width - 1)), round((y - top) * 65535 / (height - 1))
        move = 0x0001 | 0x8000 | 0x4000
        self.send([Input(type=0, mi=MouseInput(dx, dy, 0, flags, 0, 0))
                   for flags in (move, move | 2, move | 4)])

    def type(self, handle, text, replace=False):
        self.guard(handle)
        self.send((chord_inputs("CTRL+A") if replace else []) + text_inputs(text))

    def hotkey(self, handle, keys):
        inputs = chord_inputs(keys)
        self.guard(handle)
        self.send(inputs)
