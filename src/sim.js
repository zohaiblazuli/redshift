import * as THREE from 'three';
import { R_EARTH, latLonToVec } from './earth.js';

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
];

const Y_AXIS = new THREE.Vector3(0, 1, 0);

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
    this.attMode = 1; // 0 sun-track, 1 nadir-hold, 2 inertial/free
    this.attModes = ['SUN-TRACK', 'NADIR HOLD', 'FREE DRIFT'];
    this.attOffset = new THREE.Quaternion();
    this.att = new THREE.Quaternion();
    this.attFree = new THREE.Quaternion();
    this.attInit = false;
    this.sunDir = new THREE.Vector3();
    this.posKm = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
  }

  get orbitalSpeed() { return Math.sqrt(MU / (R_EARTH + this.alt)); }
  get groundSpeed() { return this.orbitalSpeed * this.speedMul; }

  // heading of the real orbit's ground track through a latitude (northbound pass by default)
  orbitHeading(lat, ascending = true) {
    const s = THREE.MathUtils.clamp(Math.cos(SPHEREX_INC * DEG) / Math.cos(lat * DEG), -1, 1);
    const b = Math.asin(s) / DEG;
    return ((ascending ? b : 180 - b) + 360) % 360;
  }

  setLocation(lat, lon, hdg = this.orbitHeading(lat)) {
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
  get localSolarTime() { return ((this.utc + this.lon / 15 + this.eqTime / 60) % 24 + 24) % 24; }

  setLocalTime(hours) {
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
  computeSun() {
    const jd = Date.UTC(this.year, 0, this.doy) / 864e5 + 2440587.5 + this.utc / 24;
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
    this.eqTime = eqTime;
    this.sunDistAU = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(trueAnom * DEG));
    const subLon = -(this.utc * 60 + eqTime - 720) / 4;
    latLonToVec(decl / DEG, ((subLon + 540) % 360) - 180, 1, this.sunDir);
    return this.sunDir;
  }

  update(dt, input) {
    const w = this.paused ? 0 : this.warp;
    // steering
    if (input.turn) this.f.applyAxisAngle(this.p, -input.turn * 22 * DEG * dt).normalize();
    if (input.climb) this.alt = THREE.MathUtils.clamp(this.alt + input.climb * dt * (60 + this.alt * 0.6), 25, 4000);
    if (input.throttle) this.speedMul = THREE.MathUtils.clamp(this.speedMul + input.throttle * dt * 0.8, 0, 12);
    if (input.timeShift) this.addHours(input.timeShift * dt * 1.5);

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
    this.posKm.copy(this.p).multiplyScalar(R_EARTH + this.alt);

    // attitude
    if (input.rot) {
      this._q.setFromEuler(new THREE.Euler(input.rot.x * dt, input.rot.y * dt, input.rot.z * dt, 'XYZ'));
      this.attOffset.multiply(this._q).normalize();
    }
    const target = this.attitudeTarget();
    if (!this.attInit) { this.att.copy(target); this.attInit = true; }
    else this.att.slerp(target, 1 - Math.exp(-dt * 2.5));
  }

  attitudeTarget() {
    const up = this.p, s = this.sunDir;
    const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
    if (this.attMode === 2) return this.attFree.clone().multiply(this.attOffset);
    if (this.attMode === 0) {
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
    this.attMode = (this.attMode + 1) % 3;
  }
}
