"""Slice the hand-laid reference sheet into clean per-animation CSS sprite strips.

Detection:
  * content = non-white, tan-label colour removed.
  * column-HEIGHT mask separates tall frame columns from short label text.
  * gap detection finds frames; if the count is wrong for a known animation,
    fall back to an even split across the content extent, then tight-bbox each cell.
Packing:
  * every frame normalised into a uniform cell (bottom-centre anchored, transparent),
    packed left-to-right into one strip PNG per animation.
"""
import os
import json
import numpy as np
from PIL import Image, ImageDraw

SRC = r'C:\Users\tvmar\.claude\image-cache\c01ed771-bd47-4846-b4e2-547271e516b0\1.png'
OUT = r'D:\maestro\src\assets\sprites'
os.makedirs(OUT, exist_ok=True)

img = Image.open(SRC).convert('RGBA')
arr = np.array(img)
rgb = arr[:, :, :3].astype(np.int16)
H, W, _ = rgb.shape

white = (rgb > 245).all(axis=2)
R, G, B = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
mx = rgb.max(axis=2); mn = rgb.min(axis=2); sat = mx - mn
label = (R >= G - 5) & (G >= B - 5) & (mx > 140) & (mx < 225) & (sat < 55) & (mn > 110)
content = (~white) & (~label)
colh_full = content.sum(axis=0)  # not used; per-band below


def runs_of(on, gap, min_run):
    res = []; s = None; blank = 0
    n = len(on)
    for i in range(n):
        if on[i]:
            if s is None: s = i
            blank = 0
        else:
            if s is not None:
                blank += 1
                if blank > gap:
                    res.append((s, i - blank + 1)); s = None; blank = 0
    if s is not None:
        res.append((s, n - blank))
    return [(a, b) for a, b in res if b - a >= min_run]


def row_bands():
    rowsum = content.sum(axis=1)
    return runs_of(rowsum >= 3, gap=12, min_run=20)


def tight_bbox(x0, x1, y0, y1, min_pix=1):
    sub = content[y0:y1, x0:x1]
    cols = np.where(sub.sum(axis=0) >= min_pix)[0]
    rows = np.where(sub.sum(axis=1) >= min_pix)[0]
    if len(cols) == 0 or len(rows) == 0:
        return None
    return (x0 + cols[0], y0 + rows[0], x0 + cols[-1] + 1, y0 + rows[-1] + 1)


def detect(x0, x1, y0, y1, min_h, expected, even_split_h=40):
    """Return list of tight bboxes for frames in region."""
    colh = content[y0:y1, x0:x1].sum(axis=0)
    on = colh >= min_h
    rr = runs_of(on, gap=10, min_run=6)
    # drop runs with too little ink
    boxes = []
    for cs, ce in rr:
        bb = tight_bbox(x0 + cs, x0 + ce, y0, y1)
        if bb and content[bb[1]:bb[3], bb[0]:bb[2]].sum() >= 120:
            boxes.append(bb)
    if expected is None:
        return boxes
    if len(boxes) == expected:
        return boxes
    # even-split fallback across full content extent (use a low height to catch fx)
    on2 = colh >= even_split_h
    idx = np.where(on2)[0]
    if len(idx) == 0:
        return boxes
    cx0, cx1 = x0 + idx[0], x0 + idx[-1] + 1
    width = (cx1 - cx0) / expected
    out = []
    for k in range(expected):
        a = int(round(cx0 + k * width)); b = int(round(cx0 + (k + 1) * width))
        bb = tight_bbox(a, b, y0, y1)
        if bb is None:
            bb = (a, y0, b, y1)
        out.append(bb)
    return out


def split_human_pet(y0, y1):
    colh = content[y0:y1].sum(axis=0)
    on = colh >= 8
    lo, hi = int(W * 0.36), int(W * 0.74)
    best = None; s = None
    for x in range(lo, hi):
        if not on[x]:
            if s is None: s = x
        else:
            if s is not None:
                if best is None or (x - s) > (best[1] - best[0]): best = (s, x)
                s = None
    if s is not None and (best is None or (hi - s) > (best[1] - best[0])): best = (s, hi)
    return (best[0] + best[1]) // 2 if best else W // 2


# name + expected-frame-count hint (None = trust gap detection)
# (left_name, left_n), (right_name, right_n)
PLAN = [
    (("idle", 4), ("pet_idle", 4)),
    (("walk", 4), ("pet_walk", 4)),
    (("run", 4), ("pet_run", 4)),
    (("jump", 4), ("pet_jump", 4)),
    (("wave", 4), ("pet_cheer", 4)),
    (("attack", 4), ("pet_attack", 3)),
    (("sit_pet", 4), (None, None)),  # "Cuddle" is only a label for sit_pet frame 4
    (("celebrate", 5), ("pet_cheer_b", 3)),
]

bands = row_bands()
print("bands:", bands)

results = {}
order = []
for bi, (y0, y1) in enumerate(bands):
    if bi < len(PLAN):
        (lname, ln), (rname, rn) = PLAN[bi]
        split = split_human_pet(y0, y1)
        lb = detect(0, split, y0, y1, min_h=50, expected=ln)
        rb = detect(split, W, y0, y1, min_h=45, expected=rn)
        results[lname] = lb; order.append(lname)
        if rname:
            results[rname] = rb; order.append(rname)
    else:
        # bottom mini strip: 4 groups, detect groups by big gaps, gap-split each
        colh = content[y0:y1].sum(axis=0)
        groups = runs_of(colh >= 12, gap=28, min_run=20)
        gi = 0
        for gs, ge in groups:
            fb = detect(gs, ge, y0, y1, min_h=18, expected=None)
            name = f"strip_{gi}"
            results[name] = fb; order.append(name); gi += 1

def trim_to_main_run(box):
    """Drop a detached label sitting above a sprite: keep only the tallest
    vertical content run within the box's x-span."""
    x0, y0, x1, y1 = box
    sub = content[y0:y1, x0:x1]
    vr = runs_of(sub.sum(axis=1) >= 2, gap=6, min_run=4)
    if len(vr) <= 1:
        return box
    best = max(vr, key=lambda r: int(sub[r[0]:r[1]].sum()))
    return (x0, y0 + best[0], x1, y0 + best[1])


for name in list(results.keys()):
    results[name] = [trim_to_main_run(b) for b in results[name]]

# debug overlay
dbg = Image.new('RGBA', (W, H), (255, 255, 255, 255)); dbg.paste(img, (0, 0))
dd = ImageDraw.Draw(dbg)
for i, name in enumerate(order):
    col = (255, 0, 0, 255) if 'pet' not in name and 'cuddle' not in name and 'strip' not in name else (0, 120, 255, 255)
    print(f"{name:14s} {len(results[name])} frames")
    for (x0, y0, x1, y1) in results[name]:
        dd.rectangle([int(x0), int(y0), int(x1), int(y1)], outline=col, width=2)
dbg.save(os.path.join(OUT, "_debug_boxes.png"))

# save boxes (ints)
clean = {n: [[int(v) for v in b] for b in bs] for n, bs in results.items()}
with open(os.path.join(OUT, "_boxes.json"), "w") as f:
    json.dump({"order": order, "boxes": clean}, f, indent=1)
print("-> _debug_boxes.png, _boxes.json")
