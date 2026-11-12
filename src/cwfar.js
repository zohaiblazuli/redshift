import { CW_PROFILE_BINS } from './cwstats.js';

// ---------------------------------------------------------------------------------------------
// Far field of the CloudWorks clouds over the planet (phase 2 of the CloudWorks integration):
// the observed day, classified into the ten genera, drawn from the per-genus statistics.
//
// Observations (data/clouds/<date>/, baked by tools/bake_clouds.py from NASA GIBS):
//   coverage.webp  8192 x 4096  cloud fraction (~5 km)
//   properties.png 2048 x 1024  R cover (box-averaged), G cloud-top height /16 km,
//                               B optical depth (log1p, /log1p(150)), A ice fraction
//   terrain.png    4096 x 2048  ground elevation, 36 m per step
//
// Per ~5 km cell, cloud-top height x optical depth (the ISCCP classes, plus cover for cellular vs
// layered and ice for high cloud) give weights for the ten genera; the three strongest are drawn.
// Each genus keeps its measured in-cloud extinction profile, scaled so its column optical depth is
// the observed one, between the observed top and a base from its thickness (never above its natural
// band, never below the ground). Clouds are smaller than a pixel here, so a cell is drawn as a
// mixture: the cloud as it is (in-cloud density and light) over the covered fraction, clear air
// over the rest. Seen at a slant, a field of tall clouds covers more of the view than of the ground.
//
// Mid field (phase 3): where a genus's clouds span more than a few pixels, its real CloudWorks
// shapes are drawn instead, placed per cell on jittered grids (cwMidGLSL), crossfading with the far
// field by pixel footprint.
// ---------------------------------------------------------------------------------------------

// ISCCP-style weights for the ten genera (TYPE_ORDER: Ci, Cs, Cc, Ac, As, Ns, St, Sc, Cu, Cb).
// Mirrored in Python for checking class shares on a baked day; keep the two in step.
export const cwClassifyGLSL = /* glsl */ `
float cwSs(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
void cwClassify(float top, float tau, float cov, float ice, out float w[10]){
  float high = max(cwSs(5.6, 7.0, top), ice * cwSs(4.5, 6.0, top));
  float low = min(1. - cwSs(2.6, 3.8, top), 1. - high);
  float mid = clamp(1. - low - high, 0., 1.);
  float thin = 1. - cwSs(2.6, 4.6, tau), thick = cwSs(17., 30., tau), med = clamp(1. - thin - thick, 0., 1.);
  float brk = 1. - cwSs(0.55, 0.85, cov), conv = cwSs(8.0, 10.0, top);
  w[0] = high * thin * (1. - .5 * brk);                               // cirrus
  w[1] = high * med * (1. - .35 * brk) + high * thick * (1. - conv);  // cirrostratus
  w[2] = high * (thin * .5 * brk + med * .35 * brk);                  // cirrocumulus
  w[3] = mid * (thin + med * .6 * brk);                               // altocumulus
  w[4] = mid * med * (1. - .6 * brk);                                 // altostratus
  w[5] = mid * thick;                                                 // nimbostratus
  w[6] = low * (thick + thin * (1. - brk) * .5);                      // stratus
  w[7] = low * (med * (1. - .5 * brk) + thin * (1. - brk) * .5);      // stratocumulus
  w[8] = low * (thin * brk + med * .5 * brk);                         // cumulus
  w[9] = high * thick * conv;                                         // cumulonimbus
}`;

// highest-cloud-top map (cwHiMaxBaseFS): size and levels
export const CW_HIMAX_W = 2048, CW_HIMAX_H = 1024, CW_HIMAX_LEVELS = 4;

const cwWeatherGLSL = /* glsl */ `
${cwClassifyGLSL}
uniform sampler2D uCwCov, uCwProps, uCwTerrain;
uniform sampler2D uCwProf;     // ${CW_PROFILE_BINS} x 10 R32F: in-cloud extinction (1/km) by relative height
uniform vec4 uCwGenus[10];     // thickness km, mean column optical depth, aspect, highest natural base km
uniform float uCwCover;        // overall cover multiplier (1 = as observed)
const float CW_TOP = 16.5;     // highest cloud top, km

struct CwWx { float c, lo, hi, aspect; vec3 w, m, base, top; ivec3 g; };

CwWx cwWeather(vec3 n, float lod){
  CwWx x;
  vec2 uv = dirToEquirect(n);
  // observed fraction: below ~8 % it is haze or surface brightness, not cloud
  x.c = clamp((textureLod(uCwCov, uv, lod).r - .08) / .92, 0., 1.) * uCwCover;
  vec4 pr = textureLod(uCwProps, uv, max(lod - 2., 0.));
  float top = max(pr.g * 16., .6), tau = max(exp(pr.b * 5.0173) - 1., .3), ice = pr.a;
  float ground = max(textureLod(uCwTerrain, uv, 0.).r * 9.18, 0.);
  float w[10];
  cwClassify(top, tau, pr.r, ice, w);
  // the three strongest genera
  ivec3 gi = ivec3(0); vec3 gw = vec3(0);
  for (int k = 0; k < 10; k++){
    float v = w[k];
    if (v > gw.x){ gw = vec3(v, gw.xy); gi = ivec3(k, gi.xy); }
    else if (v > gw.y){ gw = vec3(gw.x, v, gw.y); gi = ivec3(gi.x, k, gi.y); }
    else if (v > gw.z){ gw.z = v; gi.z = k; }
  }
  x.w = gw / max(gw.x + gw.y + gw.z, 1e-4);
  x.g = gi;
  x.lo = 1e9; x.hi = -1e9; x.aspect = 0.;
  for (int k = 0; k < 3; k++){
    vec4 G = uCwGenus[gi[k]];
    float tp = max(top, ground + .3 + .3 * G.x);
    float bs = max(ground + .3, min(tp - G.x, G.w));
    tp = min(max(tp, bs + .3 * G.x), CW_TOP);
    // stretched over [base, top]: the column keeps the observed optical depth
    float stretch = (tp - bs) / max(G.x, .01);
    x.base[k] = bs; x.top[k] = tp;
    x.m[k] = clamp(tau / max(G.y * stretch, 1e-3), .0625, 16.);
    if (x.w[k] > .01){ x.lo = min(x.lo, bs); x.hi = max(x.hi, tp); }
    x.aspect += x.w[k] * G.z;
  }
  return x;
}

// in-cloud extinction (1/km) at altitude alt (km above sea level) in a cell, each genus weighted by
// wf (its share drawn by the far field)
float cwSigmaW(CwWx x, float alt, vec3 wf){
  float s = 0.;
  for (int k = 0; k < 3; k++){
    if (x.w[k] * wf[k] < .01) continue;
    float h = (alt - x.base[k]) / max(x.top[k] - x.base[k], .01);
    if (h <= 0. || h >= 1.) continue;
    s += x.w[k] * wf[k] * x.m[k] * textureLod(uCwProf, vec2((h * ${CW_PROFILE_BINS - 1}. + .5) / ${CW_PROFILE_BINS}., (float(x.g[k]) + .5) / 10.), 0.).r;
  }
  return s;
}
float cwSigma(CwWx x, float alt){ return cwSigmaW(x, alt, vec3(1.)); }

// share of the view a cell's clouds cover along a ray with vertical cosine mu
float cwViewCover(float c, float aspect, float mu){
  float tanT = min(sqrt(max(1. - mu * mu, 0.)) / max(abs(mu), 1e-3), 6.);
  return 1. - pow(1. - min(c, .999), 1. + aspect * tanT);
}
// observed cover at a point (bilinear, so cell edges stay smooth)
float cwCoverAt(vec3 n, float lod){ return clamp((textureLod(uCwCov, dirToEquirect(n), lod).r - .08) / .92, 0., 1.) * uCwCover; }

// Ray length from a point (altitude alt, vertical cosine muV) that surely meets no cloud: the
// air above every cloud top for 20-160 km around (cwHiMaxBaseFS). 0 where clouds may be near.
uniform sampler2D uCwHiMax;
float cwClearJump(vec3 n, float alt, float muV){
  vec2 uv = dirToEquirect(n);
  float sinH = max(sqrt(max(1. - muV * muV, 0.)), 1e-3), lat = abs(asin(clamp(n.y, -1., 1.))), j = 0.;
  for (int l = 0; l < ${CW_HIMAX_LEVELS}; l++){
    ivec2 sz = ivec2(${CW_HIMAX_W}, ${CW_HIMAX_H}) >> l;
    float hm = texelFetch(uCwHiMax, min(ivec2(uv * vec2(sz)), sz - 1), l).r;
    if (alt <= hm) continue;
    // level l holds the highest top over this texel and its neighbours: a point in it is at least
    // one texel (narrowest at the block's poleward edge) from anything higher
    float ang = PI / float(sz.y);
    float r = Rg * ang * cos(min(lat + 2. * ang, 1.5707));
    j = max(j, min(r / sinH, muV < 0. ? (alt - hm) / -muV : 1e9));
  }
  return j;
}
`;

// Highest cloud top (km above sea level, 0 where there is no cloud) around each place, for
// skipping the air above the clouds. Level 0 at the properties' resolution (~20 km); level l holds
// the maximum over a texel of 2^l base texels and its eight neighbours. Built once per day.
export const cwHiMaxBaseFS = (common, lightingGLSL) => `${common}
precision highp sampler2D;
${lightingGLSL.replace(/#version[^\n]*\n/, '')}
${cwWeatherGLSL}
void main(){
  ivec2 ij = ivec2(gl_FragCoord.xy);
  // any cover in the texel (4 x 4 coverage texels each)
  bool cov = false;
  for (int b = 0; b < 4; b++) for (int a = 0; a < 4; a++) cov = cov || texelFetch(uCwCov, ij * 4 + ivec2(a, b), 0).r > .08;
  float hi = 0.;
  // the band's top at the texel centre and its four terrain texels (the observations are bilinear
  // between texel centres: a neighbour's own centre is in its own texel and block)
  if (cov) for (int k = 0; k < 5; k++){
    vec2 o = k == 4 ? vec2(.5) : vec2(float(k & 1), float(k >> 1)) * .5 + .25;
    vec2 uv = (vec2(ij) + o) / vec2(${CW_HIMAX_W}., ${CW_HIMAX_H}.);
    float lon = (uv.x - .5) * 2. * PI, lat = (uv.y - .5) * PI;
    CwWx x = cwWeather(vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon)), 0.);
    hi = max(hi, x.hi + .3);   // margin: coarser weather lookups classify a blend
  }
  frag = vec4(hi, 0., 0., 1.);
}`;
export const cwHiMaxDilateFS = /* glsl */ `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uBase;
uniform int uLevel;
out vec4 frag;
void main(){
  int s = 1 << uLevel;
  ivec2 ij = ivec2(gl_FragCoord.xy) * s;
  float m = 0.;
  for (int b = -s; b < 2 * s; b++){
    int y = clamp(ij.y + b, 0, ${CW_HIMAX_H - 1});
    for (int a = -s; a < 2 * s; a++) m = max(m, texelFetch(uBase, ivec2((ij.x + a + ${CW_HIMAX_W}) % ${CW_HIMAX_W}, y), 0).r);
  }
  frag = vec4(m, 0., 0., 1.);
}`;

// Mid field: real CloudWorks shapes, placed per cell on jittered grids over an equal-angle cube.
// (Grid layout as OpenWorld's earlier Blender-model clouds: three offset grids per genus, each
// cell holding at most one cloud, with a probability that makes the clouds' footprints add up to
// the observed cover.)
const cwMidGLSL = (dims) => /* glsl */ `
uniform vec4 uCwMidA[10];   // km per shape unit, grid cell km, footprint km^2, lowest cloud level (units)
uniform vec4 uCwMidB[10];   // density, atlas slab, cloud reach km, -
uniform float uCwLodScale;  // display pixel / cloud-target pixel: shapes are sampled for the display
uniform highp sampler3D emptyDist;   // per genus, 32 x 24 x 24 cells: Chebyshev distance to cloud
// Near field: CloudWorks' far self-shadow cache (cwBakeGLSL) per genus x orientation, baked for the
// sun in the face frame around the camera (uCwNearLf: the sun in shape units, before an instance's
// own turn), used within uCwNear.y km of the camera (uCwNearC, world km) on cube face uCwNear.x.
uniform highp sampler3D uCwShadow;
uniform vec3 uCwNearLf, uCwNearC;
uniform vec4 uCwNear;       // face, range km, on (0 / 1), -
const float CW_SIZE0 = .78, CW_SIZE1 = 1.22;

vec4 cwPcg4(vec4 f){
  uvec4 v = uvec4(ivec4(floor(f)) + 1048576) * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> 16u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return vec4(v) * (1. / 4294967295.);
}
// cube face (0..5) of a direction, equal-angle face coordinates in km, and the face across the
// nearest edge
int cwCubeFace(vec3 n){
  vec3 a = abs(n);
  if (a.x >= a.y && a.x >= a.z) return n.x > 0. ? 0 : 1;
  if (a.y >= a.z) return n.y > 0. ? 2 : 3;
  return n.z > 0. ? 4 : 5;
}
vec2 cwFaceUv(vec3 n, int f){
  vec3 m = f < 2 ? n.xzy : (f < 4 ? n.yxz : n.zxy);
  float s = (f == 0 || f == 2 || f == 4) ? 1. : -1.;
  return vec2(atan(m.y * s, m.x * s), atan(m.z, m.x * s)) * Rg;
}
int cwSideFace(vec3 n, int f){
  vec3 a = abs(n);
  if (f < 2) return a.y > a.z ? (n.y > 0. ? 2 : 3) : (n.z > 0. ? 4 : 5);
  if (f < 4) return a.x > a.z ? (n.x > 0. ? 0 : 1) : (n.z > 0. ? 4 : 5);
  return a.x > a.y ? (n.x > 0. ? 0 : 1) : (n.y > 0. ? 2 : 3);
}

// CloudWorks' sampleCloud for the generated genera, with an explicit level of detail (the atlas
// and detail noise have mipmaps here; implicit derivatives are undefined inside a ray march).
float cwFamily(vec3 p, float slab, float lod, float lodD){
  vec3 q = p / (bounds * 2.) + .5;
  if (any(lessThan(q, vec3(0))) || any(greaterThan(q, vec3(1)))) return 0.;
  float d = textureLod(families, familyCoord(q, slab), lod).r;
  if (d < .001) return 0.;
  float fine = textureLod(detail, p * .43, lodD).r * .68 + textureLod(detail, p * .91 + vec3(.17, .31, .53), lodD).r * .32;
  return d * (1. - smoothstep(.25, .85, fine) * .18);
}

// Distance (shape units) from local point lp to the nearest cloud a shape sampled at level of
// detail lod can hold, from the atlas's empty-distance grid (Groundview's empty-space skipping):
// 0 where a cell may hold cloud. Outside the box, the distance to it.
float cwEmptyUnits(vec3 lp, float slab, float lod){
  vec3 b2 = bounds * 2., q = lp / b2 + .5;
  vec3 out3 = max(abs(lp) - bounds, 0.);
  if (any(greaterThan(out3, vec3(0.)))) return length(out3);
  const vec3 G = vec3(32., 24., 24.);
  vec3 cell = min(floor(q * G), G - 1.);
  float e = texelFetch(emptyDist, ivec3(cell) + ivec3(0, 0, int(slab) * 24), 0).r * 255.;
  if (e < .5) return 0.;
  // inside the cube of empty cells around this one; mip levels reach further than the base level
  vec3 lo = (cell - (e - 1.)) / G * b2 - bounds, hi = (cell + e) / G * b2 - bounds;
  vec3 dd = min(lp - lo, hi - lp);
  return max(min(dd.x, min(dd.y, dd.z)) - (lod > 0. ? .0343 * exp2(lod + 1.) : 0.), 0.);
}

// Extinction (1/km) of one genus's clouds around face coordinate F (km), at altitude alt, for a
// cell of the observed day: base and vertical scale of the field, density multiplier m, the
// genus's share of the cover c, and the pixel footprint fp (km). safe (face km) shrinks to the
// distance within which these clouds are surely empty.
float cwMidFace(int g, int face, vec2 F, float alt, float base, float vscale, float m, float c, float fp, inout float safe){
  vec4 A = uCwMidA[g], B = uCwMidB[g];
  float km = A.x, cell = A.y, reach = B.z, e = 0.;
  // three grids, each cell holding a cloud with this probability: their footprints add up to c
  float pres = clamp(c * cell * cell / (3. * A.z), 0., 1.);
  for (int j = 0; j < 3; j++){
    vec2 off = vec2(j == 1 ? .37 : (j == 2 ? .71 : 0.), j == 1 ? .71 : (j == 2 ? .29 : 0.)) * cell;
    vec2 gc = (F + off) / cell, cid = floor(gc), fc = gc - cid;
    // the other cells' clouds stay inside their cells
    float edge = min(min(fc.x, 1. - fc.x), min(fc.y, 1. - fc.y)) * cell;
    vec4 h = cwPcg4(vec4(cid, float(face * 16 + g), float(j)));
    if (h.x >= pres){ safe = min(safe, edge); continue; }
    float sz = mix(CW_SIZE0, CW_SIZE1, h.y), s = km * sz, r = reach * sz;
    vec2 ctr = (cid + .5) * cell - off + (h.zw - .5) * max(cell - 2. * r, 0.);
    vec2 d = F - ctr;
    float dl = length(d);
    // outside this cell's cloud (or it belongs to the next face)
    if (max(abs(ctr.x), abs(ctr.y)) > .7853982 * Rg || dl >= r){ safe = min(safe, min(edge, max(dl - r, 0.))); continue; }
    vec4 h2 = cwPcg4(vec4(cid, float(face * 16 + g) + .5, float(j) + 7.));
    // CloudWorks' orientations: 45 degree turns, mirrored on odd steps
    vec3 lp = toLocal(vec3(d.x, 0., d.y), int(h2.x * 8.)) / s;
    float sv = s * vscale;
    lp.y = A.w + (alt - base) / sv;
    // level of detail for the display pixel (the image is upsampled from the cloud target): a
    // coarse trilinear atlas seen through dense cloud turns into flat-faced blocks
    float fpd = fp * uCwLodScale;
    float lod = max(log2(fpd / (${(7.4 / dims.FW).toFixed(6)} * s)), 0.);
    // known-empty air inside the box: no atlas or detail reads (a ball of radius u units is at
    // least u * min(s, sv) km across)
    float u = cwEmptyUnits(lp, B.y, lod);
    if (u > 0.){ safe = min(safe, min(edge, u * min(s, sv))); continue; }
    safe = 0.;
    float lodD = max(log2(fpd / (.0363 * s)), 0.);
    e += cwFamily(lp, B.y, lod, lodD) * B.x * m * mix(.85, 1.15, h2.y) * 22. / sv;
  }
  return e;
}

// mid-field extinction of a cell's k-th genus at a point (with the neighbouring face's clouds near
// a cube edge); safe (km) shrinks to the radius around the point these clouds surely leave empty
float cwMid(CwWx x, int k, vec3 n, float alt, float fp, inout float safe){
  int g = x.g[k];
  float vscale = clamp((x.top[k] - x.base[k]) / max(uCwGenus[g].x, .01), .75, 1.5);
  // the stretch the far field gives the genus, partly taken by the shape, the rest by density
  float m = x.m[k] * ((x.top[k] - x.base[k]) / max(uCwGenus[g].x, .01)) / vscale;
  float c = x.c * x.w[k];
  int face = cwCubeFace(n);
  vec2 F = cwFaceUv(n, face);
  float sf = 1e9, edge = .7853982 * Rg - max(abs(F.x), abs(F.y));
  float e = cwMidFace(g, face, F, alt, x.base[k], vscale, m, c, fp, sf);
  if (edge < uCwMidA[g].y){
    int f2 = cwSideFace(n, face);
    e += cwMidFace(g, f2, cwFaceUv(n, f2), alt, x.base[k], vscale, m, c, fp, sf);
  } else sf = min(sf, edge);   // the next face's clouds stay on it
  // face km to surface km: equal-angle coordinates stretch by up to 1 / |major axis| (corners)
  vec3 an = abs(n);
  safe = min(safe, sf * max(an.x, max(an.y, an.z)));
  return e;
}
float cwMid(CwWx x, int k, vec3 n, float alt, float fp){ float safe = 1e9; return cwMid(x, k, n, alt, fp, safe); }

// Near field: Groundview's in-cloud light for the clouds of one genus that hold this point (the same
// placement as cwMidFace). Per cloud, weighted by its density here (acc.y): the optical depth toward
// the sun (three short steps through the cloud, then its baked far self-shadow; x), CloudWorks' top
// occlusion (z) and height in the cloud (w). Shadows from other clouds come from the shared map.
void cwNearFace(int g, int face, vec2 F, float alt, float base, float vscale, float m, float c, float fp, inout vec4 acc){
  vec4 A = uCwMidA[g], B = uCwMidB[g];
  float km = A.x, cell = A.y, reach = B.z;
  float pres = clamp(c * cell * cell / (3. * A.z), 0., 1.);
  for (int j = 0; j < 3; j++){
    vec2 off = vec2(j == 1 ? .37 : (j == 2 ? .71 : 0.), j == 1 ? .71 : (j == 2 ? .29 : 0.)) * cell;
    vec2 cid = floor((F + off) / cell);
    vec4 h = cwPcg4(vec4(cid, float(face * 16 + g), float(j)));
    if (h.x >= pres) continue;
    float sz = mix(CW_SIZE0, CW_SIZE1, h.y), s = km * sz, r = reach * sz;
    vec2 ctr = (cid + .5) * cell - off + (h.zw - .5) * max(cell - 2. * r, 0.);
    vec2 d = F - ctr;
    if (max(abs(ctr.x), abs(ctr.y)) > .7853982 * Rg || dot(d, d) >= r * r) continue;
    vec4 h2 = cwPcg4(vec4(cid, float(face * 16 + g) + .5, float(j) + 7.));
    int kk = int(h2.x * 8.);
    vec3 lp = toLocal(vec3(d.x, 0., d.y), kk) / s;
    float sv = s * vscale;
    lp.y = A.w + (alt - base) / sv;
    float fpd = fp * uCwLodScale;
    float lod = max(log2(fpd / (${(7.4 / dims.FW).toFixed(6)} * s)), 0.);
    if (cwEmptyUnits(lp, B.y, lod) > 0.) continue;
    float lodD = max(log2(fpd / (.0363 * s)), 0.);
    float dens = B.x * m * mix(.85, 1.15, h2.y);
    float e = cwFamily(lp, B.y, lod, lodD) * dens;
    if (e < .003) continue;
    vec3 Ll = toLocal(uCwNearLf, kk);
    float optical = 0., stepL = .025, travel = .012;
    for (int i = 0; i < 3; i++){ optical += cwFamily(lp + Ll * travel, B.y, lod, lodD) * stepL; travel += stepL; stepL *= 1.29; }
    vec3 cq = lp / (bounds * 2.) + .5;
    float combo = (B.y - 1.) * 8. + float(kk);
    optical += texture(uCwShadow, vec3(cq.xy, (combo + clamp(cq.z, .5 / ${dims.CZ}., 1. - .5 / ${dims.CZ}.)) / ${80}.)).r;
    float top = cwFamily(lp + vec3(0, .3, 0), B.y, lod, lodD) * .9 + cwFamily(lp + vec3(0, .75, 0), B.y, lod, lodD) * .55;
    acc += e * vec4(optical * dens * 22., 1., top * dens, smoothstep(A.w - .2, A.w + 2.7, lp.y));
  }
}
// Near light at a point of a cell's shapes (acc.y = 0 if it holds none); weight: how near
vec4 cwNear(CwWx x, vec3 n, float alt, float fp, vec3 uK, out float wNear){
  vec4 acc = vec4(0.);
  wNear = 0.;
  if (uCwNear.z < .5) return acc;
  int face = cwCubeFace(n);
  if (face != int(uCwNear.x)) return acc;
  wNear = 1. - smoothstep(.6, 1., length(n * (Rg + alt) - uCwNearC) / uCwNear.y);
  if (wNear <= 0.) return acc;
  vec2 F = cwFaceUv(n, face);
  for (int k = 0; k < 3; k++){
    if (x.w[k] <= .01 || uK[k] >= .99) continue;
    int g = x.g[k];
    float vscale = clamp((x.top[k] - x.base[k]) / max(uCwGenus[g].x, .01), .75, 1.5);
    float m = x.m[k] * ((x.top[k] - x.base[k]) / max(uCwGenus[g].x, .01)) / vscale;
    cwNearFace(g, face, F, alt, x.base[k], vscale, m, x.c * x.w[k], fp, acc);
  }
  return acc;
}

// How unresolved each of a cell's genera is at footprint fp: 0 = real shapes (its clouds span
// >= ~16 pixels), 1 = far field (<= ~5 pixels): smaller clouds gain nothing from their shapes.
vec3 cwUnresolved(CwWx x, float fp){
  vec3 u;
  for (int k = 0; k < 3; k++) u[k] = smoothstep(.06, .2, fp / (2. * uCwMidB[x.g[k]].z));
  return u;
}
// Per genus, the share of its cover the far field draws: its unresolved part, plus the cover its
// separate clouds cannot supply (overcast decks) where shapes are drawn.
vec3 cwFarWeights(CwWx x, vec3 u){
  vec3 wf;
  for (int k = 0; k < 3; k++){
    vec4 A = uCwMidA[x.g[k]];
    float ck = x.c * x.w[k], cap = min(3. * A.z / (A.y * A.y), 1.);
    wf[k] = u[k] + (1. - u[k]) * (ck > .001 ? max(ck - cap, 0.) / ck : 0.);
  }
  return wf;
}
`;

// Light on CloudWorks clouds, calibrated to Groundview (phase 4). Next to an 18 % grey card under
// the same sun -- what each app's exposure keeps steady -- Groundview's clouds get 2.9x OpenWorld's
// sky light and less of its sunlight (its sky is brighter relative to its sun): 0.70 / 0.80 / 0.85 /
// 0.88 at 20 / 34 / 50 / 70 degrees. Measured with both apps' sky models (CloudWorks/src/template.html
// skyLight + sunAt, at its default haze; OpenWorld's Lighting hub). Only the clouds take these, so a
// cloud looks as it does in Groundview next to OpenWorld's own ground.
export const cwCalibGLSL = /* glsl */ `
const float CW_AMB_K = 2.9;
float cwSunK(float muS){ return clamp(1. - .11 / max(muS, .05), .6, 1.); }
// sun, sky from above, and light from below (the sunlit ground, some horizon sky; Groundview's
// bounce), for a cloud at radius r with the sun at cosine muS
void cwCloudLight(float r, float muS, out vec3 sunL, out vec3 ambTop, out vec3 ambLow){
  float k = cwSunK(muS);
  sunL = uSunE * sunTransmittance(r, muS) * k;
  ambTop = skyIrradiance(r, muS) / PI * CW_AMB_K;
  ambLow = ambTop * .4 + .6 * vec3(.07, .09, .05) * (uSunE * sunTransmittance(Rg, muS) * k * max(muS, 0.) / PI + ambTop);
}
`;

// near: compiled with the near field's light. Without it the shader is leaner, and faster where it
// is not needed (from orbit: ~2 ms at 1440p, from occupancy alone)
export const cwFarColorFS = (common, lightingGLSL, dims, near = false) => `${common.replace('300 es', near ? '300 es\n#define CW_NEAR' : '300 es')}
precision highp sampler2D;
${lightingGLSL.replace(/#version[^\n]*\n/, '')}
${cwWeatherGLSL}
${cwMidGLSL(dims)}
${cwCalibGLSL}
uniform vec2 uRes;
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos;
uniform float uPixAngle;
uniform vec2 uJitter;       // this frame's ray offset (pixels), for the cloud slot's accumulation
uniform float uFrame;       // frame index: the dither changes every frame
layout(location = 1) out vec4 fragDepth;   // r: the clouds' depth along the ray (km), 0 for none
const float RT_DIRECT = .386, RT_MULTI = .0857;
float cwHG(float c, float g){ return (1. - g * g) / pow(max(.01, 1. + g * g - 2. * g * c), 1.5); }

// Groundview's in-cloud light (near field): optical depth toward the sun through this cloud, the
// other clouds' shadow (shared map), top occlusion and height in the cloud for the ambient
vec3 cwLightNear(float optical, float shadow, float phase, vec3 sunL, vec3 ambTop, vec3 ambLow, float top, float hgt){
  float direct = exp(-optical) * phase * shadow;
  float multiple = (.38 * exp(-optical * .40) + .12 * exp(-optical * .12)) * mix(.2, 1., shadow);
  return mix(ambLow, ambTop, hgt) * exp(-top * .7) + sunL * (direct * RT_DIRECT + multiple * RT_MULTI);
}
// CloudWorks' in-cloud light for optical depth od toward the sun (shadow: from the shared map)
vec3 cwLight(float od, float shadow, float phase, vec3 sunL, vec3 ambTop, vec3 ambLow, float hh){
  float direct = exp(-od) * phase * shadow;
  float multiple = (.38 * exp(-od * .40) + .12 * exp(-od * .12)) * mix(.2, 1., shadow);
  return mix(ambLow, ambTop, hh) * exp(-od * .04) + sunL * (direct * RT_DIRECT + multiple * RT_MULTI);
}

void main(){
  fragDepth = vec4(0.);
  vec4 v = uInvProj * vec4((gl_FragCoord.xy + uJitter) / uRes * 2. - 1., 1., 1.);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.)).xyz), ro = uCamPos;
  vec2 tb = raySphere(ro, rd, Rg + CW_TOP);
  if (tb.y <= 0.){ frag = vec4(0.); return; }
  float t0 = max(tb.x, 0.), t1 = tb.y;
  vec2 tg = raySphere(ro, rd, Rg);
  if (tg.x > 0.) t1 = min(t1, tg.x);
  if (t1 <= t0){ frag = vec4(0.); return; }

  vec3 L = uSunDir;
  float mu = dot(rd, L), phase = .82 * cwHG(mu, .58) + .18 * cwHG(mu, -.25);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))) + uFrame * .618034);

  vec3 color = vec3(0.); float T = 1., tHit = -1.;
  float tSeg = -1., dSum = 0., aSum = 0.;   // a segment's first cloud; opacity-weighted depth
  // Segment: one cell's clouds along the ray. Its real shapes (mid) are composited as they are; its
  // unresolved part (far) by the share of cover it stands for, sampled at every lit step (weighted
  // by what that step adds) so cells blend smoothly.
  vec3 Lc = vec3(0.), Lm = vec3(0.); float Tc = 1., Tm = 1., cSum = 0., wSum = 0., muSeg = 1.;
  vec3 uK = vec3(1.), wf = vec3(1.);    // per genus: unresolved share, far field's share of its cover
  float farShare = 1., midW = 0.;        // far field's share of the cell's cover; weight of the shapes
  // The far field's view cover in this cell bounds what the cell can add to the pixel: with little
  // cover it is done sooner and steps deeper (its error is weighted by that cover).
  float cvE = 1., odF = .5, odM = .5;   // its view cover; deepest step (optical depth): far, shapes
  float tMidQ = 0., tMidSafe = -1.;     // the last shape lookup: the ray within tMidSafe of it is empty
  float nCells = 0.;                    // cloudy cells crossed so far
  vec3 sunL = vec3(0.), ambTop = vec3(0.), ambLow = vec3(0.); bool lit = false;
  CwWx x; vec3 anchor = vec3(0.); bool haveWx = false;
  float dtIn = 1e9;     // step limit inside dense cloud: no step deeper than odF / odM
  // The other clouds' shadow (shared map) changes slowly along a ray: re-read every ~0.5 km. Every
  // lit step reading the 32-bit float map tripled the cost of this pass.
  float shadow = 1., tShadow = -1e9;
  float t = t0;
  for (int i = 0; i < 520; i++){
    if (t >= t1 || T < .01) break;
    vec3 p = ro + rd * t;
    float r = length(p); vec3 n = p / r; float alt = r - Rg, muV = dot(rd, n);
    float fp = max(t * uPixAngle, .02), lodC = max(log2(fp / 4.9), 0.);
    // above every cloud top far around, or in a cloudless cell: jump the clear air at once instead
    // of reading the weather cell by cell (clear sky above low clouds cost more than the clouds)
    if (!haveWx || alt > x.hi + .02 || x.c < .01){
      float jump = cwClearJump(n, alt, muV);
      if (jump > .5){ t += jump; continue; }
    }
    // a new cell when the ray has moved ~2.5 km sideways (more where a pixel covers more)
    float cellKm = max(2.5, fp * 1.5);
    if (!haveWx || length(n - anchor) * Rg > cellKm){
      if (haveWx){
        float cv = wSum > 0. ? cwViewCover(cSum / wSum * farShare, x.aspect, muSeg) : 0.;
        color += T * (midW * Lm + cv * Lc);
        float dA = T * min(midW * (1. - Tm) + cv * (1. - Tc), 1.);
        dSum += dA * tSeg; aSum += dA;
        T -= dA;
      }
      x = cwWeather(n, lodC);
      anchor = n; haveWx = true; Lc = Lm = vec3(0.); Tc = Tm = 1.; cSum = wSum = 0.; dtIn = 1e9; lit = false; tMidSafe = -1.; tSeg = -1.;
      uK = cwUnresolved(x, fp); wf = cwFarWeights(x, uK);
      farShare = clamp(dot(x.w, wf), 0., 1.);
      float wm = dot(x.w, step(uK, vec3(.99)));
      midW = wm > 0. ? clamp(dot(x.w, (1. - uK) * step(uK, vec3(.99))) / wm, 0., 1.) : 0.;
      cvE = cwViewCover(x.c * farShare, x.aspect, muV);
      if (x.c >= .01) nCells++;
      odF = clamp(.125 / max(cvE, 1e-3), .5, 4.);
      odM = clamp(.125 / max(midW, 1e-3), .5, 4.);
    }
    float sideways = cellKm / max(sqrt(max(1. - muV * muV, 0.)), .05);   // ray length to the next cell
    bool wantMid = midW > .01, wantFar = farShare > .01;
    // A ray that has crossed many cloudy cells (grazing, at the horizon) adds each one to its pixel
    // with a small share: it steps deeper and leaves cells sooner (orbit views cross only a few).
    float lodT = clamp(nCells * .5, 1., 8.);
    // nothing here, or this cell's cloud is already opaque along the ray: on to the next cell
    if (x.c < .01 || x.hi < x.lo || ((!wantFar || Tc * min(cvE, .25) < .005 * lodT) && (!wantMid || Tm * min(midW, .25) < .005 * lodT))){ t += min(sideways, 40.); continue; }
    if (alt > x.hi + .02 || alt < x.lo - .02){
      float to = alt > x.hi ? (muV < -.02 ? (alt - x.hi) / -muV : 1e9) : (muV > .02 ? (x.lo - alt) / muV : 1e9);
      t += max(min(to + .01, sideways), .05);
      continue;
    }
    // inside the band: steps across the thinnest layer in view, finer in dense cloud and where
    // real shapes are drawn
    float band = x.hi - x.lo;
    float dt = min(clamp(band / max(abs(muV), .12) / (wantMid ? 32. : 20.), .02, 2.5), dtIn);
    // steps grow with distance, as in CloudWorks: fine next to the camera, coarse far away
    dt = min(dt, max(.02, t * .015));
    dt = min(dt, sideways);
    // the far field's own step (its profile is smooth: no empty space to skip)
    float dtFar = wantFar ? min(clamp(band / max(abs(muV), .12) / 20., .02, 2.5), max(.02, t * .015)) : 1e9;
    float tt = t + dt * jit;
    vec3 q = ro + rd * tt; float rq = length(q), aq = rq - Rg; vec3 nq = q / rq;
    float sF = wantFar ? cwSigmaW(x, aq, wf) : 0.;
    float sM = 0., safe = 1e9;
    if (wantMid){
      // the far field may need many steps through the band; the shapes are looked up only past the
      // radius the last lookup found empty
      if (abs(tt - tMidQ) < tMidSafe) safe = tMidSafe - abs(tt - tMidQ);
      else {
        for (int k = 0; k < 3; k++) if (x.w[k] > .01 && uK[k] < .99){ sM += cwMid(x, k, nq, aq, fp, safe); }
        tMidQ = tt; tMidSafe = safe;
      }
    }
    float s = max(sF, sM);
    // no step deeper than odF (far field) or odM (shapes) optical depth
    float oF = min(odF * lodT, 8.), oM = min(odM * lodT, 8.);
    float dIn = max(min(sF > .002 ? oF / sF : 1e9, sM > .002 ? oM / sM : 1e9), .02);
    if (dt > .02 && (sF * dt > 1.2 * oF || sM * dt > 1.2 * oM)){ dtIn = dIn; continue; }   // too coarse here: retry finer
    dtIn = s > .002 ? dIn : 1e9;
    if (s <= .002){
      // empty here: on past the radius the shapes surely leave empty (within the cell)
      t = max(t + dt, min(tt + min(safe, sF > .002 ? 0. : dtFar), t + sideways));
      continue;
    }
    if (s > .002){
      if (tHit < 0.) tHit = tt;
      if (tSeg < 0.) tSeg = tt;
      float muS = dot(q, L) / rq;
      if (!lit){ cwCloudLight(rq, muS, sunL, ambTop, ambLow); lit = true; }
      if (abs(tt - tShadow) > .5){ shadow = cloudShadowT(q + L * 3.); tShadow = tt; }
      float hh = clamp((aq - x.lo) / max(band, .05), 0., 1.);
      if (sF > .002){
        // three growing steps toward the sun through the cell's profile
        float od = 0., ls = .1, lt = 0.;
        for (int j = 0; j < 3; j++){
          lt += ls * .5; vec3 lp = q + L * lt; od += cwSigmaW(x, length(lp) - Rg, wf) * ls; lt += ls * .5; ls *= 3.5;
        }
        float a = 1. - exp(-sF * dt), w = Tc * a;
        cSum += cwCoverAt(nq, lodC) * w; wSum += w; muSeg = muV;
        Lc += w * cwLight(od, shadow, phase, sunL, ambTop, ambLow, hh); Tc *= 1. - a;
      }
      if (sM > .002){
        // near the camera, Groundview's own light for the clouds here
        float wNear;
#ifdef CW_NEAR
        vec4 nl = cwNear(x, nq, aq, fp, uK, wNear);
#else
        vec4 nl = vec4(0.); wNear = 0.;
#endif
        vec3 ill = vec3(0.);
        if (nl.y > 0.) ill = cwLightNear(nl.x / nl.y, shadow, phase, sunL, ambTop, ambLow, nl.z / nl.y, nl.w / nl.y);
        else wNear = 0.;
        if (wNear < 1.){
          // further out: one step toward the sun through the dominant genus's shape, then the map
          float ls = max(.5 * uCwMidB[x.g[0]].z, .05);
          vec3 lp = q + L * (ls * .5); float rl = length(lp);
          float od = cwMid(x, 0, lp / rl, rl - Rg, fp) * ls;
          ill = mix(cwLight(od, shadow, phase, sunL, ambTop, ambLow, hh), ill, wNear);
        }
        float a = 1. - exp(-sM * dt);
        Lm += Tm * a * ill; Tm *= 1. - a;
      }
    }
    t += dt;
  }
  if (haveWx){
    float cv = wSum > 0. ? cwViewCover(cSum / wSum * farShare, x.aspect, muSeg) : 0.;
    color += T * (midW * Lm + cv * Lc);
    float dA = T * min(midW * (1. - Tm) + cv * (1. - Tc), 1.);
    dSum += dA * tSeg; aSum += dA;
    T -= dA;
  }
  fragDepth = vec4(aSum > 1e-4 ? dSum / aSum : 0., 0., 0., 0.);
  float alpha = 1. - T;
  if (alpha < .002){ frag = vec4(0.); return; }
  vec3 Sa, Ta;
  aerial(ro, rd, tHit, Sa, Ta);
  frag = vec4(color * Ta + Sa * alpha, alpha);
}`;

// Shared cloud shadow map (layout in shaders.js, cloudShadowGLSL): per texel, the sun ray's front
// depth, mean extinction and optical depth through the field -- real shapes where a shadow-map
// texel resolves them, the cells' cover fractions otherwise (a broken field lets the gaps' share
// of sunlight through).
export const cwFarShadowFS = (common, lightingGLSL, dims) => `${common}
precision highp sampler2D;
${lightingGLSL.replace(/#version[^\n]*\n/, '')}
${cwWeatherGLSL}
${cwMidGLSL(dims)}
uniform vec2 uRes;
uniform vec3 uShOrigin, uShRight, uShUp, uShDir;
uniform float uShExtent;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 ro = uShOrigin + (uShRight * (uv.x * 2. - 1.) + uShUp * (uv.y * 2. - 1.)) * uShExtent, rd = uShDir;
  vec2 tb = raySphere(ro, rd, Rg + CW_TOP);
  if (tb.y <= 0.) discard;
  float t0 = max(tb.x, 0.), t1 = tb.y;
  vec2 tg = raySphere(ro, rd, Rg);
  if (tg.x > 0.) t1 = min(t1, tg.x);
  if (t1 <= t0) discard;
  float texel = 2. * uShExtent / uRes.x, cellKm = max(2.5, texel);
  float od = 0., front = -1., back = 0., Tc = 1., Tm = 1., cv = 0., midW = 0.;
  vec3 wf = vec3(1.);
  CwWx x; vec3 anchor = vec3(0.); bool haveWx = false;
  float t = t0;
  for (int i = 0; i < 128; i++){
    if (t >= t1) break;
    vec3 p = ro + rd * t;
    float r = length(p); vec3 n = p / r; float alt = r - Rg, muV = dot(rd, n);
    if (!haveWx || length(n - anchor) * Rg > cellKm){
      if (haveWx) od += -log(max(1. - min(midW * (1. - Tm) + cv * (1. - Tc), 1.), 1e-4));
      x = cwWeather(n, max(log2(texel / 4.9), 0.));
      anchor = n; haveWx = true; Tc = Tm = 1.;
      vec3 uK = cwUnresolved(x, texel);
      // shapes in the map only for the dominant genus, and only where it clearly resolves
      uK.x = uK.x < .5 ? uK.x : 1.; uK.yz = vec2(1.);
      wf = cwFarWeights(x, uK);
      midW = 1. - uK.x;
      cv = cwViewCover(x.c * clamp(dot(x.w, wf), 0., 1.), x.aspect, muV);
    }
    float sideways = cellKm / max(sqrt(max(1. - muV * muV, 0.)), .05);
    if (x.c < .01 || x.hi < x.lo){ t += min(sideways, 60.); continue; }
    if (alt > x.hi + .02 || alt < x.lo - .02){
      float to = alt > x.hi ? (muV < -.02 ? (alt - x.hi) / -muV : 1e9) : (muV > .02 ? (x.lo - alt) / muV : 1e9);
      t += max(min(to + .01, sideways), .05);
      continue;
    }
    bool wantMid = midW > .01;
    float dt = clamp((x.hi - x.lo) / max(abs(muV), .12) / (wantMid ? 10. : 8.), .05, 4.);
    float am = alt + muV * dt * .5;
    vec3 q = ro + rd * (t + dt * .5); vec3 nq = normalize(q);
    float sF = cwSigmaW(x, am, wf);
    float sM = wantMid ? cwMid(x, 0, nq, am, texel) : 0.;
    if (max(sF, sM) > .002){
      if (front < 0.) front = t;
      back = t + dt;
      Tc *= exp(-sF * dt); Tm *= exp(-sM * dt);
    }
    t += dt;
  }
  if (haveWx) od += -log(max(1. - min(midW * (1. - Tm) + cv * (1. - Tc), 1.), 1e-4));
  if (od < 1e-3 || front < 0.) discard;
  frag = vec4(front, od / max(back - front, .05), od, 1.);
}`;

// Observed-day textures, loaded in the background and uploaded from inside a render pass.
export function cwWeatherSource(date) {
  const base = `data/clouds/${date}/`;
  const src = { ready: false, pending: {}, tex: {}, error: null };
  if (!location.protocol.startsWith('http')) { src.error = 'the observed day needs the page served (start.bat)'; return src; }
  // Decoded off the main thread, flipped here: row 0 is north, equirect v = 0 is south (browsers
  // ignore UNPACK_FLIP_Y for bitmaps). Known: in Chrome a single INVALID_VALUE is reported by the
  // planet draw of the frame in which these large images finish decoding (also with Image
  // elements); no call made here fails and nothing visible changes.
  const load = (name) => fetch(base + name)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${name}: ${r.status}`))))
    .then((b) => createImageBitmap(b, { imageOrientation: 'flipY', colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
    .then((bmp) => { src.pending[name] = bmp; });
  Promise.all(['coverage.webp', 'properties.png', 'terrain.png'].map(load)).catch((e) => { src.error = String(e); console.warn('CloudWorks: observed day unavailable:', e); });
  // Uploads whatever has arrived; true once all three are on the GPU.
  src.upload = (gl) => {
    for (const [name, bmp] of Object.entries(src.pending)) {
      const t = gl.createTexture(), single = name !== 'properties.png';
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, single ? gl.R8 : gl.RGBA8, single ? gl.RED : gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      const mip = name !== 'terrain.png';
      if (mip) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      src.tex[name] = t;
      bmp.close();
      delete src.pending[name];
    }
    src.ready = Object.keys(src.tex).length === 3;
    return src.ready;
  };
  return src;
}
