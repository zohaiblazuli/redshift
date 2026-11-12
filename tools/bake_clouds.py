"""Bake one real day of global cloud observations into the textures the volumetric clouds use.

Sources (NASA GIBS, public, no key): VIIRS NOAA-20 / Suomi-NPP and MODIS Aqua / Terra cloud-top
height, cloud optical thickness and cloud phase, VIIRS true-colour reflectance, and Blue Marble
(clear-sky reference). Everything is fetched as whole-world WMS images (equirectangular, EPSG:4326)
and the colour-mapped products are decoded back to physical values with the GIBS colour maps.

Output (data/clouds/<date>/):
  coverage.webp    8192x4096 grey   sub-pixel cloud fraction (~5 km)
  properties.png   2048x1024 RGBA   R coverage (box-averaged), G cloud-top height (0..16 km),
                                    B optical thickness (log, 0..150), A ice fraction
  terrain.png      4096x2048 grey   mean ground elevation, 36 m per step (cloud bases follow
                                    terrain, and mountains hide the clouds behind them)
Usage: python tools/bake_clouds.py [YYYY-MM-DD]     (needs numpy, pillow, scipy)
Raw downloads are kept in tilecache/gibs/<date>/ so re-bakes are offline.
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
DATE = sys.argv[1] if len(sys.argv) > 1 else '2026-10-11'
RAW = ROOT / 'tilecache' / 'gibs' / DATE
OUT = ROOT / 'data' / 'clouds' / DATE
WMS = ('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0'
       '&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH={w}&HEIGHT={h}&LAYERS={layer}&FORMAT={fmt}{time}')
CMAPS = 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/{}.xml'
CLIMATOLOGY = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets/earth_bump_roughness_clouds_4096.jpg'
TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
HI = (8192, 4096)
LO = (4096, 2048)

CTH = ['VIIRS_NOAA20_Cloud_Top_Height_Day', 'VIIRS_SNPP_Cloud_Top_Height_Day', 'MODIS_Aqua_Cloud_Top_Height_Day',
       'MODIS_Terra_Cloud_Top_Height_Day', 'VIIRS_NOAA20_Cloud_Top_Height_Night', 'MODIS_Aqua_Cloud_Top_Height_Night']
COT = ['VIIRS_NOAA20_Cloud_Optical_Thickness', 'VIIRS_SNPP_Cloud_Optical_Thickness',
       'MODIS_Aqua_Cloud_Optical_Thickness', 'MODIS_Terra_Cloud_Optical_Thickness']
PHASE = ['MODIS_Aqua_Cloud_Phase_Optical_Properties', 'MODIS_Terra_Cloud_Phase_Optical_Properties']
TRUECOLOR = ['VIIRS_NOAA20_CorrectedReflectance_TrueColor', 'VIIRS_SNPP_CorrectedReflectance_TrueColor']
SNOW = 'VIIRS_NOAA20_NDSI_Snow_Cover'   # same overpass as the true colour


def fetch(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.parent.name != 'dem':
        print('  fetching', dest.name)
    req = urllib.request.Request(url, headers={'User-Agent': 'SPHEREx-OpenWorld/1.0 (cloud bake)'})
    with urllib.request.urlopen(req, timeout=600) as r:
        data = r.read()
        if not r.headers.get('Content-Type', '').startswith(('image/', 'text/xml', 'application/xml')):
            raise RuntimeError(f'{dest.name}: {data[:300]!r}')
    dest.write_bytes(data)
    return dest


def layer(name, size, fmt='image/png', dated=True):
    ext = '.png' if fmt == 'image/png' else '.jpg'
    url = WMS.format(w=size[0], h=size[1], layer=name, fmt=fmt, time=f'&TIME={DATE}' if dated else '')
    return Image.open(fetch(url, RAW / f'{name}_{size[0]}{ext}'))


def colormap(name):
    xml = fetch(CMAPS.format(name), RAW / f'{name}.xml').read_text(encoding='utf8')
    table = {}
    for tag in re.findall(r'<ColorMapEntry [^>]*/>', xml):
        at = dict(re.findall(r'(\w+)="([^"]*)"', tag))
        if at.get('transparent') == 'true':
            continue
        nums = [float(v) for v in re.findall(r'-?[\d.]+(?:e[-+]?\d+)?', at.get('value', at.get('sourceValue')))]
        r, g, b = map(int, at['rgb'].split(','))
        table[(r << 16) | (g << 8) | b] = sum(nums) / len(nums)
    return table


def decode(name, cmap, size=LO):
    a = np.asarray(layer(name, size).convert('RGBA'))
    key = (a[..., 0].astype(np.int64) << 16) | (a[..., 1].astype(np.int64) << 8) | a[..., 2]
    keys = np.array(sorted(cmap))
    vals = np.array([cmap[k] for k in keys])
    idx = np.clip(np.searchsorted(keys, key), 0, len(keys) - 1)
    hit = (keys[idx] == key) & (a[..., 3] > 0)
    return np.where(hit, vals[idx], np.nan).astype(np.float32)


def merge(names, cmap):
    """First valid value wins (sources listed best-first)."""
    out = None
    for n in names:
        v = decode(n, cmap)
        out = v if out is None else np.where(np.isnan(out), v, out)
    return out


def nearest_fill(v):
    """Fill NaNs with the nearest valid value (so properties are defined at cloud edges)."""
    bad = np.isnan(v)
    if not bad.any():
        return v
    idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
    return v[tuple(idx)]


def blur(v, sigma):
    return ndimage.gaussian_filter(v, sigma, mode=('nearest', 'wrap'))


def up(v):
    """4096x2048 -> 8192x4096, bilinear."""
    return np.asarray(Image.fromarray(v.astype(np.float32), mode='F').resize(HI, Image.BILINEAR))


def down(v):
    return v.reshape(LO[1], 2, LO[0], 2).mean(axis=(1, 3))


def terrain():
    """Global ground elevation (m, >= 0) on the 4096x2048 grid from Terrarium tiles (zoom 4)."""
    z, n = 4, 16
    merc = np.zeros((n * 256, n * 256), np.float32)
    for x in range(n):
        for y in range(n):
            a = np.asarray(Image.open(fetch(TERRARIUM.format(z=z, x=x, y=y), RAW / 'dem' / f'{z}_{x}_{y}.png')).convert('RGB'),
                           dtype=np.float32)
            merc[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    # Web Mercator -> equirectangular (rows by latitude; beyond +-85 deg the edge rows repeat)
    lat = np.radians(90 - (np.arange(LO[1]) + 0.5) * 180 / LO[1])
    ym = (1 - np.log(np.tan(np.pi / 4 + np.clip(lat, -1.4844, 1.4844) / 2)) / np.pi) / 2 * merc.shape[0]
    rows = np.clip(ym.astype(int), 0, merc.shape[0] - 1)
    cols = np.clip(((np.arange(LO[0]) + 0.5) / LO[0] * merc.shape[1]).astype(int), 0, merc.shape[1] - 1)
    return np.maximum(merc[rows][:, cols], 0)


def main():
    print(f'Baking clouds for {DATE}')
    cth_map = colormap('MODIS_VIIRS_Cloud_Top_Height')
    cot_map = colormap('MODIS_VIIRS_Cloud_Optical_Thickness')
    phase_map = colormap('MODIS_Cloud_Phase_Optical_Properties')

    # ---- true colour (8192x4096): swath coverage + reflectance ----------------------------------
    tcs = [np.asarray(layer(n, HI, 'image/jpeg').convert('RGB'), dtype=np.float32) / 255 for n in TRUECOLOR]
    seen = [down(t.max(axis=2) >= 0.02) > 0.5 for t in tcs]   # per satellite: observed in daylight

    # ---- properties (4096x2048) -------------------------------------------------------------
    # A missing cloud-top height means "clear" only where that satellite actually looked, so the
    # cloud mask comes from the true-colour satellites in order (NOAA-20, then S-NPP); the other
    # products only fill places neither saw (polar night) and supply properties.
    cths = [decode(n, cth_map) for n in CTH]
    cloudy = np.zeros(LO[::-1], bool)
    decided = np.zeros(LO[::-1], bool)
    for obs, h in zip(seen, cths[:2]):
        take = obs & ~decided
        cloudy[take] = ~np.isnan(h[take])
        decided |= take
    night = merge(CTH[4:], cth_map)
    cloudy[~decided] = ~np.isnan(night[~decided])
    height = cths[0]
    for h in cths[1:]:
        height = np.where(np.isnan(height), h, height)
    height = np.where(cloudy, height, np.nan)
    cot = merge(COT, cot_map)
    phase = merge(PHASE, phase_map)                   # 2 liquid, 3 ice, 4 undetermined
    ice = np.where(phase == 3, 1.0, np.where(phase == 2, 0.0, np.where(phase == 4, 0.5, np.nan)))
    # high cold tops are ice whatever the optical-phase retrieval missed
    ice = np.where(np.isnan(ice) & cloudy, np.clip((height - 6000) / 3000, 0, 1), ice)

    # ---- sub-pixel coverage (8192x4096) ------------------------------------------------------
    tc = tcs[0].copy()
    gap = tc.max(axis=2) < 0.02                       # outside the swaths / polar night
    for extra in tcs[1:]:
        tc[gap] = extra[gap]
        gap = tc.max(axis=2) < 0.02
    ref = np.asarray(layer('BlueMarble_NextGeneration', HI, 'image/jpeg', dated=False).convert('RGB'),
                     dtype=np.float32) / 255
    bright = tc.mean(axis=2)
    neutral = 1 - np.clip((tc.max(axis=2) - tc.min(axis=2)) / np.maximum(tc.max(axis=2), 1e-3) / 0.35, 0, 1)
    refb = ref.mean(axis=2)
    # cloud signal: brighter than the clear-sky surface, and grey/white (not desert, not water)
    signal = np.clip((bright - refb - 0.04) / np.maximum(0.80 - refb, 0.12), 0, 1) * (0.35 + 0.65 * neutral)
    # gate with the retrieval cloud mask (softened), which rejects sun glint, haze and bright ground
    mask_soft = np.clip(up(blur(cloudy.astype(np.float32), 1.2)) * 1.6, 0, 1)
    # over snow/ice/salt/bright desert the reflectance contrast is useless: trust mask + optical depth
    opacity = up(np.clip(np.nan_to_num(nearest_fill(cot), nan=8.0) / 12.0, 0.25, 1.0))
    bright_ground = np.clip((refb - 0.40) / 0.2, 0, 1)
    cov = signal * mask_soft
    cov = cov * (1 - bright_ground) + mask_soft * opacity * 0.9 * bright_ground
    # snow seen under clear sky (NDSI snow cover) is bright and flagged by the cloud retrievals
    # too, but it is ground: remove it
    snow = np.nan_to_num(decode(SNOW, colormap('MODIS_NDSI_Snow_Cover'), HI), nan=0.0)
    cov *= 1 - np.clip((blur(snow, 1.0) - 5) / 15, 0, 1)
    # No reflectance (polar night, converging swaths): the night retrievals are streaky there, so
    # fall back to the climatological cloud map the app already uses, feathered into the real data.
    clim = np.asarray(Image.open(fetch(CLIMATOLOGY, RAW / 'climatology_clouds.jpg')).convert('RGB').resize(HI, Image.BILINEAR),
                      dtype=np.float32)[..., 2] / 255
    clim = np.clip((clim - 0.03) / 0.69, 0, 1) ** 1.2 * 0.95
    w = blur(gap.astype(np.float32), 24.0)
    cov = cov * (1 - w) + clim * w
    cov = np.clip(cov, 0, 1)

    # ---- write --------------------------------------------------------------------------------
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray((cov * 255 + 0.5).astype(np.uint8), 'L').save(OUT / 'coverage.webp', quality=88, method=6)

    h_km = blur(nearest_fill(height / 1000.0), 1.0)
    tau = blur(nearest_fill(np.where(cloudy, cot, np.nan)), 1.0)
    tau = np.nan_to_num(tau, nan=8.0)
    icef = blur(nearest_fill(ice), 1.5)
    props = np.stack([
        down(cov),
        np.clip(h_km / 16.0, 0, 1),
        np.clip(np.log1p(tau) / np.log1p(150.0), 0, 1),
        np.clip(icef, 0, 1),
    ], axis=-1)
    props = props.reshape(LO[1] // 2, 2, LO[0] // 2, 2, 4).mean(axis=(1, 3))   # 2048x1024 is ample
    Image.fromarray((props * 255 + 0.5).astype(np.uint8), 'RGBA').save(OUT / 'properties.png', optimize=True)

    Image.fromarray(np.clip(terrain() / 36 + 0.5, 0, 255).astype(np.uint8), 'L').save(OUT / 'terrain.png', optimize=True)

    meta = {
        'date': DATE,
        'sources': CTH + COT + PHASE + TRUECOLOR + [SNOW, 'BlueMarble_NextGeneration'],
        'cloudFraction': float(cov.mean()),
        'retrievalCloudyFraction': float(cloudy.mean()),
    }
    (OUT / 'meta.json').write_text(json.dumps(meta, indent=2))
    for f in OUT.iterdir():
        print(f'  {f.relative_to(ROOT)}  {f.stat().st_size / 1e6:.1f} MB')
    print(f"  mean cloud fraction {meta['cloudFraction']:.3f} (retrieval mask {meta['retrievalCloudyFraction']:.3f})")


if __name__ == '__main__':
    main()
