"""Small, loss-marked model views over full UIA/OCR observations. No execution policy."""

import copy
import json


def size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


class ObservationView:
    """Keep a checked baseline; send full rows when a delta would be unsafe or larger."""

    def __init__(self, previous=None, max_bytes=4096):
        self.previous = previous
        self.max_bytes = max_bytes

    def project(self, observed, *, since=None, detail="auto"):
        targets = observed.get("targets", [])
        # A label repeated by its own named control adds no useful addressability.
        controls = {t.get("name") for t in targets if t.get("type") not in ("Text", "TextRegion")}
        controls.update(t["value"] for t in targets if t.get("type") == "Edit" and t.get("value"))
        kept = [t for t in targets if detail == "full" or (
            not t.get("chrome") and not (
                t.get("type") in ("Text", "TextRegion") and t.get("name") in controls
            )
        )]
        rows, omitted = [], len(targets) - len(kept)
        focus = next((t["id"] for t in targets if t.get("focused")), None)
        full = {"view": "full", "observation_id": observed["observation_id"],
                "window": observed.get("window"), "window_open": observed.get("window_open", True),
                "fields": ["id", "type", "name", "value"], "targets": rows, "focus": focus}
        # Prioritize inputs and buttons over static prose when a large OCR page exceeds the budget.
        kept.sort(key=lambda t: (t.get("type") in ("Text", "TextRegion"), t["id"]))
        incomplete = False
        disabled = []
        budget = 65536 if detail == "full" else self.max_bytes
        for target in kept:
            row = [target["id"], target.get("type", "Text"), target.get("name", "")]
            if "value" in target:
                row.append(target["value"])
            rows.append(row)
            if target.get("enabled") is False:
                disabled.append(target["id"])
            if size(full) + len(disabled) * 16 > budget:
                rows.pop()
                if target["id"] in disabled:
                    disabled.remove(target["id"])
                omitted += 1
                incomplete = True
        if disabled:
            full["disabled"] = disabled
        if omitted:
            full["omitted"] = omitted
        if incomplete:
            full["incomplete"] = True
            full["next"] = "Use observe with detail=full for omitted controls; absence is unproven."
        state = {"observation_id": observed["observation_id"], "window": observed.get("window"),
                 "window_open": observed.get("window_open", True), "rows": rows,
                 "focus": focus, "disabled": disabled, "omitted": omitted,
                 "incomplete": incomplete, "detail": detail,
                 "identity": observed.get("_window_identity", observed.get("window_identity"))}
        old = self.previous
        self.previous = copy.deepcopy(state)
        if (detail == "full" or not old or since != old.get("observation_id")
                or old.get("window") != state["window"] or old.get("incomplete") or incomplete
                or old.get("identity") != state["identity"]
                or old.get("detail") != detail):
            return full
        before = {r[0]: r for r in old["rows"]}
        after = {r[0]: r for r in rows}
        delta = {"view": "delta", "base": old["observation_id"],
                 "observation_id": state["observation_id"]}
        changed = [r for r in rows if before.get(r[0]) != r]
        removed = [key for key in before if key not in after]
        if changed:
            delta["set"] = changed
        if removed:
            delta["remove"] = removed
        for key in ("focus", "disabled", "window_open", "omitted"):
            if old.get(key) != state[key]:
                delta[key] = state[key]
        return delta if size(delta) < size(full) else full
