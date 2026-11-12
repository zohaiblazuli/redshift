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

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
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
