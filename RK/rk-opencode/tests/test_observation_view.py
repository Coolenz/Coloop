import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
from observation_view import ObservationView, size  # noqa: E402


class ObservationViewTests(unittest.TestCase):
    def observation(self, token="first"):
        return {"observation_id": token, "window": "Test", "window_open": True,
                "targets": [
                    {"id": 1, "type": "Edit", "name": "Amount", "value": "00123.4500", "focused": True},
                    {"id": 2, "type": "Text", "name": "Amount"},
                    {"id": 3, "type": "Button", "name": "Apply"},
                    {"id": 4, "type": "TextRegion", "name": "Code: 01234567"},
                    {"id": 5, "type": "Button", "name": "Close", "chrome": True},
                ]}

    def test_full_filters_duplicates_and_chrome_but_keeps_ocr_status_and_numeric_literals(self):
        source = self.observation()
        before = copy.deepcopy(source)
        full = ObservationView().project(source)
        self.assertEqual({r[0] for r in full["targets"]}, {1, 3, 4})
        self.assertIn([1, "Edit", "Amount", "00123.4500"], full["targets"])
        self.assertEqual(source, before)  # The complete execution snapshot must remain untouched.
        self.assertEqual(full["omitted"], 2)

    def test_delta_round_trip_including_removal_focus_and_disabled_state(self):
        view = ObservationView()
        first = view.project(self.observation())
        second = self.observation("second")
        second["targets"][0].update(value="-00123.4500", focused=False)
        second["targets"][2].update(focused=True, enabled=False)
        second["targets"] = [t for t in second["targets"] if t["id"] != 4]
        delta = view.project(second, since="first")
        self.assertEqual(delta["view"], "delta")
        reconstructed = {r[0]: r for r in first["targets"]}
        for key in delta.get("remove", []):
            reconstructed.pop(key)
        for row in delta.get("set", []):
            reconstructed[row[0]] = row
        full = ObservationView().project(second)
        self.assertEqual(reconstructed, {r[0]: r for r in full["targets"]})
        self.assertEqual(delta["focus"], 3)
        self.assertEqual(delta["disabled"], [3])
        self.assertLess(size(delta), size(full))

    def test_wrong_baseline_or_window_change_forces_full(self):
        view = ObservationView()
        view.project(self.observation())
        self.assertEqual(view.project(self.observation("next"), since="old")["view"], "full")
        changed = self.observation("third")
        changed["window"] = "Other"
        self.assertEqual(view.project(changed, since="next")["view"], "full")
        replaced = copy.deepcopy(changed)
        replaced.update(observation_id="fourth", _window_identity=[99, 199])
        self.assertEqual(view.project(replaced, since="third")["view"], "full")

    def test_explicit_full_restores_filtered_controls(self):
        full = ObservationView().project(self.observation(), detail="full")
        self.assertEqual({r[0] for r in full["targets"]}, {1, 2, 3, 4, 5})

    def test_budget_marks_partial_and_never_uses_partial_as_delta_baseline(self):
        view = ObservationView(max_bytes=220)
        source = self.observation()
        source["targets"][0]["value"] = "中文" * 200
        first = view.project(source)
        self.assertTrue(first["incomplete"])
        second = view.project(self.observation("second"), since="first")
        self.assertEqual(second["view"], "full")
        complete = view.project(source, detail="full")
        self.assertNotIn("incomplete", complete)


if __name__ == "__main__":
    unittest.main()
