#!/usr/bin/env python3
"""SessionForge brand icon generator.

Design language: "Forge Hex" — a hexagonal forge ring (cyan->violet gradient)
with a neural spark core (amber->white), on a deep-space rounded tile.
Renders procedurally at 1024px, downsamples to all ICO/PNG sizes.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "assets", "icons")
os.makedirs(OUT, exist_ok=True)

SIZE = 1024
CYAN = (34, 211, 238)
VIOLET = (167, 139, 250)
AMBER = (251, 191, 36)
WHITE_HOT = (255, 255, 255)
BG_TOP = (18, 26, 46)
BG_BOT = (8, 11, 22)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def hex_points(cx, cy, r, rot=-math.pi / 2):
    return [(cx + r * math.cos(rot + i * math.pi / 3), cy + r * math.sin(rot + i * math.pi / 3)) for i in range(6)]


def gradient_hex_ring(img, cx, cy, r, width):
    """Hex outline stroked segment-by-segment along a cyan->violet gradient."""
    pts = hex_points(cx, cy, r)
    d = ImageDraw.Draw(img)
    segs = []
    for i in range(6):
        a, b = pts[i], pts[(i + 1) % 6]
        steps = 24
        for s in range(steps):
            t0 = s / steps
            p0 = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
            p1 = (a[0] + (b[0] - a[0]) * (s + 1) / steps, a[1] + (b[1] - a[1]) * (s + 1) / steps)
            color = lerp(CYAN, VIOLET, ((i + t0) % 6) / 6)
            segs.append((p0, p1, color))
    for width_mult, blur in [(2.6, size_blur(SIZE)), (1.0, 0)]:
        if blur:
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            target = ld
        else:
            target = d
        for p0, p1, color in segs:
            target.line([p0, p1], fill=color + (230,), width=max(1, int(width * width_mult)))
        if blur:
            layer = layer.filter(ImageFilter.GaussianBlur(blur))
            img.alpha_composite(layer)
    return img


def size_blur(base):
    return max(2, int(base * 0.006))


def spark(img, cx, cy, s, core_color=AMBER, hot=WHITE_HOT):
    d = ImageDraw.Draw(img)
    pts = [
        (cx, cy - s),
        (cx + s * 0.20, cy - s * 0.20),
        (cx + s, cy),
        (cx + s * 0.20, cy + s * 0.20),
        (cx, cy + s),
        (cx - s * 0.20, cy + s * 0.20),
        (cx - s, cy),
        (cx - s * 0.20, cy - s * 0.20),
    ]
    halo = Image.new("RGBA", img.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.polygon(pts, fill=AMBER + (200,))
    halo = halo.filter(ImageFilter.GaussianBlur(s * 0.45))
    img.alpha_composite(halo)
    d.polygon(pts, fill=core_color + (255,))
    d.polygon([(p,) * 2 for p in []] or [(cx, cy - s * 0.38), (cx + s * 0.10, cy - s * 0.10), (cx + s * 0.38, cy), (cx + s * 0.10, cy + s * 0.10), (cx, cy + s * 0.38), (cx - s * 0.10, cy + s * 0.10), (cx - s * 0.38, cy), (cx - s * 0.10, cy - s * 0.10)], fill=hot)


def neural_dots(img, cx, cy, r, detail=True):
    if not detail:
        return
    d = ImageDraw.Draw(img)
    pts = hex_points(cx, cy, r)
    for i, p in enumerate(pts):
        q = pts[(i + 2) % 6]
        d.line([p, q], fill=VIOLET + (70,), width=int(SIZE * 0.002))
    for i, p in enumerate(pts):
        rr = SIZE * (0.012 if i % 2 == 0 else 0.009)
        col = CYAN if i % 2 == 0 else VIOLET
        d.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], fill=col + (220,))


def app_icon(detail=True):
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    grad = Image.new("RGBA", (SIZE, SIZE))
    gd = ImageDraw.Draw(grad)
    for y in range(SIZE):
        t = y / SIZE
        gd.line([(0, y), (SIZE, y)], fill=lerp(BG_TOP, BG_BOT, t) + (255,))
    mask = Image.new("L", (SIZE, SIZE), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.21), fill=255)
    img = Image.composite(grad, img, mask)

    edge = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ed = ImageDraw.Draw(edge)
    ed.rounded_rectangle([2, 2, SIZE - 3, SIZE - 3], radius=int(SIZE * 0.21), outline=CYAN + (90,), width=int(SIZE * 0.004))
    img.alpha_composite(edge)

    img = gradient_hex_ring(img, SIZE / 2, SIZE / 2, SIZE * 0.30, int(SIZE * 0.028))
    neural_dots(img, SIZE / 2, SIZE / 2, SIZE * 0.30, detail)
    spark(img, SIZE / 2, SIZE / 2, SIZE * 0.085)
    return img


def tray_icon(color, active=False):
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = hex_points(SIZE / 2, SIZE / 2, SIZE * 0.40)
    d.polygon(pts, outline=color + (255,), width=int(SIZE * 0.055))
    inner = hex_points(SIZE / 2, SIZE / 2, SIZE * 0.40 - SIZE * 0.075)
    d.polygon(inner, outline=color + (120,), width=int(SIZE * 0.02))
    if active:
        spark(img, SIZE / 2, SIZE / 2, SIZE * 0.11, core_color=WHITE_HOT)
    else:
        d.ellipse(
            [SIZE / 2 - SIZE * 0.09, SIZE / 2 - SIZE * 0.09, SIZE / 2 + SIZE * 0.09, SIZE / 2 + SIZE * 0.09],
            fill=color + (255,),
        )
    return img


def save_set(img, base_name, ico_sizes=((16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256))):
    imgs = {}
    for w, h in ico_sizes:
        im = img.resize((w, h), Image.LANCZOS)
        imgs[(w, h)] = im
        im.save(os.path.join(OUT, f"{base_name}_{w}.png"))
    imgs[(256, 256)].save(
        os.path.join(OUT, f"{base_name}.ico"),
        sizes=list(ico_sizes),
    )


app = app_icon(detail=True)
app.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "app_512.png"))
save_set(app, "app")
save_set(tray_icon(CYAN), "tray")
save_set(tray_icon(AMBER, active=True), "tray-active")

print("generated:", sorted(os.listdir(OUT)))
