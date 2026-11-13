"""Bake the observed day's cloud cover at 16384x8192 (~2.4 km) for the orbit view.

Same method as tools/bake_clouds.py (true-colour brightness over the Blue Marble surface, gated by
the retrieval cloud mask, snow removed, climatology where there is no daylight), but the true
colour and the Blue Marble reference are fetched at twice the resolution, so cloud edges come from
the imagery itself instead of being interpolated. The coarse fields (mask, optical depth, snow,
night fallback) are the same ones bake_clouds.py uses, resampled to the finer grid.

Output (data/clouds/<date>/):
  coverage16k_w.webp, coverage16k_e.webp   8192x8192 grey each (west / east half, WebP is
                                           limited to 16383 px a side), read by src/cwfar.js
coverage.webp (8K) stays for the built-in clouds and as the fallback.
Usage: python tools/bake_coverage_hi.py [YYYY-MM-DD]   (run tools/bake_clouds.py for the date first)
Raw tiles are kept in tilecache/gibs/<date>/hi/.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_clouds as bc  # noqa: E402

W, H = 16384, 8192
TILE = 4096          # 8 WMS tiles of 90 x 90 degrees per layer
BAND = 512           # rows processed at a time


def layer_hi(name, fmt='image/jpeg', dated=True):
    """A whole-world layer at W x H as uint8 RGB, fetched as 4 x 2 tiles."""
    out = np.zeros((H, W, 3), np.uint8)
    ext = '.png' if fmt == 'image/png' else '.jpg'
    for ty in range(2):
        for tx in range(4):
            lat1 = 90 - ty * 90; lat0 = lat1 - 90
            lon0 = -180 + tx * 90; lon1 = lon0 + 90
            url = (bc.WMS.replace('BBOX=-90,-180,90,180', f'BBOX={lat0},{lon0},{lat1},{lon1}')
                   .format(w=TILE, h=TILE, layer=name, fmt=fmt, time=f'&TIME={bc.DATE}' if dated else ''))
            p = bc.fetch(url, bc.RAW / 'hi' / f'{name}_{tx}_{ty}{ext}')
            out[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE] = np.asarray(Image.open(p).convert('RGB'))
    return out


def up_rows(src, r0, r1):
    """Rows r0..r1 of src bilinearly resampled to the W x H grid (pixel centres aligned, x wraps)."""
    sh, sw = src.shape
    ys = (np.arange(r0, r1) + 0.5) * sh / H - 0.5
    xs = (np.arange(W) + 0.5) * sw / W - 0.5
    yf = np.floor(ys).astype(int)
    y0 = np.clip(yf, 0, sh - 1); y1 = np.clip(yf + 1, 0, sh - 1)   # clamped at the poles
    fy = (ys - yf)[:, None]
    x0 = np.floor(xs).astype(int); fx = (xs - x0)[None, :]
    x1 = (x0 + 1) % sw; x0 = x0 % sw
    a = src[y0][:, x0] * (1 - fx) + src[y0][:, x1] * fx
    b = src[y1][:, x0] * (1 - fx) + src[y1][:, x1] * fx
    return (a * (1 - fy) + b * fy).astype(np.float32)


def main():
    print(f'Baking 16K cloud cover for {bc.DATE}')
    # ---- coarse fields, exactly as bake_clouds.py builds them -----------------------------------
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
    mask_lo = np.clip(bc.blur(cloudy.astype(np.float32), 1.2) * 1.6, 0, 1)                       # 4096
    opac_lo = np.clip(np.nan_to_num(bc.nearest_fill(cot), nan=8.0) / 12.0, 0.25, 1.0)            # 4096
    snow = np.nan_to_num(bc.decode(bc.SNOW, bc.colormap('MODIS_NDSI_Snow_Cover'), bc.HI), nan=0.0)
    snowk = 1 - np.clip((bc.blur(snow, 1.0) - 5) / 15, 0, 1)                                     # 8192
    clim = np.asarray(Image.open(bc.fetch(bc.CLIMATOLOGY, bc.RAW / 'climatology_clouds.jpg')).convert('RGB')
                      .resize(bc.HI, Image.BILINEAR), dtype=np.float32)[..., 2] / 255
    clim = np.clip((clim - 0.03) / 0.69, 0, 1) ** 1.2 * 0.95                                     # 8192
    gap8 = tcs8[0].max(axis=2) < 0.02
    for extra in tcs8[1:]:
        gap8 &= extra.max(axis=2) < 0.02
    wgap = bc.blur(gap8.astype(np.float32), 24.0)                                                # 8192
    del tcs8, cths, night

    # ---- fine imagery -------------------------------------------------------------------------
    tcs = [layer_hi(n) for n in bc.TRUECOLOR]
    ref = layer_hi('BlueMarble_NextGeneration', dated=False)

    cov = np.zeros((H, W), np.uint8)
    for r0 in range(0, H, BAND):
        r1 = r0 + BAND
        tc = tcs[0][r0:r1].astype(np.float32) / 255
        gap = tc.max(axis=2) < 0.02
        for extra in tcs[1:]:
            e = extra[r0:r1].astype(np.float32) / 255
            tc[gap] = e[gap]
            gap = tc.max(axis=2) < 0.02
        rf = ref[r0:r1].astype(np.float32) / 255
        bright = tc.mean(axis=2)
        mx, mn = tc.max(axis=2), tc.min(axis=2)
        neutral = 1 - np.clip((mx - mn) / np.maximum(mx, 1e-3) / 0.35, 0, 1)
        refb = rf.mean(axis=2)
        signal = np.clip((bright - refb - 0.04) / np.maximum(0.80 - refb, 0.12), 0, 1) * (0.35 + 0.65 * neutral)
        mask_soft = up_rows(mask_lo, r0, r1)
        opacity = up_rows(opac_lo, r0, r1)
        bright_ground = np.clip((refb - 0.40) / 0.2, 0, 1)
        c = signal * mask_soft
        c = c * (1 - bright_ground) + mask_soft * opacity * 0.9 * bright_ground
        c *= up_rows(snowk, r0, r1)
        w = up_rows(wgap, r0, r1)
        c = c * (1 - w) + up_rows(clim, r0, r1) * w
        cov[r0:r1] = (np.clip(c, 0, 1) * 255 + 0.5).astype(np.uint8)
        print(f'  rows {r1}/{H}', end='\r')
    print()

    for name, half in (('coverage16k_w.webp', cov[:, :W // 2]), ('coverage16k_e.webp', cov[:, W // 2:])):
        p = bc.OUT / name
        Image.fromarray(np.ascontiguousarray(half), 'L').save(p, quality=88, method=6)
        print(f'  {p.relative_to(bc.ROOT)}  {p.stat().st_size / 1e6:.1f} MB')
    old = np.asarray(Image.open(bc.OUT / 'coverage.webp').convert('L'), dtype=np.float32)
    print(f'  mean cover {cov.mean() / 255:.3f} (8K map {old.mean() / 255:.3f})')


if __name__ == '__main__':
    main()
