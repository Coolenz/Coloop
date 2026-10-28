"""Generate repository-native icon assets and a deterministic OCR test image."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
resources = root / "resources"
resources.mkdir(exist_ok=True)
# The vector mark is in resources/brand.svg. Rasterize the same circular geometry
# at 8x resolution for clean Windows icons, including the coolen c/e openings.
import math
scale = 8
image = Image.new("RGBA", (128*scale, 128*scale), (0,0,0,0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0,0,128*scale,128*scale),radius=34*scale,fill="#5868e9")
def arc(box,start,end):
    draw.arc(tuple(v*scale for v in box),start,end,fill="white",width=9*scale)
def cap(x,y,r=4.5,color="white"):
    draw.ellipse(((x-r)*scale,(y-r)*scale,(x+r)*scale,(y+r)*scale),fill=color)
arc((21,39,71,89),45,315)
cap(63.68,46.32);cap(63.68,81.68)
arc((55,39,105,89),45,360)
draw.line((55*scale,64*scale,105*scale,64*scale),fill="white",width=9*scale)
cap(55,64);cap(105,64);cap(97.68,81.68)
cap(107,91,6,"#f5b17b")
image=image.resize((512,512),Image.Resampling.LANCZOS)
image.save(resources / "icon.png")
image.save(resources / "icon.ico", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
preview=Image.new("RGB",(1400,660),"#f7f8fc")
pd=ImageDraw.Draw(preview)
pd.rounded_rectangle((50,50,1350,610),radius=28,fill="white",outline="#e3e8f2",width=2)
preview.paste(image.resize((180,180),Image.Resampling.LANCZOS),(110,175),image.resize((180,180),Image.Resampling.LANCZOS))
brand_font=ImageFont.truetype("C:/Windows/Fonts/seguisb.ttf",104)
small_font=ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf",29)
pd.text((325,180),"coloop",font=brand_font,fill="#28334b")
pd.text((330,302),"by coolen",font=small_font,fill="#74819b")
pd.line((900,125,900,525),fill="#e5eaf3",width=2)
pd.text((980,143),"c + oo + e",font=ImageFont.truetype("C:/Windows/Fonts/seguisb.ttf",38),fill="#5868e9")
for offset,size in [(0,100),(140,64),(245,32)]:
    mark=image.resize((size,size),Image.Resampling.LANCZOS)
    preview.paste(mark,(975+offset,300+(100-size)//2),mark)
pd.text((978,455),"Input. Connect. Create.",font=ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf",20),fill="#73819b")
pd.text((110,495),"Personal AI workspace",font=small_font,fill="#73819b")
preview.save(resources / "logo-preview.png")
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
