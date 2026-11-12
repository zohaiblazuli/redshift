"""Tile renders/*.png into a labelled contact sheet."""
import sys, os
from PIL import Image, ImageDraw, ImageFont
ORDER = ["cumulus_humilis", "cumulus_mediocris", "cumulus_congestus", "cumulonimbus",
         "stratocumulus", "stratus", "nimbostratus", "altocumulus",
         "altostratus", "cirrus", "cirrocumulus", "cirrostratus"]
d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "renders")
W, H, cols = 640, 360, 4
sheet = Image.new("RGB", (W * cols, H * 3), "black")
try:
    font = ImageFont.truetype("arialbd.ttf", 22)
except OSError:
    font = ImageFont.load_default()
for i, k in enumerate(ORDER):
    p = os.path.join(d, k + ".png")
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert("RGB").resize((W, H), Image.LANCZOS)
    x, y = (i % cols) * W, (i // cols) * H
    sheet.paste(im, (x, y))
    dr = ImageDraw.Draw(sheet)
    dr.rectangle((x, y + H - 34, x + W, y + H), fill=(0, 0, 0))
    dr.text((x + 10, y + H - 30), k.replace("_", " ").title(), fill="white", font=font)
sheet.save(os.path.join(d, "contact_sheet.jpg"), quality=90)
print("ok")
