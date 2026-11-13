// City-light bounce on the spacecraft: the irradiance the lit cities below throw up onto a
// nadir-facing surface at the spacecraft, from the same city radiance map the night side and
// the clouds use (cityglow.png, baked by tools/bake_photo_clouds.py).
//
// Physically it is tiny: averaged over the ~2000 km of Earth the spacecraft sees, even a dense
// city region is mostly dark land and sea, and the environment probe already carries that real
// share. `gain` lifts it so the hull picks up a visible warm under-glow over lit regions, the
// way long-exposure orbit photos show station hardware tinted orange over cities.
import * as THREE from 'three';
import { R_EARTH, CLOUD_DATE } from './earth.js';

const W = 512, H = 256;              // working grid: ~78 km cells
const REACH = THREE.MathUtils.degToRad(24);   // ground within ~2700 km (the horizon from 650 km)

export function createCityBounce({ gain = 6 } = {}) {
  let grid = null;                   // radiance (nW/cm^2/sr), row 0 = north
  const dirs = new Float32Array(W * H * 3);
  const area = new Float32Array(H);  // cell area, km^2
  const state = { gain, E: 0, ready: false, _n: 0, _pos: new THREE.Vector3() };

  for (let j = 0; j < H; j++) {
    const lat = Math.PI / 2 - (j + 0.5) / H * Math.PI;
    area[j] = (2 * Math.PI * R_EARTH / W) * (Math.PI * R_EARTH / H) * Math.cos(lat);
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
      const k = (j * W + i) * 3;
      dirs[k] = Math.sin(lon) * Math.cos(lat); dirs[k + 1] = Math.sin(lat); dirs[k + 2] = Math.cos(lon) * Math.cos(lat);
    }
  }

  async function load() {
    const base = `data/clouds/${CLOUD_DATE}/photo/`;
    const meta = await fetch(base + 'photo.json').then((r) => r.json());
    const lmax = meta.cityglow.lmax;
    const img = await createImageBitmap(await fetch(base + meta.cityglow.file).then((r) => r.blob()));
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, img.width, img.height).data;
    // decode at full resolution, then box-average (averaging the log code would lose the cores)
    const lut = new Float32Array(256);
    for (let v = 0; v < 256; v++) lut[v] = 2 ** (v / 255 * Math.log2(1 + lmax)) - 1;
    const fx = img.width / W, fy = img.height / H;
    grid = new Float32Array(W * H);
    for (let y = 0; y < img.height; y++) {
      const row = Math.floor(y / fy) * W;
      for (let x = 0; x < img.width; x++) grid[row + Math.floor(x / fx)] += lut[px[(y * img.width + x) * 4]];
    }
    const inv = 1 / (fx * fy);
    for (let i = 0; i < grid.length; i++) grid[i] *= inv;
    img.close();
    state.ready = true;
  }
  if (typeof location !== 'undefined' && location.protocol.startsWith('http')) {
    load().catch((e) => console.warn('City bounce unavailable (cityglow.png):', e));
  }

  // Irradiance on a nadir-facing plane at posKm, in radiance units x km^2/km^2 (multiply by the
  // ground's uLights to get scene units). Refreshed every few frames: the sum covers ~4000 cells.
  state.update = (posKm, sunDir, everyN = 8) => {
    if (!grid) return state.E;
    if ((state._n++ % everyN) !== 0 && state._pos.distanceToSquared(posKm) < 1e4) return state.E;
    state._pos.copy(posKm);
    const r = posKm.length(), ux = posKm.x / r, uy = posKm.y / r, uz = posKm.z / r;
    const cosReach = Math.cos(REACH);
    // rows that can fall within REACH of the nadir
    const latN = Math.asin(THREE.MathUtils.clamp(uy, -1, 1));
    const j0 = Math.max(0, Math.floor((Math.PI / 2 - (latN + REACH)) / Math.PI * H));
    const j1 = Math.min(H - 1, Math.ceil((Math.PI / 2 - (latN - REACH)) / Math.PI * H));
    let E = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = 0; i < W; i++) {
        const L = grid[j * W + i];
        if (L <= 0) continue;
        const k = (j * W + i) * 3;
        const nx = dirs[k], ny = dirs[k + 1], nz = dirs[k + 2];
        const cg = nx * ux + ny * uy + nz * uz;          // angle from the nadir point
        if (cg < cosReach) continue;
        // lamps are drowned out on the day side (as the ground shader fades them)
        const night = 1 - THREE.MathUtils.smoothstep(nx * sunDir.x + ny * sunDir.y + nz * sunDir.z, -0.1, 0.02);
        if (night <= 0) continue;
        // ray ground -> spacecraft
        const dx = ux * r - nx * R_EARTH, dy = uy * r - ny * R_EARTH, dz = uz * r - nz * R_EARTH;
        const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
        const cosG = (dx * nx + dy * ny + dz * nz) / d;   // emission angle at the ground
        if (cosG <= 0) continue;                          // past the horizon
        const cosS = (dx * ux + dy * uy + dz * uz) / d;   // arrival angle from the nadir
        E += L * night * cosG * Math.max(cosS, 0) * area[j] / d2;
      }
    }
    state.E = E;
    return E;
  };
  return state;
}
