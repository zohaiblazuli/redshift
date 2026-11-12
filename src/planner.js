import * as THREE from 'three';
import { R_EARTH, tileCache } from './earth.js';
import { Sim } from './sim.js';

// ---------------------------------------------------------------------------------------------
// Flight planner: flies the orbit ahead of time (same orbit model as the live sim), runs the
// ground tile selection at every point along it for the spacecraft cameras, and downloads exactly
// those imagery + elevation tiles into the local server's disk cache. The flight then plays back
// from disk: no streaming, no pop-in, and it works offline.
// ---------------------------------------------------------------------------------------------
const SAMPLE_S = 2;        // seconds between track samples (~14 km along the ground)
const CONCURRENCY = 24;    // parallel requests to the local server (it rate-limits each upstream)

export class FlightPlanner {
  constructor(world) {
    this.world = world;
    this.plan = null;
    this.busy = false;
    this.abort = false;
    this.line = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x7fc4ff, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.line.frustumCulled = false;
    this.line.visible = false;
    world.scene.add(this.line);
  }

  // orbits: how far ahead; viewportH: device pixels; minFov: narrowest camera the flight will use
  async compute(sim, orbits, viewportH, minFov, onProgress) {
    const s = new Sim();
    s.p.copy(sim.p); s.f.copy(sim.f); s.alt = sim.alt; s.speedMul = sim.speedMul || 1;
    s.utc = sim.utc; s.doy = sim.doy; s.year = sim.year; s.warp = 1; s.paused = false;
    const period = 2 * Math.PI * (R_EARTH + s.alt) / s.groundSpeed;
    const steps = Math.ceil(orbits * period / SAMPLE_S);
    const pxScale = viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(minFov) / 2));
    // all: imagery and terrain in track order, so the download runs ahead of the spacecraft
    const out = { img: new Set(), dem: new Set(), all: new Set(), memo: new Map() };
    const track = [];
    const pos = new THREE.Vector3();
    for (let i = 0; i <= steps; i++) {
      if (i) s.update(SAMPLE_S, {});
      pos.copy(s.p).multiplyScalar(R_EARTH + s.alt);
      this.world.tiles.collect(pos, pxScale, out);
      if (i % 5 === 0 || i === steps) track.push(s.p.clone().multiplyScalar(R_EARTH + 2));
      if (i % 40 === 0) { onProgress?.(i / steps); await new Promise((r) => setTimeout(r, 0)); }
    }
    return {
      orbits, durationS: orbits * period, trackKm: s.groundSpeed * orbits * period * R_EARTH / (R_EARTH + s.alt),
      keys: [...out.all], img: out.img.size, dem: out.dem.size, estimate: null, track,
    };
  }

  // make a computed plan the current one (and show its ground track)
  adopt(plan) {
    this.plan = plan;
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry().setFromPoints(plan.track);
  }

  // size estimate from a random sample of the plan's tiles (they're cached, so nothing is wasted)
  async estimate(plan = this.plan, n = 40) {
    const keys = plan.keys;
    const pick = [];
    for (let i = 0; i < Math.min(n, keys.length); i++) pick.push(keys[Math.floor(Math.random() * keys.length)]);
    let bytes = 0, hits = 0, ok = 0;
    await Promise.all(pick.map(async (k) => {
      const r = await this.fetchTile(k);
      if (r) { ok++; bytes += r.bytes; if (r.hit) hits++; }
    }));
    const per = bytes / Math.max(ok, 1);
    plan.estimate = { bytes: per * keys.length, cachedFrac: hits / Math.max(ok, 1) };
    return plan.estimate;
  }

  async fetchTile(key) {
    try {
      const r = await fetch(`tiles/${key}`);
      if (!r.ok) return null;
      const b = await r.arrayBuffer();
      return { bytes: b.byteLength, hit: r.headers.get('X-Tile-Cache') === 'hit' };
    } catch { return null; }
  }

  async download(onProgress) {
    if (!tileCache.available || !this.plan) return null;
    this.busy = true; this.abort = false;
    const keys = this.plan.keys;
    const res = { done: 0, total: keys.length, bytes: 0, downloaded: 0, failed: 0 };
    let next = 0;
    const worker = async () => {
      while (!this.abort && next < keys.length) {
        const r = await this.fetchTile(keys[next++]);
        if (!r) res.failed++;
        else { res.bytes += r.bytes; if (!r.hit) res.downloaded += r.bytes; }
        res.done++;
        if (res.done % 10 === 0 || res.done === res.total) onProgress?.(res);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    this.busy = false;
    return res;
  }

  async cacheStats() {
    try { return await (await fetch('tiles/stats')).json(); } catch { return null; }
  }

  async clearCache() {
    try { return await (await fetch('tiles/clear', { method: 'POST' })).json(); } catch { return null; }
  }
}
