"""JSON-lines adapter for the already-installed RK ScreenOCR environment.

Only image decoding and OCR are exposed. No mouse or keyboard actions.
Reuse one ScreenOCR instance to keep ONNX sessions warm.
"""
import base64
import contextlib
import json
from pathlib import Path
import sys

workspace = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(workspace / "tools"))
with contextlib.redirect_stdout(sys.stderr):
    import cv2
    import numpy as np
    import requests

    def offline(*_args, **_kwargs):
        raise RuntimeError("Coloop OCR is offline; network requests are disabled")

    requests.sessions.Session.request = offline
    from screen_ocr import ScreenOCR

engine = None
for line in sys.stdin:
    request_id = None
    try:
        if len(line) > 40_000_000:
            raise ValueError("Image request is too large")
        request = json.loads(line)
        request_id = request["id"]
        image = cv2.imdecode(np.frombuffer(base64.b64decode(request["image"], validate=True), dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Image cannot be decoded")
        with contextlib.redirect_stdout(sys.stderr):
            if engine is None:
                engine = ScreenOCR()
            result = engine.read(image)
        items = result["items"]
        confidence = sum(item["confidence"] for item in items) / len(items) * 100 if items else 0
        response = {"id": request_id, "ok": True, "result": {
            "text": "\n".join(item["text"] for item in items), "confidence": confidence,
            "durationMs": result["elapsed_ms"], "language": "chi_sim+eng", "items": items,
            "coordinateSpace": "image_pixels", "engine": "RapidOCR",
        }}
    except Exception as error:
        response = {"id": request_id, "ok": False, "error": str(error)}
    print(json.dumps(response, ensure_ascii=False), flush=True)
