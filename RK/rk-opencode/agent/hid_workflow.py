"""Board-local compact observations and verified HID form filling. No MCP or PC input."""

import json
import os
from pathlib import Path
import time

from desktop import DesktopTools, DESKTOP_TOOL
from hid import validate_action
from observation_view import ObservationView


HID_TOOL = {
    "name": "hid",
    "description": "Board-local USB HID with automatic compact/delta observation. Use latest observation_id. "
                   "fill_form replaces and verifies 1..4 UIA fields before optional submit. Stop on failure; "
                   "verify the application result from returned observation. No MCP required.",
    "inputSchema": {"oneOf": [
        {"type": "object", "properties": {"op": {"const": "observe"},
            "detail": {"type": "string", "enum": ["auto", "full"]}},
         "required": ["op"], "additionalProperties": False},
        {**DESKTOP_TOOL["inputSchema"], "properties": {
            **DESKTOP_TOOL["inputSchema"]["properties"], "op": {"const": "act"}},
         "required": ["op", "observation_id", "action"]},
        {"type": "object", "properties": {
            "op": {"const": "fill_form"}, "observation_id": {"type": "string", "minLength": 1},
            "fields": {"type": "array", "minItems": 1, "maxItems": 4, "items": {
                "type": "object", "properties": {
                    "target_id": {"type": "integer", "minimum": 0},
                    "text": {"type": "string", "maxLength": 64,
                             "description": "Literal single-line US-layout ASCII; empty clears"}},
                "required": ["target_id", "text"], "additionalProperties": False}},
            "submit_target_id": {"type": "integer", "minimum": 0}},
         "required": ["op", "observation_id", "fields"], "additionalProperties": False},
    ]},
}


class HIDWorkflow:
    """Persist full evidence between CLI calls; only model-facing output is projected."""

    def __init__(self, root, desktop=None):
        self.root = Path(root)
        self.desktop = desktop or DesktopTools(root)
        self.path = self.root / ".runtime/hid-view.json"

    def _load(self):
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}

    def _save(self, state):
        pending = self.path.with_suffix(".pending")
        with pending.open("w", encoding="utf-8") as output:
            os.chmod(pending, 0o600)
            json.dump(state, output, ensure_ascii=False)
        pending.replace(self.path)

    def _session(self):
        return json.loads((self.root / ".runtime/desktop-session.json").read_text(encoding="utf-8"))

    def snapshot(self):
        """Local full evidence for the Agent/verifier; never send it directly to the model."""
        with self.desktop.input_lock():
            state = self._load()
            observed = state.get("observation")
            if not observed or observed.get("session_id") != self._session().get("session_id"):
                raise RuntimeError("No observation for this desktop session")
            return observed

    @staticmethod
    def _target(observed, target_id):
        matches = [t for t in observed["targets"] if t["id"] == target_id]
        if len(matches) != 1 or matches[0].get("enabled") is not True:
            raise ValueError("Target disappeared, is disabled or ambiguous")
        return matches[0]

    @classmethod
    def _same(cls, before, after, target_id):
        old, new = cls._target(before, target_id), cls._target(after, target_id)
        keys = ("identity", "type", "name", "source", "rect")
        if any(old.get(k) != new.get(k) for k in keys):
            raise ValueError("Target identity changed during form filling")
        return new

    def call(self, request, *, reset=False, detail="auto"):
        if detail not in ("auto", "full"):
            raise ValueError("detail must be auto or full")
        if not isinstance(request, dict):
            raise ValueError("Expected request object")
        if request.get("op") == "observe" and "detail" in request:
            if detail != "auto" and detail != request["detail"]:
                raise ValueError("Conflicting observation detail")
            detail = request["detail"]
            if detail not in ("auto", "full"):
                raise ValueError("detail must be auto or full")
            request = {k: v for k, v in request.items() if k != "detail"}
        if reset and request != {"op": "observe"}:
            raise ValueError("reset is only allowed with a new observation")
        with self.desktop.input_lock():
            state = self._load()
            previous = state.get("observation", {})
            session = self._session()
            if session.get("stopped_at"):
                raise RuntimeError("Desktop session stopped")
            op = request.get("op")
            if op == "observe":
                if request != {"op": "observe"}:
                    raise ValueError("observe takes only op")
                observed = self.desktop.call(request)
                if reset or previous.get("session_id") != observed.get("session_id"):
                    state = {}
            else:
                if state.get("blocked"):
                    raise RuntimeError("Previous input failed or was interrupted; start a new task with --observe --reset-view")
                if (not previous or request.get("observation_id") != previous["observation_id"]
                        or previous.get("session_id") != session.get("session_id")):
                    raise ValueError("Observe again: missing/latest observation or session changed")
                if op == "fill_form":
                    self._preflight(request, previous)
                elif op == "act":
                    validate_action(request)
                else:
                    raise ValueError("Expected observe, act or fill_form")
                # Persist before input: a killed CLI cannot silently resume a partial transaction.
                state["blocked"] = True
                self._save(state)
                if op == "fill_form":
                    result, observed = self._fill(request, previous, session)
                else:
                    result = self.desktop.step(request)
                    observed = result.get("observation", previous)
                    result.pop("observation", None)
                    result["ok"] = "observation_error" not in result
                state["blocked"] = not result["ok"]
            view = ObservationView(state.get("view"))
            projected = view.project(observed, since=previous.get("observation_id"), detail=detail)
            state.update(observation=observed, view=view.previous)
            self._save(state)
            return projected if op == "observe" else {**result, "observation": projected}

    def _preflight(self, request, observed):
        allowed = {"op", "observation_id", "fields", "submit_target_id"}
        if set(request) - allowed:
            raise ValueError("Unknown fill_form field")
        fields = request.get("fields")
        if not isinstance(fields, list) or not 1 <= len(fields) <= 4:
            raise ValueError("fill_form requires 1..4 fields")
        ids = []
        if not observed.get("window_identity"):
            raise ValueError("Update the PC observer: window identity is required")
        for field in fields:
            if not isinstance(field, dict) or set(field) != {"target_id", "text"}:
                raise ValueError("Each field needs only target_id and text")
            target_id, text = field["target_id"], field["text"]
            if type(target_id) is not int or not isinstance(text, str) or len(text) > 64:
                raise ValueError("Fields need integer target_id and a string of 0..64 characters")
            if any(not 32 <= ord(char) <= 126 for char in text):
                raise ValueError("Form fields support single-line US-layout ASCII only")
            target = self._target(observed, target_id)
            if (target.get("type") != "Edit" or target.get("source") != "uia"
                    or not target.get("identity") or "value" not in target):
                raise ValueError("Form filling requires identifiable UIA Edit controls with value readback")
            ids.append(target_id)
        if "submit_target_id" in request:
            target_id = request["submit_target_id"]
            if type(target_id) is not int or self._target(observed, target_id).get("type") != "Button":
                raise ValueError("Submit must be an observed Button")
            ids.append(target_id)
        if len(set(ids)) != len(ids):
            raise ValueError("Duplicate form target")
        # Check every declared target live before the first report. Never perform a partial
        # batch merely because its later target/character was already invalid at entry.
        for target_id in ids:
            self.desktop.pc("/validate", {"op": "act", "action": "click",
                "observation_id": observed["observation_id"], "target_id": target_id, "consume": False})

    def _fill(self, request, original, session):
        observed = original
        result = {"ok": False, "state": "planned", "executed": False,
                  "verified_fields": [], "submitted": False, "actions_started": 0}
        if session.get("execute_hid") is not True:
            result["ok"] = True
            return result, observed
        deadline = time.monotonic() + 60

        def step(action, **fields):
            nonlocal observed
            if time.monotonic() > deadline:
                raise TimeoutError("Form time budget exhausted before next action")
            current = self._session()
            if (current.get("session_id") != session["session_id"]
                    or current.get("execute_hid") is not True or current.get("stopped_at")):
                raise RuntimeError("Desktop session changed or input stopped")
            result["actions_started"] += 1
            result["state"] = "outcome_unknown"
            value = self.desktop.step({"op": "act", "observation_id": observed["observation_id"],
                                       "action": action, **fields})
            result["executed"] |= value["action"].get("executed") is True
            if value["action"].get("executed") is not True or "observation" not in value:
                raise RuntimeError("Input or readback unconfirmed; no replay")
            observed = value["observation"]
            for key in ("session_id", "window_identity", "rect", "screen", "dpi"):
                if observed.get(key) != original.get(key):
                    raise RuntimeError("Window/session/display changed during form filling")

        try:
            for field in request["fields"]:
                target_id, text = field["target_id"], field["text"]
                self._same(original, observed, target_id)
                step("click", target_id=target_id)
                target = self._same(original, observed, target_id)
                if target.get("focused") is not True:
                    raise RuntimeError("Requested field did not receive focus")
                step("hotkey", keys="CTRL+A")
                if self._same(original, observed, target_id).get("focused") is not True:
                    raise RuntimeError("Focus changed before typing")
                step("type", text=text) if text else step("hotkey", keys="BACKSPACE")
                if self._same(original, observed, target_id).get("value") != text:
                    raise RuntimeError("Actual field value differs; stop without submit or replay")
                result["verified_fields"].append(target_id)
            # Recheck all fields together before submitting; dependent UI can change an earlier one.
            for field in request["fields"]:
                if self._same(original, observed, field["target_id"]).get("value") != field["text"]:
                    raise RuntimeError("An earlier verified field changed; submit cancelled")
            if "submit_target_id" in request:
                self._same(original, observed, request["submit_target_id"])
                step("click", target_id=request["submit_target_id"])
                result["submitted"] = True
            result.update(ok=True, state="fields_verified")
        except (OSError, RuntimeError, ValueError) as error:
            result.update(ok=False, error=str(error), state="stopped_partial_or_unknown")
        # submitted means the click was sent. The caller must verify the business result.
        return result, observed
