"""Platform-independent stale-observation and one-use action checks."""

import time
import uuid


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

    def observe(self, snapshot):
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
        result = {"valid": True, "session_id": self.session_id, "screen": live["screen"]}
        if action.get("action") == "click":
            candidates = [x for x in old["targets"] if x["id"] == action.get("target_id")]
            if len(candidates) != 1:
                raise ValueError("Unknown target_id")
            target = candidates[0]
            fields = ("name", "type", "rect", "source")
            matches = [
                x
                for x in live["targets"]
                if all(x[k] == target[k] for k in fields) and x["enabled"]
            ]
            if len(matches) != 1 or not target["enabled"]:
                raise ValueError("Observe again: target changed, disappeared or is ambiguous")
            if matches[0].get("_occluded"):
                raise ValueError("Target is covered by another window")
            rect = matches[0]["rect"]
            result["center"] = [(rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2]
        elif action.get("action") in ("hotkey", "type"):
            if not live.get("_focus") or live["_focus"] != old.get("_focus"):
                raise ValueError("Observe again: keyboard focus changed")
            if action["action"] == "type" and live.get("_focus_type") != "Edit":
                raise ValueError("Type requires focus in an observed editable control")
        else:
            raise ValueError("Unknown action")
        if action.get("consume") is True:
            old["_consumed"] = True
        return result
