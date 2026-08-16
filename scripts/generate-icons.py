#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (243, 239, 230, 255))
    draw = ImageDraw.Draw(img)
    margin = max(1, size // 16)
    draw.rounded_rectangle(
        [margin, margin, size - margin - 1, size - margin - 1],
        radius=max(3, size // 5),
        fill=(255, 252, 246, 255),
        outline=(18, 94, 77, 255),
        width=max(1, size // 18),
    )
    slit_w = max(2, size // 9)
    slit_h = max(8, int(size * 0.46))
    x0 = (size - slit_w) // 2
    y0 = (size - slit_h) // 2
    draw.rounded_rectangle(
        [x0, y0, x0 + slit_w, y0 + slit_h],
        radius=slit_w // 2,
        fill=(18, 94, 77, 255),
    )
    return img

for size in (16, 32, 48, 128):
    path = OUT / f"icon-{size}.png"
    make_icon(size).save(path, "PNG")
    print(path)
