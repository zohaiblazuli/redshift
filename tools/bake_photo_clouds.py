"""Bake the photo cloud layer: one real day of VIIRS cloud imagery at ~1.2 km, for src/photoclouds.js.

Same cloud signal as tools/bake_coverage_hi.py (true-colour brightness over the Blue Marble surface,
gated by the retrieval cloud mask, snow removed, climatology where there was no daylight pass), but
the true colour and Blue Marble are fetched as 8 x 4 WMS tiles of 45 x 45 degrees at 4096 px, so the
global grid is 32768 x 16384 (1.22 km per pixel at the equator) -- about one screen pixel from orbit.

Output (data/clouds/<date>/photo/):
  L0.bc4.gz .. L7.bc4.gz   the grid as 4 x 2 tiles of 8192 x 8192 (row-major from the north-west),
                           each BC4 (RGTC1) with its full mip chain 8192 .. 4, gzip. Value = cloud
                           signal (~reflectance / 0.85), 0 clear .. 255 thick, bright cloud.
  cityglow.png             4096 x 2048 grey, equirect: city radiance (data/lights, z4) blurred over
                           ~15 km, v = 255 log2(1 + L) / log2(1 + 6553.5), L in nW/cm^2/sr.
  photo.json               layout + encodings
Usage: python tools/bake_photo_clouds.py [YYYY-MM-DD]   (run tools/bake_clouds.py for the date first)
Raw tiles are kept in tilecache/gibs/<date>/hi1k/.
"""
import gzip
import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_clouds as bc  # noqa: E402

W, H = 32768, 16384
WMS_T = 4096                    # WMS tile: 45 x 45 degrees
GX, GY = W // WMS_T, H // WMS_T  # 8 x 4
OUT_T = 8192                    # GPU layer tile
OUT = bc.OUT / 'photo'
LMAX = 6553.5                   # data/lights uint16 / 10


def bc4(img):
    """BC4 (RGTC1 unsigned) encode of a uint8 image with sides divisible by 4 (as bake_night.py)."""
    h, w = img.shape
    b = img.reshape(h // 4, 4, w // 4, 4).transpose(0, 2, 1, 3).reshape(-1, 16).astype(np.int32)
    lo, hi = b.min(1), b.max(1)
    rng = np.maximum(hi - lo, 1)
    q = np.clip(np.round((b - lo[:, None]) * 7.0 / rng[:, None]), 0, 7).astype(np.int64)
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


def wms_tile(name, tx, ty, fmt='image/jpeg', dated=True):
    lat1 = 90 - ty * 45; lat0 = lat1 - 45
    lon0 = -180 + tx * 45; lon1 = lon0 + 45
    ext = '.png' if fmt == 'image/png' else '.jpg'
    url = (bc.WMS.replace('BBOX=-90,-180,90,180', f'BBOX={lat0},{lon0},{lat1},{lon1}')
           .format(w=WMS_T, h=WMS_T, layer=name, fmt=fmt, time=f'&TIME={bc.DATE}' if dated else ''))
    return bc.fetch(url, bc.RAW / 'hi1k' / f'{name}_{tx}_{ty}{ext}')


def up_tile(src, r0, r1, c0, c1):
    """Rows r0..r1, columns c0..c1 of src bilinearly resampled to the W x H grid (x wraps)."""
    sh, sw = src.shape
    ys = (np.arange(r0, r1) + 0.5) * sh / H - 0.5
    xs = (np.arange(c0, c1) + 0.5) * sw / W - 0.5
    yf = np.floor(ys).astype(int)
    y0 = np.clip(yf, 0, sh - 1); y1 = np.clip(yf + 1, 0, sh - 1)
    fy = (ys - yf)[:, None].astype(np.float32)
    x0 = np.floor(xs).astype(int); fx = (xs - x0)[None, :].astype(np.float32)
    x1 = (x0 + 1) % sw; x0 = x0 % sw
    a = src[y0][:, x0] * (1 - fx) + src[y0][:, x1] * fx
    b = src[y1][:, x0] * (1 - fx) + src[y1][:, x1] * fx
    return (a * (1 - fy) + b * fy).astype(np.float32)


def coarse_fields():
    """The coarse mask / opacity / snow / climatology fields, exactly as bake_coverage_hi.py."""
    cth_map = bc.colormap('MODIS_VIIRS_Cloud_Top_Height')
    cot_map = bc.colormap('MODIS_VIIRS_Cloud_Optical_Thickness')
    tcs8 = [np.asarray(bc.layer(n, bc.HI, 'image/jpeg').convert('RGB'), dtype=np.float32) / 255 for n in bc.TRUECOLOR]
    seen = [bc.down(t.max(axis=2) >= 0.02) > 0.5 for t in tcs8]
    cths = [bc.decode(n, cth_map) for n in bc.CTH]
    cloudy = np.zeros(bc.LO[::-1], bool)
    decided = np.zeros(bc.LO[::-1], bool)
    for obs, h in zip(seen, cths[:2]):
        take = obs & ~decided
        cloudy[take] = ~np.isnan(h[take])
        decided |= take
    night = bc.merge(bc.CTH[4:], cth_map)
    cloudy[~decided] = ~np.isnan(night[~decided])
    cot = bc.merge(bc.COT, cot_map)
    f = {}
    f['mask'] = np.clip(bc.blur(cloudy.astype(np.float32), 1.2) * 1.6, 0, 1)
    f['opac'] = np.clip(np.nan_to_num(bc.nearest_fill(cot), nan=8.0) / 12.0, 0.25, 1.0)
    snow = np.nan_to_num(bc.decode(bc.SNOW, bc.colormap('MODIS_NDSI_Snow_Cover'), bc.HI), nan=0.0)
    f['snowk'] = 1 - np.clip((bc.blur(snow, 1.0) - 5) / 15, 0, 1)
    clim = np.asarray(Image.open(bc.fetch(bc.CLIMATOLOGY, bc.RAW / 'climatology_clouds.jpg')).convert('RGB')
                      .resize(bc.HI, Image.BILINEAR), dtype=np.float32)[..., 2] / 255
    f['clim'] = np.clip((clim - 0.03) / 0.69, 0, 1) ** 1.2 * 0.95
    gap8 = tcs8[0].max(axis=2) < 0.02
    for extra in tcs8[1:]:
        gap8 &= extra.max(axis=2) < 0.02
    f['wgap'] = bc.blur(gap8.astype(np.float32), 24.0)
    return {k: v.astype(np.float32) for k, v in f.items()}


def cover_tile(F, tx, ty):
    r0, c0 = ty * WMS_T, tx * WMS_T
    r1, c1 = r0 + WMS_T, c0 + WMS_T
    tcs = [np.asarray(Image.open(wms_tile(n, tx, ty)).convert('RGB')) for n in bc.TRUECOLOR]
    rf = np.asarray(Image.open(wms_tile('BlueMarble_NextGeneration', tx, ty, dated=False)).convert('RGB'), np.float32) / 255
    tc = tcs[0].astype(np.float32) / 255
    gap = tc.max(axis=2) < 0.02
    for extra in tcs[1:]:
        e = extra.astype(np.float32) / 255
        tc[gap] = e[gap]
        gap = tc.max(axis=2) < 0.02
    bright = tc.mean(axis=2)
    mx, mn = tc.max(axis=2), tc.min(axis=2)
    neutral = 1 - np.clip((mx - mn) / np.maximum(mx, 1e-3) / 0.35, 0, 1)
    refb = rf.mean(axis=2)
    signal = np.clip((bright - refb - 0.04) / np.maximum(0.80 - refb, 0.12), 0, 1) * (0.35 + 0.65 * neutral)
    mask_soft = up_tile(F['mask'], r0, r1, c0, c1)
    opacity = up_tile(F['opac'], r0, r1, c0, c1)
    bright_ground = np.clip((refb - 0.40) / 0.2, 0, 1)
    c = signal * mask_soft
    c = c * (1 - bright_ground) + mask_soft * opacity * 0.9 * bright_ground
    c *= up_tile(F['snowk'], r0, r1, c0, c1)
    w = up_tile(F['wgap'], r0, r1, c0, c1)
    c = c * (1 - w) + up_tile(F['clim'], r0, r1, c0, c1) * w
    return (np.clip(c, 0, 1) * 255 + 0.5).astype(np.uint8)


def write_layer(cov, i):
    ly, lx = divmod(i, W // OUT_T)
    img = cov[ly * OUT_T:(ly + 1) * OUT_T, lx * OUT_T:(lx + 1) * OUT_T].astype(np.float32)
    parts = []
    while True:
        parts.append(bc4((img + 0.5).astype(np.uint8)))
        if img.shape[0] <= 4:
            break
        img = img.reshape(img.shape[0] // 2, 2, img.shape[1] // 2, 2).mean(axis=(1, 3))
    p = OUT / f'L{i}.bc4.gz'
    with gzip.open(p, 'wb', compresslevel=6) as f:
        f.write(b''.join(parts))
    return p.stat().st_size


def city_glow():
    """data/lights z4 (Web Mercator radiance) -> 4096 x 2048 equirect, blurred, log-encoded."""
    lights = bc.ROOT / 'data' / 'lights'
    idx = set(json.loads((lights / 'index.json').read_text())['tiles'])
    z, n = 4, 16
    merc = np.zeros((n * 256, n * 256), np.float32)
    for y in range(n):
        for x in range(n):
            if f'{z}/{x}/{y}' not in idx:
                continue
            a = np.asarray(Image.open(lights / str(z) / str(x) / f'{y}.png').convert('RGB'), np.float32)
            merc[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = (a[..., 0] * 256 + a[..., 1]) * 0.1
    OW, OH = 4096, 2048
    lat = np.radians(90 - (np.arange(OH) + 0.5) * 180 / OH)
    my = (1 - np.log(np.tan(np.pi / 4 + np.clip(lat, -1.4844, 1.4844) / 2)) / np.pi) / 2 * merc.shape[0] - 0.5
    mx = (np.arange(OW) + 0.5) * merc.shape[1] / OW - 0.5
    out = ndimage.map_coordinates(merc, np.meshgrid(my, mx, indexing='ij'), order=1, mode='nearest')
    out[np.abs(np.degrees(lat)) > 85] = 0
    out = ndimage.gaussian_filter(out, 1.3, mode='wrap')        # ~15 km: light spreading in the cloud
    v = np.log2(1 + np.maximum(out, 0)) / np.log2(1 + LMAX) * 255
    Image.fromarray((np.clip(v, 0, 255) + 0.5).astype(np.uint8), 'L').save(OUT / 'cityglow.png', optimize=True)


def main():
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    print(f'Baking photo clouds for {bc.DATE} at {W} x {H}')
    city_glow()
    print(f'  cityglow.png  ({time.time() - t0:.0f} s)')

    # downloads first, in parallel (GIBS renders each 4096 px WMS tile on request)
    jobs = [(n, tx, ty, True) for n in bc.TRUECOLOR for ty in range(GY) for tx in range(GX)]
    jobs += [('BlueMarble_NextGeneration', tx, ty, False) for ty in range(GY) for tx in range(GX)]
    done = 0
    with ThreadPoolExecutor(6) as ex:
        for _ in ex.map(lambda j: wms_tile(j[0], j[1], j[2], dated=j[3]), jobs):
            done += 1
            print(f'  downloaded {done}/{len(jobs)}  ({time.time() - t0:.0f} s)', end='\r')
    print()

    F = coarse_fields()
    print(f'  coarse fields  ({time.time() - t0:.0f} s)')
    cov = np.zeros((H, W), np.uint8)
    for ty in range(GY):
        for tx in range(GX):
            cov[ty * WMS_T:(ty + 1) * WMS_T, tx * WMS_T:(tx + 1) * WMS_T] = cover_tile(F, tx, ty)
            print(f'  cover tile {ty * GX + tx + 1}/{GX * GY}  ({time.time() - t0:.0f} s)', end='\r')
    print()
    del F
    total = 0
    for i in range((W // OUT_T) * (H // OUT_T)):
        total += write_layer(cov, i)
        print(f'  layer {i + 1}/8  ({time.time() - t0:.0f} s)', end='\r')
    print()
    (OUT / 'photo.json').write_text(json.dumps({
        'date': bc.DATE, 'width': W, 'height': H, 'tile': OUT_T, 'cols': W // OUT_T, 'rows': H // OUT_T,
        'format': 'bc4', 'mips': int(np.log2(OUT_T)) - 1, 'value': 'cloud signal, ~reflectance / 0.85',
        'cityglow': {'file': 'cityglow.png', 'lmax': LMAX, 'encoding': 'v = 255 log2(1+L)/log2(1+lmax)'},
    }, indent=1))
    prev = np.asarray(Image.open(bc.OUT / 'coverage.webp').convert('L'), dtype=np.float32)
    print(f'Done in {time.time() - t0:.0f} s: {total / 1e6:.0f} MB; mean cover {cov.mean() / 255:.3f} (8K map {prev.mean() / 255:.3f})')


if __name__ == '__main__':
    main()
