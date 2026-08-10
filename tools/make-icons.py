#!/usr/bin/env python3
"""Renders every icon candidate to its own file under tools/icon-assets/.

Nothing here overwrites another variant: each design gets a stable filename so
they can be compared side by side. Pass --use <name> to promote one to
packages/klipper/src/assets/icon.png, which is what the extension ships.

    python3 tools/make-icons.py
    python3 tools/make-icons.py --use icon-08-badge-braces-top.png

`tools/icon-assets/base-klipper.png` is the upstream dannymcgee.klipper icon
(MIT, (c) 2023 Danny McGee), used as the base for the badged variants.
"""
import os
import shutil
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGES = os.path.join(HERE, 'tools', 'icon-assets')
ACTIVE = os.path.join(HERE, 'packages', 'klipper', 'src', 'assets', 'icon.png')
SS = 4

# Klipper palette, sampled from the base icon.
BG    = (32, 34, 37, 255)
BLUE  = (89, 127, 165, 255)
RED   = (177, 47, 53, 255)
# Palette of the standalone brace mark.
BG2    = (32, 39, 51, 255)
ORANGE = (255, 122, 24, 255)
BAR    = (232, 237, 245, 255)

FONT = '/System/Library/Fonts/Avenir Next.ttc'


def canvas(size, fn):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    fn(ImageDraw.Draw(img), lambda v: int(round(v * SS)), S)
    return img.resize((size, size), Image.LANCZOS)


def bar(d, p, x0, x1, y, h, fill):
    r = h / 2.0
    d.rounded_rectangle([p(x0), p(y - r), p(x1), p(y + r)], radius=p(r), fill=fill)


def vpoly(d, p, top, vertex, inner, x0, x1, band):
    d.polygon([(p(x), p(y)) for x, y in [
        (x0, top), (128, vertex), (x1, top),
        (x1 - band, top), (128, inner), (x0 + band, top),
    ]], fill=BLUE)


def stroke(d, p, path, w, fill):
    pts = [(p(x), p(y)) for x, y in path]
    d.line(pts, fill=fill, width=p(w), joint='curve')
    r = p(w) / 2
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def cubic(a, b, c, e, n=60):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u**3*a[0] + 3*u*u*t*b[0] + 3*u*t*t*c[0] + t**3*e[0],
                    u**3*a[1] + 3*u*u*t*b[1] + 3*u*t*t*c[1] + t**3*e[1]))
    return out


# --------------------------------------------------------------------------
# 01 -- brace mark: Klipper's single-brace {expr} around indented config lines
# --------------------------------------------------------------------------
def braces(d, p, S):
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=p(58), fill=BG2)
    for notch, stem, tip in [(30, 48, 66), (226, 208, 190)]:
        y0, y1 = 58, 198
        ym = (y0 + y1) / 2
        half = ym - y0
        t, knee = half * .45, half * .18
        upper = cubic((tip, y0), (stem, y0), (stem, y0), (stem, y0 + t)) + \
                cubic((stem, y0 + t), (stem, ym - knee), (stem, ym), (notch, ym))
        lower = cubic((notch, ym), (stem, ym), (stem, ym + knee), (stem, y1 - t)) + \
                cubic((stem, y1 - t), (stem, y1), (stem, y1), (tip, y1))
        for path in (upper, lower):
            stroke(d, p, path, 11, ORANGE)
    for x0, x1, y in [(84, 172, 88), (100, 172, 114), (100, 158, 140), (84, 150, 166)]:
        bar(d, p, x0, x1, y, 13, BAR)


# --------------------------------------------------------------------------
# 02 -- V funnel over indented lines
# --------------------------------------------------------------------------
def v_bars(d, p, S):
    d.rectangle([0, 0, S, S], fill=BG)
    vpoly(d, p, 26, 122, 60, 26, 230, 47)
    stroke(d, p, [(101, 26), (128, 141), (155, 26)], 13, RED)
    stroke(d, p, [(128, 139), (128, 157)], 13, RED)
    bar(d, p, 44, 212, 180, 15, BLUE)
    bar(d, p, 76, 196, 206, 15, RED)
    bar(d, p, 76, 166, 232, 15, BLUE)


# --------------------------------------------------------------------------
# 03 -- same, with a thinner red V and a lighter bar group
# --------------------------------------------------------------------------
def v_bars_refined(d, p, S):
    d.rectangle([0, 0, S, S], fill=BG)
    vpoly(d, p, 22, 128, 86, 30, 226, 40)
    d.polygon([(p(x), p(y)) for x, y in [
        (99, 22), (128, 142), (157, 22), (148, 22), (128, 106), (108, 22)]], fill=RED)
    d.rounded_rectangle([p(123.5), p(134), p(132.5), p(159)], radius=p(4.5), fill=RED)
    bar(d, p, 40, 214, 182, 14, BLUE)
    bar(d, p, 74, 176, 208, 14, RED)
    bar(d, p, 74, 196, 234, 14, BLUE)


# --------------------------------------------------------------------------
# 04 -- bolder, full-bleed V so it survives 32px
# --------------------------------------------------------------------------
def v_bars_bold(d, p, S):
    d.rectangle([0, 0, S, S], fill=BG)
    vpoly(d, p, 18, 118, 74, 18, 238, 54)
    d.polygon([(p(x), p(y)) for x, y in [
        (98, 18), (128, 132), (158, 18), (147, 18), (128, 98), (109, 18)]], fill=RED)
    d.rounded_rectangle([p(122), p(124), p(134), p(150)], radius=p(6), fill=RED)
    bar(d, p, 34, 222, 172, 18, BLUE)
    bar(d, p, 72, 184, 200, 18, RED)
    bar(d, p, 72, 206, 228, 18, BLUE)


# --------------------------------------------------------------------------
# 05 -- V over a FORMAT wordmark, red initial echoing the base icon's red K
# --------------------------------------------------------------------------
def v_format(d, p, S):
    d.rectangle([0, 0, S, S], fill=BG)
    vpoly(d, p, 20, 120, 78, 22, 234, 50)
    d.polygon([(p(x), p(y)) for x, y in [
        (100, 20), (128, 134), (156, 20), (146, 20), (128, 100), (110, 20)]], fill=RED)
    d.rounded_rectangle([p(122), p(126), p(134), p(154)], radius=p(6), fill=RED)

    word, track, target = 'FORMAT', p(1.5), p(216)
    lo, hi, font = 10, 400, ImageFont.truetype(FONT, 10)
    while lo <= hi:
        mid = (lo + hi) // 2
        f = ImageFont.truetype(FONT, mid)
        if sum(f.getlength(c) for c in word) + track * (len(word) - 1) <= target:
            font, lo = f, mid + 1
        else:
            hi = mid - 1
    w = sum(font.getlength(c) for c in word) + track * (len(word) - 1)
    x = (S - w) / 2
    for i, ch in enumerate(word):
        d.text((x, p(216)), ch, font=font, fill=RED if i == 0 else BLUE, anchor='ls')
        x += font.getlength(ch) + track


# --------------------------------------------------------------------------
# Badged variants: the dannymcgee.klipper icon with a mark in the corner
# --------------------------------------------------------------------------
def rounded_mask(side, frac=5):
	mk = Image.new("L", (side * 4, side * 4), 0)
	ImageDraw.Draw(mk).rounded_rectangle(
		[0, 0, side * 4 - 1, side * 4 - 1], radius=side * 4 // frac, fill=255
	)
	return mk.resize((side, side), Image.LANCZOS)


def badge_onto(base, mark, frac=0.44, margin=6, ring=5, pos="br", plate=(18, 19, 21, 255)):
	"""Composites `mark` onto `base` as a corner or top-centre badge.

	`plate` is the colour painted behind the mark. A mark with a transparent
	background needs one, or the base shows through and the badge stops reading
	as a separate thing; pass None to overlay the mark directly.
	"""
	out = base.copy().convert("RGBA")
	W = out.size[0]
	b = int(W * frac)
	m = mark.resize((b, b), Image.LANCZOS)

	x = (W - b) // 2 if pos == "tc" else W - b - margin
	y = margin if pos == "tc" else W - b - margin

	if plate is not None:
		filled = Image.new("RGBA", (b, b), (0, 0, 0, 0))
		filled.paste(Image.new("RGBA", (b, b), plate), (0, 0), rounded_mask(b))
		filled.alpha_composite(m)
		m = filled

		# ring in the base's own ground colour, to separate badge from artwork
		rs = b + ring * 2
		r = Image.new("RGBA", (rs, rs), (0, 0, 0, 0))
		r.paste(Image.new("RGBA", (rs, rs), (18, 19, 21, 255)), (0, 0), rounded_mask(rs))
		out.alpha_composite(r, (x - ring, y - ring))
	else:
		m.putalpha(rounded_mask(b))

	out.alpha_composite(m, (x, y))
	return out


def main():
    base_path = os.path.join(IMAGES, 'base-klipper.png')
    variants = [
        ('icon-01-braces.png', canvas(256, braces)),
        ('icon-02-v-bars.png', canvas(256, v_bars)),
        ('icon-03-v-bars-refined.png', canvas(256, v_bars_refined)),
        ('icon-04-v-bars-bold.png', canvas(256, v_bars_bold)),
        ('icon-05-v-format.png', canvas(256, v_format)),
    ]
    if os.path.exists(base_path):
        base = Image.open(base_path).convert('RGBA')
        variants.append(("icon-06-badge-v-bars.png", badge_onto(base, canvas(256, v_bars))))
        variants.append(("icon-07-badge-braces.png", badge_onto(base, canvas(256, braces))))
        variants.append(
            ("icon-08-badge-braces-top.png", badge_onto(base, canvas(256, braces), pos="tc"))
        )

        # Hand-edited brace mark: transparent background, so it gets a white
        # plate -- its pale bars do not read against the dark base without one.
        edited_path = os.path.join(IMAGES, "icon-01-braces-edited.png")
        if os.path.exists(edited_path):
            edited = Image.open(edited_path).convert("RGBA")
            variants.append((
                "icon-09-badge-edited-white.png",
                badge_onto(base, edited, pos="tc", plate=(255, 255, 255, 255)),
            ))
            variants.append((
                "icon-10-badge-edited-clear.png",
                badge_onto(base, edited, pos="tc", plate=None),
            ))

    for name, img in variants:
        img.save(os.path.join(IMAGES, name), 'PNG')
        print('wrote tools/icon-assets/' + name)

    # contact sheet at 128 and 42 so small-size legibility is visible
    pad, big, small = 14, 128, 42
    sheet = Image.new('RGBA',
                      (pad + len(variants) * (big + pad), pad * 2 + big + small + 8),
                      (245, 246, 248, 255))
    x = pad
    for _, img in variants:
        sheet.paste(img.resize((big, big), Image.LANCZOS), (x, pad))
        sheet.paste(img.resize((small, small), Image.LANCZOS),
                    (x + (big - small) // 2, pad + big + 6))
        x += big + pad
    sheet.save(os.path.join(IMAGES, 'variants.png'), 'PNG')
    print('wrote tools/icon-assets/variants.png')

    if '--use' in sys.argv:
        pick = sys.argv[sys.argv.index('--use') + 1]
        src = os.path.join(IMAGES, pick)
        if not os.path.exists(src):
            raise SystemExit(f'no such variant: {pick}')
        shutil.copyfile(src, ACTIVE)
        print(f'active icon <- {pick}')


if __name__ == '__main__':
    main()
