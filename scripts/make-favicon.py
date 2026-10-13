#!/usr/bin/env python3
"""Writes site/favicon.ico: a 32x32 PNG (a ring of sport colours around a
white core, the brand mark) in an ICO container. Standard library only; the
result is committed, so this runs only when the icon changes.

Usage: python3 scripts/make-favicon.py
"""
import math
import struct
import zlib
from pathlib import Path

SIZE = 32
COLOURS = ["#208a44", "#c55810", "#237cc9", "#d04189", "#9c710d", "#1282a5", "#dc3b49"]


def rgb(hex_colour):
    return tuple(int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))


def pixel(x, y):
    # 4x4 supersampling for smooth edges
    acc = [0.0, 0.0, 0.0, 0.0]
    for sx in range(4):
        for sy in range(4):
            px = x + (sx + 0.5) / 4 - SIZE / 2
            py = y + (sy + 0.5) / 4 - SIZE / 2
            r = math.hypot(px, py)
            if r > 15.2:
                continue
            if r < 5.6:
                c, a = (255, 255, 255), 1.0
            else:
                angle = (math.degrees(math.atan2(px, -py)) + 360) % 360
                c, a = rgb(COLOURS[int(angle / (360 / len(COLOURS)))]), 1.0
            acc[0] += c[0] * a
            acc[1] += c[1] * a
            acc[2] += c[2] * a
            acc[3] += a
    if acc[3] == 0:
        return (0, 0, 0, 0)
    return (round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(255 * acc[3] / 16))


def png():
    rows = b"".join(b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(SIZE)) for y in range(SIZE))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def ico(png_bytes):
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", SIZE, SIZE, 0, 0, 1, 32, len(png_bytes), 6 + 16)
    return header + entry + png_bytes


out = Path(__file__).resolve().parent.parent / "site" / "favicon.ico"
out.write_bytes(ico(png()))
print(f"wrote {out.name} ({out.stat().st_size} bytes)")
