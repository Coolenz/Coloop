"""Local Windows OCR: physical-pixel boxes, UIA inspection and scoped text clicks.

Import ScreenOCR once in a long-running program to reuse ONNX sessions.
"""
import argparse
import ctypes
import json
from pathlib import Path
import statistics
import sys
import time

if sys.platform == "win32":
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

import cv2
import mss
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from rapidocr import ModelType, OCRVersion, RapidOCR

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "deployment/screen-ocr"
FONT = "C:/Windows/Fonts/msyh.ttc"


class ScreenOCR:
    def __init__(self, threads=4):
        self.engine = RapidOCR(params={
            "Global.use_cls": False,
            "Global.log_level": "error",
            "Global.font_path": FONT,
            "Global.max_side_len": 4096,
            "Det.ocr_version": OCRVersion.PPOCRV5,
            "Rec.ocr_version": OCRVersion.PPOCRV5,
            "Det.model_type": ModelType.MOBILE,
            "Rec.model_type": ModelType.MOBILE,
            "Det.model_path": str(RUNTIME / "models/ch_PP-OCRv5_det_mobile.onnx"),
            "Rec.model_path": str(RUNTIME / "models/ch_PP-OCRv5_rec_mobile.onnx"),
            "Det.limit_type": "max",
            "Det.limit_side_len": 1280,
            "EngineConfig.onnxruntime.intra_op_num_threads": threads,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        })

    def read(self, image, origin=(0, 0)):
        started = time.perf_counter()
        result = self.engine(image)
        elapsed = (time.perf_counter() - started) * 1000
        items = []
        if result.boxes is not None:
            for box, text, score in zip(result.boxes, result.txts, result.scores):
                points = np.asarray(box) + np.asarray(origin)
                left, top = points.min(axis=0)
                right, bottom = points.max(axis=0)
                items.append({"text": text, "confidence": round(float(score), 4),
                              "box": points.round(1).tolist(),
                              "rect": [round(float(x), 1) for x in (left, top, right, bottom)],
                              "center": [round(float(x), 1) for x in points.mean(axis=0)]})
        return {"elapsed_ms": round(elapsed, 2), "items": items}


def capture(monitor=1, region=None):
    with mss.MSS() as screen:
        if region:
            left, top, width, height = region
            target = {"left": left, "top": top, "width": width, "height": height}
        else:
            if not 0 <= monitor < len(screen.monitors):
                raise ValueError(f"monitor must be 0..{len(screen.monitors)-1}; 0 = virtual desktop")
            target = screen.monitors[monitor]
        if target["width"] <= 0 or target["height"] <= 0:
            raise ValueError("Capture region must have positive width and height")
        image = np.array(screen.grab(target))[:, :, :3].copy()
        return image, (target["left"], target["top"])


def find_window(title):
    from pywinauto import Desktop
    windows = [w for w in Desktop(backend="win32").windows() if w.window_text() == title]
    if len(windows) != 1:
        raise ValueError(f"Expected one visible window with exact title {title!r}; got {len(windows)}")
    return windows[0]


def window_region(window):
    r = window.rectangle()
    return [r.left, r.top, r.width(), r.height()]


def inspect_uia(title):
    from pywinauto import Desktop
    window = find_window(title)
    uia = Desktop(backend="uia").window(handle=window.handle).wrapper_object()
    items = []
    for control in uia.descendants():
        try:
            if not control.is_visible():
                continue
            r = control.rectangle()
            if r.width() <= 0 or r.height() <= 0:
                continue
            info = control.element_info
            items.append({"name": info.name, "type": info.control_type, "automation_id": info.automation_id,
                          "enabled": control.is_enabled(), "rect": [r.left, r.top, r.right, r.bottom],
                          "center": [(r.left + r.right) // 2, (r.top + r.bottom) // 2]})
        except Exception:
            continue  # A control may disappear while walking a live tree.
    return {"window": title, "handle": window.handle, "items": items}


def annotate(image, result, origin):
    canvas = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(FONT, 16)
    for index, item in enumerate(result["items"]):
        points = [(p[0] - origin[0], p[1] - origin[1]) for p in item["box"]]
        draw.line(points + [points[0]], fill="#ff2929", width=2)
        x, y = item["center"]
        x, y = x - origin[0], y - origin[1]
        draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill="#168bff")
        draw.text((points[0][0], max(0, points[0][1] - 19)), str(index), font=font, fill="#007acc")
    return canvas


def make_sample(path):
    canvas = Image.new("RGB", (1280, 720), "#eef2f7")
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(FONT, 30)
    draw.text((65, 55), "本地 OCR 桌面测试 Local Screen OCR", font=font, fill="#18222f")
    draw.text((65, 150), "用户名 Username", font=font, fill="#18222f")
    draw.rounded_rectangle((65, 205, 950, 270), radius=7, fill="white", outline="#8291a5", width=2)
    draw.text((85, 218), "测试用户 Test User 12345", font=font, fill="#18222f")
    draw.rounded_rectangle((65, 340, 300, 415), radius=8, fill="#1466d7")
    draw.text((95, 359), "开始测试", font=font, fill="white")
    draw.rounded_rectangle((365, 340, 600, 415), radius=8, fill="white", outline="#8291a5", width=2)
    draw.text((415, 359), "取消", font=font, fill="#18222f")
    draw.text((65, 500), "状态：等待操作 / Ready", font=font, fill="#18222f")
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, help="Recognize a file instead of the screen")
    parser.add_argument("--sample", action="store_true", help="Generate and recognize a Chinese/English sample")
    parser.add_argument("--monitor", type=int, default=1, help="1=primary, 0=all monitors")
    parser.add_argument("--region", type=int, nargs=4, metavar=("LEFT", "TOP", "WIDTH", "HEIGHT"))
    parser.add_argument("--window-title", help="Exact title; restrict capture/UIA/click to this window")
    parser.add_argument("--uia", action="store_true", help="Inspect named window's UI Automation tree")
    parser.add_argument("--find", help="Find an exact OCR text match")
    parser.add_argument("--click", action="store_true", help="Click one freshly recognized text target (requires --execute)")
    parser.add_argument("--keys", help="pywinauto key syntax, e.g. {ENTER}, ^a; requires a named foreground window")
    parser.add_argument("--execute", action="store_true", help="Actually deliver the requested click or keys")
    parser.add_argument("--delay", type=float, default=0, help="Seconds to switch to the target window before capture/input")
    parser.add_argument("--repeat", type=int, default=1, help="Repeat OCR on the same image; report warm latency")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--output", type=Path, default=RUNTIME / "results/latest")
    args = parser.parse_args()
    if args.repeat < 1 or args.threads < 1 or args.delay < 0:
        parser.error("repeat and threads must be positive; delay must be nonnegative")
    if args.uia and (not args.window_title or args.click):
        parser.error("--uia requires --window-title and cannot be combined with --click")
    if args.click and (not args.window_title or not args.find or args.image or args.sample or args.repeat != 1):
        parser.error("--click requires --window-title and --find, a live capture, and --repeat 1")
    if args.keys and (not args.window_title or args.click or args.image or args.sample or args.uia):
        parser.error("--keys requires --window-title and cannot combine with OCR/UIA actions")
    if args.execute and not (args.click or args.keys):
        parser.error("--execute requires --click or --keys")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.delay:
        print(f"Waiting {args.delay:g}s for target window...", flush=True)
        time.sleep(args.delay)
    if args.keys:
        window = find_window(args.window_title)
        result = {"window": args.window_title, "items": [], "action": {"type": "keys", "keys": args.keys, "executed": False}}
        if args.execute:
            import win32gui
            from pywinauto.keyboard import send_keys
            if win32gui.GetForegroundWindow() != window.handle:
                raise RuntimeError("Target must be foreground before key injection")
            send_keys(args.keys, pause=0.05)
            result["action"]["executed"] = True
    elif args.uia:
        result = inspect_uia(args.window_title)
    else:
        window = find_window(args.window_title) if args.window_title else None
        region = window_region(window) if window else args.region
        if args.sample:
            args.image = make_sample(RUNTIME / "results/sample.png")
        if args.image:
            image = cv2.imdecode(np.fromfile(args.image, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError(f"Could not read {args.image}")
            origin = (0, 0)
        else:
            image, origin = capture(args.monitor, region)
        engine = ScreenOCR(args.threads)
        runs = [engine.read(image, origin) for _ in range(args.repeat)]
        result = runs[-1]
        result.update({"source": str(args.image) if args.image else "screen", "origin": list(origin),
                       "coordinate_space": "image_pixels" if args.image else "physical_screen_pixels",
                       "image_size": [image.shape[1], image.shape[0]],
                       "first_call_ms": runs[0]["elapsed_ms"],
                       "warm_median_ms": statistics.median(r["elapsed_ms"] for r in runs[1:]) if len(runs) > 1 else None})
        if args.find:
            result["matches"] = [i for i in result["items"] if i["text"].strip() == args.find.strip()]
        if args.click:
            matches = result["matches"]
            if len(matches) != 1 or matches[0]["confidence"] < 0.8:
                raise ValueError("Click requires exactly one text match with confidence >= 0.8")
            result["action"] = {"type": "click", "center": matches[0]["center"], "executed": False}
            if args.execute:
                import win32gui
                from pywinauto import mouse
                if win32gui.GetForegroundWindow() != window.handle or window_region(window) != region:
                    raise RuntimeError("Target must remain foreground with unchanged window bounds")
                # Refuse a stale target if the immediate pixels around the text changed.
                x1, y1, x2, y2 = [int(v) for v in matches[0]["rect"]]
                fresh, _ = capture(region=[x1, y1, x2 - x1 + 1, y2 - y1 + 1])
                crop = image[y1-origin[1]:y2-origin[1]+1, x1-origin[0]:x2-origin[0]+1]
                if crop.shape != fresh.shape or np.mean(np.abs(crop.astype(float) - fresh.astype(float))) > 3:
                    raise RuntimeError("Target pixels changed; rescan before clicking")
                mouse.click(coords=tuple(round(v) for v in matches[0]["center"]))
                result["action"]["executed"] = True
        Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)).save(args.output.with_suffix(".png"))
        annotate(image, result, origin).save(args.output.with_name(args.output.name + "-marked.png"))
    args.output.with_suffix(".json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output.with_suffix(".json")), "count": len(result["items"]),
                      "first_call_ms": result.get("first_call_ms"), "warm_median_ms": result.get("warm_median_ms"),
                      "matches": result.get("matches"), "action": result.get("action")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
