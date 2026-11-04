"""Board-local desktop executor: observations over SSH; actual inputs via USB HID."""

from contextlib import contextmanager, nullcontext
import json
import os
import struct
from pathlib import Path
import time
import threading
import urllib.error
import urllib.request
import uuid

from hid import HIDController, HID_ACTIONS, POINTER_ACTIONS, hid_capabilities, validate_action


DESKTOP_TOOL = {
    "name": "desktop",
    "description": (
        "Observe allowed PC window; act uses latest observation_id. Pointer actions need target_id; "
        "drag also needs end_target_id. Optional point/end_point are screenshot pixels within those "
        "targets. scroll steps are signed detents (+up, -down), never pixels. type preserves literal "
        "US-layout ASCII. type uses text and hotkey uses keys, never target_id. "
        "Example hotkey: CTRL+SHIFT+END. Default is plan only."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": ["observe", "act", "capabilities"]},
            "observation_id": {"type": "string"},
            "action": {"type": "string", "enum": list(HID_ACTIONS)},
            "target_id": {"type": "integer"},
            "end_target_id": {"type": "integer"},
            "button": {"type": "string", "enum": ["left", "right", "middle"]},
            "steps": {"type": "integer"},
            "duration_ms": {"type": "integer"},
            "point": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
            "end_point": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
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
        self._input_mutex = threading.RLock()
        self._input_depth = 0
        self._input_pid = os.getpid()

    @contextmanager
    def input_lock(self):
        """One Linux advisory lock, reentrant only within this executor/thread/process."""
        import fcntl

        if os.getpid() != self._input_pid:
            raise RuntimeError("Create a fresh desktop executor after fork")
        if not self._input_mutex.acquire(blocking=False):
            raise BlockingIOError("Another thread owns this desktop executor")
        try:
            if self._input_depth:
                self._input_depth += 1
                try:
                    yield
                finally:
                    self._input_depth -= 1
            else:
                with (self.root / ".runtime/hid.lock").open("a") as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self._input_depth = 1
                    try:
                        yield
                    finally:
                        self._input_depth = 0
        finally:
            self._input_mutex.release()

    def pc(self, path, body=None, timeout=20):
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
            with urllib.request.urlopen(request, timeout=timeout) as response:
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

    def acquire_window(self):
        """RK alone clicks the authorized exposed caption, then checks actual foreground."""
        with self.input_lock():
            session = json.loads((self.root / ".runtime/desktop-session.json").read_text())
            if session.get("stopped_at"):
                raise RuntimeError("Desktop session stopped")
            observed = self.pc("/activation")
            if session.get("session_id") != observed.get("session_id"):
                raise RuntimeError("Activation session changed")
            if observed.get("foreground") is True:
                return {"state": "already_foreground", "executed": False}
            execute = session.get("execute_hid") is True
            validated = self.pc("/activate", {"observation_id": observed["observation_id"], "consume": execute})
            if validated.get("session_id") != session["session_id"]:
                raise RuntimeError("Activation session changed before input")
            result = {"action": "activate_window", "session_id": session["session_id"],
                      "observation_id": observed["observation_id"], "executed": False, "state": "planned"}
            if execute:
                action = {"op": "act", "action": "click", "target_id": 0,
                          "observation_id": observed["observation_id"]}
                result["state"] = "outcome_unknown"
                try:
                    HIDController().execute(action, validated, self.input_guard(action, validated))
                    result.update(executed=True, state="input_sent")
                    time.sleep(0.15)
                    if self.pc("/activation").get("foreground") is not True:
                        raise RuntimeError("RK caption click did not acquire foreground; no replay")
                    result["state"] = "foreground_verified"
                finally:
                    self.record(result)
            return result

    def call(self, args):
        started = time.perf_counter()
        if args.get("op") == "capabilities":
            if set(args) != {"op"}:
                raise ValueError("capabilities takes only op")
            return {**hid_capabilities(), "inputSchema": DESKTOP_TOOL["inputSchema"]}
        if args.get("op") == "observe":
            return self.pc("/observe")
        if args.get("op") != "act":
            raise ValueError("Unknown desktop operation")
        if not isinstance(args.get("observation_id"), str) or not args["observation_id"]:
            raise ValueError("act needs the latest observation_id")
        validate_action(args)
        session_path = self.root / ".runtime/desktop-session.json"
        session = json.loads(session_path.read_text()) if session_path.exists() else {}
        if session.get("stopped_at"):
            raise RuntimeError("Desktop session stopped; reconnect before input")
        with self.input_lock() if session.get("execute_hid") is True else nullcontext():
            return self._act(args, session, started)

    def _act(self, args, session, started):
        action = args["action"]
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
            with self.input_lock():
                try:
                    tick = time.perf_counter()
                    HIDController().execute(args, validated, self.input_guard(args, validated))
                    result.update(state="input_sent", executed=True)
                except BaseException:
                    # Interrupts can arrive after a report too. Record uncertainty,
                    # then propagate; never claim this action remained a mere plan.
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

    def input_guard(self, action, validated):
        def check(report):
            session = json.loads((self.root / ".runtime/desktop-session.json").read_text())
            if (session.get("execute_hid") is not True or session.get("stopped_at")
                    or session.get("session_id") != validated["session_id"]):
                raise RuntimeError("Desktop execution stopped or session changed")
            body = {"observation_id": action["observation_id"],
                    "reservation": validated["reservation"]}
            if action["action"] in POINTER_ACTIONS:
                _, x, y, _ = struct.unpack("<BHHb", report)
                left, top, width, height = validated["screen"]
                body["point"] = [left + round(x * (width - 1) / 32767),
                                 top + round(y * (height - 1) / 32767)]
            response = self.pc("/guard", body, timeout=1)
            if response.get("valid") is not True or response.get("session_id") != session["session_id"]:
                raise RuntimeError("PC rejected active input reservation")
        return check

    def record(self, result):
        folder = self.root / "logs"
        folder.mkdir(exist_ok=True)
        with (folder / "desktop-actions.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps(result) + "\n")
