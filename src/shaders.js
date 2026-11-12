// GLSL building blocks shared by the ground, cloud and sky shaders.
// World units are kilometres, the planet is centred at the origin with +Y = north pole.

export const noiseGLSL = /* glsl */ `
// 3D simplex noise — Ian McEwan / Ashima Arts (MIT)
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

// The chunks below carry include guards: the lighting library (lighting.js) and the app's own
// shaders paste overlapping sets of them, in any order, and each is compiled once. They are valid
// both in three.js ShaderMaterials and in raw GLSL ES 3.00 (texture(), not texture2D()).

// Planet geometry: km, Earth-centred, +Y = north pole.
export const planetGLSL = /* glsl */ `
#ifndef GLSL_PLANET
#define GLSL_PLANET
#define PI 3.141592653589793
#define Rg 6371.0
#define Rt 6471.0

vec2 dirToEquirect(vec3 n){
  return vec2(atan(n.x, n.z) * (0.5 / PI) + 0.5, asin(clamp(n.y, -1.0, 1.0)) * (1.0 / PI) + 0.5);
}

// Equirectangular lookup with seam-safe gradients (no mip seam at the antimeridian).
vec4 texEquirect(sampler2D t, vec3 n){
  vec2 uv = dirToEquirect(n);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  dx.x -= floor(dx.x + 0.5);
  dy.x -= floor(dy.x + 0.5);
  return textureGrad(t, uv, dx, dy);
}

// Numerically careful ray/sphere intersection (camera sits ~7000 km from the origin).
vec2 raySphere(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  vec3 h = ro - b * rd;
  float hl = length(h);
  float d = (r - hl) * (r + hl);
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
#endif
`;

// The sun, as every shader sees it (set once per frame by the Lighting hub).
export const sunUniformsGLSL = /* glsl */ `
#ifndef GLSL_SUN
#define GLSL_SUN
uniform vec3 uSunDir;   // unit vector toward the sun (world space)
uniform float uSunE;    // solar irradiance at the top of the atmosphere (scene units, 1/d^2 applied)
#endif
`;

export const commonGLSL = /* glsl */ `
${planetGLSL}
${sunUniformsGLSL}
#ifndef GLSL_COMMON
#define GLSL_COMMON
#define CLOUD_ALT 6.0

uniform sampler2D uCloudMap;
uniform float uCloudCover;
uniform vec3 uWind;
uniform sampler2D uCloudCov;     // observed cloud fraction (real day, ~5 km) or climatology fallback
uniform vec4 uCloudCovChan;      // channel holding it: R for observations, B for the climatology map
uniform float uCloudTime;        // simulated seconds since start: drives cloud advection
uniform vec4 uCloudCut;          // lon0, lat0, lon1, lat1 (radians): no built-in clouds inside
uniform float uCloudCutOn;       // (an external cloud provider owns that region)

// Mean zonal steering wind (m/s, + = eastward) by latitude: trade easterlies, mid-latitude
// westerlies, polar easterlies.
float zonalWind(float sinLat){
  float lat = asin(clamp(sinLat, -1.0, 1.0)) * 57.29578, a = abs(lat);
  return -7.0 * exp(-(lat * lat) / 324.0) + 13.0 * exp(-(a - 46.0) * (a - 46.0) / 169.0)
         - 4.0 * exp(-(a - 78.0) * (a - 78.0) / 64.0);
}

// Where the air at p was when the observations were made: rotate back about the polar axis by the
// distance the zonal wind carried it, so cloud fields drift tangentially (and shear with latitude).
vec3 cloudAdvect(vec3 p, float speedMul){
  float c = max(length(p.xz), 50.0);
  float s = p.y / length(p);
  float ang = zonalWind(s) * speedMul * uCloudTime * 0.001 / c * (1.0 - smoothstep(0.985, 0.998, abs(s)));
  float sn = sin(ang), cs = cos(ang);
  return vec3(cs * p.x - sn * p.z, p.y, sn * p.x + cs * p.z);
}

float cloudFractionUv(vec2 uv, float lod){
  float c = dot(textureLod(uCloudCov, uv, lod), uCloudCovChan);
  // The climatology map is a photo (haze floor, soft highlights). The observed fraction carries a
  // faint floor from haze, dust and surface brightness changes: below ~8 % it is clear sky, not a
  // veil of cloud.
  float f = uCloudCovChan.b > 0.5 ? smoothstep(0.15, 0.75, c) : clamp((c - 0.08) / 0.92, 0.0, 1.0);
  if (uCloudCutOn > 0.5){
    // every built-in cloud (volume, its shadows, the probe deck) reads its coverage here
    vec2 ll = vec2((uv.x - 0.5) * 2.0 * PI, (uv.y - 0.5) * PI);
    vec2 e = min(ll - uCloudCut.xy, uCloudCut.zw - ll);
    f *= 1.0 - smoothstep(-0.006, 0.006, min(e.x, e.y));
  }
  return f;
}

float cloudFraction(vec3 n, float lod){
  return cloudFractionUv(dirToEquirect(normalize(cloudAdvect(n, 1.0))), lod);
}
#endif
`;

// Earth's atmosphere (Bruneton 2017 / Hillaire 2020 parameters, per km).
export const atmoMediumGLSL = /* glsl */ `
#ifndef GLSL_ATMO_MEDIUM
#define GLSL_ATMO_MEDIUM
const vec3 BR = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const float HR = 8.0;
const float BMs = 3.996e-3;
const float BMe = 4.440e-3;
const float HM = 1.2;
const float MIE_G = 0.8;
const vec3 BO = vec3(0.650e-3, 1.881e-3, 0.085e-3);   // ozone absorption, tent layer 10-40 km
const float GROUND_ALBEDO = 0.3;
const vec2 TLUT = vec2(256.0, 64.0);                  // transmittance LUT size
const vec2 MLUT = vec2(32.0, 32.0);                   // multiple-scattering LUT size
const vec2 ILUT = vec2(64.0, 16.0);                   // sky irradiance LUT size

struct Medium { vec3 scatR; float scatM; vec3 ext; };
Medium mediumAt(float h){
  Medium m;
  float dR = exp(-max(h, 0.0) / HR), dM = exp(-max(h, 0.0) / HM);
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  m.scatR = BR * dR;
  m.scatM = BMs * dM;
  m.ext = BR * dR + BMe * dM + BO * dO;
  return m;
}
float phaseR(float mu){ return 0.0596831 * (1.0 + mu * mu); }
float phaseM(float mu){   // Cornette-Shanks
  const float gg = MIE_G * MIE_G;
  return 0.1193662 * (1.0 - gg) * (1.0 + mu * mu) / ((2.0 + gg) * pow(max(1.0 + gg - 2.0 * MIE_G * mu, 1e-4), 1.5));
}

// Bruneton's transmittance parameterisation: (r, mu) <-> uv, dense near the horizon
const float ATM_H = 1131.1; // sqrt(Rt^2 - Rg^2)
float distToTop(float r, float mu){ return max(-r * mu + sqrt(max(r * r * (mu * mu - 1.0) + Rt * Rt, 0.0)), 0.0); }
vec2 transUv(float r, float mu){
  float rho = sqrt(max(r * r - Rg * Rg, 0.0));
  float d = distToTop(r, mu);
  float dmin = Rt - r, dmax = rho + ATM_H;
  vec2 x = vec2((d - dmin) / max(dmax - dmin, 1e-4), rho / ATM_H);
  return x * (1.0 - 1.0 / TLUT) + 0.5 / TLUT;
}
vec2 lutUv(vec2 x, vec2 size){ return x * (1.0 - 1.0 / size) + 0.5 / size; }
#endif
`;

export const atmosphereGLSL = /* glsl */ `
${planetGLSL}
${sunUniformsGLSL}
${atmoMediumGLSL}
#ifndef GLSL_ATMOSPHERE
#define GLSL_ATMOSPHERE
uniform sampler2D uTransLUT;   // transmittance to the top of the atmosphere
uniform sampler2D uMsLUT;      // multiple-scattering transfer (Hillaire 2020)
uniform sampler2D uIrrLUT;     // sky irradiance on a horizontal surface, per unit sun illuminance
uniform float uAtmo;           // 1 = atmosphere on, 0 = airless (no sky, haze or reddening)

// Sunlight reaching radius r with the sun at cosine-zenith mu: transmittance through the air times
// the share of the 0.53 deg solar disc above the planet's horizon (soft Earth-shadow edge).
vec3 sunTransmittance(float r, float mu){
  r = clamp(r, Rg + 0.001, Rt);
  float muH = -sqrt(max(1.0 - (Rg / r) * (Rg / r), 0.0));
  float vis = clamp((mu - muH) / 0.0093 + 0.5, 0.0, 1.0);
  if (uAtmo < 0.5) return vec3(vis);
  if (vis <= 0.0) return vec3(0.0);
  return texture(uTransLUT, transUv(r, max(mu, muH))).rgb * vis;
}
vec3 msTransfer(float r, float muS){
  return texture(uMsLUT, lutUv(vec2(muS * 0.5 + 0.5, clamp((r - Rg) / (Rt - Rg), 0.0, 1.0)), MLUT)).rgb;
}
// sky irradiance (times uSunE) on a horizontal surface at radius r
vec3 skyIrradiance(float r, float muS){
  if (uAtmo < 0.5) return vec3(0.0);
  return uSunE * texture(uIrrLUT, lutUv(vec2(muS * 0.5 + 0.5, clamp((r - Rg) / (Rt - Rg), 0.0, 1.0)), ILUT)).rgb;
}

#ifndef ATM_STEPS
#define ATM_STEPS 16
#endif

uniform float uAerial;   // strength of the air haze over surfaces and clouds (1 = physical)

void atmosphereK(vec3 ro, vec3 rd, float tMax, int steps, float k, out vec3 S, out vec3 T);
void atmosphereN(vec3 ro, vec3 rd, float tMax, int steps, out vec3 S, out vec3 T){ atmosphereK(ro, rd, tMax, steps, 1.0, S, T); }
void atmosphere(vec3 ro, vec3 rd, float tMax, out vec3 S, out vec3 T){ atmosphereK(ro, rd, tMax, ATM_STEPS, 1.0, S, T); }
// Aerial perspective in front of the ground and clouds, optionally thinned by uAerial
// (scattering and extinction alike); the sky and limb keep the full atmosphere.
void aerial(vec3 ro, vec3 rd, float tMax, out vec3 S, out vec3 T){ atmosphereK(ro, rd, tMax, ATM_STEPS, uAerial, S, T); }

// Single scattering marched per pixel with LUT sun transmittance (Earth shadow included), plus
// all higher scattering orders from the multiple-scattering LUT; energy-conserving integration
// per step (Hillaire 2015). Samples are spread quadratically so the dense lower air gets most of them.
void atmosphereK(vec3 ro, vec3 rd, float tMax, int steps, float k, out vec3 S, out vec3 T){
  S = vec3(0.0);
  T = vec3(1.0);
  k *= uAtmo;
  if (k <= 0.0) return;
  vec2 ta = raySphere(ro, rd, Rt);
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, tMax);
  if (t1 <= t0) return;
  float mu = dot(rd, uSunDir);
  float pR = phaseR(mu), pM = phaseM(mu);
  // put the samples where the air is: around the ray's lowest point
  float tLow = clamp(-dot(ro, rd), t0, t1);
  float n = float(steps);
  vec3 L = vec3(0.0);
  float tPrev = t0;
  for (int i = 0; i < 48; i++){
    if (i >= steps) break;
    float f = (float(i) + 1.0) / n;
    // piecewise: half the samples on each side of the lowest point, denser near it
    float tc = f < 0.5 ? tLow - (tLow - t0) * pow(1.0 - 2.0 * f, 2.0) : tLow + (t1 - tLow) * pow(2.0 * f - 1.0, 2.0);
    float ds = tc - tPrev;
    if (ds <= 0.0) { tPrev = tc; continue; }
    float t = tPrev + 0.5 * ds;
    tPrev = tc;
    vec3 p = ro + rd * t;
    float r = length(p);
    Medium m = mediumAt(r - Rg);
    vec3 ext = m.ext * k;
    float muS = dot(p, uSunDir) / r;
    vec3 Sc = ((m.scatR * pR + m.scatM * pM) * sunTransmittance(r, muS) + (m.scatR + m.scatM) * msTransfer(r, muS)) * k;
    vec3 stepT = exp(-ext * ds);
    L += T * (Sc - Sc * stepT) / max(ext, vec3(1e-7));
    T *= stepT;
  }
  S = L * uSunE;
}
#endif
`;

// Shared cloud shadow map (Lighting hub, written by the active cloud provider): an orthographic
// map facing the sun, "Beer shadow map" layout per texel (as in UE5's volumetric clouds):
//   R  depth along the sun ray (km from the map's near plane) where the cloud starts
//   G  mean extinction (1/km) through the cloud
//   B  maximum optical depth (the whole column)
// Transmittance at any 3D point: exp(-min(B, G * max(depth - R, 0))) -- points above the cloud stay
// lit, points inside are partly shadowed. Without a provider uCloudShadowOn = 0 and the result is 1.
// Texels with no cloud hold (0, 0, 0): no optical depth.
export const cloudShadowGLSL = /* glsl */ `
#ifndef GLSL_CLOUD_SHADOW
#define GLSL_CLOUD_SHADOW
uniform sampler2D uCloudShadowMap;
uniform mat4 uCloudShadowMatrix;   // world (km) -> (u, v, depth km); u, v in [0, 1] cover the map
uniform float uCloudShadowOn;

float cloudShadowT(vec3 p){
  if (uCloudShadowOn < 0.5) return 1.0;
  vec3 s = (uCloudShadowMatrix * vec4(p, 1.0)).xyz;
  vec2 e = min(s.xy, 1.0 - s.xy);
  if (min(e.x, e.y) <= 0.0) return 1.0;
  vec4 b = textureLod(uCloudShadowMap, s.xy, 0.0);
  float od = min(b.b, b.g * max(s.z - b.r, 0.0));
  // fade out over the outer 2 % so the map's edge never draws a line on the ground
  return exp(-od * smoothstep(0.0, 0.02, min(e.x, e.y)));
}
#endif
`;

// The lighting library: everything a shader needs to light something like the rest of the app.
// three.js materials paste it like any chunk; raw WebGL2 programs (cloud providers) get the same
// text from lighting.glsl and their uniforms from lighting.bind(gl, program, unit).
export const lightingGLSL = /* glsl */ `
${planetGLSL}
${sunUniformsGLSL}
${atmosphereGLSL}
${cloudShadowGLSL}
`;

// Legacy 2D cloud deck — only used for the spacecraft's environment probe (cheap).
export const cloudGLSL = /* glsl */ `
float cloudCoverage(vec3 n){
  return clamp(cloudFraction(n, 2.0) * uCloudCover, 0.0, 1.0);
}

vec3 cloudWarp(vec3 P){
  vec3 q = P + uWind;
  vec3 w = vec3(snoise(q * 0.0045), snoise(q * 0.0045 + vec3(31.7, 4.1, -8.3)), snoise(q * 0.0045 + vec3(-17.3, 11.9, 3.7)));
  return q + w * 14.0;
}

// Cloud field (>0 inside cloud), also used as a height map for shading.
//  - mesoscale organisation (70 / 28 / 11 km) shifts the local cloud fraction around the map value
//  - cumulus "puffs" (5 km .. 250 m) are faded by pixel footprint; whatever is unresolved widens the
//    edge transition, so distant cumulus fields turn into soft translucent haze instead of aliasing.
float cloudField(vec3 q, float cov, float fp, int puffOct, out float soft){
  soft = 0.05;
  if (cov < 0.004) return -0.8;
  float o3fade = smoothstep(fp * 1.5, fp * 4.0, 11.0);
  float base = cov * 1.4 - 0.3
             + snoise(q * (1.0 / 70.0)) * 0.22
             + snoise(q * (1.0 / 28.0) + 5.2) * 0.16
             + snoise(q * (1.0 / 11.0) - 3.7) * 0.12 * o3fade;
  float f = 0.0, a = 0.5, fr = 1.0 / 5.0, tw = 0.0, un = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= puffOct) break;
    float fade = smoothstep(fp * 1.5, fp * 4.0, 1.0 / fr);
    float n = snoise(q * fr + float(i) * 7.31);
    float v = i < 2 ? n : 1.0 - 2.0 * abs(n) * 0.8;
    f += a * v * fade;
    un += a * (1.0 - fade);
    tw += a;
    a *= 0.55;
    fr *= 2.1;
  }
  f /= tw; un /= tw;
  soft = 0.05 + un * 0.55 + (1.0 - o3fade) * 0.1;
  float edge = smoothstep(0.0, 0.05, cov);
  return mix(-0.8, base + f * 0.75 - 0.3 * (1.0 - un), edge);
}

float cloudDensityS(float field, float soft){
  return smoothstep(-soft * 0.3, 0.22 + soft, field);
}

float cloudDensity(vec3 q, float cov, float fp, int puffOct){
  float soft;
  float f = cloudField(q, cov, fp, puffOct, soft);
  return cloudDensityS(f, soft);
}
`;

// ---------------------------------------------------------------------------------------------
// Weather volume driven by one real day of satellite cloud observations (tools/bake_clouds.py):
// observed cloud fraction (~5 km), cloud-top height, optical thickness and ice fraction decide
// where clouds are, how tall, how dense and which regime (cumulus fields, stratocumulus/stratus
// decks, elevated layers, cirrus, deep convection with anvils). 3D noise only adds what the
// satellites cannot resolve: individual cells, billows and fibres.
// Shared by the cloud raymarch and the ground-shadow lookups, so every shadow has its cloud.
// ---------------------------------------------------------------------------------------------
export const volumeGLSL = /* glsl */ `
uniform sampler3D uNoise3D;
uniform sampler2D uCloudProps;   // R fraction (coarse) G top height /16 km  B log optical depth  A ice
uniform sampler2D uTerrain;      // mean ground elevation, 36 m per step (cloud bases + mountain occlusion)
uniform sampler2D uRegion;       // ~500 m real cloud structure: R cloud albedo  G top /16 km  B ice
uniform vec4 uRegionBox;         // lon0, lat0, lon1, lat1 (radians)
uniform float uRegionOn;
uniform float uCloudSteps;
uniform sampler2D uNoiseLut;
uniform float uDetailMean;
uniform highp sampler3D uHeapTex;   // all heap variants, 96 x 96 x 64 each, stacked in z
uniform highp sampler3D uLayerTex;  // all layer tiles, 256 x 256 x 24 each, stacked in z
uniform float uModelsOn;
uniform vec4 uHeapA[4];   // first slab, variants, half-width min, max (km)
uniform vec4 uHeapB[4];   // height/width min, max, condensation base (km), extinction at density 1 (1/km)
uniform vec4 uHeapC[4];   // grid cell (km), depth/width aspect, total slices, -
uniform vec4 uLayerA[8];  // slab, tile (km), thickness (km), threshold soft width
uniform vec4 uLayerQ[72]; // per layer 9 x vec4: cover -> threshold quantiles (33 used)
uniform vec4 uLayerB[8];  // feature (cell) size (km), -, -, -
uniform float uCloudRes;  // cloud pass resolution scale: its pixels are 1/uCloudRes screen pixels
uniform float uLayerSlices;
#define CLOUD_BASE 0.3
#define CLOUD_TOP 13.0
const float Rcb = Rg + CLOUD_BASE;
const float Rct = Rg + CLOUD_TOP;

float remap(float v, float a, float b, float c, float d){ return c + (v - a) / max(b - a, 1e-4) * (d - c); }
// arbitrary rotation (axis ~(1,2,3), 0.9 rad) for a second, decorrelated noise tiling
const mat3 CLOUD_ROT = mat3(0.6486, 0.6821, -0.3376, -0.5740, 0.7297, 0.3715, 0.4998, -0.0472, 0.8649);

struct CloudWx {
  float cov;     // observed cloud fraction (after the user cover scale)
  float base;    // layer base above sea level (km)
  float top;     // layer top (km)
  float sigma;   // extinction inside cloud (1/km), from optical depth / thickness
  float conv;    // deep convection (tall tower + anvil)
  float cirrus;  // thin high ice cloud
  float sheet;   // stratiform deck (overcast, flat-topped)
  float ground;  // terrain elevation below (km)
  float region;  // weight of the high-resolution observed cloud layer (0 outside its box)
  float lo;      // altitude band the view march must search (both cloud models)
  float hi;
  float kind;    // library cloud type: 0-3 heaps, 4-11 layers (model mode)
};

// position inside the high-resolution region (xy) and its blend weight (z, feathered border)
vec3 regionCoord(vec3 na){
  if (uRegionOn < 0.5) return vec3(0.0);
  float lon = atan(na.x, na.z), lat = asin(clamp(na.y, -1.0, 1.0));
  vec2 uv = vec2((lon - uRegionBox.x) / (uRegionBox.z - uRegionBox.x), (lat - uRegionBox.y) / (uRegionBox.w - uRegionBox.y));
  vec2 e = min(uv, 1.0 - uv) * (uRegionBox.zw - uRegionBox.xy) * 57.29578;   // degrees to the border
  return vec3(uv, smoothstep(0.0, 0.8, min(e.x, e.y)));
}

float terrainKm(vec3 n){ return textureLod(uTerrain, dirToEquirect(n), 0.0).r * 9.18; }

// lod: mip level of the ~5 km observation maps (raise it for coarse/far lookups)
CloudWx cloudWeather(vec3 n, vec3 p, float lod){
  vec2 uv = dirToEquirect(normalize(cloudAdvect(n, 1.0)));
  // the observed cloud mask is near-binary per ~5 km pixel; bilinear filtering alone would draw
  // its pixel grid as rounded squares, so the lookup is warped by a couple of pixels of smooth noise
  vec2 uvc = uv;
  vec4 wn = vec4(0.5);   // one ~13 km noise lookup serves the warp (gb) and the type jitter (r, a)
  if (uModelsOn > 0.5){ wn = textureLod(uNoise3D, n * (Rg / 13.0), 1.0); uvc += (wn.gb - 0.5) * vec2(2.4 / 8192.0, 2.4 / 4096.0); }
  float cov = clamp(cloudFractionUv(uvc, lod) * uCloudCover, 0.0, 1.0);
  vec4 pr = textureLod(uCloudProps, uv, max(lod - 2.0, 0.0));
  float top = max(pr.g * 16.0, 0.9);
  float tau = exp(pr.b * 5.0173) - 1.0;           // log1p(150) = 5.0173
  float ice = pr.a;
  float conv = smoothstep(6.0, 9.5, top) * smoothstep(12.0, 35.0, tau);
  float cirrus = smoothstep(5.5, 8.0, top) * (1.0 - smoothstep(3.0, 12.0, tau)) * mix(0.6, 1.0, ice) * (1.0 - conv);
  float mid = smoothstep(3.2, 4.8, top) * (1.0 - conv) * (1.0 - cirrus);
  float sheet = smoothstep(0.55, 0.92, cov) * (1.0 - conv);
  float lowBase = mix(0.95, 0.45, sheet);          // decks sit lower than fair-weather cumulus bases
  float thick = clamp(0.35 + tau * 0.09, 0.5, 3.5); // layered cloud: deeper where optically thicker
  float base = mix(lowBase, max(top - thick, lowBase), max(mid, cirrus));
  base = mix(base, 0.8, conv);
  // observed tops are above sea level, but bases sit on the air above the local ground
  float ground = terrainKm(n);
  base = max(base, ground + 0.3);
  top = min(max(top, base + 0.5), CLOUD_TOP - 0.05);
  float sigma = clamp(tau / max(top - base, 0.3), 4.0, 45.0);
  sigma = mix(sigma, clamp(tau / max(top - base, 0.3), 0.2, 2.5), cirrus);
  vec3 rc = regionCoord(normalize(cloudAdvect(n, 1.0)));
  float lo = base, hi = top;
  if (rc.z > 0.0){
    // search band for the observed layer: from just above the ground to its (coarse) top
    float rTop = textureLod(uRegion, rc.xy, 4.0).g * 16.0;
    lo = min(lo, ground + 0.15);
    hi = min(max(hi, rTop * 1.25 + 0.8), CLOUD_TOP - 0.05);
    cov = max(cov, rc.z);
  }
  float kind = -1.0;
  if (uModelsOn > 0.5){
    // ISCCP classes: cloud-top height x optical depth; broken low/mid cloud is cumuliform
    float tj = wn.a - 0.5;
    float tauJ = tau * (1.0 + 0.25 * tj);
    // ~12 km noise on the cover used to pick deck vs. cumulus: the 5 km data's straight contours
    // would otherwise cut decks into polygons
    float covK = clamp(cov + (wn.r - 0.5) * 0.4, 0.0, 1.0);
    if (conv > 0.5) kind = 3.0;                                                      // cumulonimbus
    else if (top >= 6.5) kind = tauJ < 3.6 ? (tj > 0.38 ? 10.0 : 9.0) : 11.0;        // cirrus / cirrocumulus / cirrostratus
    else if (top >= 3.0) kind = (covK < 0.55 && ice < 0.5) ? 2.0 : (tauJ < 3.6 ? 7.0 : (tauJ < 23.0 ? 8.0 : 6.0));
    else kind = covK < 0.6 ? (top < 2.0 + 0.5 * tj ? 0.0 : 1.0) : (tauJ < 23.0 ? 4.0 : 5.0);
    // decks thin out towards their edge with the cumulus field (see modelExtinction)
    sheet = smoothstep(0.55, 0.85, covK);
    int k = int(kind + 0.5);
    if (k < 4){
      // heaps stand on their condensation level and reach their type's (or the observed) top
      base = max(uHeapB[k].z, ground + 0.3);
      float hiZ = uHeapA[k].w * uHeapB[k].y * 1.35 * 1.41;
      top = min(base + max(hiZ, top - base), CLOUD_TOP - 0.05);
    } else {
      float thick = uLayerA[k - 4].z * (k == 6 ? clamp(tau / 15.0, 0.7, 2.0) : 1.0);
      top = clamp(top, ground + 0.15 + thick, CLOUD_TOP - 0.05);
      base = top - thick;
    }
    lo = base; hi = top;
    rc.z = 0.0;
  }
  return CloudWx(cov, base, top, sigma, conv, cirrus, sheet, ground, rc.z, lo, hi, kind);
}

// Smooth (cubic B-spline) lookup from 4 bilinear taps: magnified 500 m texels would otherwise show
// as little squares once the albedo is turned into thickness and relief.
vec4 regionTexel(vec2 uv, float lod){
  if (lod > 1.0) return textureLod(uRegion, uv, lod);
  vec2 size = vec2(textureSize(uRegion, 0));
  vec2 st = uv * size - 0.5, i = floor(st), f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0, w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / size, h1 = (i + 1.5 + w3 / g1) / size;
  vec4 c = g0.y * (g0.x * textureLod(uRegion, h0, 0.0) + g1.x * textureLod(uRegion, vec2(h1.x, h0.y), 0.0))
         + g1.y * (g0.x * textureLod(uRegion, vec2(h0.x, h1.y), 0.0) + g1.x * textureLod(uRegion, h1, 0.0));
  return mix(c, textureLod(uRegion, uv, lod), clamp(lod, 0.0, 1.0));
}

// Extinction (1/km) of the observed high-resolution cloud layer. The stored cloud albedo is turned
// back into optical depth (conservative two-stream: A = t / (2 + t), t = (1 - g) tau, g ~ 0.85);
// optically thicker cloud is also deeper and reaches higher, so the brightness pattern of the
// real clouds becomes their relief under the live sun.
float regionExtinction(vec3 p, float r, float lod, float ground){
  vec3 q = cloudAdvect(p, 1.0);
  vec3 rc = regionCoord(normalize(q));
  // texels are ~0.55 km; the noise LOD is relative to 0.12 km footprints
  float rl = max(lod - 2.2, 0.0);
  vec4 R = regionTexel(rc.xy, rl);
  float a = R.r;
  if (a < 0.02) return 0.0;
  // local mean over ~4 km: low in broken (cumulus) fields, high inside sheets and decks
  float aM = textureLod(uRegion, rc.xy, rl + 3.0).r;
  // A partly cloudy texel inside a broken field is several smaller clouds, not one even blob:
  // split it with sub-texel noise (mean preserved) while the camera can resolve it. Sheets and
  // thick cloud are left smooth.
  float split = (1.0 - smoothstep(3.6, 4.6, lod)) * (1.0 - smoothstep(0.45, 0.85, a)) * (1.0 - smoothstep(0.28, 0.5, aM));
  if (split > 0.0){
    float dn = textureLod(uNoise3D, q / 3.0, min(lod * 0.8, 4.0)).r;
    a *= mix(1.0, clamp(0.1 + 1.8 * smoothstep(0.3, 0.75, dn), 0.0, 1.9), split);
    if (a < 0.02) return 0.0;
  }
  float tau = 13.33 * a / max(1.0 - a, 0.05);
  float ice = R.b;
  float thick = mix(clamp(0.25 + 0.05 * tau, 0.25, 3.0), clamp(1.0 + 0.08 * tau, 1.0, 3.0), ice);
  // relief follows the smoothed brightness (texel-level brightness noise would only add grain)
  float ar = mix(aM, a, 0.3);
  float top = R.g * 16.0 * (0.8 + 0.3 * smoothstep(0.05, 0.75, ar)) + 0.25 * smoothstep(0.2, 0.9, ar);
  float base = max(top - thick, ground + 0.15);
  top = max(top, base + 0.2);
  float alt = r - Rg;
  if (alt <= base || alt >= top) return 0.0;
  float hf = (alt - base) / (top - base);
  float prof = smoothstep(0.0, 0.2, hf) * (1.0 - smoothstep(0.65, 1.0, hf));
  return tau / (top - base) * prof * 1.35;
}

// rank of a 3D-noise base-shape value among all values at that LOD (uniform 0..1 at every mip),
// so a threshold of (1 - coverage) covers the observed fraction at any distance
float noiseRank(vec4 s, float lod){
  float wf = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  float b = clamp(remap(s.r, wf - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  return textureLod(uNoiseLut, vec2((b * 255.0 + 0.5) / 256.0, (lod + 0.5) / 5.0), 0.0).r;
}

float cloudExtinctionGlobal(vec3 p, float r, CloudWx w, float lod, bool detail);

// ---- Cloud models baked from the Blender library (blender_clouds/bake_volumes.py) ----------------
// Each weather cell is classified (ISCCP: cloud-top height x optical depth, plus cover) into one of
// the 12 library types. Heaps (cumulus x3, cumulonimbus) are scattered on a jittered grid laid on
// the six faces of an (equal-angle) cube around the planet; layers tile their 48 km patch.

vec4 pcg4(vec4 f){
  uvec4 v = uvec4(ivec4(floor(f)) + 1048576) * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> 16u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return vec4(v) * (1.0 / 4294967295.0);
}

// cube face (0..5) of a direction and equal-angle face coordinates in km
int cubeFace(vec3 n){
  vec3 a = abs(n);
  if (a.x >= a.y && a.x >= a.z) return n.x > 0.0 ? 0 : 1;
  if (a.y >= a.z) return n.y > 0.0 ? 2 : 3;
  return n.z > 0.0 ? 4 : 5;
}
vec2 faceUv(vec3 n, int f){
  vec3 m = f < 2 ? n.xzy : (f < 4 ? n.yxz : n.zxy);
  float s = (f == 0 || f == 2 || f == 4) ? 1.0 : -1.0;
  return vec2(atan(m.y * s, m.x * s), atan(m.z, m.x * s)) * Rg;
}
// the face across the nearest edge (for clouds anchored there that reach over)
int sideFace(vec3 n, int f){
  vec3 a = abs(n);
  if (f < 2) return a.y > a.z ? (n.y > 0.0 ? 2 : 3) : (n.z > 0.0 ? 4 : 5);
  if (f < 4) return a.x > a.z ? (n.x > 0.0 ? 0 : 1) : (n.z > 0.0 ? 4 : 5);
  return a.x > a.y ? (n.x > 0.0 ? 0 : 1) : (n.y > 0.0 ? 2 : 3);
}

// one heap type on one face: two offset grids, each cell holding at most one cloud
float heapField(int k, vec2 F, int face, float alt, float base, float topKm, float cov, float fp){
  vec4 A = uHeapA[k], B = uHeapB[k], C = uHeapC[k];
  float cell = C.x, e = 0.0;
  // three grids at irregular offsets: anchors don't line up into a visible lattice
  for (int j = 0; j < 3; j++){
    vec2 off = vec2(j == 1 ? 0.37 : (j == 2 ? 0.71 : 0.0), j == 1 ? 0.71 : (j == 2 ? 0.29 : 0.0)) * cell;
    vec2 cid = floor((F + off) / cell);
    vec4 h = pcg4(vec4(cid, float(face * 8 + k), float(j)));
    float hx = mix(A.z, A.w, h.y);
    // probability of a cloud in the cell, so the cloud footprints add up to the observed cover
    float area = 3.1416 * (0.72 * hx) * (0.72 * hx * C.y * 1.12);
    if (h.x > clamp(cov * cell * cell / (2.4 * area), 0.0, 1.0)) continue;
    vec2 ctr = (cid + 0.5) * cell - off + (h.zw - 0.5) * max(cell - 2.0 * hx * max(C.y, 1.0) * 1.25, 0.0);
    if (max(abs(ctr.x), abs(ctr.y)) > 0.7853982 * Rg) continue;   // each anchor belongs to one face
    vec4 h2 = pcg4(vec4(cid, float(face * 8 + k) + 0.5, float(j) + 7.0));
    float ang = h2.x * 6.2831853, ca = cos(ang), sa = sin(ang);
    vec2 d = F - ctr;
    d = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);
    float hy = hx * C.y * mix(1.0, 1.25, h2.y);
    // height: the type's proportions, stretched towards the observed cloud top
    float sz = hx * mix(B.x, B.y, h2.z);
    sz = clamp((topKm - base) / 1.41, sz * 0.75, sz * 1.35);
    vec3 o = vec3(d.x / hx, d.y / hy, (alt - (base + 0.56 * sz)) / sz);
    if (max(max(abs(o.x), abs(o.y)), abs(o.z)) >= 1.0) continue;
    float slab = A.x + floor(h2.w * A.y);
    vec3 uvw = o * 0.5 + 0.5;
    float zt = (slab * 64.0 + clamp(uvw.z * 64.0, 0.5, 63.5)) / C.z;
    float lod = clamp(log2(max(fp, 1e-3) * 48.0 / hx), 0.0, 3.0);
    // the library's anvils reach their box walls: fade the outer 15 % so no cloud is cut by a plane
    float wall = 1.0 - smoothstep(0.85, 1.0, max(abs(o.x), abs(o.y)));
    e = max(e, textureLod(uHeapTex, vec3(uvw.xy, zt), lod).r * B.w * wall);
  }
  return e;
}

float layerField(int k, vec2 F, int face, float z, float fp){
  vec4 A = uLayerA[k];
  vec2 uv = F / A.y + vec2(float(face) * 0.371, float(face) * 0.713);
  float zt = (A.x * 24.0 + clamp(z * 24.0, 0.5, 23.5)) / uLayerSlices;
  float lod = clamp(log2(max(fp, 1e-3) * 256.0 / A.y), 0.0, 3.0);
  return textureLod(uLayerTex, vec3(uv, zt), lod).r;
}

float modelExtinction(vec3 p, float r, CloudWx w, float lod){
  float alt = r - Rg;
  if (alt <= w.base || alt >= w.top || w.cov < 0.01) return 0.0;
  vec3 n = normalize(cloudAdvect(p, 1.0));
  // footprint of one cloud-pass pixel (the temporal resolve recovers some of it, hence the 0.7)
  float fp = 0.12 * exp2(lod) / mix(1.0, uCloudRes, 0.7);
  int face = cubeFace(n);
  vec2 F = faceUv(n, face);
  int k = int(w.kind + 0.5);
  float e;
  if (k < 4){
    e = heapField(k, F, face, alt, w.base, w.top, w.cov, fp);
    // anchors on the neighbouring face can reach across the edge
    float margin = uHeapA[k].w * 1.4 + uHeapC[k].x;
    if (max(abs(F.x), abs(F.y)) > 0.7853982 * Rg - margin){
      int f2 = sideFace(n, face);
      e = max(e, heapField(k, faceUv(n, f2), f2, alt, w.base, w.top, w.cov, fp));
    }
    // clouds below ~1.5 pixels: their observed cover as an effective (unresolved) extinction
    float unres = smoothstep(0.6, 1.6, fp / uHeapA[k].z);
    if (unres > 0.0){
      float H = max(w.top - w.base, 0.3);
      float sigEff = -log(max(1.0 - w.cov * 0.85 * (1.0 - exp(-uHeapB[k].w * 0.5 * H)), 1e-3)) / H;
      float hf = (alt - w.base) / H;
      e = mix(e, sigEff * smoothstep(0.0, 0.1, hf) * (1.0 - smoothstep(0.55, 1.0, hf)), unres);
    }
  } else {
    int kl = k - 4;
    float z = (alt - w.base) / (w.top - w.base);
    float d = layerField(kl, F, face, z, fp);
    // blend the neighbouring face's tiling over the last few km before an edge
    float edge = smoothstep(0.7853982 * Rg - 6.0, 0.7853982 * Rg, max(abs(F.x), abs(F.y)));
    if (edge > 0.0){ int f2 = sideFace(n, face); d = mix(d, layerField(kl, faceUv(n, f2), f2, z, fp), edge * 0.5); }
    // The pattern is stored before its threshold: cut it to the observed cover (varied over
    // ~40 km so decks open into mesoscale cells and rifts), as the Blender material does.
    float meso = textureLod(uNoise3D, n * (Rg / 41.0) + vec3(3.1, 7.7, 1.3), 1.0).r;
    float ce = clamp(w.cov * mix(0.6, 1.0, w.sheet) + (meso - 0.5) * 0.9 * (1.0 - w.cov * w.cov * w.cov), 0.0, 1.0);
    float qi = (1.0 - ce) * 32.0, qf = fract(qi);
    int i0 = int(qi), i1 = min(i0 + 1, 32);
    float thr = mix(uLayerQ[kl * 9 + i0 / 4][i0 % 4], uLayerQ[kl * 9 + i1 / 4][i1 % 4], qf);
    // magnified texels: widen the threshold so cells stay round instead of showing their texels
    float soft = uLayerA[kl].w * clamp(uLayerA[kl].y / 256.0 / fp, 1.0, 3.0);
    d = smoothstep(thr - 0.25 * soft, thr + soft, d);
    // cells below ~1.5 pixels (of the reduced-resolution cloud pass) would alias into a mosaic:
    // fade them into their covered fraction
    d = mix(d, ce * 0.8, smoothstep(0.35, 1.0, fp / uLayerB[kl].x));
    // brightness from the observations: mean extinction = observed optical depth / thickness
    e = d * w.sigma * 1.4;
  }
  return e;
}

// Extinction (1/km) at p. detail = fine billows/erosion (view rays); cheap lookups skip them.
float cloudExtinction(vec3 p, float r, CloudWx w, float lod, bool detail){
  float e = w.region < 0.999 ? cloudExtinctionGlobal(p, r, w, lod, detail) : 0.0;
  if (w.region > 0.0) e = mix(e, regionExtinction(p, r, lod, w.ground), w.region);
  return e;
}

// the procedural, data-steered field used everywhere outside the high-resolution region
float cloudExtinctionGlobal(vec3 p, float r, CloudWx w, float lod, bool detail){
  if (uModelsOn > 0.5) return modelExtinction(p, r, w, lod);
  float alt = r - Rg;
  if (alt <= w.base || alt >= w.top || w.cov < 0.01) return 0.0;
  float hf = (alt - w.base) / (w.top - w.base);
  // Cells smaller than ~1.5 pixels can't be resolved: in broken-to-overcast fields fade them into
  // their expected cover. Sparse fields stay discrete clumps; averaged they would turn into a
  // uniform translucent veil over clear ground.
  float unres = smoothstep(4.0, 5.3, lod) * smoothstep(0.3, 0.65, w.cov);
  lod = min(lod, 4.0);
  // carried by the same wind as the observations, plus slow internal evolution
  vec3 q = cloudAdvect(p, 1.0) + vec3(0.6, 0.35, -0.45) * (uCloudTime * 0.00025);
  q += (textureLod(uNoise3D, q / 37.0, min(lod + 1.0, 4.0)).gba - 0.5) * 6.0;

  // cells (~3-6 km) grouped into clusters (~25 km). Two rotated, incommensurate tilings of the
  // noise hide its period; the average of two uniform ranks is re-ranked (triangular CDF) so the
  // covered fraction still equals the observed one.
  float ra = noiseRank(textureLod(uNoise3D, q / 22.0, lod), lod);
  float rb = noiseRank(textureLod(uNoise3D, CLOUD_ROT * q / 34.7 + vec3(0.37, 0.71, 0.13), lod), lod);
  float sb = 0.5 * (ra + rb);
  float b = sb < 0.5 ? 2.0 * sb * sb : 1.0 - 2.0 * (1.0 - sb) * (1.0 - sb);
  float cl = textureLod(uNoise3D, q / 110.0 + vec3(7.1, -2.3, 4.7), min(lod + 1.5, 4.0)).r;
  // lumpy tops: low-rank columns lose their upper part
  float hfx = hf + (1.0 - b) * mix(0.15, 0.32, w.sheet);
  float cuProf = smoothstep(0.0, 0.07, hf) * (1.0 - hfx * hfx * hfx);                          // domes
  float stProf = smoothstep(0.0, 0.12, hf) * (1.0 - smoothstep(0.62, 1.0, hfx));                 // flat decks
  float cbProf = smoothstep(0.0, 0.04, hf) * mix(1.0 - 0.55 * hf, 1.15, smoothstep(0.80, 0.90, hf))
               * (1.0 - smoothstep(0.95, 1.0, hfx * 0.9 + 0.1 * hf));                            // tower + anvil
  float prof = max(mix(mix(cuProf, stProf, w.sheet), cbProf, w.conv), 0.0);
  float thr = 1.0 - w.cov * prof + (cl - 0.5) * 0.35 * (1.0 - w.sheet) * (1.0 - w.conv);
  float d = prof > 0.001 ? smoothstep(thr - 0.015, thr + 0.09, b) : 0.0;
  float dMean = clamp(w.cov * prof, 0.0, 1.0);

  if (w.cirrus > 0.01){
    // fibrous ice streaks stretched along the (zonal) flow
    vec3 qc = cloudAdvect(p, 1.8);
    vec3 east = normalize(vec3(qc.z, 0.0, -qc.x) + vec3(1e-4, 0.0, 0.0));
    qc -= east * dot(qc, east) * 0.8;
    float fil = noiseRank(textureLod(uNoise3D, qc / 19.0 + vec3(3.0, -9.0, 12.0), lod), lod);
    float cProf = smoothstep(0.0, 0.25, hf) * (1.0 - smoothstep(0.6, 1.0, hf));
    float dc = smoothstep(1.0 - w.cov * cProf - 0.05, 1.0 - w.cov * cProf + 0.25, fil) * cProf;
    d = mix(d, dc, w.cirrus);
  }

  // Fine detail erodes only the boundary: wispy undersides, billowed (cauliflower) tops.
  float dk = smoothstep(2.0, 3.0, lod);
  float dw = uDetailMean;
  if (detail && dk < 1.0){
    vec4 dn = textureLod(uNoise3D, q / 2.3 + vec3(0.0, hf * 0.4, 0.0), lod * 0.8);
    dw = mix(dn.g * 0.625 + dn.b * 0.25 + dn.a * 0.125, uDetailMean, dk);
  }
  float dmod = mix(1.0 - dw, dw, smoothstep(0.1, 0.6, hf));
  d = clamp(remap(d, dmod * mix(0.42, 0.18, w.cirrus), 1.0, 0.0, 1.0), 0.0, 1.0);
  if (unres <= 0.0) return d * w.sigma;
  // Unresolved broken cloud: a fraction f of opaque cells passes 1 - f(1 - e^-tau) of the light,
  // far more than a homogeneous slab of the same mean density, so use that effective extinction.
  float H = max(w.top - w.base, 0.3);
  float sigEff = -log(max(1.0 - dMean * (1.0 - exp(-w.sigma * H)), 1e-3)) / H;
  return mix(d * w.sigma, sigEff, unres);
}

// Shared LOD rule: noise mip from the full-resolution pixel footprint (km/pixel) at the sample.
float cloudLod(float fpKm){ return clamp(log2(max(fpKm, 0.02) / 0.12), 0.0, 6.0); }
// LOD the view raymarch uses at a point: pixel footprint, or its step length when it is
// undersampling (distant/grazing rays) — then the noise is pre-blurred instead of skipped over.
float cloudViewLod(float fpKm, float dtKm){ return clamp(max(log2(max(fpKm, 0.02) / 0.12), log2(max(dtKm, 0.02) / 0.35)), 0.0, 6.0); }
// mip of the ~4.9 km/texel observation map for a footprint (km)
float wxLod(float fpKm){ return clamp(log2(max(fpKm, 1.0) / 4.9), 0.0, 6.0); }

// Sunlight reaching a point below/inside the cloud layer: walks the sun ray through the layer with
// the same weather and extinction as the visible clouds. Clouds pass diffuse, multiply-scattered
// light, which keeps real cloud shadows soft and grey rather than black.
float cloudShadowAt(vec3 P, vec3 L, float lod, float jitter){
  float r0 = length(P);
  float ta = 0.0;
  if (r0 < Rcb){ vec2 ti = raySphere(P, L, Rcb); if (ti.y <= 0.0) return 1.0; ta = max(ti.y, 0.0); }
  vec2 to = raySphere(P, L, Rct);
  float tb = min(to.y, ta + 45.0);
  if (tb <= ta) return 1.0;
  float wl = wxLod(exp2(lod) * 0.12);
  vec3 q1 = P + L * ta, q2 = P + L * mix(ta, tb, 0.6);
  CloudWx w1 = cloudWeather(normalize(q1), q1, wl), w2 = cloudWeather(normalize(q2), q2, wl);
  if (max(w1.cov, w2.cov) < 0.01) return 1.0;
  int NS = uCloudSteps > 64.0 ? 12 : 8;
  if (uModelsOn > 0.5){
    // library clouds sit in a known altitude band: walk only that, in fine steps (sharp shadows
    // without the stepping pattern of a long coarse walk)
    float lo = min(w1.lo, w2.lo), hi = max(w1.hi, w2.hi);
    if (r0 < Rg + lo){ vec2 tl = raySphere(P, L, Rg + lo); ta = max(tl.y, 0.0); }
    vec2 th = raySphere(P, L, Rg + hi);
    tb = min(tb, max(th.y, ta + 0.3));
    if (tb <= ta) return 1.0;     // the sun ray leaves the search range before reaching the layer
    NS = 10;
  } else if (max(w1.region, w2.region) > 0.0){
    // the observed layer is thin and sharp: walk only its altitude band, in finer steps
    vec2 th = raySphere(P, L, Rg + max(w1.hi, w2.hi));
    tb = min(tb, max(th.y, ta + 0.5));
    NS = 16;
  }
  float dt = (tb - ta) / float(NS);
  float od = 0.0;
  CloudWx w = w1;
  for (int i = 0; i < 16; i++){
    if (i >= NS) break;
    vec3 p = P + L * (ta + (float(i) + jitter) * dt);
    float r = length(p);
    if (uModelsOn > 0.5 ? i == NS / 2 : (i == 4 || i == 8 || i == 12)) w = cloudWeather(p / r, p, wl);
    od += cloudExtinction(p, r, w, lod, false) * dt;
    if (od > 40.0) break;
  }
  float direct = exp(-od);
  float diffuse = 1.0 / (1.0 + 0.11 * od);         // two-stream diffuse transmission, (1 - g) tau
  return 0.12 + 0.88 * (direct + (1.0 - direct) * diffuse * 0.5);
}
`;
