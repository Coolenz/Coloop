"""Generate repository-native icon assets and a deterministic OCR test image."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
resources = root / "resources"
resources.mkdir(exist_ok=True)
# Coloop mark: equal 28px radii, equal 10px stroke, fixed 128px grid.
scale = 8
image = Image.new("RGBA", (128*scale,128*scale),(0,0,0,0))
draw=ImageDraw.Draw(image)
draw.rounded_rectangle((0,0,128*scale,128*scale),radius=28*scale,fill="#5364db")
# Pillow draws arcs inside the bounding box; expand by half stroke to match SVG.
draw.arc(tuple(v*scale for v in (8,31,74,97)),45,315,fill="white",width=10*scale)
for x,y in [(60.97,44.2),(60.97,83.8)]:
    draw.ellipse(((x-5)*scale,(y-5)*scale,(x+5)*scale,(y+5)*scale),fill="white")
draw.ellipse(tuple(v*scale for v in (50,31,116,97)),outline="white",width=10*scale)
image=image.resize((512,512),Image.Resampling.LANCZOS)
image.save(resources/"icon.png")
image.save(resources/"icon.ico",sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
preview=Image.new("RGB",(1200,480),"#f7f8fa")
pd=ImageDraw.Draw(preview)
pd.rounded_rectangle((40,40,1160,440),radius=16,fill="white",outline="#e3e7ee",width=2)
mark=image.resize((144,144),Image.Resampling.LANCZOS)
preview.paste(mark,(110,168),mark)
pd.text((295,157),"Coloop",font=ImageFont.truetype("C:/Windows/Fonts/seguisb.ttf",88),fill="#252b37")
pd.text((300,272),"Desktop AI workspace",font=ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf",24),fill="#687387")
pd.line((800,100,800,380),fill="#e3e7ee",width=2)
for x,size in [(860,96),(1004,40)]:
    mark=image.resize((size,size),Image.Resampling.LANCZOS)
    preview.paste(mark,(x,240-size//2),mark)
preview.save(resources/"logo-preview.png")
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
