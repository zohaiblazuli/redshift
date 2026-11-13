import * as THREE from 'three';
import { R_EARTH, latLonToVec } from './earth.js';
import { SUN_HINT } from './orbit.js';

const MU = 398600.4418; // km^3/s^2
const DEG = Math.PI / 180;
// SPHEREx's real orbit (mission paper, arXiv 2511.02985): a = 7037.4 km (~665 km up), i = 97.951 deg,
// sun-synchronous, riding the dawn-dusk terminator.
export const SPHEREX_ALT = 665;
export const SPHEREX_INC = 97.951;
const OMEGA_E = 7.2921159e-5; // Earth's sidereal rotation, rad/s

export const PLACES = [
  { key: '1', name: 'Ionian Sea · Greece', lat: 37.2, lon: 18.6 },
  { key: '2', name: 'Strait of Messina · Italy', lat: 36.4, lon: 13.8 },
  { key: '3', name: 'Great Bahama Bank', lat: 22.8, lon: -77.5 },
  { key: '4', name: 'Himalaya', lat: 26.0, lon: 86.2 },
  { key: '5', name: 'Nile Delta · Sinai', lat: 27.2, lon: 31.0 },
  { key: '6', name: 'Japan', lat: 32.0, lon: 136.5 },
  { key: '7', name: 'Great Barrier Reef', lat: -21.5, lon: 151.5 },
  { key: '8', name: 'Hawaiian Islands', lat: 18.0, lon: -157.5 },
  { key: '9', name: 'Iceland', lat: 61.5, lon: -19.5 },
  { key: '0', name: 'Patagonian Andes', lat: -52.0, lon: -71.0 },
  // Presentation routes (Shift + digit): southbound passes that stay over green, populated land.
  // Picked by flying this free-flight model from every 2 deg start point and scoring the run
  // against Sentinel-2 land/greenery and Black Marble lights (2026-11-14).
  { key: '1', shift: true, south: true, name: 'Route · Minnesota → Texas → Mexico (9 min)', lat: 48.0, lon: -92.0 },
  { key: '2', shift: true, south: true, name: 'Route · Manchuria → Beijing → Wuhan → Guangzhou (9 min)', lat: 54.0, lon: 122.0 },
  { key: '3', shift: true, south: true, name: 'Route · Quebec → Toronto → Atlanta (8 min)', lat: 58.0, lon: -74.0 },
];

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const SLEW_RATE = 1.5 * DEG;   // rad/s: a ~60 deg survey slew takes ~45 s plus settling, as flown

export class Sim {
  constructor() {
    this.p = new THREE.Vector3(0, 0, 1); // unit position
    this.f = new THREE.Vector3(0, 1, 0); // unit forward (ground track direction)
    this.alt = SPHEREX_ALT;
    this.speedMul = 1;
    this.year = 2026;
    this.doy = 196; // 15 July
    this.sunDistAU = 1;
    this.eqTime = 0;
    this.utc = 7.6;
    this.warp = 1;
    this.paused = false;
    // 3 survey: SPHEREx's real pointing (IRSA archive) or the survey model past it (orbit.js)
    this.attMode = 3; // 0 sun-track, 1 nadir-hold, 2 inertial/free, 3 survey
    this.attModes = ['SUN-TRACK', 'NADIR HOLD', 'FREE DRIFT', 'SURVEY'];
    this.pointing = null;
    this._bore = new THREE.Vector3();
    this.attOffset = new THREE.Quaternion();
    this.att = new THREE.Quaternion();
    this.attFree = new THREE.Quaternion();
    this.attInit = false;
    this.sunDir = new THREE.Vector3();
    this.sunDirReal = new THREE.Vector3();
    // [ and ] move only the Sun: hours added to the clock for the solar ephemeris alone. The orbit,
    // Moon, stars and HUD clock keep the real time (N or a place key puts it back to 0).
    this.sunShiftH = 0;
    this.moonDir = new THREE.Vector3(0, 0, 1);
    this.moonPhase = 0;   // moon's brightness relative to a full moon (phase law), 0..1
    this.moonIllum = 0;   // illuminated fraction of the disc, 0..1
    this.posKm = new THREE.Vector3();
    // real path: when an orbit (orbit.js, SPHEREx's TLE + SGP4) is attached and onOrbit is set, the
    // position, track and height follow the real spacecraft at the simulated time. Steering,
    // throttle or climbing leaves it (offOrbitReason says why) for the old free great-circle flight.
    this.orbit = null;
    this.onOrbit = false;
    this.offOrbitReason = '';
    this._vOrb = 0;
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    // scratch for carrying the survey pointing off the real orbit (attitudeTarget)
    this._rp = new THREE.Vector3(); this._rf = new THREE.Vector3(); this._ru = new THREE.Vector3();
    this._rt = new THREE.Vector3(); this._rs = new THREE.Vector3();
    this._rm1 = new THREE.Matrix4(); this._rm2 = new THREE.Matrix4();
  }

  get orbitalSpeed() { return this.onOrbit && this._vOrb ? this._vOrb : Math.sqrt(MU / (R_EARTH + this.alt)); }
  get groundSpeed() { return this.orbitalSpeed * this.speedMul; }
  get periodMin() { return this.onOrbit ? this.orbit.periodMin : 2 * Math.PI * (R_EARTH + this.alt) / this.orbitalSpeed / 60; }

  // put the spacecraft on its real path at the simulated time
  followRealOrbit() {
    if (!this.orbit) return false;
    this.onOrbit = true;
    this.attInit = false;   // back on the real path is a jump too: snap, don't slew
    this.speedMul = 1;
    this.offOrbitReason = '';
    this.syncOrbit();
    return true;
  }

  syncOrbit() {
    const d = this.date;
    const h = this.orbit.state(d, this.p, this.f);
    if (h == null) { this.onOrbit = false; this.offOrbitReason = 'propagation failed'; return; }
    this.alt = h;
    this._vOrb = this.orbit.speedAt(d) || 0;
  }

  // heading of the real orbit's ground track through a latitude (northbound pass by default)
  orbitHeading(lat, ascending = true) {
    const s = THREE.MathUtils.clamp(Math.cos(SPHEREX_INC * DEG) / Math.cos(lat * DEG), -1, 1);
    const b = Math.asin(s) / DEG;
    return ((ascending ? b : 180 - b) + 360) % 360;
  }

  setLocation(lat, lon, hdg = this.orbitHeading(lat)) {
    this.onOrbit = false;
    this.attInit = false;   // a jump: take the new attitude at once (no 1.5 deg/s slew from the old place's)
    latLonToVec(lat, lon, 1, this.p);
    const { north, east } = this.basisAt(this.p);
    this.f.copy(north).multiplyScalar(Math.cos(hdg * DEG)).addScaledVector(east, Math.sin(hdg * DEG)).normalize();
  }

  basisAt(p) {
    const north = new THREE.Vector3(0, 1, 0).addScaledVector(p, -p.y);
    if (north.lengthSq() < 1e-10) north.set(0, 0, 1);
    north.normalize();
    const east = new THREE.Vector3().crossVectors(north, p).normalize();
    return { north, east };
  }

  get lat() { return Math.asin(THREE.MathUtils.clamp(this.p.y, -1, 1)) / DEG; }
  get lon() { return Math.atan2(this.p.x, this.p.z) / DEG; }
  get heading() {
    const { north, east } = this.basisAt(this.p);
    return (Math.atan2(this.f.dot(east), this.f.dot(north)) / DEG + 360) % 360;
  }
  // apparent (sundial) solar time: the sun is due south/north at 12:00
  get localSolarTime() { return ((this.utc + this.sunShiftH + this.lon / 15 + this.eqTime / 60) % 24 + 24) % 24; }

  setLocalTime(hours) {
    this.sunShiftH = 0;
    this.computeSun();
    this.utc = ((hours - this.lon / 15 - this.eqTime / 60) % 24 + 24) % 24;
    this.computeSun();
  }

  // Set the simulated clock to a real instant (default: now) - the sun then stands exactly where
  // it really is.
  setRealTime(d = new Date()) {
    this.year = d.getUTCFullYear();
    this.doy = Math.floor((d - Date.UTC(this.year, 0, 1)) / 864e5) + 1;
    this.utc = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600 + d.getUTCMilliseconds() / 3.6e6;
    this.computeSun();
  }

  // advance the UTC clock, rolling the calendar date over at midnight
  addHours(h) {
    const ms = Date.UTC(this.year, 0, this.doy) + (this.utc + h) * 3.6e6;
    this.setRealTime(new Date(ms));
  }

  // Calendar date (UTC) of the simulation, for the sun's position.
  get date() { return new Date(Date.UTC(this.year, 0, this.doy) + this.utc * 3.6e6); }

  // Solar ephemeris (NOAA / Meeus low-precision, ~0.01 deg): apparent declination, equation of
  // time and Earth-Sun distance for the simulated date and UTC. The sub-solar point follows from
  // them, so sunrise times, the seasons and the analemma all come out right.
  // sunDir is the lit Sun (shifted by [ / ], sunShiftH); sunDirReal is where the Sun really is at
  // the simulated time. Attitude and the HERO framing follow sunDirReal, so [ / ] moves only the
  // light, not the spacecraft or the camera.
  computeSun() {
    const jdReal = Date.UTC(this.year, 0, this.doy) / 864e5 + 2440587.5 + this.utc / 24;
    this._solar(jdReal, this.utc, this.sunDirReal);
    const sh = this.sunShiftH;
    const eqTime = sh ? this._solar(jdReal + sh / 24, this.utc + sh, this.sunDir) : this._eqT;
    if (!sh) this.sunDir.copy(this.sunDirReal);
    this.eqTime = eqTime;
    this.sunDistAU = this._dist;
    this.computeMoon(jdReal);
    return this.sunDir;
  }

  // sub-solar direction for a Julian date / UTC; returns the equation of time (minutes) and leaves
  // the Earth-Sun distance in this._dist
  _solar(jd, utc, out) {
    const T = (jd - 2451545.0) / 36525;
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const Mr = M * DEG;
    const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
    const trueLon = L0 + C, trueAnom = M + C;
    const omega = 125.04 - 1934.136 * T;
    const lambda = (trueLon - 0.00569 - 0.00478 * Math.sin(omega * DEG)) * DEG;
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = (eps0 + 0.00256 * Math.cos(omega * DEG)) * DEG;
    const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const y = Math.tan(eps / 2) ** 2, L0r = L0 * DEG;
    const eqTime = 4 / DEG * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r)
      - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));   // minutes
    this._eqT = eqTime;
    this._dist = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(trueAnom * DEG));
    const subLon = -(utc * 60 + eqTime - 720) / 4;
    latLonToVec(decl / DEG, (((subLon + 180) % 360) + 360) % 360 - 180, 1, out);
    return eqTime;
  }

  // Lunar ephemeris (main periodic terms of Meeus ch. 47, ~0.3 deg): sub-lunar point in the same
  // Earth-fixed frame as the sun, and the phase. Moonlight is what shows the land on the night side.
  computeMoon(jd) {
    const d = jd - 2451545.0;
    const r = (a) => ((a % 360) + 360) % 360 * DEG;
    const Lp = 218.3165 + 13.17639648 * d;
    const D = r(297.8502 + 12.19074912 * d), M = r(357.5291 + 0.98560028 * d);
    const Mp = r(134.9634 + 13.06499295 * d), F = r(93.2721 + 13.22935024 * d);
    const lam = (Lp + 6.2888 * Math.sin(Mp) + 1.2740 * Math.sin(2 * D - Mp) + 0.6583 * Math.sin(2 * D)
      + 0.2136 * Math.sin(2 * Mp) - 0.1856 * Math.sin(M) - 0.1143 * Math.sin(2 * F)) * DEG;
    const bet = (5.1282 * Math.sin(F) + 0.2806 * Math.sin(Mp + F) + 0.2777 * Math.sin(Mp - F)
      + 0.1732 * Math.sin(2 * D - F)) * DEG;
    const eps = 23.4393 * DEG;
    const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam));
    const dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam));
    const gmst = 280.46061837 + 360.98564736629 * d;
    const lon = ((ra / DEG - gmst) % 360 + 540) % 360 - 180;
    latLonToVec(dec / DEG, lon, 1, this.moonDir);
    // phase angle ~ 180 deg - elongation (parallax ignored); brightness from the lunar phase law
    const elong = Math.acos(THREE.MathUtils.clamp(this.moonDir.dot(this.sunDir), -1, 1));
    const a = 180 - elong / DEG;
    this.moonIllum = (1 - Math.cos(elong)) / 2;
    this.moonPhase = Math.pow(10, -0.4 * (0.026 * a + 4e-9 * a ** 4));
    return this.moonDir;
  }

  update(dt, input) {
    const w = this.paused ? 0 : this.warp;
    if (this.onOrbit && (input.turn || input.climb || input.throttle)) {
      this.onOrbit = false;
      this.offOrbitReason = input.turn ? 'steering' : input.climb ? 'orbit change' : 'throttle';
    }
    if (this.onOrbit) {
      if (input.timeShift) this.sunShiftH += input.timeShift * dt * 1.5;
      this.addHours(dt * w / 3600);
      this.syncOrbit();
    }
    if (!this.onOrbit) this.freeFlight(dt, w, input);
    this.posKm.copy(this.p).multiplyScalar(R_EARTH + this.alt);

    // attitude
    if (input.rot) {
      this._q.setFromEuler(new THREE.Euler(input.rot.x * dt, input.rot.y * dt, input.rot.z * dt, 'XYZ'));
      this.attOffset.multiply(this._q).normalize();
    }
    const target = this.attitudeTarget();
    if (!this.attInit) { this.att.copy(target); this.attInit = true; }
    else if (this.attMode === 3 && this.pointing) this.att.rotateTowards(target, SLEW_RATE * dt * Math.max(w, 1));
    else this.att.slerp(target, 1 - Math.exp(-dt * 2.5));
  }

  // manual flight: a great circle with the Earth's rotation folded in
  freeFlight(dt, w, input) {
    // steering
    if (input.turn) this.f.applyAxisAngle(this.p, -input.turn * 22 * DEG * dt).normalize();
    if (input.climb) this.alt = THREE.MathUtils.clamp(this.alt + input.climb * dt * (60 + this.alt * 0.6), 25, 4000);
    if (input.throttle) this.speedMul = THREE.MathUtils.clamp(this.speedMul + input.throttle * dt * 0.8, 0, 12);
    if (input.timeShift) this.sunShiftH += input.timeShift * dt * 1.5;

    // advance along the great circle (an orbit with the Earth's rotation folded in)
    const ang = this.groundSpeed * dt * w / (R_EARTH + this.alt);
    if (ang) {
      const axis = new THREE.Vector3().crossVectors(this.p, this.f).normalize();
      this.p.applyAxisAngle(axis, ang).normalize();
      this.f.applyAxisAngle(axis, ang);
      this.f.addScaledVector(this.p, -this.f.dot(this.p)).normalize();
    }
    // the Earth turns under the orbit: the ground track drifts ~25 deg west per revolution
    const spin = -OMEGA_E * dt * w;
    if (spin) { this.p.applyAxisAngle(Y_AXIS, spin); this.f.applyAxisAngle(Y_AXIS, spin); }
    this.addHours(dt * w / 3600);
  }

  attitudeTarget() {
    // the real Sun, not the [ / ]-shifted light: [ / ] must never turn the spacecraft (user, 2026-11-14)
    const up = this.p, s = this.sunDirReal;
    const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
    if (this.attMode === 2) return this.attFree.clone().multiply(this.attOffset);
    if (this.attMode === 3 && this.pointing) {
      // boresight (+Y) on the survey target; roll set by the Sun: the solar array (+X) and the
      // photon shield's sun side face it
      SUN_HINT.dir.copy(s);
      Y.copy(this.pointing.boresight(this.date, this._bore));
      // The survey points from where the real spacecraft is. Off the real orbit (a place jump,
      // steering) that can be the far side of the planet, and its zenith-ish boresight then aimed
      // into the Earth here (the spacecraft flipped). Carry the pointing over in the local frame:
      // same angles from the zenith and the track, at this position.
      if (!this.onOrbit && this.orbit && this.orbit.state(this.date, this._rp, this._rf) != null) {
        const toLocal = (p, f, m) => {
          const u = this._ru.copy(p).normalize();
          const t = this._rt.copy(f).addScaledVector(u, -f.dot(u)).normalize();
          return m.makeBasis(t, u, this._rs.crossVectors(t, u));
        };
        const real = toLocal(this._rp, this._rf, this._rm1);
        const here = toLocal(this.p, this.f, this._rm2);
        Y.applyMatrix4(real.transpose()).applyMatrix4(here).normalize();
      }
      X.copy(s).addScaledVector(Y, -s.dot(Y));
      if (X.lengthSq() < 1e-4) X.crossVectors(this.f, Y);
      X.normalize();
    } else if (this.attMode === 0 || this.attMode === 3) {
      // boresight away from Earth but perpendicular to the Sun; array faces the Sun
      const perp = up.clone().addScaledVector(s, -up.dot(s));
      const w = perp.length();
      Y.copy(up).lerp(perp.divideScalar(Math.max(w, 1e-6)), THREE.MathUtils.smoothstep(w, 0.15, 0.45)).normalize();
      X.copy(s).addScaledVector(Y, -s.dot(Y));
      if (X.lengthSq() < 0.04) X.crossVectors(this.f, Y);
      X.normalize();
    } else {
      Y.copy(up);
      X.crossVectors(this.f, up).normalize(); // panel to the right of the track
    }
    Z.crossVectors(X, Y).normalize();
    this._m.makeBasis(X, Y, Z);
    return new THREE.Quaternion().setFromRotationMatrix(this._m).multiply(this.attOffset);
  }

  cycleAttitude() {
    if (this.attMode !== 2) this.attFree.copy(this.att).multiply(this.attOffset.clone().invert());
    this.attMode = (this.attMode + 1) % 4;
  }
}
