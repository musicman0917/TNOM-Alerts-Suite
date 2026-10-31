#!/usr/bin/env python3
"""Generates every icon asset the NOM Alerts Stream Deck plugin manifest
references: the plugin/category icons, and per-action list icons (mono
white-on-transparent) + key-face images (full color), at both @1x/@2x."""
import math
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "com.neighborhoodofmusic.nomalerts.sdPlugin", "imgs")
# DejaVu Sans Bold ships on most Linux distros; swap this path if rebuilding
# on Windows/Mac, or any bold sans-serif .ttf works just as well.
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

DARK_BG       = (24, 12, 4, 255)      # #180C04 — matches nom-alerts.html body
WOOD_BG       = (42, 21, 8, 255)      # #2A1508 — matches .panel gradient
PAUSED_BG     = (58, 16, 16, 255)     # dark red-brown for the paused state
BORDER        = (184, 120, 32, 180)   # #B87820 @ ~70%, matches var(--border)
AMBER         = (212, 168, 64, 255)   # #D4A840 — matches var(--amber)
GOLD_BRIGHT   = (232, 144, 16, 255)   # #E89010
CREAM         = (242, 228, 204, 255)  # #F2E4CC
RED           = (224, 48, 32, 255)    # #E03020 — matches panic danger color
WHITE         = (255, 255, 255, 255)
TRANSPARENT   = (0, 0, 0, 0)


def new_rgba(size):
    return Image.new("RGBA", (size, size), TRANSPARENT)


def rounded_bg(size, fill, border=None, radius_frac=0.18):
    img = new_rgba(size)
    d = ImageDraw.Draw(img)
    r = int(size * radius_frac)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=fill)
    if border:
        d.rounded_rectangle([1, 1, size - 2, size - 2], radius=r, outline=border, width=max(1, size // 48))
    return img


def centered_paste(base, glyph, scale=0.56):
    size = base.size[0]
    gsize = int(size * scale)
    glyph = glyph.resize((gsize, gsize), Image.LANCZOS)
    pos = ((size - gsize) // 2, (size - gsize) // 2)
    base.alpha_composite(glyph, pos)


# ── Glyph primitives (drawn at a fixed working resolution, then scaled) ────
GW = 200  # glyph working size


def glyph_canvas():
    return new_rgba(GW)


def g_triangle_right(color):
    img = glyph_canvas()
    d = ImageDraw.Draw(img)
    d.polygon([(50, 25), (50, 175), (175, 100)], fill=color)
    return img


def g_pause_bars(color):
    img = glyph_canvas()
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([45, 30, 85, 170], radius=12, fill=color)
    d.rounded_rectangle([115, 30, 155, 170], radius=12, fill=color)
    return img


def g_dot(color):
    img = glyph_canvas()
    d = ImageDraw.Draw(img)
    d.ellipse([35, 35, 165, 165], fill=color)
    return img


def g_lock(color):
    img = glyph_canvas()
    d = ImageDraw.Draw(img)
    # Shackle (arc)
    d.arc([55, 20, 145, 120], start=180, end=360, fill=color, width=16)
    # Body
    d.rounded_rectangle([35, 90, 165, 180], radius=14, fill=color)
    # Keyhole cut-out
    d.ellipse([88, 115, 112, 139], fill=TRANSPARENT)
    d.rectangle([94, 127, 106, 155], fill=TRANSPARENT)
    return img


def g_star(color):
    img = glyph_canvas()
    d = ImageDraw.Draw(img)
    cx, cy, r_out, r_in = 100, 100, 85, 34
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        r = r_out if i % 2 == 0 else r_in
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    d.polygon(pts, fill=color)
    return img


def g_reset_arrow(color):
    img = glyph_canvas()
    d = ImageDraw.Draw(img)
    d.arc([30, 30, 170, 170], start=35, end=320, fill=color, width=18)
    # Arrowhead at the start angle (~35deg on the circle)
    cx, cy, r = 100, 100, 70
    ang = math.radians(35)
    tip = (cx + r * math.cos(ang), cy + r * math.sin(ang))
    d.polygon([
        (tip[0] - 8, tip[1] - 30),
        (tip[0] + 32, tip[1] - 6),
        (tip[0] - 2, tip[1] + 24),
    ], fill=color)
    return img


def g_skip_next(color):
    img = glyph_canvas()
    d = ImageDraw.Draw(img)
    d.polygon([(30, 30), (30, 170), (105, 100)], fill=color)
    d.polygon([(95, 30), (95, 170), (170, 100)], fill=color)
    d.rounded_rectangle([170, 30, 182, 170], radius=4, fill=color)
    return img


def g_trash(color):
    img = glyph_canvas()
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([50, 35, 150, 50], radius=6, fill=color)  # lid
    d.rectangle([80, 20, 120, 38], fill=color)  # handle
    d.polygon([(45, 55), (155, 55), (142, 175), (58, 175)], fill=color)  # body
    for x in (78, 100, 122):
        d.rounded_rectangle([x - 5, 75, x + 5, 155], radius=4, fill=WOOD_BG)
    return img


def g_n_monogram(color):
    img = glyph_canvas()
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_BOLD, 150)
    bbox = d.textbbox((0, 0), "N", font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((GW - w) / 2 - bbox[0], (GW - h) / 2 - bbox[1]), "N", font=font, fill=color)
    return img


def save_pair(img_fn, base_path, size1x, scale2x=2):
    os.makedirs(os.path.dirname(base_path), exist_ok=True)
    img_fn(size1x).save(base_path + ".png")
    img_fn(size1x * scale2x).save(base_path + "@2x.png")


# ── Plugin + category icons ─────────────────────────────────────────────────
def plugin_icon(size):
    img = rounded_bg(size, WOOD_BG, border=BORDER, radius_frac=0.16)
    centered_paste(img, g_n_monogram(AMBER), scale=0.6)
    return img


def category_icon(size):
    img = new_rgba(size)
    centered_paste(img, g_n_monogram(WHITE), scale=0.92)
    return img


save_pair(plugin_icon, os.path.join(OUT, "plugin", "plugin-icon"), 256)
save_pair(category_icon, os.path.join(OUT, "plugin", "category-icon"), 28)
print("plugin + category icons done")

# ── Per-action assets ───────────────────────────────────────────────────────
ACTIONS = {
    "panic": None,  # handled specially (two states)
    "giveaway-start": (g_triangle_right, AMBER),
    "giveaway-close": (g_lock, AMBER),
    "giveaway-draw": (g_star, GOLD_BRIGHT),
    "giveaway-reset": (g_reset_arrow, AMBER),
    "karaoke-next": (g_skip_next, AMBER),
    "karaoke-clear": (g_trash, AMBER),
}

for name, spec in ACTIONS.items():
    if spec is None:
        continue
    glyph_fn, color = spec

    def list_icon(size, glyph_fn=glyph_fn):
        img = new_rgba(size)
        centered_paste(img, glyph_fn(WHITE), scale=0.85)
        return img

    def key_img(size, glyph_fn=glyph_fn, color=color):
        img = rounded_bg(size, WOOD_BG, border=BORDER, radius_frac=0.16)
        centered_paste(img, glyph_fn(color), scale=0.5)
        return img

    save_pair(list_icon, os.path.join(OUT, "actions", name, "icon"), 20)
    save_pair(key_img, os.path.join(OUT, "actions", name, "key"), 72)
    print(f"{name} done")

# ── Panic (two states: list icon + key-active + key-paused) ────────────────
def panic_list_icon(size):
    img = new_rgba(size)
    centered_paste(img, g_dot(WHITE), scale=0.85)
    return img


def panic_key_active(size):
    img = rounded_bg(size, WOOD_BG, border=BORDER, radius_frac=0.16)
    centered_paste(img, g_dot(AMBER), scale=0.34)
    return img


def panic_key_paused(size):
    img = rounded_bg(size, PAUSED_BG, border=(224, 48, 32, 200), radius_frac=0.16)
    centered_paste(img, g_pause_bars(RED), scale=0.5)
    return img


save_pair(panic_list_icon, os.path.join(OUT, "actions", "panic", "icon"), 20)
save_pair(panic_key_active, os.path.join(OUT, "actions", "panic", "key-active"), 72)
save_pair(panic_key_paused, os.path.join(OUT, "actions", "panic", "key-paused"), 72)
print("panic done")

print("ALL ICONS GENERATED")
