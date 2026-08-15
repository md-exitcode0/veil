#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw, PngImagePlugin
import random

out = Path(__file__).resolve().parents[1] / "tests" / "fixture"
out.mkdir(parents=True, exist_ok=True)

ai = Image.new("RGB", (384, 384), (18, 24, 48))
draw = ImageDraw.Draw(ai)
for i in range(14):
    draw.ellipse(
        [20 + i * 8, 30 + i * 6, 360 - i * 6, 350 - i * 8],
        outline=(80 + i * 10, 140, 255 - i * 8),
        width=3,
    )
info = PngImagePlugin.PngInfo()
info.add_text(
    "parameters",
    "a lighthouse on a cliff, cinematic lighting\nSteps: 30, Sampler: Euler, CFG scale: 7, Seed: 42, Model hash: abc123, stable diffusion",
)
ai.save(out / "ai.png", pnginfo=info)

rng = random.Random(7)
real = Image.new("RGB", (384, 384))
pixels = real.load()
for y in range(384):
    for x in range(384):
        n = rng.randint(0, 45)
        pixels[x, y] = (92 + n, 88 + n // 2, 74 + n // 3)
draw = ImageDraw.Draw(real)
draw.rectangle([40, 220, 340, 360], fill=(70, 78, 52))
draw.ellipse([120, 40, 250, 170], fill=(210, 198, 160))
real.save(out / "real.png")
print(out / "ai.png")
print(out / "real.png")
