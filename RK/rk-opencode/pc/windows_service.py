"""Opt-in Windows software actions, isolated from the existing HID-only observer."""

import argparse
import ctypes
from ctypes import wintypes
from http.server import HTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

from observer import Observer, Handler, ROOT
from windows_input import WindowsInput, chord_inputs

sys.path.insert(0, str(ROOT / "agent"))
from windows_desktop import validate_arguments  # noqa: E402


def compact(observed, identity=None):
    result = {k: observed[k] for k in (
        "observation_id", "window", "window_open", "focused_control",
    ) if k in observed}
    result["targets"] = [{k: t[k] for k in (
        "id", "name", "type", "enabled", "focused", "value", "chrome",
    ) if k in t} for t in observed.get("targets", [])]
    if identity is not None:
        result["_window_identity"] = identity
    return result


class WindowsDesktop(Observer):
    def __init__(self, title, folder, *, execute=False, allowed_files=(), file_app=None,
                 use_ocr=False):
        super().__init__(title, use_ocr, folder)
        self.value_limit = 512
        self.execute = execute
        self.input = WindowsInput()
        self.allowed_files = {Path(p).resolve(strict=True) for p in allowed_files}
        self.file_app = str(Path(file_app).resolve(strict=True)) if file_app else None
        self.used_requests = set()

    def snapshot(self):
        observed = super().snapshot()
        if observed.get("window_open") is False:
            return observed
        rect, origin = wintypes.RECT(), wintypes.POINT()
        api, handle = self.input.api, wintypes.HWND(observed["_handle"])
        if api.GetClientRect(handle, ctypes.byref(rect)) and api.ClientToScreen(handle, ctypes.byref(origin)):
            left, top = origin.x, origin.y
            right, bottom = left + rect.right, top + rect.bottom
            for target in observed["targets"]:
                x1, y1, x2, y2 = target["rect"]
                if not (left <= x1 < x2 <= right and top <= y1 < y2 <= bottom):
                    target["chrome"] = True
        return observed

    def observe_compact(self):
        public = super().measured_call("/observe", None)
        raw = self.registry.latest
        return compact(public, [raw.get("_handle"), raw.get("_pid")])

    def measured_call(self, path, body):
        if path != "/windows":
            return super().measured_call(path, body)
        if not isinstance(body, dict) or body.get("session_id") != self.registry.session_id:
            raise ValueError("Windows session changed; reconnect the companion")
        args = {k: v for k, v in body.items() if k not in ("session_id", "request_id")}
        validate_arguments(args)
        if args["op"] == "observe":
            return self.observe_compact()
        request_id = body.get("request_id")
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 64:
            raise ValueError("Action needs a request_id")
        if request_id in self.used_requests:
            raise ValueError("Already attempted; never replay input")
        if len(self.used_requests) >= 4096:
            raise ValueError("Session action budget exhausted; reconnect")
        op = args["op"]
        if op == "fill_form":
            return self.fill_form(args, request_id)
        target = None
        if op == "open_file":
            path = Path(args["path"])
            if not path.is_absolute() or path.resolve(strict=True) not in self.allowed_files:
                raise ValueError("File is outside this session's explicit allowed files")
            path = path.resolve(strict=True)
            if not path.is_file() or path.suffix.lower() not in (
                ".txt", ".md", ".csv", ".pdf", ".docx", ".xlsx", ".pptx", ".png", ".jpg",
            ):
                raise ValueError("Only explicitly allowed document/image files may be opened")
        else:
            if op == "hotkey":
                chord_inputs(args["keys"])
            action = "click" if op == "fill" else op
            live = self.snapshot()
            validated = self.registry.validate({**args, "action": action}, live)
            handle = live["_handle"]
            if op == "fill":
                target = next(t for t in live["targets"] if t["id"] == args["target_id"])
                if target["type"] != "Edit" or target["source"] != "uia":
                    raise ValueError("fill requires an observed editable UIA control")
        result = {"op": op, "executed": False, "state": "planned"}
        if not self.execute:
            return result
        self.used_requests.add(request_id)  # Consume before the first possible side effect.
        if op != "open_file":
            self.registry.latest["_consumed"] = True
        started = time.perf_counter()
        try:
            if op == "open_file":
                if self.file_app:
                    subprocess.Popen([self.file_app, str(path)])
                else:
                    os.startfile(str(path), "open")
            elif op == "click":
                self.input.click(handle, validated["center"])
            elif op == "fill":
                self.input.click(handle, validated["center"])
                focused = self.poll(lambda s: s.get("_focus") == target["_runtime_id"])
                if focused["_handle"] != handle or focused["rect"] != live["rect"]:
                    raise ValueError("Window changed after focusing the Edit; typing stopped")
                self.input.type(handle, args["text"], replace=True)
            elif op == "type":
                self.input.type(handle, args["text"])
            elif op == "hotkey":
                self.input.hotkey(handle, args["keys"])
            result.update(executed=True, state="open_requested" if op == "open_file" else "input_sent")
        except (OSError, ValueError, RuntimeError) as error:
            result.update(state="outcome_unknown", error=str(error),
                          next="Stop; observe before further actions. Never replay this action.")
            return result
        finally:
            result["input_ms"] = round((time.perf_counter() - started) * 1000, 2)
            with (self.folder / "windows-actions.jsonl").open("a", encoding="utf-8") as log:
                # Keep input text/file contents out of default action logs.
                log.write(json.dumps({**result, "request_id": request_id}) + "\n")
        try:
            if op == "fill":
                def filled(s):
                    return any(t.get("_runtime_id") == target["_runtime_id"]
                               and t.get("value") == args["text"] for t in s["targets"])
                after = self.poll(filled)
                result["value_verified"] = True
            else:
                time.sleep(0.08)
                after = self.poll(lambda s: s.get("window_open") is True)
            result["observation"] = compact(self.registry.observe(after),
                                            [after.get("_handle"), after.get("_pid")])
        except (OSError, ValueError, RuntimeError) as error:
            result.update(observation_error=str(error),
                          next="Input was sent; do not replay it. Report the observation failure.")
        return result

    def fill_form(self, args, request_id):
        """A bounded batch; every primitive keeps its normal fresh-state checks and receipts."""
        live = self.snapshot()
        operations = [{"op": "fill", **field} for field in args["fields"]]
        if "submit" in args:
            operations.append({"op": "click", "target_id": args["submit"]})
        identities = {}
        identity_keys = ("name", "type", "source", "rect", "_runtime_id")
        # Validate the entire declared sequence before any input, including submit.
        for operation in operations:
            self.registry.validate({"action": "click", "observation_id": args["observation_id"],
                                    "target_id": operation["target_id"]}, live)
            target = next(t for t in live["targets"] if t["id"] == operation["target_id"])
            if operation["op"] == "fill" and (target["type"] != "Edit" or target["source"] != "uia"):
                raise ValueError("Every form field must be an observed UIA Edit")
            if operation["op"] == "click" and target["type"] not in ("Button", "TextRegion"):
                raise ValueError("submit requires an observed Button or OCR text target")
            identities[target["id"]] = {key: target.get(key) for key in identity_keys}
        result = {"op": "fill_form", "executed": False, "state": "planned", "batch_complete": False}
        if not self.execute:
            return result
        self.used_requests.add(request_id)
        started = time.monotonic()
        attempted = []
        try:
            for operation in operations:
                current = self.registry.latest
                if time.monotonic() - started > 20:
                    raise ValueError("Form batch time budget reached; remaining steps were not sent")
                if current["_handle"] != live["_handle"] or current["rect"] != live["rect"]:
                    raise ValueError("Window changed between form steps")
                target = next((t for t in current["targets"] if t["id"] == operation["target_id"]), None)
                if not target or any(target.get(k) != v for k, v in identities[operation["target_id"]].items()):
                    raise ValueError("Form target changed between steps; rediscovery is required")
                child = self.measured_call("/windows", {
                    **operation, "observation_id": current["observation_id"],
                    "session_id": self.registry.session_id, "request_id": uuid.uuid4().hex,
                })
                attempted.append({"op": operation["op"], "target_id": operation["target_id"],
                                  **{k: child[k] for k in ("state", "executed", "value_verified") if k in child}})
                result["executed"] |= child.get("executed") is True
                if child.get("state") != "input_sent" or child.get("observation_error"):
                    result.update(state="partial", completed_steps=len(attempted) - 1,
                                  error=child.get("error") or child.get("observation_error") or "Step failed",
                                  next="Stop. Earlier inputs may have happened; never replay the batch.")
                    return result
            result.update(state="input_sent", batch_complete=True,
                          filled=[f["target_id"] for f in args["fields"]],
                          observation=child["observation"])
            if "submit" in args:
                result["submitted"] = args["submit"]
            return result
        except (OSError, ValueError, RuntimeError) as error:
            result.update(state="partial", completed_steps=len(attempted), error=str(error),
                          next="Stop; do not replay any earlier field or click.")
            return result
        finally:
            with (self.folder / "windows-batches.jsonl").open("a", encoding="utf-8") as log:
                log.write(json.dumps({"request_id": request_id, "state": result["state"],
                                      "batch_complete": result["batch_complete"], "steps": attempted,
                                      "elapsed_ms": (time.monotonic() - started) * 1000}) + "\n")

    def poll(self, predicate):
        deadline = time.monotonic() + 3
        while True:
            try:
                value = self.snapshot()
                if predicate(value):
                    return value
            except ValueError:
                if time.monotonic() >= deadline:
                    raise
            if time.monotonic() >= deadline:
                raise ValueError("Expected window/control value was not observed")
            time.sleep(0.05)


class WindowsHandler(Handler):
    routes = (("GET", "/health"), ("POST", "/windows"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--allow-file", action="append", default=[])
    parser.add_argument("--file-app", help="Fixed application for allowed files; default uses association")
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--output-dir", type=Path, default=ROOT / ".runtime/windows-observer")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("Windows only")
    from comtypes import CoInitialize, CoUninitialize

    CoInitialize()
    server = HTTPServer(("127.0.0.1", 8093), WindowsHandler)
    server.api_key = (ROOT / ".runtime/windows-desktop-key").read_text().strip()
    server.observer = WindowsDesktop(args.title, args.output_dir, execute=args.execute,
                                     allowed_files=args.allow_file, file_app=args.file_app,
                                     use_ocr=args.ocr)
    try:
        print("Windows desktop companion ready; execute=" + str(args.execute), flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        CoUninitialize()


if __name__ == "__main__":
    main()
