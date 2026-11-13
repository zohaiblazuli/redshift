"""Bake the night lights from NASA Black Marble VNP46A4 (annual VIIRS Day/Night Band composite).

Source: LAADS DAAC, VNP46A4 collection 5200 (v002), 15 arc-second (~460 m) radiance in nW/cm^2/sr,
540 sinusoidal-free 10 x 10 degree tiles (h00..h35, v00..v17, 2400 x 2400 each, ~52 GB per year).
Layer: AllAngle_Composite_Snow_Free (all view angles, snow-free months): the standard annual product.
Needs a NASA Earthdata token (earthdata_token.txt in the project root, or EARTHDATA_TOKEN) and the
VNP46 license accepted once on the LAADS website for that account.

Output, in data/lights/:
  <z>/<x>/<y>.png   Web Mercator tiles, zoom 0..ZMAX, 256 x 256, RGB8 PNG. The value is the product's
                    radiance x 10 as uint16 (0.1 nW steps, up to 6553 nW), R = high byte,
                    G = low byte, B = 0. Fill / no data = 0. Zoom ZMAX samples the source grid (nearest: the data
                    as published); each coarser zoom is the 2 x 2 mean radiance of its children.
                    Tiles whose brightest pixel is below MIN_RAD are not written (dark: the client
                    treats a missing tile as no light).
  index.json        Every written tile, "z/x/y", so the client never requests a missing one.

Usage: python tools/bake_lights.py [--year 2025] [--zmax 9] [--cache tilecache/vnp46a4] [--keep]
  Downloads are resumable (finished files are kept in the cache). --keep keeps the .h5 files after
  the bake (default: each source file is deleted once every tile that needs it is written).
"""
import argparse
import io
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import h5py
import numpy as np
from PIL import Image

BASE = 'https://ladsweb.modaps.eosdis.nasa.gov/archive/allData/5200/VNP46A4'
LAYER = 'AllAngle_Composite_Snow_Free'
T = 256
SRC = 2400                 # source tile size (10 degrees)
MIN_RAD = 1.0              # nW/cm^2/sr: tiles darker than this everywhere are not written
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def token():
    t = os.environ.get('EARTHDATA_TOKEN')
    if not t:
        with open(os.path.join(ROOT, 'earthdata_token.txt'), encoding='utf-8') as f:
            t = f.read()
    return t.strip()


def get(url, tok=None, timeout=120):
    req = urllib.request.Request(url, headers={'User-Agent': 'OpenWorld-bake/1.0'})
    if tok:
        req.add_header('Authorization', f'Bearer {tok}')
    return urllib.request.urlopen(req, timeout=timeout)


def listing(year):
    with get(f'{BASE}/{year}/001.json') as r:
        return {c['name'].split('.')[2]: (c['name'], c['size']) for c in json.load(r)['content']}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(newurl, code, f'redirected to {newurl}', headers, fp)


def download(year, name, size, cache, tok):
    path = os.path.join(cache, name)
    if os.path.exists(path) and os.path.getsize(path) == size:
        return path
    opener = urllib.request.build_opener(NoRedirect)
    for attempt in range(5):
        try:
            req = urllib.request.Request(f'{BASE}/{year}/001/{name}',
                                         headers={'User-Agent': 'OpenWorld-bake/1.0', 'Authorization': f'Bearer {tok}'})
            with opener.open(req, timeout=300) as r, open(path + '.part', 'wb') as f:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b)
            if os.path.getsize(path + '.part') != size:
                raise IOError(f'{name}: size {os.path.getsize(path + ".part")} != {size}')
            os.replace(path + '.part', path)
            return path
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 401, 403):
                sys.exit(f'{name}: HTTP {e.code} ({e.msg}). Check the token, and accept the VNP46 license '
                         'on https://ladsweb.modaps.eosdis.nasa.gov (download one file in the browser once).')
            err = e
        except Exception as e:  # noqa: BLE001 - retry network errors
            err = e
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f'{name}: {err}')


def read_tile(path):
    """Radiance (float32, nW/cm^2/sr; fill -> 0), 2400 x 2400, north up, west left. Pixel centres
    lie on whole 1/240 degree steps from the tile's north-west corner."""
    with h5py.File(path, 'r') as h:
        ds = None
        def find(n, o):
            nonlocal ds
            if ds is None and isinstance(o, h5py.Dataset) and n.endswith('/' + LAYER):
                ds = o
        h.visititems(find)
        if ds is None:
            raise KeyError(f'{path}: no {LAYER}')
        a = ds[()].astype(np.float32)
        fill = ds.attrs.get('_FillValue')
        fill = float(np.ravel(fill)[0]) if fill is not None else -999.9
    a[(a == np.float32(fill)) | ~np.isfinite(a) | (a < 0)] = 0
    return a


def merc_lat(y, n):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, default=2025)
    ap.add_argument('--zmax', type=int, default=9)
    ap.add_argument('--cache', default=os.path.join(ROOT, 'tilecache', 'vnp46a4'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'lights'))
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--only', help='test: bake one zoom-4 block "x,y" from the source files already cached')
    args = ap.parse_args()
    t0 = time.time()
    tok = token()
    os.makedirs(args.cache, exist_ok=True)
    files = listing(args.year)
    if args.only:   # test bake from what is cached, no downloads
        have = {f for f in os.listdir(args.cache) if f.endswith('.h5')}
        files = {hv: v for hv, v in files.items() if v[0] in have}
    total = sum(s for _, s in files.values())
    print(f'{len(files)} source tiles, {total / 1e9:.1f} GB for {args.year}', flush=True)

    # 1. Download everything first (resumable), 4 at a time
    done = [0, 0]
    def dl(item):
        hv, (name, size) = item
        p = download(args.year, name, size, args.cache, tok)
        done[0] += 1; done[1] += size
        if done[0] % 10 == 0 or done[0] == len(files):
            el = time.time() - t0
            print(f'  {done[0]}/{len(files)} files, {done[1] / 1e9:.1f} GB, {el / 60:.0f} min, '
                  f'~{(total - done[1]) / max(done[1], 1) * el / 60:.0f} min left', flush=True)
        return hv, p
    with ThreadPoolExecutor(args.workers) as pool:
        paths = dict(pool.map(dl, sorted(files.items())))
    print(f'downloaded ({(time.time() - t0) / 60:.0f} min)', flush=True)

    @lru_cache(maxsize=12)
    def src(h, v):
        p = paths.get(f'h{h:02d}v{v:02d}')
        return read_tile(p) if p else None

    # 2. Mercator tiles, processed per zoom-4 block (32 x 32 tiles at zoom 9), coarser zooms by mean
    Z = args.zmax
    os.makedirs(args.out, exist_ok=True)
    index = []
    top = {}   # zoom-4 arrays (radiance float32) for the zooms above

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
        return a.reshape(T, 2, T, 2).mean(axis=(1, 3))

    n = 2 ** Z
    k = 2 ** (Z - 4)           # zoom-Z tiles per zoom-4 tile side
    only = tuple(map(int, args.only.split(','))) if args.only else None
    for by in range(16):
        for bx in range(16):
            if only and (bx, by) != only:
                continue
            # source pixel coordinates of every zoom-Z pixel in this block
            lon = (bx * k * T + np.arange(k * T) + 0.5) / (n * T) * 360 - 180
            lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (by * k * T + np.arange(k * T) + 0.5) / (n * T)))))
            # nearest source pixel (centres on whole 1/240 degree steps from each tile's NW corner)
            gx = np.round((lon + 180) / 10 * SRC).astype(np.int64) % (36 * SRC)   # global source column
            gy = np.clip(np.round((90 - lat) / 10 * SRC).astype(np.int64), 0, 18 * SRC - 1)   # row
            block = np.zeros((k * T, k * T), np.float32)
            for v in np.unique(gy // SRC):
                rows = np.nonzero(gy // SRC == v)[0]
                for h in np.unique(gx // SRC):
                    s = src(int(h), int(v))
                    if s is None:
                        continue
                    cols = np.nonzero(gx // SRC == h)[0]
                    block[np.ix_(rows, cols)] = s[np.ix_(gy[rows] % SRC, gx[cols] % SRC)]
            if block.max() < MIN_RAD:
                top[(bx, by)] = None
                continue
            level = block
            for z in range(Z, 3, -1):
                m = level.shape[0] // T
                x0, y0 = bx * m, by * m
                for ty in range(m):
                    for tx in range(m):
                        write(z, x0 + tx, y0 + ty, level[ty * T:(ty + 1) * T, tx * T:(tx + 1) * T])
                if z > 4:
                    level = level.reshape(m * T // 2, 2, m * T // 2, 2).mean(axis=(1, 3))
            top[(bx, by)] = level
        print(f'  zoom-4 row {by + 1}/16, {len(index)} tiles ({(time.time() - t0) / 60:.0f} min)', flush=True)

    if only:
        with open(os.path.join(args.out, 'index.json'), 'w') as f:
            json.dump({'maxZoom': Z, 'tiles': sorted(index)}, f, separators=(',', ':'))
        print(f'test block {only}: {len(index)} tiles')
        return
    # 3. Zooms 3..0 from the zoom-4 tiles
    level = {k2: v for k2, v in top.items()}
    for z in range(3, -1, -1):
        nxt = {}
        for y in range(2 ** z):
            for x in range(2 ** z):
                quad = np.zeros((2 * T, 2 * T), np.float32)
                for dy in (0, 1):
                    for dx in (0, 1):
                        a = level.get((2 * x + dx, 2 * y + dy))
                        if a is not None:
                            quad[dy * T:(dy + 1) * T, dx * T:(dx + 1) * T] = a
                a = half(quad)
                nxt[(x, y)] = a
                write(z, x, y, a)
        level = nxt

    with open(os.path.join(args.out, 'index.json'), 'w') as f:
        json.dump({'source': f'NASA Black Marble VNP46A4 {args.year} {LAYER}', 'units': 'nW/cm2/sr x 10, R high byte, G low byte',
                   'maxZoom': Z, 'tiles': sorted(index)}, f, separators=(',', ':'))
    size = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fs in os.walk(args.out) for fn in fs)
    print(f'{len(index)} tiles, {size / 1e6:.0f} MB in {args.out} ({(time.time() - t0) / 60:.0f} min)', flush=True)
    if not args.keep:
        for p in paths.values():
            os.remove(p)
        print('source files deleted (--keep to keep them)')


if __name__ == '__main__':
    sys.exit(main())
