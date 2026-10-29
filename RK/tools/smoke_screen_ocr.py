"""Check real OCR, offline inference, empty input and desktop coordinate mapping."""
import json
from unittest.mock import patch

import cv2
import numpy as np

from screen_ocr import RUNTIME, ScreenOCR, make_sample


def main():
    sample = make_sample(RUNTIME / "results/sample.png")
    image = cv2.imdecode(np.fromfile(sample, dtype=np.uint8), cv2.IMREAD_COLOR)
    with patch("requests.sessions.Session.request", side_effect=AssertionError("Inference tried to access network")):
        engine = ScreenOCR()
        result = engine.read(image, origin=(-1280, 120))
        start = next(i for i in result["items"] if i["text"] == "开始测试")
        cancel = next(i for i in result["items"] if i["text"] == "取消")
        assert -1215 <= start["center"][0] <= -980 and 460 <= start["center"][1] <= 535, start
        assert -915 <= cancel["center"][0] <= -680 and 460 <= cancel["center"][1] <= 535, cancel
        assert any("12345" in i["text"] for i in result["items"]), "Numbers/English not recognized"
        assert engine.read(np.full((200, 400, 3), 255, dtype=np.uint8))["items"] == []
    report = {"offline_inference": "passed", "chinese_english_numbers": "passed",
              "negative_monitor_origin_mapping": "passed", "empty_image": "passed",
              "sample_text_lines": len(result["items"])}
    target = RUNTIME / "smoke-report.json"
    target.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
