"""Bake one region of real cloud observations at ~500 m for the high-detail cloud layer.

The global bake (bake_clouds.py) only says *where* clouds are (~5 km). Here the cloud structure
itself comes from the satellite image: VIIRS true-colour reflectance is turned back into physical
reflectance, the ground's contribution is removed with a two-stream cloud-over-surface model, and
what remains is the cloud's own albedo (0..1). Albedo, not optical depth, is stored because it
averages linearly: a distant mip level keeps the brightness a camera would see, instead of turning
broken cumulus into a grey veil. The renderer converts it back to optical depth and relights it
with the live sun, so the satellite's 13:30 lighting is discarded.

Output (data/clouds/<date>/region-<name>.png + region-<name>.json):
  R cloud albedo   G cloud-top height (0..16 km)   B ice fraction   A 255
Usage: python tools/bake_region.py [YYYY-MM-DD] [name lon0 lat0 lon1 lat1 deg_per_px]
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bake_clouds as bc  # noqa: E402  (shares the download cache and colour-map decoding)

Image.MAX_IMAGE_PIXELS = None
DATE = sys.argv[1] if len(sys.argv) > 1 else '2026-10-11'
if len(sys.argv) > 7:
    NAME, LON0, LAT0, LON1, LAT1, STEP = sys.argv[2], *map(float, sys.argv[3:8])
else:
    NAME, LON0, LAT0, LON1, LAT1, STEP = 'adriatic', 5.0, 33.0, 30.0, 50.0, 0.005
W, H = round((LON1 - LON0) / STEP), round((LAT1 - LAT0) / STEP)
RAW = bc.ROOT / 'tilecache' / 'gibs' / DATE / f'region-{NAME}'
OUT = bc.ROOT / 'data' / 'clouds' / DATE
WMS = ('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0'
       f'&STYLES=&CRS=EPSG:4326&BBOX={LAT0},{LON0},{LAT1},{LON1}&WIDTH={W}&HEIGHT={H}'
       '&LAYERS={layer}&FORMAT={fmt}{time}')

# GIBS "Corrected Reflectance" true colour is stretched for display: reflectance (x 255 / 1.1)
# through this piecewise-linear curve. Inverting it recovers (approximate) reflectance.
STRETCH_IN = np.array([0, 30, 60, 120, 190, 255], np.float32)
STRETCH_OUT = np.array([0, 110, 160, 210, 240, 255], np.float32)


def region_layer(name, fmt='image/png', dated=True):
    ext = '.png' if fmt == 'image/png' else '.jpg'
    url = WMS.format(layer=name, fmt=fmt, time=f'&TIME={DATE}' if dated else '')
    return Image.open(bc.fetch(url, RAW / f'{name}{ext}'))


def region_decode(name, cmap):
    a = np.asarray(region_layer(name).convert('RGBA'))
    key = (a[..., 0].astype(np.int64) << 16) | (a[..., 1].astype(np.int64) << 8) | a[..., 2]
    keys = np.array(sorted(cmap))
    vals = np.array([cmap[k] for k in keys])
    idx = np.clip(np.searchsorted(keys, key), 0, len(keys) - 1)
    hit = (keys[idx] == key) & (a[..., 3] > 0)
    return np.where(hit, vals[idx], np.nan).astype(np.float32)


def reflectance(img):
    """Display bytes -> approximate reflectance (per channel)."""
    v = np.asarray(img.convert('RGB'), dtype=np.float32)
    return np.interp(v, STRETCH_OUT, STRETCH_IN) / 255 * 1.1


def cloud_albedo(r_total, surface):
    """Solve R = Rc + (1 - Rc)^2 A / (1 - A Rc) for the cloud's own reflectance Rc (conservative
    two-stream cloud over a Lambertian surface of albedo A), by bisection."""
    lo = np.zeros_like(r_total)
    hi = np.ones_like(r_total)
    for _ in range(24):
        x = (lo + hi) / 2
        f = x + (1 - x) ** 2 * surface / np.maximum(1 - surface * x, 1e-4)
        up = f < r_total
        lo = np.where(up, x, lo)
        hi = np.where(up, hi, x)
    return (lo + hi) / 2


def main():
    print(f'Baking region "{NAME}" {LON0}..{LON1}E {LAT0}..{LAT1}N at {STEP} deg ({W}x{H}) for {DATE}')
    cth_map = bc.colormap('MODIS_VIIRS_Cloud_Top_Height')
    phase_map = bc.colormap('MODIS_Cloud_Phase_Optical_Properties')
    snow_map = bc.colormap('MODIS_NDSI_Snow_Cover')

    tc = reflectance(region_layer(bc.TRUECOLOR[0], 'image/jpeg'))
    seen = tc.max(axis=2) > 0.01
    tc2 = reflectance(region_layer(bc.TRUECOLOR[1], 'image/jpeg'))
    tc[~seen] = tc2[~seen]
    seen = tc.max(axis=2) > 0.01
    ref = reflectance(region_layer('BlueMarble_NextGeneration', 'image/jpeg', dated=False))

    # brightness of a neutral (white/grey) target; clouds are spectrally flat, land and water are not
    r_tot = tc.mean(axis=2)
    a_srf = np.clip(ref.mean(axis=2), 0.0, 0.9)
    mx, mn = tc.max(axis=2), tc.min(axis=2)
    neutral = 1 - np.clip(((mx - mn) / np.maximum(mx, 1e-3) - 0.12) / 0.3, 0, 1)
    alb = cloud_albedo(np.clip(r_tot, 0, 1.2), a_srf)

    # The retrieval cloud mask (1 km) vetoes sun glint, haze and bright ground; it is dilated a
    # little so the 500 m cloud edges from the reflectance survive.
    cth = region_decode(bc.CTH[0], cth_map)
    cloudy = ~np.isnan(cth)
    mask = np.clip(ndimage.gaussian_filter(ndimage.binary_dilation(cloudy, iterations=2).astype(np.float32), 1.0) * 1.5, 0, 1)
    snow = np.nan_to_num(region_decode(bc.SNOW, snow_map), nan=0.0)
    not_snow = 1 - np.clip((ndimage.gaussian_filter(snow, 1.0) - 5) / 15, 0, 1)
    alb = alb * mask * not_snow * (0.4 + 0.6 * neutral)
    alb[~seen] = 0
    # a faint floor of haze and residual surface mismatch is not cloud
    alb = np.clip((alb - 0.03) / 0.97, 0, 1)

    height = bc.nearest_fill(np.where(cloudy, cth / 1000.0, np.nan))
    height = ndimage.gaussian_filter(np.nan_to_num(height, nan=2.0), 1.5)
    phase = region_decode(bc.PHASE[0], phase_map)
    ice = np.where(phase == 3, 1.0, np.where(phase == 2, 0.0, np.where(phase == 4, 0.5, np.nan)))
    ice = np.where(np.isnan(ice) & cloudy, np.clip((cth - 6000) / 3000, 0, 1), ice)
    ice = ndimage.gaussian_filter(np.nan_to_num(bc.nearest_fill(ice), nan=0.0), 2.0)

    OUT.mkdir(parents=True, exist_ok=True)
    rgba = np.stack([alb, np.clip(height / 16, 0, 1), np.clip(ice, 0, 1), np.ones_like(alb)], axis=-1)
    Image.fromarray((rgba * 255 + 0.5).astype(np.uint8), 'RGBA').save(OUT / f'region-{NAME}.png', optimize=True)
    meta = {'name': NAME, 'date': DATE, 'lon0': LON0, 'lat0': LAT0, 'lon1': LON1, 'lat1': LAT1,
            'width': W, 'height': H, 'meanAlbedo': float(alb.mean()), 'cloudyShare': float((alb > 0.05).mean())}
    (OUT / f'region-{NAME}.json').write_text(json.dumps(meta, indent=2))
    print(f"  region-{NAME}.png {(OUT / f'region-{NAME}.png').stat().st_size / 1e6:.1f} MB,"
          f" mean albedo {meta['meanAlbedo']:.3f}, cloudy share {meta['cloudyShare']:.3f}")


if __name__ == '__main__':
    main()
