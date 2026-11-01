#!/usr/bin/env python3
"""Generate the PWA icons as PNGs with no image library installed.

Draws a dark tile with a green `>_` prompt. Run from the repo root:
    python3 tools/generate-icons.py
"""

import struct
import zlib
from pathlib import Path

BACKGROUND = (11, 15, 20, 255)
ACCENT = (126, 231, 135, 255)
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "app" / "icons"


def blank(size):
    return [[BACKGROUND] * size for _ in range(size)]


def fill(pixels, x0, y0, x1, y1, color):
    size = len(pixels)
    for y in range(max(0, y0), min(size, y1)):
        row = pixels[y]
        for x in range(max(0, x0), min(size, x1)):
            row[x] = color


def stroke(pixels, start, end, thickness, color):
    (x0, y0), (x1, y1) = start, end
    steps = max(abs(x1 - x0), abs(y1 - y0))
    half = thickness // 2
    for step in range(steps + 1):
        x = x0 + (x1 - x0) * step // steps
        y = y0 + (y1 - y0) * step // steps
        fill(pixels, x - half, y - half, x + half, y + half, color)


def draw_prompt(size, scale):
    """Draw `>_` inside a 100x100 box occupying `scale` of the tile."""
    pixels = blank(size)
    unit = size * scale / 100
    offset = (size - int(100 * unit)) // 2

    def place(x, y):
        return offset + int(x * unit), offset + int(y * unit)

    thickness = max(4, int(11 * unit))
    stroke(pixels, place(18, 20), place(46, 50), thickness, ACCENT)
    stroke(pixels, place(46, 50), place(18, 80), thickness, ACCENT)
    fill(pixels, *place(54, 72), *place(84, 80), ACCENT)
    return pixels


def write_png(path, pixels):
    size = len(pixels)
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for red, green, blue, alpha in row:
            raw += bytes((red, green, blue, alpha))

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, 0.85),
        ("icon-512.png", 512, 0.85),
        ("icon-maskable-512.png", 512, 0.62),
    ]
    for name, size, scale in targets:
        path = OUTPUT_DIR / name
        write_png(path, draw_prompt(size, scale))
        print(f"wrote {path} ({size}x{size}, art scale {scale})")


if __name__ == "__main__":
    main()
