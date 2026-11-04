from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pc"))
from observations import ObservationRegistry, TargetIDs


class ObservationTests(unittest.TestCase):
    def test_activation_is_one_use_and_guard_only_allows_unchanged_exposed_caption(self):
        registry = ObservationRegistry()
        live = {"window": "Lab", "targets": [], "_activation": True, "_handle": 1,
                "_pid": 2, "rect": [0, 0, 500, 500], "screen": [0, 0, 1920, 1080],
                "dpi": 96, "activation_point": [250, 18], "_caption": True,
                "_point_occluded": False}
        observed = registry.observe(live)
        request = {"observation_id": observed["observation_id"], "consume": True}
        token = registry.activate(request, live)["reservation"]
        body = {"observation_id": observed["observation_id"], "reservation": token,
                "point": [250, 18]}
        self.assertTrue(registry.guard(body, live)["valid"])
        for mutated in ({"_point_occluded": True}, {"_caption": False}, {"_pid": 3}, {"dpi": 120}):
            with self.assertRaises(ValueError):
                registry.guard(body, {**live, **mutated})
        with self.assertRaises(ValueError):
            registry.guard({**body, "point": [250, 100]}, live)
        with self.assertRaises(ValueError):
            registry.activate(request, live)

    def test_covered_caption_rejected_before_activation_reservation(self):
        registry = ObservationRegistry()
        live = {"_activation": True, "targets": [], "activation_point": [20, 20],
                "_caption": True, "_point_occluded": False}
        observed = registry.observe(live)
        with self.assertRaisesRegex(ValueError, "exposed caption"):
            registry.activate({"observation_id": observed["observation_id"], "consume": True},
                              {**live, "_point_occluded": True})
        self.assertIsNone(registry.active)

    def test_target_ids_survive_insertion_reordering_and_small_ocr_jitter(self):
        ids = TargetIDs()
        apply = {
            "name": "Apply",
            "type": "TextRegion",
            "source": "ocr",
            "rect": [100, 100, 150, 130],
        }
        code = {
            "name": "Code: 12345678",
            "type": "TextRegion",
            "source": "ocr",
            "rect": [10, 10, 90, 30],
        }
        first = ids.assign([dict(code), dict(apply)])
        old_id = first[1]["id"]
        second = ids.assign(
            [{**apply, "rect": [101, 99, 150, 131]}, {**code, "name": "12345678"}, dict(code)]
        )
        self.assertEqual(second[0]["id"], old_id)
        self.assertNotIn(second[1]["id"], {x["id"] for x in first})

    def test_disappeared_or_ambiguous_targets_do_not_reuse_identity(self):
        ids = TargetIDs()
        target = {"name": "Apply", "type": "TextRegion", "source": "ocr", "rect": [0, 0, 20, 20]}
        old_id = ids.assign([dict(target)])[0]["id"]
        ids.assign([])
        self.assertNotEqual(ids.assign([dict(target)])[0]["id"], old_id)
        ids.assign([dict(target), dict(target)])
        duplicate = ids.assign([dict(target), dict(target)])
        self.assertNotEqual(duplicate[0]["id"], duplicate[1]["id"])

    def test_closed_fixture_is_observable_but_never_actionable(self):
        registry = ObservationRegistry()
        closed = {"window": "Lab", "window_open": False, "targets": []}
        observation = registry.observe(closed)
        self.assertFalse(observation["window_open"])
        with self.assertRaisesRegex(ValueError, "closed"):
            registry.validate(
                {
                    "observation_id": observation["observation_id"],
                    "action": "hotkey",
                    "keys": "ALT+F4",
                },
                closed,
            )

    def snapshot(self):
        return {
            "window": "Lab",
            "rect": [0, 0, 500, 500],
            "screen": [0, 0, 1920, 1080],
            "_handle": 1,
            "_focus": "edit1",
            "_focus_type": "Edit",
            "targets": [
                {
                    "id": 0,
                    "name": "Save",
                    "type": "Button",
                    "rect": [10, 20, 110, 60],
                    "enabled": True,
                    "source": "uia",
                }
            ],
        }

    def test_claim_is_single_use_and_replaced_observations_rejected(self):
        registry = ObservationRegistry()
        observed = registry.observe(self.snapshot())
        action = {
            "observation_id": observed["observation_id"],
            "action": "click",
            "target_id": 0,
            "consume": True,
        }
        self.assertEqual(registry.validate(action, self.snapshot())["center"], [60, 40])
        with self.assertRaises(ValueError):
            registry.validate(action, self.snapshot())
        registry.observe(self.snapshot())
        with self.assertRaises(ValueError):
            registry.validate(action, self.snapshot())

    def test_window_change_focus_change_and_expiry_block_input(self):
        registry = ObservationRegistry(ttl=10)
        with patch("observations.time.monotonic", return_value=100):
            obs = registry.observe(self.snapshot())
        action = {"observation_id": obs["observation_id"], "action": "type", "text": "test"}
        with patch("observations.time.monotonic", return_value=101):
            for live in (
                {**self.snapshot(), "rect": [1, 0, 501, 500]},
                {**self.snapshot(), "_focus": "edit2"},
            ):
                with self.assertRaises(ValueError):
                    registry.validate(action, live)
        with patch("observations.time.monotonic", return_value=111):
            with self.assertRaises(ValueError):
                registry.validate(action, self.snapshot())

    def test_disabled_or_occluded_target_is_rejected(self):
        registry = ObservationRegistry()
        obs = registry.observe(self.snapshot())
        action = {"observation_id": obs["observation_id"], "action": "click", "target_id": 0}
        for changes in ({"enabled": False}, {"_occluded": True}):
            live = self.snapshot()
            live["targets"][0].update(changes)
            with self.assertRaises(ValueError):
                registry.validate(action, live)

    def test_pointer_variants_use_targets_and_screenshot_zero_maps_to_physical(self):
        registry = ObservationRegistry()
        snap = self.snapshot()
        snap.update(image_origin=[10, 20], image_size=[500, 500], dpi=144)
        obs = registry.observe(snap)
        for kind in ("move", "hover", "click", "double_click", "drag", "scroll"):
            action = {"action": kind, "observation_id": obs["observation_id"], "target_id": 0,
                      "point": [0, 0]}
            if kind == "drag":
                action.update(end_target_id=0, end_point=[99, 39])
            if kind == "scroll":
                action["steps"] = 1
            result = registry.validate(action, snap)
            self.assertEqual(result["center"], [10, 20])
            if kind == "drag":
                self.assertEqual(result["end_center"], [109, 59])
            with self.assertRaises(ValueError):
                registry.validate({**action, "point": [100, 40]}, snap)
        for change in ({"dpi": 96}, {"screen": [0, 0, 800, 600]}):
            with self.assertRaisesRegex(ValueError, "mapping"):
                registry.validate(action, {**snap, **change})

    def test_guard_requires_consumed_reservation_and_stops_on_replacement_or_expiry(self):
        registry = ObservationRegistry()
        snap = self.snapshot()
        obs = registry.observe(snap)
        action = {"action": "drag", "observation_id": obs["observation_id"], "target_id": 0,
                  "end_target_id": 0, "consume": True}
        result = registry.validate(action, snap)
        body = {"observation_id": obs["observation_id"], "reservation": result["reservation"],
                "point": [60, 40]}
        self.assertTrue(registry.guard(body, snap)["valid"])
        for change in ({"rect": [1, 0, 501, 500]}, {"_point_occluded": True}, {"_handle": 2}):
            with self.assertRaises(ValueError):
                registry.guard(body, {**snap, **change})
        with self.assertRaises(ValueError):
            registry.guard({**body, "point": [500, 40]}, snap)
        with self.assertRaises(ValueError):
            registry.guard({**body, "reservation": "wrong"}, snap)
        with patch("observations.time.monotonic", return_value=registry.active["until"] + 1):
            with self.assertRaisesRegex(ValueError, "ended"):
                registry.guard(body, snap)
        registry.observe(snap)
        with self.assertRaisesRegex(ValueError, "ended"):
            registry.guard(body, snap)

    def test_drag_destination_identity_and_keyboard_focus_are_checked(self):
        registry = ObservationRegistry()
        snap = self.snapshot()
        obs = registry.observe(snap)
        action = {"action": "drag", "observation_id": obs["observation_id"], "target_id": 0,
                  "end_target_id": 999}
        with self.assertRaisesRegex(ValueError, "target_id"):
            registry.validate(action, snap)
        action = {"action": "hotkey", "keys": "CTRL+A", "observation_id": obs["observation_id"],
                  "consume": True}
        result = registry.validate(action, snap)
        with self.assertRaisesRegex(ValueError, "focus"):
            registry.guard({"observation_id": obs["observation_id"],
                            "reservation": result["reservation"]}, {**snap, "_focus": "other"})


if __name__ == "__main__":
    unittest.main()
