"""OpenCode desktop tool: observations over SSH; actual inputs via board USB HID."""

import json
from pathlib import Path
import time
import urllib.error
import urllib.request
import uuid

from hid import HIDController, keyboard_report, text_reports


DESKTOP_TOOL = {
    "name": "desktop",
    "description": "observe the allowed PC window; act uses its observation_id. Default is a plan, not input.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": ["observe", "act"]},
            "observation_id": {"type": "string"},
            "action": {"type": "string", "enum": ["click", "hotkey", "type"]},
            "target_id": {"type": "integer"},
            "keys": {"type": "string"},
            "text": {"type": "string"},
        },
        "required": ["op"],
        "additionalProperties": False,
    },
}


class DesktopTools:
    def __init__(self, root):
        self.root = Path(root)

    def pc(self, path, body=None):
        try:
            key = (self.root / ".runtime/desktop-key").read_text().strip()
        except FileNotFoundError as error:
            raise RuntimeError("Start the Windows observation companion first") from error
        request = urllib.request.Request(
            "http://127.0.0.1:8091" + path,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            data=json.dumps(body).encode() if body is not None else None,
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode("utf-8", errors="replace")) from error
        except urllib.error.URLError as error:
            raise RuntimeError("PC companion unavailable; reconnect its USB SSH tunnel") from error

    def step(self, args):
        """Send one validated action and return its fresh observation without another LLM call."""
        if args.get("op") != "act":
            raise ValueError("step requires an act operation")
        action = self.call(args)
        result = {"action": action}
        if action.get("executed") is True:
            time.sleep(0.15)  # allow the target application's event loop to settle
            try:
                result["observation"] = self.call({"op": "observe"})
            except (OSError, RuntimeError, ValueError) as error:
                # The input already happened: retain that fact and never replay it.
                result["observation_error"] = str(error)
        return result

    def call(self, args):
        started = time.perf_counter()
        if args.get("op") == "observe":
            return self.pc("/observe")
        if args.get("op") != "act":
            raise ValueError("Unknown desktop operation")
        if not isinstance(args.get("observation_id"), str) or not args["observation_id"]:
            raise ValueError("act needs the latest observation_id")
        action = args.get("action")
        if action == "click":
            if type(args.get("target_id")) is not int:
                raise ValueError("click requires target_id from the observation")
        elif action == "hotkey":
            keyboard_report(args.get("keys"))
        elif action == "type":
            text_reports(args.get("text"))
        else:
            raise ValueError("Unsupported action")
        session_path = self.root / ".runtime/desktop-session.json"
        session = json.loads(session_path.read_text()) if session_path.exists() else {}
        execute = session.get("execute_hid") is True
        # A reservation is consumed before the first report: unknown outcomes are not retried.
        tick = time.perf_counter()
        validated = self.pc("/validate", {**args, "consume": execute})
        validation_ms = (time.perf_counter() - tick) * 1000
        if execute and session.get("session_id") != validated.get("session_id"):
            raise RuntimeError("Desktop session changed; reconnect before sending input")
        result = {
            "action_id": uuid.uuid4().hex[:12],
            "action": action,
            "observation_id": args["observation_id"],
            "executed": False,
            "state": "planned",
            "at": time.time(),
            "session_id": validated.get("session_id"),
            "validation_ms": validation_ms,
        }
        if execute:
            import fcntl

            with (self.root / ".runtime/hid.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                try:
                    tick = time.perf_counter()
                    HIDController().execute(args, validated)
                    result.update(state="input_sent", executed=True)
                except OSError:
                    result["state"] = "outcome_unknown"
                    raise
                finally:
                    result["hid_ms"] = (time.perf_counter() - tick) * 1000
                    result["elapsed_ms"] = (time.perf_counter() - started) * 1000
                    self.record(result)
        else:
            self.record(result)
        result["next"] = "observe again to verify the application result"
        # Measurement metadata stays in logs: timestamps with many digits are costly tokens.
        private = {"session_id", "validation_ms", "hid_ms", "elapsed_ms"}
        return {key: value for key, value in result.items() if key not in private}

    def record(self, result):
        folder = self.root / "logs"
        folder.mkdir(exist_ok=True)
        with (folder / "desktop-actions.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps(result) + "\n")
