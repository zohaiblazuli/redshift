"""Bake data/lights/ from the cached NASA GIBS Black Marble 2016 tiles (tilecache/bm), no download.

The quick alternative to tools/bake_lights.py (which needs ~53 GB of VNP46A4 source files). Same
output format, so the client is unchanged:
  <z>/<x>/<y>.png   256 x 256 RGB8, radiance x 10 as uint16 (R high byte, G low byte), zoom 0..8
  index.json        every written tile

Black Marble 2016 tiles are display imagery (tone-mapped city light over a dim bluish base map), not
radiance. Per pixel: light = linear red minus the base map's share of the blue (as bake_night.py),
then a monotone colour -> radiance curve fitted by quantile matching against a real VNP46A4 2025
bake of one zoom-4 block (--calib, the old test bake), so brightness lands near the measured scale.
Coarser zooms are 2 x 2 means of radiance, as in bake_lights.py.

Usage: python tools/bake_lights_bm.py [--cache tilecache/bm] [--calib DIR] [--out data/lights]
"""
import argparse
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

T = 256
Z = 8                  # finest cached Black Marble zoom
BASE_RB = 0.35         # base map: red <= ~0.3 x blue (linear)
FLOOR = 0.004          # residual base-map noise (linear)
MIN_RAD = 1.0          # tiles darker than this everywhere are not written
BINS = 1024
LOW_L0, LOW_POW = 0.15, 1.5   # below light L0 the curve falls off as (L / L0)^LOW_POW (no haze pools)


def srgb_to_lin(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def light_of(path):
    rgb = srgb_to_lin(np.asarray(Image.open(path).convert('RGB'), np.float32) / 255)
    return np.clip((rgb[..., 0] - BASE_RB * rgb[..., 2]) / (1 - BASE_RB) - FLOOR, 0, 1).astype(np.float32)


def read_rad(path):
    a = np.asarray(Image.open(path).convert('RGB'), np.uint16)
    return ((a[..., 0] << 8) | a[..., 1]).astype(np.float32) * 0.1


def fit_curve(cache, calib):
    """Light (0..1) -> radiance LUT over BINS bins, by matching quantiles on the overlapping z8 tiles."""
    Ls, Rs = [], []
    zdir = os.path.join(calib, str(Z))
    for xs in os.listdir(zdir):
        for fn in os.listdir(os.path.join(zdir, xs)):
            bm = os.path.join(cache, str(Z), xs, fn)
            if os.path.exists(bm):
                Ls.append(light_of(bm).ravel())
                Rs.append(read_rad(os.path.join(zdir, xs, fn)).ravel())
    # calibration tiles that exist only in 2025 (dark in 2016) would bias the match: both sets cover
    # the same pixels, so the quantiles compare like with like
    L, R = np.sort(np.concatenate(Ls)), np.sort(np.concatenate(Rs))
    b = np.minimum((L * BINS).astype(np.int64), BINS - 1)
    lut = np.zeros(BINS, np.float64)
    cnt = np.bincount(b, minlength=BINS)
    sums = np.bincount(b, weights=R, minlength=BINS)
    has = cnt > 0
    lut[has] = sums[has] / cnt[has]
    lut[0] = 0.0                              # no light stays dark
    idx = np.arange(BINS)
    lut = np.interp(idx, idx[has | (idx == 0)], lut[has | (idx == 0)])
    lut = np.maximum.accumulate(lut)          # monotone
    # Low end: the 2016 imagery has a smooth, featureless haze around cities (L ~0.005-0.1). Quantile
    # matching squeezed that 20x range into ~1-3 nW, turning it into flat pools with hard rims. Below
    # L0, fall off as a power instead (continuous at L0, zero at L = 0): the haze fades out smoothly
    # and only real point lights keep their calibrated brightness.
    i0 = int(LOW_L0 * BINS)
    lut[:i0] = lut[i0] * (idx[:i0] / i0) ** LOW_POW
    print(f'calibrated on {len(Ls)} tiles: light 0.1 -> {lut[BINS // 10]:.1f}, 0.5 -> {lut[BINS // 2]:.1f}, '
          f'1.0 -> {lut[-1]:.1f} nW/cm2/sr', flush=True)
    return lut.astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join('tilecache', 'bm'))
    ap.add_argument('--calib', default=os.path.join('tilecache', 'lights_2025_test'))
    ap.add_argument('--out', default=os.path.join('data', 'lights'))
    args = ap.parse_args()
    t0 = time.time()
    lut = fit_curve(args.cache, args.calib)
    os.makedirs(args.out, exist_ok=True)
    index = []

    def write(z, x, y, rad):
        if rad.max() < MIN_RAD:
            return
        v = np.clip(np.round(rad * 10), 0, 65534).astype(np.uint16)
        rgb = np.zeros((T, T, 3), np.uint8)
        rgb[..., 0] = v >> 8
        rgb[..., 1] = v & 255
        d = os.path.join(args.out, str(z), str(x))
        os.makedirs(d, exist_ok=True)
        Image.fromarray(rgb, 'RGB').save(os.path.join(d, f'{y}.png'), optimize=True)
        index.append(f'{z}/{x}/{y}')

    def half(a):
        h, w = a.shape
        return a.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))

    # zoom 8: every cached tile, converted and written; parents collect 128 x 128 quadrants
    tiles = [(int(xs), int(fn[:-4])) for xs in os.listdir(os.path.join(args.cache, str(Z)))
             for fn in os.listdir(os.path.join(args.cache, str(Z), xs)) if fn.endswith('.png')]

    def conv(xy):
        x, y = xy
        L = light_of(os.path.join(args.cache, str(Z), str(x), f'{y}.png'))
        rad = np.interp(L, np.arange(BINS) / BINS, lut).astype(np.float32)
        write(Z, x, y, rad)
        return x, y, half(rad)

    parents = {}
    with ThreadPoolExecutor(8) as pool:
        for i, (x, y, h) in enumerate(pool.map(conv, tiles)):
            p = parents.setdefault((x >> 1, y >> 1), np.zeros((T, T), np.float32))
            p[(y & 1) * 128:(y & 1) * 128 + 128, (x & 1) * 128:(x & 1) * 128 + 128] = h
            if (i + 1) % 1000 == 0:
                print(f'  zoom {Z}: {i + 1}/{len(tiles)} ({time.time() - t0:.0f} s)', flush=True)

    for z in range(Z - 1, -1, -1):
        nxt = {}
        for (x, y), a in parents.items():
            write(z, x, y, a)
            p = nxt.setdefault((x >> 1, y >> 1), np.zeros((T, T), np.float32))
            p[(y & 1) * 128:(y & 1) * 128 + 128, (x & 1) * 128:(x & 1) * 128 + 128] = half(a)
        parents = nxt
        print(f'  zoom {z} done ({time.time() - t0:.0f} s)', flush=True)

    with open(os.path.join(args.out, 'index.json'), 'w') as f:
        json.dump({'source': 'NASA GIBS VIIRS_Black_Marble 2016, calibrated to VNP46A4 2025 radiance',
                   'units': 'nW/cm2/sr x 10, R high byte, G low byte',
                   'maxZoom': Z, 'tiles': sorted(index)}, f, separators=(',', ':'))
    size = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fs in os.walk(args.out) for fn in fs)
    print(f'{len(index)} tiles, {size / 1e6:.0f} MB in {args.out} ({time.time() - t0:.0f} s)', flush=True)


if __name__ == '__main__':
    sys.exit(main())
