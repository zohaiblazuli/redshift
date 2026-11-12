import { TYPES, TYPE_ORDER } from '../../CloudWorks/src/cloudcore.js';

// ---------------------------------------------------------------------------------------------
// Per-genus statistics, measured from the generated CloudWorks atlas (phase 2 of the CloudWorks
// integration). The far field draws clouds smaller than a pixel from these numbers instead of their
// shapes, so they come from the shapes themselves and follow any change made in CloudWorks.
//
// For each genus (shape seed as generated, CloudWorks size `size`, density 1):
//   - column optical depth of every vertical column through the shape (the clouds' footprint is
//     where it exceeds 0.3, about where a satellite calls a pixel cloudy) and its mean over the footprint;
//   - in-cloud extinction by height: the mean over the footprint, in 1/km, on CW_PROFILE_BINS
//     levels from the cloud's lowest to its highest occupied level;
//   - thickness (km) and aspect (thickness / footprint width), for how much a field of this genus
//     covers when seen at a slant.
// Shape units: the atlas box is +-3.7 x 2.6 x 2.8 units; one unit is size x TYPES[t].scale metres.
// Extinction per unit is density x 22 (CloudWorks' sampleCloud scale).
// ---------------------------------------------------------------------------------------------

export const CW_PROFILE_BINS = 64;
// footprint: columns above 0.3 optical depth (about where a satellite calls a pixel cloudy), or above
// 15 % of the densest column for veils thinner than that (cirrostratus)
const CW_FOOTPRINT_TAU = 0.3, CW_FOOTPRINT_REL = 0.15;

// Column sums (x, z) and level sums (y) of one genus's coarse atlas density.
export const cwStatsColumnFS = (common, dims) => `${common}
uniform float uSlab;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  int off = ${dims.FD} * (int(uSlab) - 1);
  float s = 0.;
  for (int y = 0; y < ${dims.FH}; y++) s += texelFetch(families, ivec3(c.x, y, c.y + off), 0).r;
  frag = vec4(s, 0, 0, 1);
}`;
// Row sums over x, one pixel per (y, z); the CPU adds the rows up into level sums. (A single pass
// summing whole levels -- ~35 000 reads per pixel -- was long enough for the driver to fail the
// next frame's draw.)
export const cwStatsLevelFS = (common, dims) => `${common}
uniform float uSlab;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);          // x: level y, y: layer z
  int off = ${dims.FD} * (int(uSlab) - 1);
  float s = 0.;
  for (int x = 0; x < ${dims.FW}; x++) s += texelFetch(families, ivec3(x, c.x, c.y + off), 0).r;
  frag = vec4(s, 0, 0, 1);
}`;
// FH x FD row sums -> FH level sums
export function cwLevelsFromRows(rows, dims) {
  const levels = new Float32Array(dims.FH);
  for (let z = 0; z < dims.FD; z++) for (let y = 0; y < dims.FH; y++) levels[y] += rows[z * dims.FH + y];
  return levels;
}

// Mean of the families' edge-detail factor in sampleCloud, 1 - smoothstep(.25,.85,fine)*.18, over
// CloudWorks' detail noise (64^3, trilinear, wrapped), by Monte Carlo.
export function cwDetailMean(noise, samples = 200000) {
  const N = 64, at = (x, y, z) => noise[(((z % N) + N) % N) * N * N + (((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const tri = (p) => {
    // texture() at coordinate p (in texels, texel centres at .5)
    const x = p[0] - 0.5, y = p[1] - 0.5, z = p[2] - 0.5, ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz, l = (a, b, t) => a + (b - a) * t;
    return l(l(l(at(ix, iy, iz), at(ix + 1, iy, iz), fx), l(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), fx), fy),
      l(l(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), fx), l(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), fx), fy), fz);
  };
  let seed = 12345, sum = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < samples; i++) {
    const p = [rnd() * 7.4 - 3.7, rnd() * 5.2 - 2.6, rnd() * 5.6 - 2.8];
    const fine = tri(p.map((v) => v * 0.43 * N)) * 0.68 + tri([(p[0] * 0.91 + 0.17) * N, (p[1] * 0.91 + 0.31) * N, (p[2] * 0.91 + 0.53) * N]) * 0.32;
    const t = Math.min(Math.max((fine - 0.25) / 0.6, 0), 1);
    sum += 1 - t * t * (3 - 2 * t) * 0.18;
  }
  return sum / samples;
}

// Turns one genus's column and level sums into its far-field numbers.
//   cols: FW x FD sums of coarse density over y; levels: FH sums over x, z.
export function cwGenusStats(t, cols, levels, dims, size, detailMean) {
  const P = TYPES[t], sc = size * P.scale;                 // metres per shape unit
  const dy = 5.2 / dims.FH, cell = (7.4 / dims.FW) * (5.6 / dims.FD);
  const k = detailMean * 22 * P.density;                   // extinction per unit, per unit coarse density
  let tauMax = 0;
  for (let i = 0; i < cols.length; i++) tauMax = Math.max(tauMax, cols[i] * dy * k);
  const threshold = Math.min(CW_FOOTPRINT_TAU, CW_FOOTPRINT_REL * tauMax);
  let nFoot = 0, tauSum = 0, radius2 = 0;
  for (let i = 0; i < cols.length; i++) {
    const tau = cols[i] * dy * k;
    if (tau > threshold) { nFoot++; tauSum += tau; }
    // reach of the cloud from the box centre: the farthest column with any visible cloud
    if (tau > 0.02 * tauMax) {
      const x = -3.7 + ((i % dims.FW) + 0.5) / dims.FW * 7.4, z = -2.8 + (Math.floor(i / dims.FW) + 0.5) / dims.FD * 5.6;
      radius2 = Math.max(radius2, x * x + z * z);
    }
  }
  if (!nFoot) return null;
  // vertical span: levels holding more than 1 % of the peak
  let peak = 0;
  for (const v of levels) peak = Math.max(peak, v);
  let y0 = 0, y1 = levels.length - 1;
  while (y0 < y1 && levels[y0] < peak * 0.01) y0++;
  while (y1 > y0 && levels[y1] < peak * 0.01) y1--;
  const spanUnits = (y1 - y0 + 1) * dy, thicknessKm = spanUnits * sc / 1000;
  // in-cloud extinction (1/km) by relative height, mean over the footprint
  const profile = new Float32Array(CW_PROFILE_BINS);
  for (let b = 0; b < CW_PROFILE_BINS; b++) {
    const y = y0 + (b + 0.5) / CW_PROFILE_BINS * (y1 - y0 + 1) - 0.5, i = Math.floor(y), f = y - i;
    const v = (levels[Math.max(i, y0)] ?? 0) * (1 - f) + (levels[Math.min(i + 1, y1)] ?? 0) * f;
    profile[b] = v;
  }
  // the level sums include faint columns outside the footprint: keep the profile's shape, scaled
  // so a column through it has the footprint's mean optical depth
  const tauMean = tauSum / nFoot, integral = profile.reduce((a, v) => a + v, 0) / CW_PROFILE_BINS * thicknessKm;
  for (let b = 0; b < CW_PROFILE_BINS; b++) profile[b] *= tauMean / Math.max(integral, 1e-9);
  const widthUnits = Math.sqrt(nFoot * cell);
  return {
    // shape units: the cloud's reach from the box centre, and its lowest occupied level
    radiusUnits: Math.sqrt(radius2), yLowUnits: -2.6 + y0 * dy, footprintKm2: nFoot * cell * (sc / 1000) ** 2,
    genus: t, scaleM: sc, thicknessKm, tauMean, threshold,
    footprint: nFoot / cols.length, aspect: spanUnits / widthUnits,
    highestBaseKm: P.alt[1] / 1000, profile,
    // profile integral, as a check: should equal tauMean
    tauFromProfile: profile.reduce((s, v) => s + v, 0) / CW_PROFILE_BINS * thicknessKm,
  };
}

// Size variation of placed clouds (CloudWorks' own instances vary 0.72-1.28).
export const CW_MID_SIZE = [0.78, 1.22];

// The far and mid fields' tables:
//   prof    CW_PROFILE_BINS x 10 profile texture (R32F, row = genus in TYPE_ORDER)
//   genus   vec4 per genus: thickness km, mean column optical depth, aspect, highest natural base km
//   midA    vec4 per genus: km per shape unit, grid cell km, footprint km^2, lowest cloud level (units)
//   midB    vec4 per genus: density, atlas slab, cloud reach km, -
// A grid cell is as wide as the largest variant of its cloud, so every cloud stays inside its cell
// and a point only ever looks at its own cell.
export function cwFarTables(stats) {
  const n = TYPE_ORDER.length, prof = new Float32Array(CW_PROFILE_BINS * n), genus = new Float32Array(n * 4);
  const midA = new Float32Array(n * 4), midB = new Float32Array(n * 4);
  TYPE_ORDER.forEach((t, g) => {
    const s = stats[g];
    if (!s) return;
    prof.set(s.profile, g * CW_PROFILE_BINS);
    genus.set([s.thicknessKm, s.tauMean, s.aspect, s.highestBaseKm], g * 4);
    const km = s.scaleM / 1000, reach = s.radiusUnits * km;
    midA.set([km, 2 * reach * CW_MID_SIZE[1] * 1.02, s.footprintKm2, s.yLowUnits], g * 4);
    midB.set([TYPES[t].density, g + 1, reach, 0], g * 4);
  });
  return { prof, genus, midA, midB };
}
