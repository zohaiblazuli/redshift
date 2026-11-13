import * as THREE from 'three';

// ---- OpenWorld grade: our own 3D LUT -------------------------------------------------------------
// The whole look (tone curve + colour grade) is one function, gradePixel(), baked at start-up into a
// 48^3 LUT over a log2 shaper and applied in the lens pass on the exposed HDR frame. To change the
// look, change gradePixel() and reload; GRADE_LUT_DOMAIN and the size only matter for precision.
//
// The look, for a camera in orbit:
//  - a little blue taken out of the haze veil (white balance), so land reads tan, not pink
//  - filmic tone curve on luminance with midtone contrast: deep sea and shadows, land mid-bright,
//    a long shoulder (clouds, glints and the white spacecraft roll off instead of clipping flat)
//  - hue kept through the curve; only the brightest highlights desaturate toward white, like film
//  - hue fixes for haze casts: pinks rotated to ochre, lavenders back to blue; land tones fuller,
//    saturated sea blues darker; a light vibrance lift
//  - cool shadows only; true black stays neutral (space, night)

export const GRADE_LUT_SIZE = 48;
export const GRADE_LUT_DOMAIN = [-12, 5];   // log2 of the exposed linear input, per channel

const gLuma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
// Narkowicz's ACES fit as the base S, with a gain into it and a power for a firmer toe
const gNarkowicz = (x) => (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
// The fit's own toe multiplies near-black by ~0.16, which erased moonlit land, airglow and dim
// suburbs; the added linear term (gone by ~0.3) keeps faint detail at ~65-80 % of its level.
const gToneCurve = (x) => Math.min(Math.max(gNarkowicz(GRADE.gain * x) + 0.45 * x * Math.exp(-x / 0.08), 0), 1);

// Live-tunable: __sx.grade.params (edit, then __sx.grade.rebuild()). Defaults are the shipped look.
export const GRADE = {
  // Neutral, photographic defaults (2026-11-13): a camera's curve and white balance, light touches
  // only where the haze makes colours read false (pink land, lavender sea, blue-grey land)
  gain: 0.6,          // exposure into the curve (lower: land sits mid-bright instead of near white)
  contrast: 0.35,     // extra midtone S around the curve's middle (0 = none)
  black: 0.16,        // black level (levels), applied after the LUT in the lens pass and scaled by how
                      // sunlit the view is (none at night, where it would erase faint lights)
  wb: [1.0, 1.0, 1.0],// white balance multipliers (neutral)
  pinkToOchre: 8,     // degrees: pinks/reds (hue ~350-20) rotated toward ochre
  violetToBlue: 8,    // degrees: violets/lavenders (hue ~240-290) rotated back toward blue
  violetDesat: 0.2,   // and desaturated
  seaDeepen: 0.08,    // value cut on saturated blues
  landSat: 0.06,      // saturation lift on ochre/orange/green land tones
  vibrance: 0.04,
  hiDesat: 0.45,      // highlight desaturation toward white above Lt ~0.75
  coolShadows: 0.0,   // blue tint in the shadows only (0 = neutral)
  hazeNeutral: 0.45,  // low-saturation blue-greys (haze veiling land) lose part of their blue cast; saturated sea keeps it
};
// smooth hue window (degrees), wrapping
const gHueWin = (h, centre, width) => {
  let d = Math.abs(h - centre) % 360; if (d > 180) d = 360 - d;
  return Math.exp(-(d * d) / (2 * width * width));
};

export function gradePixel(r, g, b) {
  const P = GRADE;
  // 0. white balance (luminance kept)
  const L0 = gLuma(r, g, b);
  if (L0 <= 1e-7) return [0, 0, 0];
  r *= P.wb[0]; g *= P.wb[1]; b *= P.wb[2];
  const kw = L0 / Math.max(gLuma(r, g, b), 1e-9); r *= kw; g *= kw; b *= kw;

  // 1. tone: curve on luminance, hue and saturation carried by the ratio
  const L = L0;
  let Lt = gToneCurve(L);
  // midtone contrast: an S around 0.4, zero at 0 and 1 so blacks and whites stay put
  // (faded out in the faint range, where it would erase dim lights and airglow at night)
  Lt = Math.min(Math.max(Lt + P.contrast * gSmooth(0.03, 0.2, Lt) * Lt * (1 - Lt) * (Lt - 0.4) * 2.5, 0), 1);
  let k = Lt / L;
  r *= k; g *= k; b *= k;
  // a channel still above 1 bleeds into the others (desaturates toward white) instead of clipping
  let m = Math.max(r, g, b);
  if (m > 1) { const w = (m - 1) / m; r = r / m * (1 - w) + w; g = g / m * (1 - w) + w; b = b / m * (1 - w) + w; }
  // film-like highlight desaturation in the top of the curve
  const hd = P.hiDesat * gSmooth(0.75, 1.0, Lt);
  r += (Lt - r) * hd; g += (Lt - g) * hd; b += (Lt - b) * hd;

  // 2. colour, in HSV
  let [h, s, v] = gRgbToHsv(r, g, b);
  const pink = gHueWin(h, 3, 16), violet = gHueWin(h, 262, 20), blue = gHueWin(h, 218, 20);
  const land = Math.max(gHueWin(h, 30, 18), gHueWin(h, 50, 16), gHueWin(h, 95, 35));
  h += P.pinkToOchre * pink - P.violetToBlue * violet;
  // haze over land reads as a weak blue-grey (sat ~0.2), open sea as a clear blue (sat ~0.45)
  const hazy = gHueWin(h, 205, 30) * (1 - gSmooth(0.16, 0.36, s));
  s *= (1 - P.violetDesat * violet) * (1 + P.landSat * land) * (1 - P.hazeNeutral * hazy);
  v *= 1 - P.seaDeepen * blue * gSmooth(0.2, 0.6, s);   // deeper sea, not deeper grey sky
  s += (1 - s) * s * P.vibrance;                         // vibrance: lifts muted colour most
  s = Math.min(s, 1);
  [r, g, b] = gHsvToRgb((h + 360) % 360, s, v);

  // 3. cool shadows only (luminance-neutral), faded out at black (space) and by the midtones
  const sh = P.coolShadows * gSmooth(0.0, 0.04, Lt) * (1 - gSmooth(0.1, 0.4, Lt));
  let tr = 1 - sh, tg = 1, tb = 1 + 2 * sh;
  const tl = gLuma(tr, tg, tb); tr /= tl; tg /= tl; tb /= tl;
  r *= tr; g *= tg; b *= tb;
  return [gClamp01(r), gClamp01(g), gClamp01(b)];
}

function gSmooth(a, b, x) { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }
function gClamp01(x) { return Math.min(Math.max(x, 0), 1); }
function gRgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return [(h + 360) % 360, mx > 1e-9 ? d / mx : 0, mx];
}
function gHsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

// Bake gradePixel() into a Data3DTexture (RGBA half float, trilinear). Input coordinate per channel:
// (log2(max(c, 2^lo)) - lo) / (hi - lo).
export function buildGradeLut(size = GRADE_LUT_SIZE) {
  const [lo, hi] = GRADE_LUT_DOMAIN;
  const data = new Uint16Array(size * size * size * 4);
  const toHalf = THREE.DataUtils.toHalfFloat;
  const val = (i) => (i === 0 ? 0 : Math.pow(2, lo + (i / (size - 1)) * (hi - lo)));
  let o = 0;
  for (let bz = 0; bz < size; bz++) for (let gy = 0; gy < size; gy++) for (let rx = 0; rx < size; rx++) {
    const [r, g, b] = gradePixel(val(rx), val(gy), val(bz));
    data[o++] = toHalf(r); data[o++] = toHalf(g); data[o++] = toHalf(b); data[o++] = toHalf(1);
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat; tex.type = THREE.HalfFloatType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// GLSL: apply the LUT to an exposed linear colour (output is display-linear, before sRGB encoding)
export const gradeLutGLSL = /* glsl */ `
uniform highp sampler3D tGradeLut;
uniform float uBlack;   // GRADE.black x day factor (set per frame in main.js)
// black level on luminance (hue kept): pulls the haze floor down in the mids, zero at black and white
vec3 applyBlackLevel(vec3 c){
  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (uBlack <= 0.0 || L <= 1e-5) return c;
  float Lb = max(L - uBlack * smoothstep(0.02, 0.25, L) * (1.0 - L), 0.0);
  return c * (Lb / L);
}
vec3 applyGradeLut(vec3 c){
  const float LO = ${GRADE_LUT_DOMAIN[0].toFixed(1)}, HI = ${GRADE_LUT_DOMAIN[1].toFixed(1)}, N = ${GRADE_LUT_SIZE.toFixed(1)};
  vec3 t = clamp((log2(max(c, vec3(exp2(LO)))) - LO) / (HI - LO), 0.0, 1.0);
  // channels at (near) zero sit on texel 0, which holds the graded value of exactly 0
  return texture(tGradeLut, t * ((N - 1.0) / N) + 0.5 / N).rgb;
}`;
