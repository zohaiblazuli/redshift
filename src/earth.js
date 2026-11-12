import * as THREE from 'three';
import { noiseGLSL, commonGLSL, atmosphereGLSL, cloudShadowGLSL, cloudGLSL, volumeGLSL } from './shaders.js';
import { createCloudNoise } from './clouds.js';
import { cloudModelUniforms, loadCloudModels } from './cloudmodels.js';

export const R_EARTH = 6371.0;
export const R_ATMO = 6471.0;

const TEX_BASE = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets/';
// Day of real cloud observations in data/clouds/ (bake another with tools/bake_clouds.py).
// Master cloud switch: false removes every cloud (volumetric pass, ground shadows, probe deck, data loads).
// Off: the app runs cloud-free until the external cloud renderer is plugged in (cloudslot.js).
export const CLOUDS_ENABLED = false;
// Procedural cloud shapes (noise steered by the observations; the code is kept): off, so only the
// Blender cloud models draw clouds — with those switched off (Z) the sky is clear.
export const PROCEDURAL_CLOUDS = false;
// Master atmosphere switch: false removes the sky, limb glow, air haze and sunlight reddening.
export const ATMOSPHERE_ENABLED = true;
export const CLOUD_DATE = '2026-10-11';
// High-resolution observed region (tools/bake_region.py); off while the Blender cloud models
// (data/clouds/models, blender_clouds/bake_volumes.py) shape the clouds.
const CLOUD_REGION = null;

// Imagery: EOX Sentinel-2 cloudless 2020 at every zoom level.
const s2Url = (z, x, y) =>
  `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`;
// Elevation: Terrarium-encoded global DEM (AWS Open Data / Mapzen terrain tiles), incl. bathymetry.
const terrainUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const H_MAXZ = 12;
// Elevation is fetched one zoom level coarser than the imagery: its 256-sample tiles then still put
// a height sample every ~1-2.5 screen pixels (relief stays pixel-sharp), at a quarter of the
// download - Terrarium PNGs are ~80 KB each, 20x the size of an imagery tile.
const H_OFFSET = 1;
const demZ = (z) => Math.max(2, Math.min(H_MAXZ, z - H_OFFSET));

// When the page is served by server.js, tiles go through its disk cache (tilecache/), so a planned
// flight path downloads once and replays offline. Opened as a plain file, tiles stream directly.
export const tileCache = { available: false };
if (location.protocol.startsWith('http')) {
  fetch('tiles/stats').then((r) => { tileCache.available = r.ok; }).catch(() => {});
}
const DIRECT = { s2: s2Url, dem: terrainUrl };
export const tileUrl = (src, z, x, y) => (tileCache.available ? `tiles/${src}/${z}/${x}/${y}` : DIRECT[src](z, x, y));

// ---------------------------------------------------------------------------------------------
// Ground shader (imagery tiles with Terrarium elevation, and the global fallback sphere)
// ---------------------------------------------------------------------------------------------
const groundVert = /* glsl */ `
attribute float aSkirt;
uniform sampler2D uHeight;
uniform vec4 uHXform;
uniform float uHasHeight;
uniform float uExag;
varying vec3 vWorld;
varying vec2 vUv;
void main(){
  vUv = uv;
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 n = normalize(wp);
  float disp = 0.0;
#ifndef GLOBAL_MAP
  float h = uHasHeight > 0.5 ? textureLod(uHeight, uv * uHXform.zw + uHXform.xy, 0.0).r : 0.0;
  disp = max(h, 0.0) * uExag - aSkirt * 3.0;
#endif
  vWorld = wp + n * disp;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + n * disp, 1.0);
}`;

const groundFrag = /* glsl */ `
${commonGLSL}
${noiseGLSL}
${atmosphereGLSL}
${cloudShadowGLSL}
${volumeGLSL}
uniform sampler2D uMap;
uniform vec4 uUvXform;
// Sharper imagery fades in instead of popping: the coarser tile it replaces is (nearly) this tile
// several mip levels down, so the fade eases a mip bias from that level difference to 0. No extra
// sampler (the ground shader is at the 16-texture-unit limit).
uniform float uFadeBias;
uniform sampler2D uHeight;
uniform vec4 uHXform;
uniform float uHasHeight;
uniform float uHTexelKm;
uniform float uExag;
uniform sampler2D uNight;
uniform float uLights;
uniform float uLandGain;
varying vec3 vWorld;
varying vec2 vUv;

float hAt(vec2 uv){ return texture2D(uHeight, uv).r; }

void main(){
  vec3 P = vWorld;
  vec3 N = normalize(P);
  vec3 camToP = P - cameraPosition;
  float dist = length(camToP);
  vec3 rd = camToP / dist;
  vec3 V = -rd;
  vec3 L = uSunDir;
  float fp = length(fwidth(P));
  vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), N) + vec3(1e-6, 0.0, 0.0));
  vec3 north = cross(N, east);

#ifdef GLOBAL_MAP
  vec3 alb = texEquirect(uMap, N).rgb;
#else
  vec3 alb = texture2D(uMap, vUv * uUvXform.zw + uUvXform.xy, uFadeBias).rgb;
#endif
  vec3 night = texEquirect(uNight, N).rgb;
  float NdLg = dot(N, L);

  // ---- terrain: relief normal + self-shadowing from the elevation tile ----
  float h = 0.0;
  vec3 Nt = N;
  float terrShadow = 1.0;
  float skyOpen = 1.0;     // ray-traced sky visibility (cosine-weighted) of the terrain
#ifndef GLOBAL_MAP
  if (uHasHeight > 0.5){
    vec2 huv = vUv * uHXform.zw + uHXform.xy;
    float tk = uHTexelKm * max(sqrt(1.0 - N.y * N.y), 0.05);   // km per height texel (Mercator)
    float e = 1.0 / 256.0;
    h = hAt(huv);
    float hE = hAt(huv + vec2(e, 0.0)), hW = hAt(huv - vec2(e, 0.0));
    float hS = hAt(huv + vec2(0.0, e)), hN = hAt(huv - vec2(0.0, e));
    float dhe = (max(hE, 0.0) - max(hW, 0.0)) / (2.0 * tk);
    float dhn = (max(hN, 0.0) - max(hS, 0.0)) / (2.0 * tk);
    Nt = normalize(N - (east * dhe + north * dhn) * uExag * 1.15);
    // march the height field toward the sun for cast mountain shadows
    vec2 sdir = vec2(dot(L, east), -dot(L, north));
    float sl = length(sdir);
    if (NdLg > 0.0 && sl > 1e-3 && h > 0.0){
      sdir /= sl;
      float tanEl = NdLg / sl;
      // cast shadows use the true (unexaggerated) heights: exaggerated relief at a dawn sun throws
      // shadows several times too long, which read as dark cloud shadows from orbit
      float h0 = max(h, 0.0);
      float d = tk * 1.2;
      for (int i = 0; i < 14; i++){
        float hs = max(hAt(huv + sdir * (d / tk) * e), 0.0);
        float rayH = h0 + d * tanEl;
        // penumbra: the 0.5 deg sun disc plus forward-scattered skylight soften the edge (~2.5 deg)
        terrShadow = min(terrShadow, clamp(0.5 + (rayH - hs) / (d * 0.045 + 0.02), 0.0, 1.0));
        d *= 1.4;
      }
    }
    // sky visibility: baked per height texel when the elevation tile loads (skyBakeFrag, G channel).
    // Valleys and gorges lose skylight and take light bounced off the sunlit slopes instead.
    skyOpen = texture2D(uHeight, huv).g;
  }
#endif

  vec3 s = sqrt(max(alb, 0.0));
  float water = smoothstep(0.0, 0.04, s.b - max(s.r, s.g)) * (1.0 - smoothstep(0.42, 0.62, s.g));
  // only clearly elevated ground vetoes water (coarse DEM tiles would otherwise chop coasts into blocks)
  water *= 1.0 - smoothstep(0.3, 0.8, h);
  // global land/sea mask: open sea is always water, even on coarse fallback imagery
  // (with an elevation tile the sea floor itself decides: the ~10 km mask would paint blocky
  // squares of glint / no-glint along island coasts)
  if (uHasHeight > 0.5) water = max(water, 1.0 - smoothstep(-0.03, -0.005, h));
  else water = max(water, 1.0 - smoothstep(0.0, 0.12, texEquirect(uCloudMap, N).g));

  // ---- light ----
  // the clouds themselves render at full detail; their shadow on a ground pixel uses the noise
  // pre-filtered to that pixel's footprint (isotropic minor axis), so distant shadows don't speckle.
  // The LOD lookup preserves coverage, so each shadow still matches its cloud.
  float fpIso = min(length(dFdx(P)), length(dFdy(P)));
  float lodS = cloudLod(fpIso);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float cloudSh = (NdLg > -0.08 && uCloudCover > 0.0) ? cloudShadowAt(P + N * 0.02, L, lodS, jit) : 1.0;
  // shared cloud shadow map (Lighting hub; exactly 1 while no cloud provider is attached): feeds
  // direct sun, skylight, sea reflections and the haze dimming below, like the built-in clouds
  cloudSh *= cloudShadowT(P + N * 0.02);
  vec3 Tsun = sunTransmittance(Rg + max(h, 0.0) + 0.05, NdLg);
  vec3 E = uSunE * Tsun * cloudSh * terrShadow;
  // skylight from the precomputed irradiance table (real dawn sky colour and strength), reduced by
  // the ray-traced terrain horizon, the facet's tilt and cloud cover overhead
  float tilt = 0.5 + 0.5 * dot(Nt, N);                 // share of the sky dome a sloped facet faces
  vec3 skyE = skyIrradiance(Rg + max(h, 0.0), NdLg) * skyOpen * tilt * (0.4 + 0.6 * cloudSh);

  // land: Lambert on the relief normal + sky irradiance + one bounce off the surrounding terrain:
  // whatever part of the hemisphere is not sky sees sunlit ground of about the same albedo
  vec3 landAlb = alb * uLandGain;
  vec3 Eflat = uSunE * Tsun * cloudSh * max(NdLg, 0.0);
  vec3 bounce = Eflat * landAlb * clamp(1.0 - skyOpen * tilt, 0.0, 1.0);
  vec3 col = landAlb / PI * (E * max(dot(Nt, L), 0.0) * smoothstep(-0.02, 0.06, NdLg) + skyE + bounce);

  // ---- ocean (only evaluated where there is water) ----
  if (water > 0.01){
    // Cox-Munk: mean-square wave slope = 0.003 + 0.00512 * wind (m/s); for the usual 4-9 m/s open-sea
    // wind that is GGX alpha ~0.15-0.22. Wind varies only gently over hundreds of km, so the glint
    // stays one broad soft patch instead of a mottled (cloud-like) mix of mirror-calm and rough water.
    float wind = snoise(P * 0.002) * 0.5 + 0.5;
    float rough = mix(0.15, 0.22, wind);
    // resolved wave facets when close; they fade into the GGX roughness further away
    float waveFade = 1.0 - smoothstep(0.03, 0.4, fp);
    vec3 Nw = N;
    if (waveFade > 0.0){
      vec3 q = P * 18.0;
      vec2 g = vec2(snoise(q), snoise(q + 17.1)) + 0.5 * vec2(snoise(q * 2.3 + 5.0), snoise(q * 2.3 - 9.0));
      Nw = normalize(N + (east * g.x + north * g.y) * 0.06 * waveFade);
    }
    vec3 H = normalize(L + V);
    float NdH = max(dot(Nw, H), 0.0);
    float NdV = max(dot(Nw, V), 1e-3);
    float NdLw = max(dot(Nw, L), 0.0);
    float a2 = rough * rough;
    float dd = NdH * NdH * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dd * dd);
    float k = rough * 0.5;
    float G = (NdLw / (NdLw * (1.0 - k) + k)) * (NdV / (NdV * (1.0 - k) + k));
    float F = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    vec3 spec = E * (D * G * F / (4.0 * NdV));
    // The glint core is hundreds of times brighter than the land; left unbounded it floods the bloom
    // and spreads a white veil over the coasts. Roll it off softly to just below the bloom threshold.
    float specL = dot(spec, vec3(0.2126, 0.7152, 0.0722));
    spec *= 6.0 / (6.0 + specL);
    float Fv = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
    // reflected sky: integrate the real atmosphere along the mirror direction
    vec3 Rr = reflect(rd, Nw);
    Rr = normalize(Rr + N * max(0.03 - dot(Rr, N), 0.0));
    vec3 Ssky, Tsky;
    atmosphereN(P + N * 0.02, Rr, 1e9, 5, Ssky, Tsky);
    vec3 skyRefl = Ssky * (0.35 + 0.65 * cloudSh);
    vec3 deep = vec3(0.0025, 0.010, 0.030);
    float shallow = uHasHeight > 0.5 ? exp(min(h, 0.0) / 0.025) : 0.0;
    // trust imagery colour only in shallows; open ocean takes its colour from optics, not from the
    // (source-dependent, bathymetry-tinted) imagery — avoids tile-to-tile colour seams
    float deepness = uHasHeight > 0.5 ? smoothstep(-0.008, -0.05, h) : 0.0;
    float turquoise = smoothstep(0.8, 0.95, s.g / max(s.b, 1e-3)) * smoothstep(0.18, 0.38, s.g);
    vec3 wAlb = mix(deep, alb * 1.1, turquoise * (1.0 - deepness));
    wAlb = mix(wAlb, max(wAlb, vec3(0.012, 0.06, 0.07)), shallow * (1.0 - deepness) * 0.5 * turquoise);
    vec3 waterCol = wAlb / PI * (E * NdLw + skyE) * (1.0 - Fv) + spec + skyRefl * Fv;
    col = mix(col, waterCol, water);
  }

  // ---- night lights ----
  float nightF = smoothstep(0.06, -0.14, NdLg);
  if (nightF > 0.0){   // day side skips the noise entirely
    float sparkle = smoothstep(-0.2, 0.7, snoise(P * 0.9)) * 0.7 + smoothstep(0.1, 0.9, snoise(P * 2.7 + 4.0)) * 0.6;
    float covHere = uCloudCover > 0.0 ? cloudFraction(N, 2.0) * min(uCloudCover, 1.0) : 0.0;
    col += night * night * nightF * uLights * (0.35 + sparkle) * (1.0 - 0.8 * covHere);
  }

  vec3 S, T;
  aerial(cameraPosition, rd, dist, S, T);
  // the lowest air column (below the cloud deck) is shadowed too; approximate by dimming a share
  // of the in-scatter in cloud shadow — makes shadows read over the hazy ocean like in photos
  S *= mix(1.0, 0.62, 1.0 - cloudSh);
  gl_FragColor = vec4(col * T + S, 1.0);
}`;

// Sky-visibility bake, run once per elevation tile: trace 6 rays through the height field, find each
// one's horizon elevation and integrate the cosine-weighted sky above it (occluded share of a horizon
// at angle a = sin^2 a). Output R = height (km), G = sky visibility. The ray offsets are in texels, so
// the result only depends on the tile; the per-pixel shader just reads it back.
const skyBakeVert = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const skyBakeFrag = /* glsl */ `
uniform sampler2D uH;
uniform float uTexelKm;
uniform vec2 uTileY;   // (tile row, 2^z)
varying vec2 vUv;
float hAt(vec2 uv){ return texture2D(uH, uv).r; }
void main(){
  float yn = (uTileY.x + vUv.y) / uTileY.y;
  float lat = atan(sinh(3.14159265 * (1.0 - 2.0 * yn)));
  float tk = uTexelKm * max(cos(lat), 0.05);
  float e = 1.0 / 256.0;
  float h = hAt(vUv);
  float hp = max(h, 0.0);
  float occ = 0.0;
  for (int k = 0; k < 6; k++){
    float a = float(k) * 1.0471976 + 0.2618;
    vec2 dir = vec2(cos(a), sin(a));
    float t2 = 0.0;
    float d = tk;
    for (int i = 0; i < 5; i++){
      float rise = (max(hAt(vUv + dir * (d / tk) * e), 0.0) - hp) / d;
      t2 = max(t2, rise);
      d *= 2.2;
    }
    occ += t2 * t2 / (1.0 + t2 * t2);
  }
  gl_FragColor = vec4(h, 1.0 - occ / 6.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Cloud deck
// ---------------------------------------------------------------------------------------------
const cloudVert = /* glsl */ `
varying vec3 vWorld;
void main(){
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const cloudFrag = /* glsl */ `
${commonGLSL}
${noiseGLSL}
${atmosphereGLSL}
${cloudGLSL}
varying vec3 vWorld;

void main(){
  vec3 N = normalize(vWorld);
  vec3 Pc = N * (Rg + CLOUD_ALT);
  vec3 camToP = Pc - cameraPosition;
  float dist = length(camToP);
  vec3 rd = camToP / dist;
  float fp = length(fwidth(Pc));
  float cov = cloudCoverage(N);
  if (cov < 0.01) discard;
  vec3 q = cloudWarp(Pc);
  float soft;
  float h = cloudField(q, cov, fp, 5, soft);
  float d = cloudDensityS(h, soft);
  if (d < 0.004) discard;

  vec3 L = uSunDir;
  vec3 T1 = normalize(cross(vec3(0.0, 1.0, 0.0), N) + vec3(1e-4, 0.0, 0.0));
  vec3 T2 = cross(N, T1);
  // the raw field doubles as a height map (1.0 ~ 2.4 km of cumulus tower) -> billowy lit tops
  float e = max(0.3, fp * 1.2);
  float sd;
  float h6 = cloudField(q, cov, fp, 3, sd);
  float dx = cloudField(q + T1 * e, cov, fp, 3, sd) - h6;
  float dy = cloudField(q + T2 * e, cov, fp, 3, sd) - h6;
  vec2 grad = vec2(dx, dy) / e * 2.4;
  vec3 n = normalize(N - T1 * grad.x - T2 * grad.y);

  float NdLg = dot(N, L);
  float NdL = dot(n, L);
  vec3 Lt = L - N * NdLg;
  float ltl = length(Lt);
  float occ = 0.0;
  if (ltl > 0.05){
    float hs = cloudField(q + Lt / ltl * 1.4, cov, fp, 3, sd);
    occ = clamp((hs - h) * 1.3, 0.0, 1.0) * ltl;
  }
  vec3 Ts = sunTransmittance(Rg + CLOUD_ALT, NdLg);
  vec3 sunL = uSunE * Ts * smoothstep(-0.06, 0.06, NdLg);
  float diff = mix(max(NdLg, 0.0), clamp(NdL * 0.7 + 0.3, 0.0, 1.0), 0.8);
  float ao = mix(0.5, 1.0, smoothstep(-0.05, 0.8, h));
  float mu = dot(rd, L);
  float hg = (1.0 - 0.36) / pow(1.0 + 0.36 - 1.2 * mu, 1.5) / (4.0 * PI);
  vec3 amb = uSunE * vec3(0.028, 0.045, 0.085) * smoothstep(-0.2, 0.4, NdLg);
  vec3 c = 0.95 / PI * (sunL * diff * (1.0 - 0.6 * occ) * ao + amb * PI * ao)
         + sunL * (1.0 - d) * hg * 0.6;
  float alpha = d;

  vec3 S, T;
  aerial(cameraPosition, rd, dist, S, T);
  gl_FragColor = vec4(c * T + S, clamp(alpha, 0.0, 1.0));
}`;

// ---------------------------------------------------------------------------------------------
// Sky shell (limb glow / blue airglow) — additive, drawn before the opaque planet
// ---------------------------------------------------------------------------------------------
const skyFrag = /* glsl */ `
#define ATM_STEPS 24
${commonGLSL}
${atmosphereGLSL}
varying vec3 vWorld;
void main(){
  vec3 rd = normalize(vWorld - cameraPosition);
  vec2 tg = raySphere(cameraPosition, rd, Rg);
  float tMax = tg.x > 0.0 ? tg.x : 1e9;
  vec3 S, T;
  atmosphere(cameraPosition, rd, tMax, S, T);
  gl_FragColor = vec4(S, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Sun billboard
// ---------------------------------------------------------------------------------------------
export const SUN_DISC_TAN = Math.tan(THREE.MathUtils.degToRad(0.265));
// Catalyst2Roblox disc-lighting.json, 12:00 capture (SkyPhysicalSunDisk PS 12259399).
export const CATALYST_SUN_RADIUS = THREE.MathUtils.degToRad(0.5835);
export const CATALYST_SUN_TAN = Math.tan(CATALYST_SUN_RADIUS);
const sunVert = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const sunFrag = /* glsl */ `
varying vec2 vUv;
uniform vec3 uTint;
uniform float uDiscR;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float x = r / uDiscR;               // in solar radii
  // photosphere: hard edge, wavelength-dependent limb darkening I = 1 - u (1 - mu)
  float mu = sqrt(max(1.0 - x * x, 0.0));
  vec3 u = vec3(0.50, 0.62, 0.78);
  vec3 disc = (1.0 - u * (1.0 - mu)) * (1.0 - smoothstep(0.96, 1.0, x));
  vec3 col = vec3(1.0, 0.98, 0.95) * disc * 260.0;
  // a thin aureole just outside the limb; the big soft glow and rays are the lens's (lens.js
  // SunFlarePass, Catalyst's core and halo elements)
  float glow = 3.0 / (1.0 + 0.6 * x * x * x) + 0.02 * exp(-x * 0.12);
  col += vec3(1.0) * glow * smoothstep(0.95, 1.05, x) * (1.0 - smoothstep(0.6, 1.0, r));
  gl_FragColor = vec4(col * uTint, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------------------------
const starVert = /* glsl */ `
attribute float aMag;
attribute vec3 aCol;
varying vec3 vCol;
uniform float uStarI;
void main(){
  vCol = aCol * aMag * uStarI;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = 1.0 + aMag * 1.6;
}`;
const starFrag = /* glsl */ `
varying vec3 vCol;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(p, p) * 3.0);
  gl_FragColor = vec4(vCol * a, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
export function latLonToVec(latDeg, lonDeg, r = 1, out = new THREE.Vector3()) {
  const la = THREE.MathUtils.degToRad(latDeg), lo = THREE.MathUtils.degToRad(lonDeg);
  return out.set(Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)).multiplyScalar(r);
}
export function vecToLatLon(v) {
  const n = v.clone().normalize();
  return { lat: THREE.MathUtils.radToDeg(Math.asin(n.y)), lon: THREE.MathUtils.radToDeg(Math.atan2(n.x, n.z)) };
}
const mercLat = (yNorm) => Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm))) * 180 / Math.PI;

// JS twin of the shader's Chapman-based sun transmittance (used to light the spacecraft
// and to tint/dim the sun disc as seen through the limb).
const BR = [5.802e-3, 13.558e-3, 33.1e-3], BMe = 4.4e-3, BO = [0.65e-3, 1.881e-3, 0.085e-3];
function odToSun(r, mu, H) {
  const X = r / H, h = (r - R_EARTH) / H, c = Math.sqrt(0.5 * Math.PI * X);
  if (mu >= 0) return H * Math.exp(-h) * c / ((c - 1) * mu + 1);
  const s = Math.sqrt(Math.max(1 - mu * mu, 0));
  return H * (Math.exp(-h) * c / ((c - 1) * mu - 1) + 2 * c * Math.sqrt(s) * Math.exp(Math.min((R_EARTH - r * s) / H, 80)));
}
export function sunTransmittanceJS(pos, sunDir, out = new THREE.Color()) {
  const r = Math.max(pos.length(), R_EARTH + 0.01);
  const mu = pos.dot(sunDir) / r;
  const muH = -Math.sqrt(Math.max(1 - (R_EARTH / r) ** 2, 0));
  if (!ATMOSPHERE_ENABLED) return mu >= muH ? out.setRGB(1, 1, 1) : out.setRGB(0, 0, 0);
  if (mu < muH - 0.04) return out.setRGB(0, 0, 0);
  const tR = odToSun(r, mu, 8.0), tM = odToSun(r, mu, 1.2);
  const t = [0, 1, 2].map((i) => Math.exp(-(BR[i] * tR + BMe * tM + BO[i] * 15 * (tR / 8))));
  return out.setRGB(t[0], t[1], t[2]);
}

// ---------------------------------------------------------------------------------------------
// Imagery tile quadtree
// ---------------------------------------------------------------------------------------------
const ST_NONE = 0, ST_LOADING = 1, ST_READY = 2, ST_ERROR = 3;

class Tile {
  constructor(z, x, y) {
    this.z = z; this.x = x; this.y = y;
    this.key = `${z}/${x}/${y}`;
    this.state = ST_NONE;
    this.texture = null;
    this.hstate = ST_NONE;
    this.htex = null;
    this.mesh = null;
    this.shownSrc = null;    // tile whose imagery this tile's mesh currently shows
    this.fadeFrom = null;    // previous (coarser) source while fading to a sharper one
    this.fadeStart = 0;
    this.lastUsed = -1;
    this.priority = 0;
    const n = 2 ** z;
    this.lon0 = x / n * 360 - 180; this.lon1 = (x + 1) / n * 360 - 180;
    this.latN = mercLat(y / n); this.latS = mercLat((y + 1) / n);
    const latC = mercLat((y + 0.5) / n), lonC = (this.lon0 + this.lon1) / 2;
    this.dir = latLonToVec(latC, lonC);
    let maxAng = 0;
    for (const la of [this.latN, latC, this.latS]) for (const lo of [this.lon0, lonC, this.lon1]) {
      maxAng = Math.max(maxAng, this.dir.angleTo(latLonToVec(la, lo)));
    }
    this.angR = maxAng;
    this.sizeKm = 2 * Math.PI * R_EARTH * Math.cos(THREE.MathUtils.degToRad(latC)) / n;
    this.sphere = new THREE.Sphere(this.dir.clone().multiplyScalar(R_EARTH), R_EARTH * Math.sin(Math.min(maxAng, Math.PI / 2)) + 5);
  }
}

class TileManager {
  constructor(scene, makeMaterial, renderer) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.makeMaterial = makeMaterial;
    this.tiles = new Map();
    this.frame = 0;
    this.inflight = 0;
    this.maxInflight = 32;   // zooming in asks for hundreds of detail tiles at once: fetch them in parallel
    this.visible = [];
    this.aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    this.hiRes = true;
    this.loadedCount = 0;
    this.pending = 0;
    this.frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    // a tile is split once it would cover more than lodPx screen pixels: 256-texel tiles then land at
    // 1.3-2.6 texels per pixel, so the ground is always minified (crisp) and never wastefully fine
    this.lodPx = 200;
    this.prefetch = 0.7;   // on screen: preload one level finer once a tile reaches 70 % of its split size
    this.fadeMs = 400;
    this.preload = true;   // off: only on-screen tiles load (old behaviour; for comparisons)     // cross-fade when sharper imagery replaces a coarser stand-in
    this.hInflight = 0;
    this.exag = 1.0;
    this.renderer = renderer;
    this.bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bakeMat = new THREE.ShaderMaterial({
      uniforms: { uH: { value: null }, uTexelKm: { value: 1 }, uTileY: { value: new THREE.Vector2() } },
      vertexShader: skyBakeVert, fragmentShader: skyBakeFrag, depthTest: false, depthWrite: false,
    });
    this.bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bakeMat);
    this.bakeQuad.frustumCulled = false;
    this.hCanvas = new OffscreenCanvas(256, 256);
    this.hCtx = this.hCanvas.getContext('2d', { willReadFrequently: true });
  }

  loadHeight(t) {
    t.hstate = ST_LOADING;
    this.hInflight++;
    fetch(tileUrl('dem', t.z, t.x, t.y), { mode: 'cors' })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
      .then((bmp) => {
        this.hCtx.clearRect(0, 0, 256, 256);
        this.hCtx.drawImage(bmp, 0, 0, 256, 256);
        bmp.close();
        const d = this.hCtx.getImageData(0, 0, 256, 256).data;
        const arr = new Uint16Array(256 * 256);
        const toHalf = THREE.DataUtils.toHalfFloat;
        for (let i = 0; i < 65536; i++) {
          const m = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768; // metres
          arr[i] = toHalf(m * 0.001);
        }
        const tex = new THREE.DataTexture(arr, 256, 256, THREE.RedFormat, THREE.HalfFloatType);
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.flipY = false;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        t.hrt = this.bakeSky(t, tex);
        tex.dispose();
        t.htex = t.hrt.texture;
        t.hstate = ST_READY;
      })
      .catch(() => { t.hstate = ST_ERROR; })
      .finally(() => { this.hInflight--; });
  }

  // height (R) + baked sky visibility (G) for one elevation tile, in its own 256x256 target
  bakeSky(t, heightTex) {
    const rt = new THREE.WebGLRenderTarget(256, 256, {
      type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    const u = this.bakeMat.uniforms;
    u.uH.value = heightTex;
    u.uTexelKm.value = 2 * Math.PI * R_EARTH / 2 ** t.z / 256;
    u.uTileY.value.set(t.y, 2 ** t.z);
    const r = this.renderer, prev = r.getRenderTarget(), prevAuto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(rt);
    r.render(this.bakeQuad, this.bakeCam);
    r.setRenderTarget(prev);
    r.autoClear = prevAuto;
    u.uH.value = null;
    return rt;
  }

  get maxZ() { return this.hiRes ? 13 : 8; }

  get(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) { t = new Tile(z, x, y); this.tiles.set(key, t); }
    return t;
  }

  url(t) { return tileUrl('s2', t.z, t.x, t.y); }

  // Every imagery + elevation tile this tile manager would request with the camera at camPos,
  // looking in any direction (so free look is covered). Used by the flight planner.
  collect(camPos, pxScale, out) {
    const memo = out.memo;
    const get = (z, x, y) => {
      const k = `${z}/${x}/${y}`;
      let t = memo.get(k);
      if (!t) { t = new Tile(z, x, y); memo.set(k, t); }
      return t;
    };
    const D = camPos.length();
    const camDir = camPos.clone().divideScalar(D);
    const horizon = Math.acos(Math.min(1, R_EARTH / D));
    const maxZ = this.maxZ;
    const visit = (t) => {
      const ang = Math.acos(THREE.MathUtils.clamp(camDir.dot(t.dir), -1, 1));
      if (ang - t.angR > horizon + 0.01) return;
      const aMin = Math.max(0, ang - t.angR);
      const dist = Math.sqrt(Math.max(D * D + R_EARTH * R_EARTH - 2 * D * R_EARTH * Math.cos(aMin), 1));
      if (t.sizeKm / dist * pxScale > this.lodPx && t.z < maxZ) {
        const z = t.z + 1, x = t.x * 2, y = t.y * 2;
        visit(get(z, x, y)); visit(get(z, x + 1, y)); visit(get(z, x, y + 1)); visit(get(z, x + 1, y + 1));
        return;
      }
      // the tile, plus the ancestors drawn while it loads
      const add = (set, k) => { if (!set.has(k)) { set.add(k); out.all?.add(k); } };
      for (let d = 0, z = t.z, x = t.x, y = t.y; d <= 3 && z > 2; d++, z--, x >>= 1, y >>= 1) add(out.img, `s2/${z}/${x}/${y}`);
      let z = t.z, x = t.x, y = t.y;
      while (z > demZ(t.z)) { z--; x >>= 1; y >>= 1; }
      add(out.dem, `dem/${z}/${x}/${y}`);
      if (z > 2) add(out.dem, `dem/${z - 1}/${x >> 1}/${y >> 1}`);
    };
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) visit(get(2, x, y));
  }

  load(t) {
    t.state = ST_LOADING;
    this.inflight++;
    fetch(this.url(t), { mode: 'cors' })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then((b) => createImageBitmap(b))
      .then((bmp) => {
        const tex = new THREE.Texture(bmp);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        tex.anisotropy = this.aniso;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        // upload now (spread over arrivals), not on first draw: preloaded tiles would otherwise all
        // upload in the frame a fast turn reveals them
        this.renderer.initTexture(tex);
        t.texture = tex;
        t.state = ST_READY;
        this.loadedCount++;
      })
      .catch(() => { t.state = ST_ERROR; t.errorFrame = this.frame; t.errors = (t.errors || 0) + 1; })
      .finally(() => { this.inflight--; });
  }

  buildMesh(t) {
    const seg = t.z <= 3 ? 32 : t.z <= 6 ? 28 : 24;
    const n = 2 ** t.z;
    const verts = [], uvs = [], skirt = [], idx = [];
    const c = t.dir.clone().multiplyScalar(R_EARTH);
    const v = new THREE.Vector3();
    for (let j = 0; j <= seg; j++) {
      const lat = mercLat((t.y + j / seg) / n);
      for (let i = 0; i <= seg; i++) {
        const lon = (t.x + i / seg) / n * 360 - 180;
        latLonToVec(lat, lon, R_EARTH, v).sub(c);
        verts.push(v.x, v.y, v.z);
        uvs.push(i / seg, j / seg);
        skirt.push(0);
      }
    }
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, cc = a + seg + 1, d = cc + 1;
      idx.push(a, cc, b, b, cc, d);
    }
    // skirts hide cracks between neighbouring tiles at different LOD / height resolution
    const ring = [];
    for (let i = 0; i <= seg; i++) ring.push(i);
    for (let j = 1; j <= seg; j++) ring.push(j * (seg + 1) + seg);
    for (let i = seg - 1; i >= 0; i--) ring.push(seg * (seg + 1) + i);
    for (let j = seg - 1; j >= 1; j--) ring.push(j * (seg + 1));
    const base = verts.length / 3;
    for (const r of ring) {
      verts.push(verts[r * 3], verts[r * 3 + 1], verts[r * 3 + 2]);
      uvs.push(uvs[r * 2], uvs[r * 2 + 1]);
      skirt.push(1);
    }
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length], sa = base + k, sb = base + (k + 1) % ring.length;
      idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('aSkirt', new THREE.Float32BufferAttribute(skirt, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), t.sphere.radius + 10);
    const mesh = new THREE.Mesh(g, this.makeMaterial());
    mesh.position.copy(c);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    mesh.renderOrder = 0;
    this.group.add(mesh);
    t.mesh = mesh;
  }

  update(camera, camPos, viewportH) {
    this.frame++;
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._m);
    const D = camPos.length();
    const camDir = camPos.clone().divideScalar(D);
    const horizon = Math.acos(Math.min(1, R_EARTH / D));
    const pxScale = viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const selected = [];
    const maxZ = this.maxZ;

    const visit = (t) => {
      const ang = Math.acos(THREE.MathUtils.clamp(camDir.dot(t.dir), -1, 1));
      if (ang - t.angR > horizon + 0.01) return;
      if (!this.frustum.intersectsSphere(t.sphere)) return;
      const aMin = Math.max(0, ang - t.angR);
      const dist = Math.sqrt(Math.max(D * D + R_EARTH * R_EARTH - 2 * D * R_EARTH * Math.cos(aMin), 1));
      const px = t.sizeKm / dist * pxScale;
      t.priority = t.z * 1e6 + dist;
      if (px > this.lodPx && t.z < maxZ) {
        const z = t.z + 1, x = t.x * 2, y = t.y * 2;
        visit(this.get(z, x, y)); visit(this.get(z, x + 1, y));
        visit(this.get(z, x, y + 1)); visit(this.get(z, x + 1, y + 1));
      } else selected.push(t);
    };
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) visit(this.get(2, x, y));

    for (const t of this.visible) if (t.mesh) t.mesh.visible = false;
    const wanted = [], hwanted = [];
    const now = performance.now();
    // the DEM tile (or closest ready ancestor) for tile t, as [tile, levels up]; queues missing ones
    const heightFor = (t, queue) => {
      let hs = t, hd = 0;
      while (hs.z > demZ(t.z)) { hs = this.get(hs.z - 1, hs.x >> 1, hs.y >> 1); hd++; }
      let tries = 0;
      while (hs.hstate !== ST_READY) {
        if (hs.hstate === ST_NONE && tries < 2) queue.push(hs);
        tries++;
        if (hs.z <= 2) return null;
        hs = this.get(hs.z - 1, hs.x >> 1, hs.y >> 1); hd++;
      }
      return [hs, hd];
    };
    for (const t of selected) {
      t.lastUsed = this.frame;
      if (t.state === ST_NONE) wanted.push(t);
      else if (t.state === ST_ERROR && t.errors < 3 && this.frame - t.errorFrame > 300) wanted.push(t);
      // draw with the closest ancestor that has imagery
      let src = t, d = 0;
      while (src && src.state !== ST_READY) {
        if (src.z <= 2) { src = null; break; }
        src = this.get(src.z - 1, src.x >> 1, src.y >> 1); d++;
        if (src.state === ST_NONE && d <= 3) wanted.push(src);
      }
      if (!src) continue;
      src.lastUsed = this.frame;
      if (!t.mesh) this.buildMesh(t);
      const u = t.mesh.material.uniforms;
      // sharper imagery arrived: cross-fade from what was shown instead of popping
      if (t.shownSrc && t.shownSrc !== src && src.z > t.shownSrc.z) {
        t.fadeFrom = t.shownSrc; t.fadeStart = now;
      }
      t.shownSrc = src;
      u.uMap.value = src.texture;
      const s = 1 / 2 ** d;
      u.uUvXform.value.set((t.x - (src.x << d)) * s, (t.y - (src.y << d)) * s, s, s);
      const f = t.fadeFrom ? Math.min(1, (now - t.fadeStart) / this.fadeMs) : 1;
      if (f < 1) u.uFadeBias.value = (src.z - t.fadeFrom.z) * (1 - f * f * (3 - 2 * f));
      else { t.fadeFrom = null; u.uFadeBias.value = 0; }
      // elevation: its own fallback chain (DEM capped at z12)
      const hh = heightFor(t, hwanted);
      if (hh) {
        const [hs, hd] = hh;
        hs.lastUsed = this.frame;
        const hsc = 1 / 2 ** hd;
        u.uHeight.value = hs.htex;
        u.uHXform.value.set((t.x - (hs.x << hd)) * hsc, (t.y - (hs.y << hd)) * hsc, hsc, hsc);
        u.uHTexelKm.value = 2 * Math.PI * R_EARTH / 2 ** hs.z / 256;
        u.uHasHeight.value = 1;
      } else u.uHasHeight.value = 0;
      t.mesh.visible = true;
    }
    this.visible = selected;

    // Preload beyond the view so fast turns and zooms find their tiles already there: every tile
    // above the horizon in any direction, one level finer than needed once a tile nears its split
    // size (prefetch), plus the coarse global levels so the low-res fallback sphere never shows.
    // All of it queues behind what is on screen.
    const ahead = [], hahead = [];
    const pre = (t) => {
      const ang = Math.acos(THREE.MathUtils.clamp(camDir.dot(t.dir), -1, 1));
      if (ang - t.angR > horizon + 0.01) return;
      const aMin = Math.max(0, ang - t.angR);
      const dist = Math.sqrt(Math.max(D * D + R_EARTH * R_EARTH - 2 * D * R_EARTH * Math.cos(aMin), 1));
      const px = t.sizeKm / dist * pxScale;
      t.lastUsed = this.frame;
      if (t.state === ST_NONE) { t.priority = 1e8 + t.z * 1e6 + dist; ahead.push(t); }
      // finer prefetch only on screen (zoom / approach); off screen the level it would be drawn at
      const split = this.frustum.intersectsSphere(t.sphere) ? this.lodPx * this.prefetch : this.lodPx;
      if (px > split && t.z < maxZ) {
        const z = t.z + 1, x = t.x * 2, y = t.y * 2;
        pre(this.get(z, x, y)); pre(this.get(z, x + 1, y));
        pre(this.get(z, x, y + 1)); pre(this.get(z, x + 1, y + 1));
      } else if (t.z >= 4) {
        const hh = heightFor(t, hahead);
        if (hh) hh[0].lastUsed = this.frame;
      }
    };
    if (this.preload && this.frame % 4 === 0) {   // the off-screen set changes slowly
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) pre(this.get(2, x, y));
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const t = this.get(3, x, y);
        t.lastUsed = this.frame;
        if (t.state === ST_NONE) { t.priority = 3e6; ahead.push(t); }
      }
    }
    for (const t of hahead) t.priority = 1e8 + t.z * 1e6;
    this.preloadCount = ahead.length + hahead.length;

    // request queue: on-screen first (coarse levels first, then nearest), then the preload set
    wanted.sort((a, b) => a.priority - b.priority);
    hwanted.sort((a, b) => a.priority - b.priority);
    ahead.sort((a, b) => a.priority - b.priority);
    hahead.sort((a, b) => a.priority - b.priority);
    this.pending = wanted.length + hwanted.length;
    for (const t of wanted) {
      if (this.inflight >= this.maxInflight) break;
      if (t.state === ST_NONE || t.state === ST_ERROR) this.load(t);
    }
    for (const t of ahead) {
      if (this.inflight >= this.maxInflight) break;
      if (t.state === ST_NONE) this.load(t);
    }
    for (const t of hwanted) {
      if (this.hInflight >= 16) break;
      if (t.hstate === ST_NONE) this.loadHeight(t);
    }
    for (const t of hahead) {
      if (this.hInflight >= 16) break;
      if (t.hstate === ST_NONE) this.loadHeight(t);
    }

    if (this.frame % 60 === 0) this.evict();
  }

  evict() {
    let live = 0;
    for (const t of this.tiles.values()) if (t.texture && this.frame - t.lastUsed <= 90) live++;
    const budget = Math.max(800, Math.ceil(live * 1.5));
    if (this.loadedCount <= budget && this.tiles.size < 6000) return;
    const old = [...this.tiles.values()].filter((t) => this.frame - t.lastUsed > 90).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of old) {
      if (this.loadedCount <= budget * 0.8 && this.tiles.size < 4500) break;
      if (t.texture) { t.texture.dispose(); t.texture.image?.close?.(); t.texture = null; this.loadedCount--; }
      if (t.hrt) { t.hrt.dispose(); t.hrt = null; t.htex = null; }
      if (t.hstate === ST_LOADING || t.state === ST_LOADING) continue;
      if (t.mesh) { t.mesh.geometry.dispose(); t.mesh.material.dispose(); this.group.remove(t.mesh); t.mesh = null; }
      if (t.state !== ST_LOADING) this.tiles.delete(t.key);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// World assembly
// ---------------------------------------------------------------------------------------------
// lighting: the Lighting hub (lighting.js) -- sun, atmosphere and shared cloud shadow uniforms
export function createWorld(renderer, manager, lighting) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const loader = new THREE.TextureLoader(manager);
  const dayTex = loader.load(TEX_BASE + 'earth_day_4096.jpg');
  const nightTex = loader.load(TEX_BASE + 'earth_night_4096.jpg');
  // The source is global, but only a broad weather signal is needed inside the active flight
  // corridor. Downsample before GPU upload: 1024x512 is ample for synoptic cloud placement and
  // uses one sixteenth of the texture memory of the 4096 map.
  const cloudCanvas = document.createElement('canvas');
  cloudCanvas.width = 2; cloudCanvas.height = 1;
  const cloudTex = new THREE.CanvasTexture(cloudCanvas);
  new THREE.ImageLoader(manager).load(TEX_BASE + 'earth_bump_roughness_clouds_4096.jpg', (image) => {
    cloudCanvas.width = 1024; cloudCanvas.height = 512;
    const ctx = cloudCanvas.getContext('2d', { alpha: false });
    ctx.drawImage(image, 0, 0, cloudCanvas.width, cloudCanvas.height);
    cloudTex.needsUpdate = true;
  });
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  for (const t of [dayTex, nightTex]) t.colorSpace = THREE.SRGBColorSpace;
  cloudTex.colorSpace = THREE.NoColorSpace;
  for (const t of [dayTex, nightTex, cloudTex]) {
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = aniso;
  }

  // Real clouds: one observed day baked by tools/bake_clouds.py (needs the page served over http;
  // opened as a file, or before it loads, the climatological map stands in with typical properties).
  const fallbackProps = new THREE.DataTexture(new Uint8Array([128, 48, 120, 0]), 1, 1);
  fallbackProps.needsUpdate = true;
  const flatTerrain = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat);
  flatTerrain.needsUpdate = true;
  const cloudData = { date: CLOUD_DATE, loaded: false };
  if (CLOUDS_ENABLED && location.protocol.startsWith('http')) {
    const base = `data/clouds/${CLOUD_DATE}/`;
    const mk = (image, format) => {
      const t = new THREE.Texture(image, THREE.UVMapping, THREE.RepeatWrapping, THREE.ClampToEdgeWrapping,
        THREE.LinearFilter, THREE.LinearMipmapLinearFilter, format);
      t.colorSpace = THREE.NoColorSpace; t.anisotropy = aniso; t.generateMipmaps = true; t.needsUpdate = true;
      return t;
    };
    const il = new THREE.ImageLoader();
    Promise.all(['coverage.webp', 'properties.png', 'terrain.png'].map((f) => il.loadAsync(base + f))).then(([cov, props, ter]) => {
      // single channel on the GPU: the 8K coverage map costs 32 MB (+ mips) instead of 128 MB
      shared.uCloudCov.value = mk(cov, THREE.RedFormat);
      shared.uCloudProps.value = mk(props, THREE.RGBAFormat);
      shared.uTerrain.value = mk(ter, THREE.RedFormat);
      shared.uCloudCovChan.value.set(1, 0, 0, 0);
      cloudData.loaded = true;
    }).catch((e) => console.warn('Cloud observations unavailable, using climatology:', e));
    // high-resolution (~500 m) region of real cloud structure, if one was baked (tools/bake_region.py)
    if (CLOUD_REGION) fetch(base + `region-${CLOUD_REGION}.json`).then((r) => (r.ok ? r.json() : null)).then((meta) => {
      if (!meta) return;
      il.loadAsync(base + `region-${CLOUD_REGION}.png`).then((img) => {
        const d = Math.PI / 180;
        shared.uRegion.value = mk(img, THREE.RGBAFormat);
        shared.uRegion.value.wrapS = THREE.ClampToEdgeWrapping;
        shared.uRegionBox.value.set(meta.lon0 * d, meta.lat0 * d, meta.lon1 * d, meta.lat1 * d);
        shared.uRegionOn.value = 1;
      });
    }).catch(() => {});
  }

  const cloudNoise = createCloudNoise(renderer, 128);
  const shared = {
    ...lighting.uniforms,
    uCloudMap: { value: cloudTex },
    uCloudCover: { value: CLOUDS_ENABLED ? 1.0 : 0.0 },
    uCloudCov: { value: cloudTex },
    uCloudCovChan: { value: new THREE.Vector4(0, 0, 1, 0) },
    uCloudProps: { value: fallbackProps },
    uTerrain: { value: flatTerrain },
    uRegion: { value: flatTerrain },
    uRegionBox: { value: new THREE.Vector4() },
    uRegionOn: { value: 0 },
    ...cloudModelUniforms(),
    uCloudTime: { value: 0 },
    uCloudCut: { value: new THREE.Vector4() },
    uCloudCutOn: { value: 0 },
    uWind: { value: new THREE.Vector3() },
    uNight: { value: nightTex },
    uLights: { value: 6.0 },
    uLandGain: { value: 1.35 },
    uNoise3D: { value: cloudNoise.noise },
    uNoiseLut: { value: cloudNoise.lut },
    uDetailMean: { value: cloudNoise.detailMean },
    uExag: { value: 1.0 },   // true-scale relief (X exaggerates)
    uCloudSteps: { value: 56 },
  };

  const makeGround = (global = false) => new THREE.ShaderMaterial({
    uniforms: {
      ...shared, uMap: { value: global ? dayTex : null }, uUvXform: { value: new THREE.Vector4(0, 0, 1, 1) },
      uFadeBias: { value: 0 },
      uHeight: { value: null }, uHXform: { value: new THREE.Vector4(0, 0, 1, 1) }, uHasHeight: { value: 0 }, uHTexelKm: { value: 1 },
    },
    vertexShader: groundVert,
    fragmentShader: groundFrag,
    defines: global ? { GLOBAL_MAP: 1 } : {},
  });

  // global fallback sphere slightly below the tiles (fills poles, cracks and not-yet-loaded areas)
  // Drawn AFTER the tiles: it sits 4 km below them, so the depth test rejects every pixel a tile
  // already covers and the (heavy) ground shader only runs where it actually shows.
  const base = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH - 4, 384, 192), makeGround(true));
  base.renderOrder = 0.5;
  scene.add(base);

  const tiles = new TileManager(scene, () => makeGround(false), renderer);

  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH + 6, 720, 360),
    new THREE.ShaderMaterial({
      uniforms: { ...shared }, vertexShader: cloudVert, fragmentShader: cloudFrag,
      transparent: true, depthWrite: false,
    }),
  );
  clouds.renderOrder = 1;
  clouds.layers.set(2); // cheap 2D deck: environment probe only (the main view raymarches volumetric clouds)
  clouds.visible = CLOUDS_ENABLED;
  scene.add(clouds);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(R_ATMO, 256, 128),
    new THREE.ShaderMaterial({
      uniforms: { ...shared }, vertexShader: cloudVert, fragmentShader: skyFrag,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: false,
    }),
  );
  sky.renderOrder = -1;
  sky.visible = ATMOSPHERE_ENABLED;
  scene.add(sky);

  // stars (dim — a daylight-exposed orbital camera barely registers them)
  const starCount = 9000;
  const sp = new Float32Array(starCount * 3), sm = new Float32Array(starCount), sc = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    sp.set([s * Math.cos(th) * 9e4, u * 9e4, s * Math.sin(th) * 9e4], i * 3);
    sm[i] = Math.pow(Math.random(), 6) * 1.0 + 0.05;
    const tcol = Math.random();
    sc.set(tcol < 0.2 ? [1.0, 0.8, 0.6] : tcol < 0.6 ? [1, 0.95, 0.9] : [0.75, 0.85, 1.0], i * 3);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  sg.setAttribute('aMag', new THREE.BufferAttribute(sm, 1));
  sg.setAttribute('aCol', new THREE.BufferAttribute(sc, 3));
  const starUniforms = { uStarI: { value: 0.35 } };
  const stars = new THREE.Points(sg, new THREE.ShaderMaterial({
    uniforms: starUniforms, vertexShader: starVert, fragmentShader: starFrag,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: false,
  }));
  stars.renderOrder = -3;
  stars.frustumCulled = false;
  scene.add(stars);

  const sunUniforms = {
    uTint: { value: new THREE.Color(1, 1, 1) }, uDiscR: { value: 0.03 },
  };
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: sunUniforms, vertexShader: sunVert, fragmentShader: sunFrag,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: false,
  }));
  sun.renderOrder = -2;
  sun.frustumCulled = false;
  sun.layers.set(1); // excluded from the spacecraft's environment probe
  scene.add(sun);

  const tmpC = new THREE.Color();
  const SUN_DIST = 8e4;
  function update(camera, camPos, viewportH, sunDir, catalyst = false) {
    shared.uSunDir.value.copy(sunDir);
    const alt = camPos.length() - R_EARTH;
    sky.material.side = alt > 100 ? THREE.FrontSide : THREE.BackSide;
    stars.position.copy(camPos);
    // true-size photosphere (0.265 deg radius) in every output mode
    const quad = SUN_DIST * SUN_DISC_TAN / sunUniforms.uDiscR.value * 2;
    sun.position.copy(camPos).addScaledVector(sunDir, SUN_DIST);
    sun.scale.setScalar(quad);
    sun.quaternion.copy(camera.quaternion);
    // occlusion by the planet + limb reddening
    const b = camPos.dot(sunDir);
    const d2 = camPos.lengthSq() - b * b;
    const blocked = b < 0 && Math.sqrt(Math.max(d2, 0)) < R_EARTH;
    lighting.sunColorAt(camPos, tmpC);
    sunUniforms.uTint.value.copy(tmpC).multiplyScalar(blocked ? 0 : 1);
    tiles.update(camera, camPos, viewportH);
  }

  if (CLOUDS_ENABLED && location.protocol.startsWith('http')) {
    loadCloudModels(shared).catch((e) => console.warn('Cloud models unavailable, using procedural clouds:', e));
  }
  return { scene, shared, tiles, update, starUniforms, textures: { dayTex, nightTex, cloudTex } };
}
