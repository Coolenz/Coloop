"""Generate repository-native icon assets and a deterministic OCR test image."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
resources = root / "resources"
resources.mkdir(exist_ok=True)
image = Image.new("RGBA", (512, 512), (65, 105, 225, 255))
draw = ImageDraw.Draw(image)
# Two interlocking, open rings represent local and cloud cooperation.
draw.arc((92, 136, 324, 368), 65, 290, fill="white", width=39)
draw.arc((188, 136, 420, 368), 245, 470, fill="white", width=39)
draw.line((206, 188, 310, 188), fill="white", width=39)
draw.line((202, 316, 306, 316), fill="white", width=39)
image.save(resources / "icon.png")
image.save(resources / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
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
