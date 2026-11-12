import * as THREE from 'three';

// Procedural spacecraft textures: crumpled MLI foil, solar cells, photon-shield skin.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Multi-scale Voronoi facets with random tilts: reads as crinkled multi-layer insulation.
export function makeFoilTextures(size = 1024, seed = 7) {
  const rand = mulberry32(seed);
  const n = size * size;
  const nx = new Float32Array(n), ny = new Float32Array(n), edge = new Float32Array(n), shade = new Float32Array(n);
  const layers = [[9, 0.34, 1.0], [23, 0.3, 0.8], [58, 0.2, 0.55], [140, 0.12, 0.3]];
  for (const [C, tilt, w] of layers) {
    const cnt = C * C;
    const px = new Float32Array(cnt), py = new Float32Array(cnt), cnx = new Float32Array(cnt), cny = new Float32Array(cnt), csh = new Float32Array(cnt);
    for (let i = 0; i < cnt; i++) {
      px[i] = rand(); py[i] = rand();
      const a = rand() * Math.PI * 2, m = Math.pow(rand(), 0.6) * tilt;
      cnx[i] = Math.cos(a) * m; cny[i] = Math.sin(a) * m; csh[i] = rand();
    }
    const s = C / size;
    for (let y = 0; y < size; y++) {
      const fy = (y + 0.5) * s, cy = Math.floor(fy);
      for (let x = 0; x < size; x++) {
        const fx = (x + 0.5) * s, cx = Math.floor(fx);
        let d1 = 1e9, d2 = 1e9, b = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const gy = cy + oy, wy = (gy + C) % C;
          for (let ox = -1; ox <= 1; ox++) {
            const gx = cx + ox, wx = (gx + C) % C, id = wy * C + wx;
            const dx = gx + px[id] - fx, dy = gy + py[id] - fy, d = dx * dx + dy * dy;
            if (d < d1) { d2 = d1; d1 = d; b = id; } else if (d < d2) d2 = d;
          }
        }
        const i = y * size + x;
        nx[i] += cnx[b] * w; ny[i] += cny[b] * w; shade[i] += (csh[b] - 0.5) * w;
        const e = (Math.sqrt(d2) - Math.sqrt(d1)) / s;
        edge[i] = Math.max(edge[i], Math.max(0, 1 - e / 1.6) * w);
      }
    }
  }
  const [cn, xn] = canvas(size, size), [cr, xr] = canvas(size, size), [cc, xc] = canvas(size, size);
  const inN = xn.createImageData(size, size), inR = xr.createImageData(size, size), inC = xc.createImageData(size, size);
  for (let i = 0; i < n; i++) {
    let ax = nx[i], ay = ny[i];
    const l = Math.hypot(ax, ay, 1);
    inN.data[i * 4] = (ax / l * 0.5 + 0.5) * 255;
    inN.data[i * 4 + 1] = (ay / l * 0.5 + 0.5) * 255;
    inN.data[i * 4 + 2] = (1 / l * 0.5 + 0.5) * 255;
    inN.data[i * 4 + 3] = 255;
    const r = Math.min(1, 0.2 + edge[i] * 0.3 + Math.abs(shade[i]) * 0.12);
    inR.data[i * 4] = inR.data[i * 4 + 1] = inR.data[i * 4 + 2] = r * 255; inR.data[i * 4 + 3] = 255;
    const c = Math.max(0, Math.min(1, 0.9 + shade[i] * 0.12 - edge[i] * 0.22));
    inC.data[i * 4] = inC.data[i * 4 + 1] = inC.data[i * 4 + 2] = c * 255; inC.data[i * 4 + 3] = 255;
  }
  xn.putImageData(inN, 0, 0); xr.putImageData(inR, 0, 0); xc.putImageData(inC, 0, 0);
  return { normal: tex(cn, false), rough: tex(cr, false), color: tex(cc, true) };
}

// Solar array: dark-blue cells with fingers, busbars, clipped corners and silver interconnect gaps.
export function makeSolarTextures() {
  const W = 2048, H = 1152, cols = 22, rows = 12, m = 22, gap = 5;
  const rand = mulberry32(42);
  const [c, x] = canvas(W, H), [d, y] = canvas(W, H);
  x.fillStyle = '#8f959e'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#6d727a'; x.fillRect(0, 0, W, m); x.fillRect(0, H - m, W, m); x.fillRect(0, 0, m, H); x.fillRect(W - m, 0, m, H);
  y.fillStyle = 'rgb(0,135,150)'; y.fillRect(0, 0, W, H);
  const cw = (W - 2 * m) / cols, ch = (H - 2 * m) / rows;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x0 = m + i * cw + gap / 2, y0 = m + j * ch + gap / 2, w = cw - gap, h = ch - gap;
    const l = 7 + rand() * 4, hue = 220 + rand() * 8;
    const g = x.createLinearGradient(x0, y0, x0 + w, y0 + h);
    g.addColorStop(0, `hsl(${hue},60%,${l + 3}%)`); g.addColorStop(1, `hsl(${hue + 4},55%,${l}%)`);
    x.fillStyle = g; x.fillRect(x0, y0, w, h);
    x.strokeStyle = 'rgba(140,155,190,0.13)'; x.lineWidth = 1;
    for (let k = 1; k < 22; k++) { const yy = y0 + (h * k) / 22; x.beginPath(); x.moveTo(x0, yy); x.lineTo(x0 + w, yy); x.stroke(); }
    x.fillStyle = 'rgba(170,178,192,0.55)';
    x.fillRect(x0 + w * 0.32, y0, 2, h); x.fillRect(x0 + w * 0.68, y0, 2, h);
    const cc = 6; x.fillStyle = '#7f858e';
    for (const [px, py, sx, sy] of [[x0, y0, 1, 1], [x0 + w, y0, -1, 1], [x0, y0 + h, 1, -1], [x0 + w, y0 + h, -1, -1]]) {
      x.beginPath(); x.moveTo(px, py); x.lineTo(px + cc * sx, py); x.lineTo(px, py + cc * sy); x.closePath(); x.fill();
    }
    y.fillStyle = 'rgb(0,26,0)'; y.fillRect(x0, y0, w, h);
    y.fillStyle = 'rgb(0,70,255)'; y.fillRect(x0 + w * 0.32, y0, 3, h); y.fillRect(x0 + w * 0.68, y0, 3, h);
  }
  const map = tex(c, true), data = tex(d, false);
  map.wrapS = map.wrapT = data.wrapS = data.wrapT = THREE.ClampToEdgeWrapping;
  return { map, data };
}

// Photon shield skin: off-white panels, gore seams with rivet rows, joint bands, smudges.
export function makeShieldTextures(gores = 16) {
  const W = 2048, H = 1024;
  const rand = mulberry32(99);
  const [c, x] = canvas(W, H), [d, y] = canvas(W, H);
  x.fillStyle = '#eceef0'; x.fillRect(0, 0, W, H);
  y.fillStyle = 'rgb(128,96,0)'; y.fillRect(0, 0, W, H);
  for (let i = 0; i < 700; i++) {
    const px = rand() * W, py = rand() * H, r = 20 + rand() * 140;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    const dark = rand() < 0.5;
    g.addColorStop(0, dark ? `rgba(145,148,152,${0.04 + rand() * 0.05})` : `rgba(255,255,255,${0.05 + rand() * 0.08})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r);
    const g2 = y.createRadialGradient(px, py, 0, px, py, r);
    g2.addColorStop(0, `rgba(128,${dark ? 140 : 70},0,0.25)`); g2.addColorStop(1, 'rgba(128,96,0,0)');
    y.fillStyle = g2; y.fillRect(px - r, py - r, 2 * r, 2 * r);
  }
  const rivet = (px, py) => {
    x.fillStyle = 'rgba(165,165,170,0.7)'; x.beginPath(); x.arc(px, py, 1.7, 0, 7); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.6)'; x.beginPath(); x.arc(px - 0.5, py - 0.5, 0.8, 0, 7); x.fill();
    y.fillStyle = 'rgb(175,60,0)'; y.beginPath(); y.arc(px, py, 1.8, 0, 7); y.fill();
  };
  for (let k = 0; k < gores; k++) {
    const sx = (k * W) / gores;
    x.fillStyle = 'rgba(110,110,116,0.45)'; x.fillRect(sx - 1, 0, 2, H);
    x.fillStyle = 'rgba(255,255,255,0.4)'; x.fillRect(sx + 1.5, 0, 1, H);
    y.fillStyle = 'rgb(80,140,0)'; y.fillRect(sx - 1.5, 0, 3, H);
    for (let py = 20; py < H; py += 44) rivet(sx + 8, py);
  }
  for (const fy of [0.03, 0.36, 0.7, 0.975]) {
    const py = fy * H;
    x.fillStyle = 'rgba(110,110,116,0.4)'; x.fillRect(0, py - 1, W, 2);
    x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(0, py + 1.5, W, 1);
    y.fillStyle = 'rgb(80,135,0)'; y.fillRect(0, py - 1.5, W, 3);
    for (let px = 12; px < W; px += 40) rivet(px, py + 8);
  }
  const map = tex(c, true), data = tex(d, false);
  map.wrapT = data.wrapT = THREE.ClampToEdgeWrapping;
  return { map, data };
}

// Honeycomb-composite panel back / radiator.
export function makePanelBackTexture() {
  const [c, x] = canvas(512, 512);
  x.fillStyle = '#9da3ab'; x.fillRect(0, 0, 512, 512);
  x.strokeStyle = 'rgba(70,74,80,0.5)'; x.lineWidth = 2;
  for (let i = 0; i <= 512; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 512); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(512, i); x.stroke(); }
  return tex(c, true);
}
