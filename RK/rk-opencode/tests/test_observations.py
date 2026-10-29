from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pc"))
from observations import ObservationRegistry, TargetIDs


class ObservationTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
