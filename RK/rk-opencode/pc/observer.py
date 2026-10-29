"""Window-scoped Windows observation service. This process never injects input."""

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import sys
import threading
import time

from observations import ObservationRegistry, TargetIDs

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "tools"))


class Observer:
    def __init__(self, title, use_ocr, folder, perception="hybrid", fixture_state=None):
        started = time.perf_counter()
        from screen_ocr import ScreenOCR

        self.title = title
        self.ocr = ScreenOCR() if use_ocr else None
        self.startup_ms = (time.perf_counter() - started) * 1000
        self.perception = perception
        self.fixture_state = Path(fixture_state) if fixture_state else None
        self.fixture_pid = None
        self.last_timing = {}
        self.first_image = None
        self.first_origin = None
        self.folder = folder
        self.folder.mkdir(parents=True, exist_ok=True)
        self.registry = ObservationRegistry()
        self.target_ids = TargetIDs()
        self.lock = threading.Lock()

    def snapshot(self):
        started = time.perf_counter()
        self.last_timing = {}
        if self.fixture_state and self.fixture_state.exists():
            state = json.loads(self.fixture_state.read_text(encoding="utf-8-sig"))
            if state.get("title") != self.title:
                raise ValueError("Fixture title mismatch")
            if self.fixture_pid == state.get("pid") and state.get("closed") is True:
                self.last_timing["total_ms"] = (time.perf_counter() - started) * 1000
                return {
                    "window": self.title,
                    "window_open": False,
                    "targets": [],
                    "closed_by_fixture": True,
                }
        elif self.fixture_state:
            raise ValueError("Fixture has not reported ready")
        import cv2
        import mss
        from comtypes import CoInitialize, CoUninitialize
        from pywinauto import Desktop
        from screen_ocr import capture, find_window, window_region

        CoInitialize()
        try:
            window = find_window(self.title)
            ctypes.windll.user32.GetForegroundWindow.restype = wintypes.HWND
            foreground = ctypes.windll.user32.GetForegroundWindow()
            if foreground != window.handle:
                raise ValueError(
                    "The allowed window must be foreground; switch to it and observe again"
                )
            left, top, width, height = window_region(window)
            if self.fixture_state:
                pid = wintypes.DWORD()
                ctypes.windll.user32.GetWindowThreadProcessId(
                    wintypes.HWND(window.handle), ctypes.byref(pid)
                )
                if pid.value != state.get("pid"):
                    raise ValueError("Fixture process mismatch")
                self.fixture_pid = pid.value
            with mss.MSS() as screen:
                if len(screen.monitors) != 2:
                    raise ValueError("Initial HID mapping requires a single connected display")
                primary = screen.monitors[1]
                physical = [primary["left"], primary["top"], primary["width"], primary["height"]]
            self.last_timing["window_ms"] = (time.perf_counter() - started) * 1000
            tick = time.perf_counter()
            image, origin = capture(region=[left, top, width, height])
            self.last_timing["capture_ms"] = (time.perf_counter() - tick) * 1000
            tick = time.perf_counter()
            cv2.imwrite(str(self.folder / "latest.png"), image)
            if self.first_image is None:
                self.first_image, self.first_origin = image.copy(), origin
                cv2.imwrite(str(self.folder / "first.png"), image)
            self.last_timing["image_save_ms"] = (time.perf_counter() - tick) * 1000
            tick = time.perf_counter()
            uia = Desktop(backend="uia").window(handle=window.handle).wrapper_object()
            targets, focus, focus_type = [], None, None
            for control in uia.descendants():
                try:
                    info = control.element_info
                    if (
                        not control.is_visible()
                        or info.element.CurrentIsPassword
                        or info.control_type
                        not in (
                            "Button",
                            "Edit",
                            "Text",
                            "CheckBox",
                            "ComboBox",
                            "MenuItem",
                            "TabItem",
                        )
                    ):
                        continue
                    r = control.rectangle()
                    if r.width() <= 0 or r.height() <= 0:
                        continue
                    if not (
                        left <= r.left < r.right <= left + width
                        and top <= r.top < r.bottom <= top + height
                    ):
                        continue
                    name = info.name
                    if info.control_type == "Edit":
                        try:
                            name = name or control.get_value()[:128]
                        except Exception:
                            pass
                    item = {
                        "id": len(targets),
                        "name": name[:128],
                        "type": info.control_type,
                        "rect": [r.left, r.top, r.right, r.bottom],
                        "enabled": control.is_enabled(),
                        "source": "uia",
                    }
                    item["focused"] = control.has_keyboard_focus()
                    if info.control_type == "Edit":
                        try:
                            item["value"] = control.get_value()[:128]
                        except Exception:
                            pass
                    if item["focused"]:
                        focus = str(info.runtime_id)
                        focus_type = info.control_type
                    targets.append(item)
                    if len(targets) >= 32:
                        break
                except Exception:
                    continue
            self.last_timing["uia_ms"] = (time.perf_counter() - tick) * 1000
            if self.perception == "ocr":
                targets = []
            if self.ocr:
                tick = time.perf_counter()
                recognized = self.ocr.read(image, origin)
                self.last_timing["ocr_ms"] = (time.perf_counter() - tick) * 1000
                self.last_timing["ocr_engine_ms"] = recognized["elapsed_ms"]
                self.last_timing["ocr_regions"] = len(recognized["items"])
                for item in recognized["items"]:
                    if item["confidence"] < 0.85 or len(targets) >= 40:
                        continue
                    if any(x["name"] == item["text"] for x in targets):
                        continue
                    targets.append(
                        {
                            "id": len(targets),
                            "name": item["text"][:128],
                            "type": "TextRegion",
                            "rect": [round(x) for x in item["rect"]],
                            "enabled": True,
                            "source": "ocr",
                        }
                    )
            targets = self.target_ids.assign(targets)
            ctypes.windll.user32.WindowFromPoint.restype = wintypes.HWND
            ctypes.windll.user32.GetAncestor.restype = wintypes.HWND
            for target in targets:
                r = target["rect"]
                at = ctypes.windll.user32.WindowFromPoint(
                    wintypes.POINT((r[0] + r[2]) // 2, (r[1] + r[3]) // 2)
                )
                target["_occluded"] = (
                    ctypes.windll.user32.GetAncestor(wintypes.HWND(at), 2) != window.handle
                )
            if ctypes.windll.user32.GetForegroundWindow() != window.handle:
                raise ValueError("Foreground changed during capture")
            self.last_timing["total_ms"] = (time.perf_counter() - started) * 1000
            return {
                "window": self.title,
                "window_open": True,
                "focused_control": focus_type,
                "rect": [left, top, left + width, top + height],
                "screen": physical,
                "targets": targets,
                "_handle": window.handle,
                "_focus": focus,
                "_focus_type": focus_type,
                "image_sha256": hashlib.sha256(image.tobytes()).hexdigest(),
            }
        finally:
            CoUninitialize()

    def call(self, path, body=None):
        with self.lock:
            if path == "/health":
                return {
                    "ready": True,
                    "window": self.title,
                    "session_id": self.registry.session_id,
                    "ocr_startup_ms": self.startup_ms,
                    "perception": self.perception,
                }
            if path == "/profile-ocr":
                count = (body or {}).get("repeats", 5)
                if type(count) is not int or not 1 <= count <= 20:
                    raise ValueError("repeats must be 1..20")
                if not self.ocr or self.first_image is None:
                    raise ValueError("Observe a window with OCR first")
                samples = []
                for _ in range(count):
                    tick = time.perf_counter()
                    result = self.ocr.read(self.first_image, self.first_origin)
                    samples.append(
                        {
                            "wall_ms": (time.perf_counter() - tick) * 1000,
                            "engine_ms": result["elapsed_ms"],
                            "regions": len(result["items"]),
                        }
                    )
                return {"samples": samples, "image": "first.png"}
            tick = time.perf_counter()
            result, error = None, None
            try:
                result = self.measured_call(path, body)
                return result
            except Exception as exc:
                error = str(exc)
                raise
            finally:
                record = {
                    "path": path,
                    "session_id": self.registry.session_id,
                    "observation_id": (result or {}).get("observation_id")
                    or (body or {}).get("observation_id"),
                    "elapsed_ms": (time.perf_counter() - tick) * 1000,
                    "snapshot": self.last_timing,
                    "error": error,
                }
                with (self.folder / "observations.jsonl").open("a", encoding="utf-8") as log:
                    log.write(json.dumps(record) + "\n")

    def measured_call(self, path, body):
        if path == "/observe":
            result = self.registry.observe(self.snapshot())
            result["targets"] = [
                {k: v for k, v in t.items() if not k.startswith("_")} for t in result["targets"]
            ]
            return result
        if path == "/validate":
            return self.registry.validate(body, self.snapshot())
        raise ValueError("Unknown endpoint")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        status = 200
        try:
            if self.headers.get("Origin") or not hmac.compare_digest(
                self.headers.get("Authorization", ""), "Bearer " + self.server.api_key
            ):
                status = 403
                raise ValueError("Authentication required; browser origins disabled")
            body = None
            if self.command == "POST":
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8192:
                    raise ValueError("Request must be 1..8192 bytes")
                self.connection.settimeout(5)
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise ValueError("Expected object")
            if (self.command, self.path) not in (
                ("GET", "/health"),
                ("GET", "/observe"),
                ("POST", "/validate"),
                ("POST", "/profile-ocr"),
            ):
                raise ValueError("Unknown endpoint")
            value = self.server.observer.call(self.path, body)
        except Exception as error:
            status = status if status != 200 else 409
            value = {"error": str(error)}
        encoded = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    do_GET = handle_request
    do_POST = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title", required=True)
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--output-dir", type=Path, default=ROOT / ".runtime/observer")
    parser.add_argument("--perception", choices=("hybrid", "ocr"), default="hybrid")
    parser.add_argument("--fixture-state")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("Windows only")
    if args.perception == "ocr" and not args.ocr:
        parser.error("--perception ocr requires --ocr")
    key = (ROOT / ".runtime/desktop-key").read_text().strip()
    # UIA caches COM interfaces: keep their apartment alive on ONE service thread.
    from comtypes import CoInitialize, CoUninitialize

    CoInitialize()
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    server.api_key = key
    server.observer = Observer(
        args.title, args.ocr, args.output_dir, args.perception, args.fixture_state
    )
    print("Window-scoped observer ready", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        CoUninitialize()


if __name__ == "__main__":
    main()
