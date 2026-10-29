"""Generate repository-native icon assets and a deterministic OCR test image."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
resources = root / "resources"
resources.mkdir(exist_ok=True)
# All logo rasters come from resources/brand.svg through the bundled Chromium renderer.
import subprocess
from PIL.PngImagePlugin import PngInfo
subprocess.run(["node", str(root / "scripts" / "render-brand.mjs")], cwd=root, check=True)
image = Image.open(resources / "icon.png").convert("RGBA")
metadata = PngInfo()
metadata.add_text("Source", "Coloop original vector: resources/brand.svg; rendered by scripts/render-brand.mjs")
image.save(resources / "icon.png", pnginfo=metadata)
image.save(resources / "icon.ico", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
preview = Image.open(resources / "logo-preview.png")
metadata = PngInfo()
metadata.add_text("Source", "Coloop original brand presentation: scripts/render-brand.mjs, resources/brand.svg")
preview.save(resources / "logo-preview.png", pnginfo=metadata)
fixtures = root / "tests" / "fixtures"
fixtures.mkdir(exist_ok=True)
image = Image.new("RGB", (1200, 460), "white")
draw = ImageDraw.Draw(image)
font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 48)
zh_font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 44)
draw.text((60, 50), "COLOOP DESKTOP WORKSPACE", font=font, fill="#202731")
draw.text((60, 145), "USB connected. Local OCR is ready.", font=font, fill="#202731")
draw.text((60, 245), "Order total: 128.50", font=font, fill="#202731")
draw.text((60, 335), "本地识别，连接智能工作。", font=zh_font, fill="#202731")
image.save(fixtures / "ocr-sample.png")
print("Icon and OCR fixture ready")
