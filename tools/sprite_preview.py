"""Generate a standalone preview.html (pure CSS steps()) from sprites.json.
Lives next to the PNGs so relative paths resolve when opened directly."""
import os, json

OUT = r'D:\maestro\src\assets\sprites'
man = json.load(open(os.path.join(OUT, "sprites.json")))

SCALE = 3
cards, kf = [], []
for name, m in man.items():
    w, h, n, fps = m["frameW"], m["frameH"], m["frames"], m["fps"]
    dur = round(n / fps, 3)
    kf.append(
        f"@keyframes kf-{name}{{from{{background-position-x:0}}"
        f"to{{background-position-x:-{w*n}px}}}}"
    )
    cards.append(f'''  <figure class="card">
    <div class="stage">
      <div class="spr" style="width:{w}px;height:{h}px;background-image:url('{name}.png');
        animation:kf-{name} {dur}s steps({n}) infinite;transform:scale({SCALE});"></div>
    </div>
    <figcaption>{name}<span>{n}f · {fps}fps · {w}×{h}</span></figcaption>
  </figure>''')

html = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Maestro mascot sprites</title>
<style>
  :root{{color-scheme:dark}}
  body{{margin:0;background:#15171c;color:#e6e8ee;
    font:14px/1.4 system-ui,Segoe UI,sans-serif;padding:28px}}
  h1{{font-size:18px;font-weight:600;margin:0 0 4px}}
  p.sub{{margin:0 0 24px;color:#8a90a0}}
  .grid{{display:grid;gap:18px;
    grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}}
  .card{{margin:0;background:#1e2128;border:1px solid #2b2f3a;border-radius:12px;
    padding:14px 10px 10px;display:flex;flex-direction:column;align-items:center;gap:10px}}
  .stage{{height:200px;width:100%;display:flex;align-items:flex-end;
    justify-content:center;
    background:
      linear-gradient(45deg,#272b34 25%,transparent 25%,transparent 75%,#272b34 75%) 0 0/16px 16px,
      linear-gradient(45deg,#272b34 25%,#1e2128 25%,#1e2128 75%,#272b34 75%) 8px 8px/16px 16px;
    border-radius:8px;overflow:hidden}}
  .spr{{image-rendering:pixelated;background-repeat:no-repeat;transform-origin:bottom center}}
  figcaption{{font-weight:600;text-align:center;display:flex;flex-direction:column}}
  figcaption span{{font-weight:400;color:#8a90a0;font-size:12px}}
  {''.join(kf)}
</style></head>
<body>
  <h1>Maestro mascot — pixel sprites</h1>
  <p class="sub">{len(man)} animations sliced from the reference sheet · CSS steps() preview · scaled {SCALE}×</p>
  <div class="grid">
{chr(10).join(cards)}
  </div>
</body></html>'''

with open(os.path.join(OUT, "preview.html"), "w", encoding="utf-8") as f:
    f.write(html)
print("-> preview.html (", len(man), "animations )")
