"""Bake the night lights (NASA Black Marble) for loading once at start-up: no streaming.

Source: NASA GIBS, VIIRS_Black_Marble (2016 annual composite of the VIIRS Day/Night Band), Web
Mercator tiles. Public, no key. Zoom 6 finds the lit areas, zoom 8 (~600 m per texel) is downloaded
there, and every coarser page is built from the zoom-8 data (one source: no steps between zooms).

Outputs, in data/night/:
  pages/NNN.bc4.gz  Page atlas: every lit Web Mercator tile from zoom 2 to 8 as a 256 x 256 page,
                    64 pages per 2048 x 2048 layer, 5 mip levels, BC4-compressed (one channel, half
                    a byte per texel), gzip. The page app loads all layers into one texture array
                    (~580 MB on the GPU), and each ground tile reads the page of its own zoom
                    (capped at 8). Unlit tiles have no page and are simply dark.
  pages.json        Index: "z/x/y" -> page number, plus the atlas layout.
  blackmarble.png   8192 x 4096 equirectangular map (~4.9 km per texel) for the low-detail fallback
                    globe under the tiles.

All values are sRGB-encoded luminance of the city light alone. Black Marble draws its lights over a
dim, bluish base map of the Earth (brighter on ice and desert): the base map has red <= ~0.3 x blue
(linear), city light is neutral to warm, so light = the red left after the base map's share of the
blue. Ice, desert and relief drop out.

Usage: python tools/bake_night.py [--cache DIR]   (downloaded tiles are kept in DIR, default tilecache/bm)
"""
import argparse
import gzip
import io
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

URL = ('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/'
       'GoogleMapsCompatible_Level8/{z}/{y}/{x}.png')
T = 256                 # tile / page size
ZB, ZMAX = 6, 8         # base zoom (whole planet), top zoom (lit tiles only)
LAYER = 2048            # atlas layer size: 8 x 8 pages
PER_ROW = LAYER // T
LEVELS = 5              # mips 2048 .. 128 (pages are sampled near 1:1; deeper mips would mix pages)
BASE_RB = 0.35          # base map: red <= ~0.3 x blue (linear)
FLOOR = 0.004           # linear; residual base-map noise
GLOBAL_W, GLOBAL_H = 8192, 4096


def fetch(cache, z, x, y):
    path = os.path.join(cache, str(z), str(x), f'{y}.png')
    if os.path.exists(path):
        with open(path, 'rb') as f:
            return f.read()
    req = urllib.request.Request(URL.format(z=z, x=x, y=y), headers={'User-Agent': 'OpenWorld-bake/1.0'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as f:
                f.write(data)
            return data
        except Exception as e:  # noqa: BLE001 - retry any network error
            if attempt == 3:
                raise RuntimeError(f'tile {z}/{x}/{y}: {e}') from e
            time.sleep(1.5 * (attempt + 1))


def srgb_to_lin(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def lin_to_srgb8(v):
    v = np.clip(v, 0, 1)
    return np.round(np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055) * 255).astype(np.uint8)


def light_of(png_bytes):
    """Linear city-light luminance (float32) of one Black Marble tile."""
    rgb = srgb_to_lin(np.asarray(Image.open(io.BytesIO(png_bytes)).convert('RGB'), np.float32) / 255)
    return np.clip((rgb[..., 0] - BASE_RB * rgb[..., 2]) / (1 - BASE_RB) - FLOOR, 0, 1).astype(np.float32)


def half(lin):
    """2x box downsample in linear light."""
    h, w = lin.shape
    return lin.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))


def half_r(light):
    """2x downsample that conserves the rendered radiance. The shader draws light L as L^2, so
    coarser texels hold sqrt(mean(L^2)): a town keeps its brightness at every mip and page zoom
    (averaging L instead made small towns dim and flare as the zoom changed)."""
    h, w = light.shape
    return np.sqrt((light.astype(np.float32) ** 2).reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3)))


def bc4(img):
    """BC4 (RGTC1 unsigned) encode of a uint8 image with sides divisible by 4."""
    h, w = img.shape
    b = img.reshape(h // 4, 4, w // 4, 4).transpose(0, 2, 1, 3).reshape(-1, 16).astype(np.int32)
    lo, hi = b.min(1), b.max(1)
    rng = np.maximum(hi - lo, 1)
    q = np.clip(np.round((b - lo[:, None]) * 7.0 / rng[:, None]), 0, 7).astype(np.int64)
    # 8-value mode (r0 = max > r1 = min): index 0 = max, 1 = min, 2..7 = (6 max + min)/7 .. (max + 6 min)/7
    idx = np.where(q == 7, 0, np.where(q == 0, 1, 8 - q))
    idx[hi == lo] = 0
    bits = np.zeros(len(b), np.uint64)
    for i in range(16):
        bits |= idx[:, i].astype(np.uint64) << np.uint64(3 * i)
    out = np.zeros((len(b), 8), np.uint8)
    out[:, 0], out[:, 1] = hi, lo
    for k in range(6):
        out[:, 2 + k] = ((bits >> np.uint64(8 * k)) & np.uint64(0xFF)).astype(np.uint8)
    return out.tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join('tilecache', 'bm'))
    ap.add_argument('--out', default=os.path.join('data', 'night'))
    ap.add_argument('--global-only', action='store_true', help='only rebuild blackmarble.png')
    args = ap.parse_args()
    t0 = time.time()
    pool = ThreadPoolExecutor(8)   # polite to GIBS

    # 1. Zoom-6 mosaic of the whole planet (linear light, float32: 1 GB)
    nb = 2 ** ZB
    base = np.zeros((nb * T, nb * T), np.float32)
    for (x, y), lin in zip([(x, y) for y in range(nb) for x in range(nb)],
                           pool.map(lambda xy: light_of(fetch(args.cache, ZB, *xy)), [(x, y) for y in range(nb) for x in range(nb)])):
        base[y * T:(y + 1) * T, x * T:(x + 1) * T] = lin
    print(f'zoom {ZB} mosaic ({time.time() - t0:.0f} s)', flush=True)

    if args.global_only:
        return write_global(base, args.out, t0)

    # 2. Pages: zoom 8 downloaded where the mosaic shows light, every coarser zoom (7..2) built from
    #    its zoom-8 descendants with half_r. GIBS's own zoom-6 tiles are processed differently (25-40 %
    #    dimmer for sparse towns), so cutting coarse pages from them left brightness steps where a
    #    coarse ground tile met a fine one; built from the same data, every level matches.
    pages = {}
    n8, s = 2 ** ZMAX, 2 ** (ZMAX - ZB)
    lit6 = base.reshape(nb * T // (T // s), T // s, nb * T // (T // s), T // s).max(axis=(1, 3)) > 0
    want8 = [(int(x), int(y)) for y, x in zip(*np.nonzero(lit6))]
    print(f'downloading {len(want8)} zoom-{ZMAX} tiles', flush=True)
    done = 0
    for (x, y), lin in zip(want8, pool.map(lambda xy: light_of(fetch(args.cache, ZMAX, *xy)), want8)):
        if lin.max() > 0:
            pages[(ZMAX, x, y)] = lin.astype(np.float16)   # ~9000 pages: half precision keeps RAM ~1 GB
        done += 1
        if done % 500 == 0:
            print(f'  {done}/{len(want8)}  ({time.time() - t0:.0f} s)', flush=True)
    for zc in range(ZMAX - 1, 1, -1):
        for xc, yc in {(x >> 1, y >> 1) for (z, x, y) in pages if z == zc + 1}:
            quad = np.zeros((2 * T, 2 * T), np.float32)
            for dy in (0, 1):
                for dx in (0, 1):
                    p = pages.get((zc + 1, 2 * xc + dx, 2 * yc + dy))
                    if p is not None:
                        quad[dy * T:(dy + 1) * T, dx * T:(dx + 1) * T] = p
            pages[(zc, xc, yc)] = half_r(quad).astype(np.float16)

    # 3. Atlas: pages in (z, y, x) order, 64 per layer; 5 mips each, BC4 + gzip
    keys = sorted(pages, key=lambda k: (k[0], k[2], k[1]))
    n_layers = math.ceil(len(keys) / PER_ROW ** 2)
    os.makedirs(os.path.join(args.out, 'pages'), exist_ok=True)
    gpu = 0
    for L in range(n_layers):
        lin = np.zeros((LAYER, LAYER), np.float32)
        for i, k in enumerate(keys[L * PER_ROW ** 2:(L + 1) * PER_ROW ** 2]):
            cy, cx = divmod(i, PER_ROW)
            lin[cy * T:(cy + 1) * T, cx * T:(cx + 1) * T] = pages[k]
        blob = b''
        for _ in range(LEVELS):   # page borders fall on 2^8 boundaries: mips never mix pages
            enc = bc4(lin_to_srgb8(lin))
            blob += enc
            lin = half_r(lin)
        gpu += len(blob)
        with gzip.open(os.path.join(args.out, 'pages', f'{L:03d}.bc4.gz'), 'wb', compresslevel=9) as f:
            f.write(blob)
    index = {f'{z}/{x}/{y}': i for i, (z, x, y) in enumerate(keys)}
    with open(os.path.join(args.out, 'pages.json'), 'w') as f:
        json.dump({'pageSize': T, 'layerSize': LAYER, 'perRow': PER_ROW, 'levels': LEVELS, 'layers': n_layers,
                   'maxZoom': ZMAX, 'format': 'bc4', 'pages': index}, f, separators=(',', ':'))
    disk = sum(os.path.getsize(os.path.join(args.out, 'pages', f)) for f in os.listdir(os.path.join(args.out, 'pages')))
    counts = {z: sum(1 for k in keys if k[0] == z) for z in range(2, ZMAX + 1)}
    print(f'{len(keys)} pages {counts} in {n_layers} layers: {gpu / 1e6:.0f} MB on the GPU, '
          f'{disk / 1e6:.1f} MB on disk ({time.time() - t0:.0f} s)', flush=True)

    write_global(base, args.out, t0)


def write_global(base, out_dir, t0):
    # Low-detail equirectangular map for the fallback globe (rows area-averaged from Mercator)
    H = base.shape[0]
    max_lat = math.degrees(math.atan(math.sinh(math.pi)))
    cols = base.reshape(H, GLOBAL_W, base.shape[1] // GLOBAL_W).mean(2)

    def merc_y(lat):
        lat = max(-max_lat, min(max_lat, lat))
        y = (1 - math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) / math.pi) / 2 * H
        return min(max(y, 0.0), H)

    out = np.zeros((GLOBAL_H, GLOBAL_W), np.float32)
    for j in range(GLOBAL_H):
        y0, y1 = merc_y(90 - j * 180 / GLOBAL_H), merc_y(90 - (j + 1) * 180 / GLOBAL_H)
        i0, i1 = int(math.floor(y0)), int(math.ceil(y1))
        if i1 <= i0:
            continue
        w = np.ones(i1 - i0, np.float32)
        w[0] -= y0 - i0
        w[-1] -= i1 - y1
        if w.sum() > 1e-6:
            out[j] = (cols[i0:i1] * w[:, None]).sum(0) / w.sum()
    Image.fromarray(lin_to_srgb8(out), 'L').save(os.path.join(out_dir, 'blackmarble.png'), optimize=True)
    print(f'blackmarble.png {GLOBAL_W} x {GLOBAL_H} ({time.time() - t0:.0f} s)')


if __name__ == '__main__':
    sys.exit(main())
