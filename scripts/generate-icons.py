#!/usr/bin/env python3
"""Render the app icons in packages/frontend/public from branding/mark.svg.

Needs rsvg-convert (librsvg) and Pillow. Run after changing the mark:

    python3 scripts/generate-icons.py
"""

from __future__ import annotations

import io
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "packages" / "frontend"
MARK = FRONTEND / "branding" / "mark.svg"
PUBLIC = FRONTEND / "public"

# Corner radius for icons shown as-is (favicon, PWA "any"): about the iOS curve.
CORNER = 224
# Maskable icons must keep content inside the central 80% circle.
MASKABLE_SCALE = 0.8


def body(svg: str) -> str:
    return re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)


def background(svg: str) -> str:
    return re.search(r'<rect width="1024" height="1024" fill="([^"]+)"/>', svg).group(1)


def rounded(svg: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        f'<clipPath id="c"><rect width="1024" height="1024" rx="{CORNER}"/></clipPath>'
        f'<g clip-path="url(#c)">{body(svg)}</g></svg>\n'
    )


def maskable(svg: str) -> str:
    offset = 512 * (1 - MASKABLE_SCALE)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
        f'<rect width="1024" height="1024" fill="{background(svg)}"/>'
        f'<g transform="translate({offset} {offset}) scale({MASKABLE_SCALE})">{body(svg)}</g></svg>\n'
    )


def png(svg: str, size: int, opaque: bool = False) -> bytes:
    out = subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), "-f", "png"],
        input=svg.encode(),
        capture_output=True,
        check=True,
    ).stdout
    if opaque:
        # iOS paints transparent pixels black; the touch icon must be opaque RGB.
        img = Image.open(io.BytesIO(out)).convert("RGB")
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        return buf.getvalue()
    return out


def main() -> int:
    if not shutil.which("rsvg-convert"):
        print("rsvg-convert not found (brew install librsvg / apt install librsvg2-bin)", file=sys.stderr)
        return 1
    mark = MARK.read_text()
    round_svg = rounded(mark)

    (PUBLIC / "favicon.svg").write_text(round_svg)
    (PUBLIC / "pwa-192x192.png").write_bytes(png(round_svg, 192))
    (PUBLIC / "pwa-512x512.png").write_bytes(png(round_svg, 512))
    (PUBLIC / "pwa-maskable-512x512.png").write_bytes(png(maskable(mark), 512, opaque=True))

    # Full-bleed and opaque: iOS applies its own mask. Safari also probes the
    # conventional root paths, so ship both names.
    touch = png(mark, 180, opaque=True)
    (PUBLIC / "apple-touch-icon.png").write_bytes(touch)
    (PUBLIC / "apple-touch-icon-precomposed.png").write_bytes(touch)

    ico = Image.open(io.BytesIO(png(round_svg, 48)))
    ico.save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    return 0


if __name__ == "__main__":
    sys.exit(main())
