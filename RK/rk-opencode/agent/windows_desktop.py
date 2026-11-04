"""Small RK-side client for the opt-in Windows software-input companion."""

import argparse
import copy
import json
import os
from pathlib import Path
import urllib.error
import urllib.request
import uuid


WINDOWS_TOOL = {
    "name": "desktop",
    "description": (
        "Windows desktop. open_file uses path; click uses target_id; fill replaces an Edit's "
        "text; fill_form fills fields and optionally clicks submit in one verified call; "
        "type appends; hotkey uses keys. "
        "Actions need observation_id and return a fresh observation."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": [
                "observe", "open_file", "click", "fill", "fill_form", "type", "hotkey",
            ]},
            "observation_id": {"type": "string"},
            "target_id": {"type": "integer"},
            "text": {"type": "string"},
            "keys": {"type": "string"},
            "path": {"type": "string"},
            "detail": {"type": "string", "enum": ["auto", "full"]},
            "fields": {"type": "array", "items": {
                "type": "object", "properties": {
                    "target_id": {"type": "integer"}, "text": {"type": "string"},
                }, "required": ["target_id", "text"], "additionalProperties": False,
            }},
            "submit": {"type": "integer"},
        },
        "required": ["op"],
        "additionalProperties": False,
    },
}


def validate_arguments(args):
    if not isinstance(args, dict):
        raise ValueError("Expected an object")
    fields = {
        "observe": set(), "open_file": {"path"}, "click": {"target_id"},
        "fill": {"target_id", "text"}, "type": {"text"}, "hotkey": {"keys"},
        "fill_form": {"fields"},
    }
    op = args.get("op")
    if not isinstance(op, str) or op not in fields:
        raise ValueError("Unknown Windows operation")
    needed = fields[op] | {"op"}
    if op not in ("observe", "open_file"):
        needed.add("observation_id")
    optional = {"detail"} if op == "observe" else {"submit"} if op == "fill_form" else set()
    if set(args) - optional != needed:
        raise ValueError("Use exactly the fields required by this operation")
    if "detail" in args and args["detail"] not in ("auto", "full"):
        raise ValueError("detail must be auto or full")
    if op == "fill_form":
        batch = args["fields"]
        if not isinstance(batch, list) or not 1 <= len(batch) <= 4:
            raise ValueError("fill_form requires 1..4 fields")
        ids = set()
        total = 0
        for field in batch:
            if not isinstance(field, dict) or set(field) != {"target_id", "text"}:
                raise ValueError("Each field requires target_id and literal text")
            validate_arguments({"op": "fill", "observation_id": args["observation_id"], **field})
            if field["target_id"] in ids:
                raise ValueError("Duplicate field target")
            ids.add(field["target_id"])
            total += len(field["text"].encode("utf-8"))
        if total > 4096:
            raise ValueError("Total field text exceeds the batch byte budget")
        if "submit" in args and (type(args["submit"]) is not int or args["submit"] < 0
                                 or args["submit"] in ids):
            raise ValueError("submit must be a separate observed Button ID")
    for key in needed - {"target_id", "fields"}:
        if not isinstance(args[key], str) or "\x00" in args[key]:
            raise ValueError(f"{key} must be a string without NUL")
    if "target_id" in needed and (type(args["target_id"]) is not int or args["target_id"] < 0):
        raise ValueError("target_id must be an observed integer")
    if "text" in needed:
        text = args["text"]
        if len(text) > 512 or any(ord(c) < 32 or ord(c) == 127 for c in text):
            raise ValueError("Use at most 512 characters of single-line literal text")
        text.encode("utf-16-le")  # Reject unpaired surrogates before any input.
        if op == "type" and not text:
            raise ValueError("type needs non-empty text; fill may clear an Edit")
    for key in ("path", "observation_id", "keys"):
        if key in needed and not args[key]:
            raise ValueError(f"{key} must not be empty")


class WindowsDesktopTools:
    def __init__(self, root, model_view=False):
        self.root = Path(root)
        self.turn = None
        self.failed = False
        self.model_view = model_view

    def call(self, args):
        validate_arguments(args)
        runtime = self.root / ".runtime"
        marker = runtime / "windows-desktop-turn"
        turn = marker.read_text(encoding="utf-8") if marker.exists() else "standalone"
        if turn != self.turn:
            self.turn, self.failed = turn, False
        if self.failed:
            raise RuntimeError("Previous Windows action failed; stop until a new user message")
        key = (runtime / "windows-desktop-key").read_text(encoding="utf-8").strip()
        session = json.loads((runtime / "windows-desktop-session.json").read_text(encoding="utf-8"))
        if session.get("stopped"):
            raise RuntimeError("Windows desktop companion has stopped")
        request = urllib.request.Request(
            "http://127.0.0.1:8093/windows",
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            data=json.dumps({
                **args, "session_id": session["session_id"], "request_id": uuid.uuid4().hex,
            }, ensure_ascii=False).encode("utf-8"),
        )
        try:
            with urllib.request.urlopen(request, timeout=90 if args["op"] == "fill_form" else 30) as response:
                value = json.load(response)
                if value.get("state") in ("outcome_unknown", "partial") or value.get("observation_error"):
                    self.failed = True
                if not self.model_view:
                    return value
                try:
                    return self.project(value, args, session, turn)
                except (OSError, ValueError, KeyError) as error:
                    self.failed = True
                    value["observation_error"] = "Model view failed; do not replay input: " + str(error)
                    return value
        except urllib.error.HTTPError as error:
            self.failed = True
            raise RuntimeError(error.read().decode("utf-8", errors="replace")) from error
        except (OSError, urllib.error.URLError) as error:
            self.failed = True
            raise RuntimeError(
                "Windows request failed; outcome may be unknown. Observe before further input; "
                "never automatically replay the action."
            ) from error

    def project(self, value, args, session, turn):
        from observation_view import ObservationView

        path = self.root / ".runtime/windows-desktop-view.json"
        previous = None
        if path.exists():
            packet = json.loads(path.read_text(encoding="utf-8"))
            if packet.get("session") == session["session_id"] and packet.get("turn") == turn:
                previous = packet.get("state")
        result = copy.deepcopy(value)
        observed = result if args["op"] == "observe" else result.get("observation")
        if not observed:
            return result
        view = ObservationView(previous)
        projected = view.project(observed, since=args.get("observation_id"),
                                 detail=args.get("detail", "auto"))
        pending = path.with_suffix(".pending")
        pending.write_text(json.dumps({"session": session["session_id"], "turn": turn,
                                       "state": view.previous}, ensure_ascii=False), encoding="utf-8")
        pending.replace(path)
        if args["op"] == "observe":
            return projected
        result["observation"] = projected
        result.pop("input_ms", None)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--observe", action="store_true")
    mode.add_argument("--context", action="store_true")
    args = parser.parse_args()
    root = Path(os.environ.get("RK_AGENT_ROOT", Path(__file__).resolve().parents[1]))
    if args.context:
        (root / ".runtime/windows-desktop-turn").write_text(uuid.uuid4().hex, encoding="utf-8")
        session = json.loads((root / ".runtime/windows-desktop-session.json").read_text(encoding="utf-8"))
        value = {k: session[k] for k in ("window", "execute", "allowed_files", "stopped")
                 if k in session}
        try:
            value["observation"] = WindowsDesktopTools(root, model_view=True).call({"op": "observe"})
        except RuntimeError as error:
            value["observation_unavailable_reason"] = str(error)
    else:
        value = WindowsDesktopTools(root).call({"op": "observe"})
    print(json.dumps(value, ensure_ascii=False))


if __name__ == "__main__":
    main()
