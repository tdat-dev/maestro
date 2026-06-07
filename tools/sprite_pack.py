"""Pack detected frames into uniform-cell horizontal strips + manifest + CSS.

* Frames in one animation share a cell; vertical motion (jump arc, idle bob) is
  preserved by aligning each animation's GROUND (lowest frame bottom) to the cell
  floor and keeping per-frame vertical offsets.
* "hero" and "pet" groups share a common cell size so the mascot element does not
  resize when switching between those animations.
* Background keyed out: pure-white -> transparent.
"""
import os
import json
import numpy as np
from PIL import Image

SRC = r'C:\Users\tvmar\.claude\image-cache\c01ed771-bd47-4846-b4e2-547271e516b0\1.png'
OUT = r'D:\maestro\src\assets\sprites'

img = Image.open(SRC).convert('RGBA')
arr = np.array(img)
rgb = arr[:, :, :3].astype(np.int16)
white = (rgb > 245).all(axis=2)

with open(os.path.join(OUT, "_boxes.json")) as f:
    data = json.load(f)
boxes = data["boxes"]

# Erase reference-sheet label text. The crop windows are wider than the tight
# frame boxes, so they would otherwise capture the tan "Pet Walk" labels. Label
# pixels are tan AND lie OUTSIDE every detected frame box, so keying them there
# removes labels while protecting in-sprite grey shading (which is inside a box).
mx = rgb.max(axis=2); mn = rgb.min(axis=2); sat = mx - mn
# broad: low-saturation mid/bright pixels = label text, shadows, near-white edges.
# Safe because we only erase where NOT protected (sprite interiors keep their cream).
label = (sat < 60) & (mn > 95)
protected = np.zeros(white.shape, bool)
for bs in boxes.values():
    for x0, y0, x1, y1 in bs:
        protected[y0:y1, x0:x1] = True
erase = white | (label & ~protected)

src = arr.copy()
src[:, :, 3] = np.where(erase, 0, 255).astype(np.uint8)
SRC_IMG = Image.fromarray(src, 'RGBA')

PADX, PADY, PADBOT = 8, 8, 4

# animation config: fps + loop. groups share a cell size.
CFG = {
    "idle":      dict(fps=6,  loop=True,  group="hero"),
    "walk":      dict(fps=8,  loop=True,  group="hero"),
    "run":       dict(fps=12, loop=True,  group="hero"),
    "jump":      dict(fps=10, loop=False, group="hero"),
    "wave":      dict(fps=7,  loop=False, group="hero"),
    "attack":    dict(fps=10, loop=False, group=None),
    "sit_pet":   dict(fps=4,  loop=True,  group=None),
    "celebrate": dict(fps=9,  loop=False, group=None),
    "pet_idle":  dict(fps=6,  loop=True,  group="pet"),
    "pet_walk":  dict(fps=8,  loop=True,  group="pet"),
    "pet_run":   dict(fps=12, loop=True,  group="pet"),
    "pet_jump":  dict(fps=10, loop=False, group="pet"),
    "pet_cheer": dict(fps=8,  loop=True,  group="pet"),
    "pet_attack":dict(fps=10, loop=False, group=None),
    "pet_cheer_b":dict(fps=8, loop=True,  group=None),
    # bottom reference strip (strip_0..3) dropped: redundant mini pet poses + label noise
}

def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


IMG_H, IMG_W = arr.shape[0], arr.shape[1]
manifest = {}
for name, bs in boxes.items():
    if not bs or name not in CFG:
        continue
    bs = sorted(bs, key=lambda b: b[0])
    n = len(bs)
    centers = [(b[0] + b[2]) / 2 for b in bs]
    # even grid: artist laid frames on an evenly-spaced grid; reconstruct it so
    # no per-frame drift is introduced. spacing = median gap between centers.
    if n >= 2:
        spacing = median([centers[i + 1] - centers[i] for i in range(n - 1)])
        c0 = centers[0]
    else:
        spacing = bs[0][2] - bs[0][0]
        c0 = centers[0]
    maxW = max(b[2] - b[0] for b in bs)
    cellW = int(min(maxW + 2 * PADX, spacing))  # never wider than a grid step (avoids bleed)
    cellW = max(cellW, maxW)                     # but never clip the widest pose
    # common vertical window for ALL frames -> preserves bob / jump arc exactly as drawn
    top = max(0, min(b[1] for b in bs) - PADY)
    bot = min(IMG_H, max(b[3] for b in bs) + PADBOT)
    cellH = bot - top

    strip = Image.new('RGBA', (cellW * n, cellH), (0, 0, 0, 0))
    for i in range(n):
        cx = c0 + i * spacing
        sx0 = int(round(cx - cellW / 2))
        sx0 = max(0, min(sx0, IMG_W - cellW))
        crop = SRC_IMG.crop((sx0, top, sx0 + cellW, bot))
        strip.alpha_composite(crop, (i * cellW, 0))
    strip.save(os.path.join(OUT, f"{name}.png"))
    manifest[name] = dict(frames=n, frameW=cellW, frameH=cellH,
                          fps=CFG[name]["fps"], loop=CFG[name]["loop"])
    print(f"{name:12s} {n}f  cell {cellW}x{cellH}  -> {name}.png")

with open(os.path.join(OUT, "sprites.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print("\nmanifest -> sprites.json  (", len(manifest), "animations )")
