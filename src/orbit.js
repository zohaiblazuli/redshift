import * as THREE from 'three';
import { twoline2satrec, propagate, gstime, eciToGeodetic } from 'satellite.js';
import { latLonToVec } from './earth.js';

// SPHEREx's real path: the spacecraft's published two-line elements (NORAD 63182, CelesTrak),
// propagated with SGP4. Served fresh by server.js at /tle/spherex (cached on disk, refreshed every
// few hours); this copy is the fallback when the page is opened as a file or offline.
// Epoch 2026-11-12 23:14 UTC.
export const SPHEREX_TLE_FALLBACK = [
  '1 63182U 25047E   26316.96838829  .00000999  00000+0  15840-3 0  9996',
  '2 63182  97.9570 139.1120 0011598  77.1274 283.1229 14.74305948 89962',
];

const ORB_DEG = 180 / Math.PI;

export class RealOrbit {
  constructor(lines = SPHEREX_TLE_FALLBACK) {
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this.setTle(lines);
  }

  setTle([l1, l2]) {
    const rec = twoline2satrec(l1.trim(), l2.trim());
    if (rec.error) throw new Error(`bad TLE (sgp4 error ${rec.error})`);
    this.satrec = rec;
    this.lines = [l1.trim(), l2.trim()];
    this.epoch = new Date((rec.jdsatepoch + (rec.jdsatepochF || 0) - 2440587.5) * 864e5);
    this.periodMin = 2 * Math.PI / rec.no;                  // rec.no: rad/min
  }

  // sub-satellite point (unit vector in the app's Earth-fixed frame) and geodetic height in km
  sample(date, outP) {
    const pv = propagate(this.satrec, date);
    if (!pv || !pv.position) return null;
    const g = eciToGeodetic(pv.position, gstime(date));
    latLonToVec(g.latitude * ORB_DEG, g.longitude * ORB_DEG, 1, outP);
    return g.height;
  }

  // position p, ground-track direction f (unit, tangent) and height at a date; false on failure
  state(date, p, f) {
    const h = this.sample(date, this._a);
    const h2 = this.sample(new Date(date.getTime() + 2000), this._b);
    if (h == null || h2 == null) return null;
    p.copy(this._a);
    f.copy(this._b).sub(this._a);
    f.addScaledVector(p, -f.dot(p)).normalize();
    return h;
  }

  // inertial orbital speed (km/s), for the HUD
  speedAt(date) {
    const pv = propagate(this.satrec, date);
    if (!pv || !pv.velocity) return null;
    const v = pv.velocity;
    return Math.hypot(v.x, v.y, v.z);
  }
}

// ---------------------------------------------------------------------------------------------
// Pointing. SPHEREx's real pointing is published in the IRSA archive (exposure times + sky
// positions), weeks after the fact. Where the archive covers the simulated time, the boresight is
// replayed exposure by exposure. Beyond it (including "now") it follows a model of the survey,
// fitted to that archive: the boresight is held fixed on the sky for 1-4 exposures (~115 s each,
// one every ~129 s), within ~37 deg of zenith, starting near the zenith and offset up to 30 deg
// across the track, then slews (~70 s) to the next patch.
// ---------------------------------------------------------------------------------------------
const EXP_CADENCE = 129, SLEW_S = 70;
const MJD_UNIX = 40587;
const toMjd = (d) => d.getTime() / 864e5 + MJD_UNIX;

// J2000 (ICRS) -> mean equator of date (IAU 1976 precession), so archive RA/Dec line up with the
// orbit's true-of-date frame to ~0.01 deg
function precessJ2000(v, date) {
  const T = (toMjd(date) - 51544.5) / 36525, as = Math.PI / 180 / 3600;
  const zeta = (2306.2181 * T + 0.30188 * T * T) * as, z = (2306.2181 * T + 1.09468 * T * T) * as;
  const th = (2004.3109 * T - 0.42665 * T * T) * as;
  const cz = Math.cos(zeta), sz = Math.sin(zeta), cZ = Math.cos(z), sZ = Math.sin(z), ct = Math.cos(th), st = Math.sin(th);
  const [x, y, w] = v;
  return [
    (cZ * ct * cz - sZ * sz) * x + (-cZ * ct * sz - sZ * cz) * y + (-cZ * st) * w,
    (sZ * ct * cz + cZ * sz) * x + (-sZ * ct * sz + cZ * cz) * y + (-sZ * st) * w,
    (st * cz) * x + (-st * sz) * y + ct * w,
  ];
}
// inertial-of-date [x, y, z] (z = north pole) <-> the app's Earth-fixed frame (y = north, lon 0 on +z)
function inertialToApp(v, gmst, out) {
  const c = Math.cos(gmst), s = Math.sin(gmst);
  return out.set(-v[0] * s + v[1] * c, v[2], v[0] * c + v[1] * s);
}
function appToInertial(a, gmst) {
  const c = Math.cos(gmst), s = Math.sin(gmst);
  return [a.z * c - a.x * s, a.z * s + a.x * c, a.y];
}
// The galactic frame (x = galactic centre, y = north galactic pole) turned into the app's frame at
// `date` (J2000 directions, precession ignored: ~0.4 deg by 2026).
const GAL_N = [192.85948, 27.12825], GAL_C = [266.40510, -28.93617];
const radec = ([ra, de]) => { const a = ra * Math.PI / 180, d = de * Math.PI / 180; return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]; };
const gqN = new THREE.Vector3(), gqC = new THREE.Vector3(), gqZ = new THREE.Vector3(), gqM = new THREE.Matrix4();
export function galacticQuat(date, out) {
  const g = gstime(date);
  inertialToApp(radec(GAL_N), g, gqN);
  inertialToApp(radec(GAL_C), g, gqC);
  gqC.addScaledVector(gqN, -gqC.dot(gqN)).normalize();
  gqZ.crossVectors(gqC, gqN);
  return out.setFromRotationMatrix(gqM.makeBasis(gqC, gqN, gqZ));
}
function hash01(a, b) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export class SurveyPointing {
  constructor(orbit) {
    this.orbit = orbit;
    this.days = new Map();          // 'YYYY-MM-DD' -> exposures[] | 'pending' | null
    this.coverageMjd = null;        // archive reaches up to here
    this.served = location.protocol.startsWith('http');
    this.source = 'MODEL';          // what the last answer came from
    this.exposure = '';
    this._p = new THREE.Vector3(); this._f = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._segCache = new Map();
    if (this.served) {
      fetch('/spherex/coverage').then((r) => (r.ok ? r.json() : null))
        .then((c) => { this.coverageMjd = c && c.lastMjd; }).catch(() => {});
    }
  }

  _day(date) {
    if (!this.served || !this.coverageMjd || toMjd(date) > this.coverageMjd + 0.01) return null;
    const key = date.toISOString().slice(0, 10);
    const d = this.days.get(key);
    if (d === undefined) {
      this.days.set(key, 'pending');
      fetch(`/spherex/pointing/${key}`).then((r) => (r.ok ? r.json() : null))
        .then((j) => this.days.set(key, j && j.exposures.length ? j.exposures : null))
        .catch(() => this.days.set(key, null));
      return null;
    }
    return Array.isArray(d) ? d : null;
  }

  // boresight at a date, as a unit vector in the app's Earth-fixed frame
  boresight(date, out) {
    const gmst = gstime(date);
    const list = this._day(date);
    if (list) {
      const m = toMjd(date);
      let lo = 0, hi = list.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (list[mid].t0 <= m) lo = mid; else hi = mid - 1; }
      let e = list[lo].t0 <= m ? list[lo] : null;
      // between exposures (LVF step or slew): already heading for the next one
      if (e && m > e.t1) { const n = list[lo + 1]; e = n && (n.t0 - e.t1) * 86400 < 360 ? n : null; }
      if (e) {
        this.source = 'IRSA'; this.exposure = e.id;
        return inertialToApp(precessJ2000(e.v, date), gmst, out);
      }
    }
    this.source = 'MODEL'; this.exposure = '';
    return inertialToApp(this._modelInertial(date), gmst, out);
  }

  // survey model: a deterministic segment schedule from each UTC midnight
  _modelInertial(date) {
    const day = Math.floor(date.getTime() / 864e5), t = (date.getTime() / 1000) - day * 86400;
    let ts = 0, k = 0, n = 1;
    for (; ; k++) {
      n = hash01(day, k * 3) < 0.5 ? 1 : 4;
      const len = n * EXP_CADENCE + SLEW_S;
      if (ts + len > t || ts > 86400) break;
      ts += len;
    }
    const key = day * 1000 + k;
    let v = this._segCache.get(key);
    if (!v) {
      const t0 = new Date((day * 86400 + ts) * 1000);
      this.orbit.state(t0, this._p, this._f);
      const sun = SUN_HINT.dir;
      this._s.crossVectors(this._f, this._p);
      if (sun.lengthSq() && this._s.dot(sun) < 0) this._s.negate();   // + = toward the Sun
      const a = (-4 + 10 * hash01(day, k * 3 + 1)) * Math.PI / 180;
      const cMax = n === 4 ? 20 : 30;
      const c = (-cMax + (cMax + 19) * hash01(day, k * 3 + 2)) * Math.PI / 180;
      const d = this._p.clone().addScaledVector(this._f, Math.tan(a)).addScaledVector(this._s, Math.tan(c)).normalize();
      v = appToInertial(d, gstime(t0));
      if (this._segCache.size > 400) this._segCache.clear();
      this._segCache.set(key, v);
    }
    return v;
  }
}
// the Sun's direction (app frame) for the model's sun-side choice; main keeps it current
export const SUN_HINT = { dir: new THREE.Vector3() };

// Fetch the current elements from the local server; fall back to the bundled ones.
export async function loadSpherexTle() {
  try {
    const r = await fetch('/tle/spherex', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    const lines = (await r.text()).split(/\r?\n/).filter((l) => /^[12] /.test(l));
    if (lines.length >= 2) return { lines: lines.slice(0, 2), live: true };
  } catch { /* opened as a file, or offline */ }
  return { lines: SPHEREX_TLE_FALLBACK, live: false };
}
