"""Platform-independent stale-observation and one-use action checks."""

import time
import uuid
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from hid import POINTER_ACTIONS, mouse_report  # noqa: E402


class TargetIDs:
    """Keep visible target identities stable when OCR inserts or reorders other regions."""

    def __init__(self):
        self.previous = []
        self.next_id = 0

    def assign(self, targets):
        used = set()
        for target in targets:
            candidates = [
                old
                for old in self.previous
                if all(old.get(k) == target.get(k) for k in ("name", "type", "source"))
                and max(abs(a - b) for a, b in zip(old["rect"], target["rect"])) <= 8
            ]
            if len(candidates) == 1 and candidates[0]["id"] not in used:
                target["id"] = candidates[0]["id"]
            else:
                target["id"] = self.next_id
                self.next_id += 1
            used.add(target["id"])
        self.previous = [dict(t) for t in targets]
        return targets


class ObservationRegistry:
    def __init__(self, ttl=90):
        self.ttl = ttl
        self.session_id = uuid.uuid4().hex
        self.latest = None
        self.active = None

    def observe(self, snapshot):
        self.active = None
        self.latest = {
            **snapshot,
            "observation_id": uuid.uuid4().hex[:12],
            "session_id": self.session_id,
            "_at": time.monotonic(),
            "_consumed": False,
        }
        return {key: value for key, value in self.latest.items() if not key.startswith("_")}

    def validate(self, action, live):
        old = self.latest
        if not old or action.get("observation_id") != old["observation_id"]:
            raise ValueError("Observe again: unknown or replaced observation")
        if old["_consumed"] or time.monotonic() - old["_at"] > self.ttl:
            raise ValueError("Observe again: expired or already consumed")
        if old.get("window_open") is False or live.get("window_open") is False:
            raise ValueError("Target window is closed")
        if live["_handle"] != old["_handle"] or live["rect"] != old["rect"]:
            raise ValueError("Observe again: target window moved or changed")
        for key in ("screen", "dpi", "image_origin", "image_size", "_pid"):
            if old.get(key) != live.get(key):
                raise ValueError("Observe again: display mapping or process changed")
        result = {"valid": True, "session_id": self.session_id, "screen": live["screen"]}
        if action.get("action") in POINTER_ACTIONS:
            result["center"] = self.target_point(action, live, "target_id", "point")
            if action["action"] == "drag":
                result["end_center"] = self.target_point(action, live, "end_target_id", "end_point")
        elif action.get("action") in ("hotkey", "type"):
            if not live.get("_focus") or live["_focus"] != old.get("_focus"):
                raise ValueError("Observe again: keyboard focus changed")
            if action["action"] == "type" and live.get("_focus_type") != "Edit":
                raise ValueError("Type requires focus in an observed editable control")
        else:
            raise ValueError("Unknown action")
        if action.get("consume") is True:
            old["_consumed"] = True
            result["reservation"] = uuid.uuid4().hex
            self.active = {"token": result["reservation"], "action": action["action"],
                           "until": time.monotonic() + 12}
        return result

    def activate(self, body, live):
        """One narrow reservation for an exposed real non-client caption, not other inputs."""
        old = self.latest
        if (not old or old.get("_activation") is not True or old["_consumed"]
                or body.get("observation_id") != old["observation_id"]
                or time.monotonic() - old["_at"] > 10):
            raise ValueError("Observe the activation target again")
        for key in ("_handle", "_pid", "rect", "screen", "dpi", "activation_point"):
            if old.get(key) != live.get(key):
                raise ValueError("Activation window or mapping changed")
        if live.get("_caption") is not True or live.get("_point_occluded"):
            raise ValueError("Activation point is not an exposed caption")
        result = {"valid": True, "session_id": self.session_id, "screen": live["screen"],
                  "center": old["activation_point"]}
        mouse_report(*result["center"], result["screen"])
        if body.get("consume") is True:
            old["_consumed"] = True
            result["reservation"] = uuid.uuid4().hex
            self.active = {"token": result["reservation"], "action": "activate",
                           "until": time.monotonic() + 12}
        return result

    def target_point(self, action, live, id_key, point_key):
        old = self.latest
        if type(action.get(id_key)) is not int or action[id_key] < 0:
            raise ValueError("Pointer action requires observed target_id")
        candidates = [t for t in old["targets"] if t["id"] == action[id_key]]
        if len(candidates) != 1:
            raise ValueError("Unknown target_id")
        target = candidates[0]
        fields = ("name", "type", "rect", "source", "_runtime_id")
        matches = [t for t in live["targets"]
                   if all(t.get(k) == target.get(k) for k in fields) and t["enabled"]]
        if len(matches) != 1 or not target["enabled"]:
            raise ValueError("Observe again: target changed, disappeared or is ambiguous")
        if matches[0].get("_occluded"):
            raise ValueError("Target is covered by another window")
        rect = matches[0]["rect"]
        point = [(rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2]
        if point_key in action:
            origin, size = old.get("image_origin"), old.get("image_size")
            if not origin or not size:
                raise ValueError("Observation has no screenshot pixel mapping")
            px, py = action[point_key]
            if not 0 <= px < size[0] or not 0 <= py < size[1]:
                raise ValueError("Point outside screenshot")
            point = [origin[0] + px, origin[1] + py]
        for bounds in (rect, live["rect"]):
            if not bounds[0] <= point[0] < bounds[2] or not bounds[1] <= point[1] < bounds[3]:
                raise ValueError("Point outside observed target/window")
        mouse_report(*point, live["screen"])
        return point

    def guard(self, body, live):
        """Check an already consumed reservation; never grant a second execution."""
        old, active = self.latest, self.active
        if (not old or not active or body.get("reservation") != active["token"]
                or body.get("observation_id") != old["observation_id"]
                or time.monotonic() > active["until"]):
            raise ValueError("Input reservation ended; observe again")
        for key in ("_handle", "_pid", "rect", "screen", "dpi"):
            if old.get(key) != live.get(key):
                raise ValueError("Window or display changed during input")
        if active["action"] == "activate":
            if (live.get("_caption") is not True or live.get("_point_occluded")
                    or body.get("point") != old.get("activation_point")):
                raise ValueError("Activation must remain on the exposed authorized caption")
        if active["action"] in ("type", "hotkey") and live.get("_focus") != old.get("_focus"):
            raise ValueError("Keyboard focus changed during input")
        point = body.get("point")
        if active["action"] in POINTER_ACTIONS:
            if (not isinstance(point, list) or len(point) != 2
                    or any(type(n) is not int for n in point)):
                raise ValueError("Pointer guard needs physical pixel point")
            rect = old["rect"]
            mouse_report(*point, old["screen"])
            if not rect[0] <= point[0] < rect[2] or not rect[1] <= point[1] < rect[3]:
                raise ValueError("Pointer left allowed window")
            if live.get("_point_occluded"):
                raise ValueError("Pointer path covered by another window")
        return {"valid": True, "session_id": self.session_id}
