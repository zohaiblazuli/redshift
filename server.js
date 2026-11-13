// Minimal zero-dependency static file server for the SPHEREx Open World, with a disk cache for
// map tiles: /tiles/<source>/<z>/<x>/<y> is fetched from the upstream service once, saved under
// ./tilecache, and served from disk from then on (offline replays of planned flight paths).
// Usage: node server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.argv[2] || process.env.PORT || 8080);
const cacheDir = path.join(root, 'tilecache');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
};

const SOURCES = {
  s2: { ext: '.jpg', url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg` },
  dem: { ext: '.png', url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png` },
};

// cache statistics (scanned once at start-up, then kept up to date)
const stats = { files: 0, bytes: 0, ready: false };
(async function scan(dir) {
  let entries = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await scan(p);
    else { try { stats.bytes += (await fs.promises.stat(p)).size; stats.files++; } catch {} }
  }
})(cacheDir).then(() => { stats.ready = true; });

// polite upstream access: a capped number of requests per service, identical requests shared
const LIMITS = { s2: 12, dem: 24 };
const pools = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, { active: 0, queue: [] }]));
const inflight = new Map();
function upstream(src, url) {
  if (inflight.has(url)) return inflight.get(url);
  const pool = pools[src];
  const p = new Promise((resolve, reject) => {
    const run = () => {
      pool.active++;
      fetch(url, { headers: { 'User-Agent': 'SPHEREx-OpenWorld/1.0 (local tile cache)' } })
        .then(async (r) => resolve({ status: r.status, type: r.headers.get('content-type'), body: r.ok ? Buffer.from(await r.arrayBuffer()) : null }))
        .catch(reject)
        .finally(() => { pool.active--; inflight.delete(url); if (pool.queue.length) pool.queue.shift()(); });
    };
    if (pool.active < LIMITS[src]) run(); else pool.queue.push(run);
  });
  inflight.set(url, p);
  return p;
}

async function serveTile(res, src, z, x, y) {
  const s = SOURCES[src];
  const file = path.join(cacheDir, src, String(z), String(x), String(y) + s.ext);
  const type = s.ext === '.png' ? 'image/png' : 'image/jpeg';
  try {
    const data = await fs.promises.readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'X-Tile-Cache': 'hit', 'Cache-Control': 'max-age=86400' });
    return res.end(data);
  } catch {}
  try {
    const r = await upstream(src, s.url(z, x, y));
    if (!r.body) { res.writeHead(r.status === 404 ? 404 : 502); return res.end(); }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      await fs.promises.writeFile(file, r.body);
      stats.files++; stats.bytes += r.body.length;
    }
    res.writeHead(200, { 'Content-Type': r.type || type, 'X-Tile-Cache': 'miss', 'Cache-Control': 'max-age=86400' });
    res.end(r.body);
  } catch (e) {
    res.writeHead(502); res.end(String(e.message || e));
  }
}

// SPHEREx's current two-line elements (NORAD 63182) from CelesTrak, cached on disk and refreshed
// every 6 hours; a stale copy is served when CelesTrak cannot be reached.
const TLE_FILE = path.join(cacheDir, 'spherex.tle');
let tleFetch = null;
function serveTle(res) {
  const send = (txt) => { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' }); res.end(txt); };
  fs.stat(TLE_FILE, (err, st) => {
    if (!err && Date.now() - st.mtimeMs < 6 * 3600e3) return fs.readFile(TLE_FILE, 'utf8', (e, t) => (e ? (res.writeHead(500), res.end()) : send(t)));
    tleFetch ||= fetch('https://celestrak.org/NORAD/elements/gp.php?CATNR=63182&FORMAT=TLE', { headers: { 'User-Agent': 'SPHEREx-OpenWorld/1.0' } })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
      .then((t) => {
        if (!/^1 63182/m.test(t)) throw new Error('no TLE');
        fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(TLE_FILE, t); return t;
      })
      .finally(() => { tleFetch = null; });
    tleFetch.then(send, () => fs.readFile(TLE_FILE, 'utf8', (e, t) => (e ? (res.writeHead(502), res.end()) : send(t))));
  });
}

// SPHEREx's measured pointing, from the IRSA archive's spectral-image metadata (ObsCore, all Quick
// Release collections). One exposure = six detector images; their centres are averaged to the
// boresight. The archive trails real time by weeks, so /spherex/coverage says how far it reaches.
// Both answers are cached on disk (IRSA's TAP service takes ~20 s per query).
const POINT_DIR = path.join(cacheDir, 'pointing');
const irsaPending = new Map();
function irsaTap(query) {
  const url = 'https://irsa.ipac.caltech.edu/TAP/sync?FORMAT=csv&QUERY=' + encodeURIComponent(query);
  return fetch(url, { headers: { 'User-Agent': 'SPHEREx-OpenWorld/1.0' } })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`IRSA ${r.status}`))));
}
function cachedJson(file, maxAgeMs, make, res) {
  const send = (txt) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); res.end(txt); };
  fs.stat(file, (err, st) => {
    if (!err && Date.now() - st.mtimeMs < maxAgeMs) return fs.readFile(file, 'utf8', (e, t) => (e ? (res.writeHead(500), res.end()) : send(t)));
    if (!irsaPending.has(file)) {
      irsaPending.set(file, make().then((obj) => {
        const t = JSON.stringify(obj);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, t); return t;
      }).finally(() => irsaPending.delete(file)));
    }
    irsaPending.get(file).then(send, (e) => fs.readFile(file, 'utf8', (e2, t) => (e2 ? (res.writeHead(502), res.end(String(e.message))) : send(t))));
  });
}
function serveCoverage(res) {
  cachedJson(path.join(POINT_DIR, 'coverage.json'), 12 * 3600e3, () =>
    irsaTap("SELECT TOP 1 t_max FROM ivoa.obscore WHERE obs_collection LIKE 'spherex_qr%' AND t_max IS NOT NULL ORDER BY t_max DESC")
      .then((csv) => ({ lastMjd: Number(csv.trim().split(/\r?\n/)[1]) || null, checked: new Date().toISOString() })), res);
}
function servePointingDay(res, day) {
  const mjd0 = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 864e5 + 40587;
  cachedJson(path.join(POINT_DIR, day + '.json'), 30 * 864e5, () =>
    irsaTap(`SELECT obs_id, t_min, t_max, s_ra, s_dec FROM ivoa.obscore WHERE obs_collection LIKE 'spherex_qr%' AND t_min >= ${mjd0} AND t_min < ${mjd0 + 1} AND s_ra IS NOT NULL`)
      .then((csv) => {
        const exp = new Map();
        for (const line of csv.trim().split(/\r?\n/).slice(1)) {
          const [id, t0, t1, ra, dec] = line.split(',');
          const a = ra * Math.PI / 180, d = dec * Math.PI / 180;
          let e = exp.get(id);
          if (!e) exp.set(id, e = { id, t0: +t0, t1: +t1, v: [0, 0, 0] });
          e.t0 = Math.min(e.t0, +t0); e.t1 = Math.max(e.t1, +t1);
          e.v[0] += Math.cos(d) * Math.cos(a); e.v[1] += Math.cos(d) * Math.sin(a); e.v[2] += Math.sin(d);
        }
        const list = [...exp.values()].map((e) => {
          const l = Math.hypot(...e.v);
          return { id: e.id, t0: e.t0, t1: e.t1, v: e.v.map((x) => +(x / l).toFixed(6)) };
        }).sort((a, b) => a.t0 - b.t0);
        return { day, exposures: list };
      }), res);
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/tle/spherex') return serveTle(res);
  if (p === '/spherex/coverage') return serveCoverage(res);
  const pd = p.match(/^\/spherex\/pointing\/(\d{4}-\d{2}-\d{2})$/);
  if (pd) return servePointingDay(res, pd[1]);
  const m = p.match(/^\/tiles\/(s2|dem)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/);
  if (m) {
    const [z, x, y] = [m[2], m[3], m[4]].map(Number);
    if (z > 15 || x >= 2 ** z || y >= 2 ** z) { res.writeHead(400); return res.end(); }
    return serveTile(res, m[1], z, x, y);
  }
  if (p === '/tiles/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(stats));
  }
  if (p === '/tiles/clear' && req.method === 'POST') {
    fs.rm(cacheDir, { recursive: true, force: true }, () => {
      stats.files = 0; stats.bytes = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(stats));
    });
    return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root) || file.startsWith(cacheDir)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}).listen(port, () => console.log(`SPHEREx Open World running at http://localhost:${port}`));
