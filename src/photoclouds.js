// ---------------------------------------------------------------------------------------------
// Photo clouds: the observed day's clouds as a picture -- NASA VIIRS imagery at ~1.2 km
// (tools/bake_photo_clouds.py) -- draped on a shell at the measured cloud-top height and relit live.
// A cloud provider (contract in cloudslot.js), raw WebGL2.
//
// The image holds the cloud signal (~ reflectance / 0.85) as the satellite saw it. Per pixel it is
// turned back into an optical depth (two-stream inversion at the overpass sun), then relit with:
//   - the sun after the air (reddening and the Earth's shadow at the terminator) and the skylight;
//     the picture's brightness as relief (thicker = higher) shades sunlit and lee sides, and a short
//     march toward the sun lets taller clouds shadow lower ones when the sun is low;
//   - the moon and the night-sky ambient, the same terms that light the ground;
//   - the cities below: their radiance (data/lights) diffused up through the cloud, so decks over
//     towns glow amber and the lights under thick cloud fade to that glow.
// It writes the shared cloud shadow map from the same image, so the ground, sea, haze and spacecraft
// get matching shadows, offset by the cloud height and the sun's angle.
// Units: km, Earth-centred world space, +Y = north pole. Live knobs on the provider object.
// ---------------------------------------------------------------------------------------------
import { CLOUD_DATE } from './earth.js';

const pcVert = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const pcHeader = '#version 300 es\nprecision highp float;\nprecision highp sampler2D;\nprecision highp sampler2DArray;\n';

// shared by both programs: the image, the cloud-top height and the optics
const pcCommonGLSL = /* glsl */ `
uniform sampler2DArray uCov;     // 4 x 2 layers of 8192^2, north-west first, BC4 + mips
uniform sampler2D uProps;        // 2048 x 1024: R cover, G cloud-top height / 16 km, B log optical depth
uniform float uReady;
uniform float uSignal;           // reflectance of a full-scale (255) cloud signal
uniform float uTopMin, uTopScale;

const float BETA = 0.075;        // (1 - g) / 2, g = 0.85: backscattered share in the two-stream model
uniform float uCovTile;          // side of one layer on the GPU (8192, less when memory is short)
#define COV_SIZE (vec2(4.0, 2.0) * uCovTile)

// equirect, row 0 = north (as the baked files)
vec2 pcUv(vec3 n){ return vec2(atan(n.x, n.z) * (0.5 / PI) + 0.5, 0.5 - asin(clamp(n.y, -1.0, 1.0)) * (1.0 / PI)); }

vec3 pcLayerUv(vec2 uv){
  vec2 g = vec2(fract(uv.x) * 4.0, clamp(uv.y, 0.0, 0.99999) * 2.0);
  vec2 c = floor(g);
  return vec3(g - c, c.y * 4.0 + c.x);
}
float covGrad(vec2 uv, vec2 dx, vec2 dy){
  return textureGrad(uCov, pcLayerUv(uv), dx * vec2(4.0, 2.0), dy * vec2(4.0, 2.0)).r;
}
float covLod(vec2 uv, float lod){ return textureLod(uCov, pcLayerUv(uv), lod).r; }
// Magnified (views well below orbit): cubic B-spline from 4 bilinear taps, so lone 1.2 km texels
// become soft blobs instead of bilinear squares
float covCubic(vec2 uv){
  vec3 l = pcLayerUv(uv);
  vec2 p = l.xy * uCovTile - 0.5, f = fract(p), i = floor(p);
  vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0, w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  vec2 w3 = f * f * f / 6.0, w2 = 1.0 - w0 - w1 - w3;
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 t0 = (i - 0.5 + w1 / s0) / uCovTile, t1 = (i + 1.5 + w3 / s1) / uCovTile;
  return (textureLod(uCov, vec3(t0, l.z), 0.0).r * s0.x + textureLod(uCov, vec3(t1.x, t0.y, l.z), 0.0).r * s1.x) * s0.y
       + (textureLod(uCov, vec3(t0.x, t1.y, l.z), 0.0).r * s0.x + textureLod(uCov, vec3(t1, l.z), 0.0).r * s1.x) * s1.y;
}

// cloud-top height (km): the retrieval, with a floor for clouds it missed
float topKm(vec2 uv){
  vec4 p = textureLod(uProps, uv, 0.0);
  return max(p.g * 16.0 * uTopScale, uTopMin);
}
// the same, smoothed over ~100 km, for the sun's reach at the terminator: there a few hundred
// metres decide lit or in the Earth's shadow, and the retrieval's gap-filled plateaus and swath
// seams (flat ~20 km patches with straight edges) turned into hard pink / dark rectangles
float topKmSun(vec2 uv){
  vec4 p = textureLod(uProps, uv, 2.5);
  return max(p.g * 16.0 * uTopScale, uTopMin);
}

// optical depth from the observed signal (inverted at a typical overpass sun, mu 0.6)
float tauOf(float c){
  float R = min(c * uSignal, 0.97);
  return R * 0.6 / (BETA * (1.0 - R));
}
// two-stream reflectance at sun (or view) cosine mu
float reflOf(float tau, float mu){ float b = BETA * tau; return b / (max(mu, 0.02) + b); }

// first hit of the sphere of radius r: the outside from above, the inside from below
float shellHit(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, h = b * b - c;
  if (h < 0.0) return -1.0;
  h = sqrt(h);
  float t0 = -b - h, t1 = -b + h;
  return t0 > 0.0 ? t0 : (t1 > 0.0 ? t1 : -1.0);
}
`;

const pcColorFrag = (lightingGLSL) => `${pcHeader}${lightingGLSL}
${pcCommonGLSL}
uniform sampler2D uGlow;         // 4096 x 2048: city radiance, log-encoded, blurred
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos;
uniform float uPixelAngle;
uniform vec3 uMoonDir;
uniform float uMoonE, uNightGlowE;
uniform float uLights, uGlowLmax, uCityK;
uniform float uRelief, uSelfShadow, uGroundAlb, uSeeThrough, uDebug, uCine, uLining;
in vec2 vUv;
out vec4 outColor;

float cityRad(vec2 uv){
  float v = textureLod(uGlow, uv, 0.0).r;
  return exp2(v * log2(1.0 + uGlowLmax)) - 1.0;
}

void main(){
  outColor = vec4(0.0);
  if (uReady < 0.5) return;
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 ro = uCamPos;
  float camR = length(ro);

  // the cloud-top shell: a first guess at 6 km, then at the measured top there
  float t = shellHit(ro, rd, Rg + 6.0);
  if (t < 0.0) return;
  float hTop = topKm(pcUv(normalize(ro + rd * t)));
  t = shellHit(ro, rd, Rg + hTop);
  if (t < 0.0) return;
  // from below the clouds, the ground can be in front
  if (camR < Rg + hTop){
    vec2 tg = raySphere(ro, rd, Rg);
    if (tg.x > 0.0 && tg.x < t) return;
  }
  vec3 p = ro + rd * t;
  float r = length(p);
  vec3 n = p / r;
  vec2 uv = pcUv(n);

  // the picture, filtered for this pixel (seam-safe gradients across the antimeridian)
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);
  float c = covGrad(uv, dx, dy);
  // magnified more than ~1.5x: smooth cubic instead (blended in over 1.5x .. 3x)
  float mag = (2.0 * PI * Rg / COV_SIZE.x) / max(t * uPixelAngle, 1e-4);
  if (mag > 1.5) c = mix(c, covCubic(uv), smoothstep(1.5, 3.0, mag));
  if (uDebug > 0.5){ outColor = vec4(vec3(c) * 20.0, 1.0); return; }
  if (c < 0.004) return;
  float tau = tauOf(c);

  // geometry: local east / north, the pixel's footprint and a level for the neighbour taps
  vec3 E = normalize(vec3(n.z, 0.0, -n.x) + vec3(1e-6, 0.0, 0.0));
  vec3 N = cross(n, E);
  float muV = max(abs(dot(rd, n)), 0.02);
  float fpKm = t * uPixelAngle;                          // across the pixel (minor axis)
  float texKm = 2.0 * PI * Rg / COV_SIZE.x;
  // relief and self-shadow taps no finer than ~2.5 texels: BC4 errors are per 4 x 4 block, and
  // gradients finer than that turn them into squares in the shading
  float stepKm = max(fpKm, texKm * 2.5);
  float lod = max(log2(stepKm / texKm), 0.0);
  float cosLat = max(sqrt(1.0 - n.y * n.y), 0.02);
  vec2 kmToUv = vec2(1.0 / (2.0 * PI * Rg * cosLat), -1.0 / (PI * Rg));   // (east km, north km) -> uv

  // relief: the signal as height (a bright cloud stands taller), for the lighting below
  float cE = covLod(uv + vec2(stepKm, 0.0) * kmToUv, lod), cW = covLod(uv - vec2(stepKm, 0.0) * kmToUv, lod);
  float cN = covLod(uv + vec2(0.0, stepKm) * kmToUv, lod), cS = covLod(uv - vec2(0.0, stepKm) * kmToUv, lod);
  vec3 L = uSunDir;
  float muS = dot(n, L);
  vec3 col = vec3(0.0);
  // golden hour: 0 with the sun above ~11 degrees, 1 at the horizon (cinematic terms scale with it)
  float lowF = (1.0 - smoothstep(0.0, 0.2, muS)) * uCine;
  // a low sun exaggerates relief: the deck's bumps and towers throw long shadows
  float relief = uRelief * (1.0 + 1.2 * lowF);
  vec2 grad = vec2(cE - cW, cN - cS) / (2.0 * stepKm) * relief;   // km of height per km
  vec3 nb = normalize(n - grad.x * E - grad.y * N);

  // ---- sun and sky ----
  // tall tops (thick, bright cloud stands higher) keep the sun after the deck below has lost it:
  // anvils and cirrus stay lit pink while the low clouds already lie in the Earth's shadow
  float hLit = topKmSun(uv) + c * relief * (1.0 + 2.0 * uCine);
  vec3 Tsun = sunTransmittance(Rg + hLit, muS);
  // deeper, more saturated reddening through the long air path at sunset
  float TsL = dot(Tsun, vec3(0.2126, 0.7152, 0.0722));
  Tsun = max(vec3(TsL) + (Tsun - TsL) * (1.0 + 0.9 * lowF), 0.0) * mix(vec3(1.0), vec3(1.18, 0.95, 0.7), lowF);
  vec3 Esun = uSunE * Tsun;
  if (dot(Esun, Esun) > 0.0 && muS > -0.08){
    // the sun's cosine at the lit top: grazing past the geometric horizon still lights the towers
    float mu0 = max(muS + 0.012 * uCine * smoothstep(0.0, 0.5, c), 0.0);
    // relief turns the flat layer's lighting toward the bumped normal; strongest at a low sun
    float shade = clamp((max(dot(nb, L), 0.0) + 0.02) / (mu0 + 0.02), 0.0, 3.0 + 2.0 * lowF);
    // taller clouds toward the sun shadow this one (a low sun's long shadows across the deck)
    float occ = 0.0;
    vec2 Lh = vec2(dot(L, E), dot(L, N));
    float lh = length(Lh);
    if (lh > 1e-3 && uSelfShadow > 0.0){
      Lh /= lh;
      float tanE = mu0 / lh, h0 = c * relief;
      float d = stepKm * 1.5;
      // a soft height test, widening for the coarser far taps: their mips are big bilinear (and
      // BC4 block) squares, and a sharp 250 m threshold cut those squares out as hard shadows
      // across the deck at a low sun
      for (int i = 0; i < 6; i++){
        float ci = covLod(uv + Lh * d * kmToUv, lod + float(i) * 0.5);
        float w = 0.25 + relief * (0.12 + 0.06 * float(i));
        occ += smoothstep(0.0, 1.0, (ci * relief - h0 - d * tanE) / w) * ci;
        d *= 2.0;
      }
    }
    float selfT = exp(-occ * uSelfShadow * (1.0 + lowF));
    float R0 = reflOf(tau, mu0);
    col += Esun * mu0 * R0 / PI * shade * mix(1.0, selfT, smoothstep(0.0, 0.15, R0));
    col += skyIrradiance(r, muS) / PI * reflOf(tau, 0.66);
    // sunlit ground under the cloud, diffused up through it
    float Tdif = max(1.0 - reflOf(tau, 0.66) - exp(-tau / 0.66), 0.0);
    col += Esun * mu0 * uGroundAlb / PI * Tdif * (1.0 - reflOf(tau, mu0)) * 0.5;
    // silver lining: looking toward a low sun, thin cloud and the edges of thick cloud scatter it
    // forward (Henyey-Greenstein, g 0.75, relative to isotropic)
    // Soft: g 0.6 with a rolled-off peak (~4x, was 28x at g 0.75), weighted by the cloud's body
    // so faint fringes and thin veils fade out instead of glowing brighter than the cloud
    // itself (bright orange rims and halos that bloomed at golden hour)
    float cosT = dot(rd, L);
    float hg = (1.0 - 0.36) / pow(1.0 + 0.36 - 1.2 * cosT, 1.5);
    hg = hg / (1.0 + 0.15 * hg);
    float body = smoothstep(0.05, 0.45, c);
    float edge = (1.0 - exp(-tau / muV)) * mix(1.0, exp(-tau * 0.06), 0.6);
    col += Esun * hg * edge * body * 0.02 * lowF * uLining * selfT;
  }

  // ---- twilight afterglow: the sunlit air above still lights the cloud tops after sunset,
  // rose just past the terminator, deepening to violet, then gone (~6 degrees) ----
  float dep = -muS;
  if (uCine > 0.0 && dep > -0.03 && dep < 0.12){
    float k = exp(-max(dep, 0.0) / 0.028) * smoothstep(-0.03, 0.01, dep);
    vec3 twCol = mix(vec3(1.0, 0.5, 0.36), vec3(0.5, 0.36, 0.9), smoothstep(0.0, 0.05, dep));
    col += twCol * uSunE * 0.018 * k * reflOf(tau, 0.66) / PI * uCine;
  }

  // ---- night: moon, night-sky ambient, cities below ----
  float nightF = smoothstep(0.06, -0.14, muS);
  if (nightF > 0.0){
    float muM = dot(n, uMoonDir);
    vec3 Em = uMoonE * vec3(0.72, 0.86, 1.2) * sunTransmittance(r, muM) * smoothstep(-0.02, 0.06, muM);
    col += Em * max(muM, 0.0) * reflOf(tau, max(muM, 0.05)) / PI * nightF;
    col += uNightGlowE * vec3(0.42, 0.62, 1.15) * reflOf(tau, 0.66) / PI * nightF;
    float Lc = cityRad(uv) * uLights * uCityK;
    if (Lc > 0.0){
      float Tdif = max(1.0 - reflOf(tau, 0.66) - exp(-tau / 0.66), 0.0);
      vec3 tint = mix(vec3(1.48, 0.92, 0.41), vec3(1.15, 0.98, 0.75), smoothstep(0.3, 3.0, Lc));
      col += tint * Lc * Tdif * smoothstep(0.0, -0.08, muS);
    }
  }

  // how much of what lies below is hidden: what the cloud reflects, and what it scatters out of the
  // line of sight (thin cloud, mostly forward-scattering, keeps the ground sharp)
  float a = clamp(max(reflOf(tau, muV), 1.0 - exp(-tau * uSeeThrough / muV)), 0.0, 1.0);
  vec3 Sa, Ta;
  aerial(ro, rd, t, Sa, Ta);
  outColor = vec4(col * Ta + Sa * a, a);
}`;

const pcShadowFrag = (lightingGLSL) => `${pcHeader}${lightingGLSL}
${pcCommonGLSL}
uniform vec3 uShOrigin, uShRight, uShUp, uShDir;
uniform float uShExtent, uShLod, uSlabKm;
in vec2 vUv;
out vec4 outShadow;
void main(){
  if (uReady < 0.5) discard;
  vec3 ro = uShOrigin + (uShRight * (vUv.x * 2.0 - 1.0) + uShUp * (vUv.y * 2.0 - 1.0)) * uShExtent;
  float t = shellHit(ro, uShDir, Rg + 5.0);
  if (t < 0.0) discard;
  // shadows come from the middle of the cloud, below its top
  float hMid = max(topKm(pcUv(normalize(ro + uShDir * t))) - 0.5 * uSlabKm, 0.3);
  t = shellHit(ro, uShDir, Rg + hMid);
  if (t < 0.0) discard;
  vec3 p = ro + uShDir * t;
  vec3 n = normalize(p);
  float c = covLod(pcUv(n), uShLod);
  if (c < 0.004) discard;
  float mu0 = max(dot(n, -uShDir), 0.02);
  // the sunlight that gets through (direct and diffuse): 1 - reflectance
  float od = -log(max(1.0 - reflOf(tauOf(c), mu0), 0.03));
  float len = uSlabKm / mu0;
  outShadow = vec4(t - 0.5 * len, od / len, od, (hMid + 0.5 * uSlabKm) * od);
}`;

export function createPhotoCloudProvider({ date = CLOUD_DATE, lightsGain = () => 0.01 } = {}) {
  const base = `data/clouds/${date}/`;
  let gl, lighting, vao, colorProg, shadowProg, covTex, propsTex, glowTex, meta = null, ready = false, disposed = false;
  let skip = 0, tile = 8192;   // GPU layer size: 8192 >> skip (skip > 0 when GPU memory is short)

  function compile(fragSrc) {
    const mk = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, pcVert));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const locs = new Map();
    p.loc = (n) => { if (!locs.has(n)) locs.set(n, gl.getUniformLocation(p, n)); return locs.get(n); };
    return p;
  }

  // A download, retried: the local server restarting or dropping a connection mid-transfer
  // ("TypeError: Failed to fetch", or a truncated gzip stream) must not leave a clear sky until the
  // next reload. read() consumes the response inside the retry, so a cut-off body retries too.
  async function retry(url, read, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        // first try: the download the page head already started (build.js), if any; after a
        // failure, a fresh request that skips the cache
        const early = attempt === 0 && window.__pcPrefetch?.[url];
        if (early) delete window.__pcPrefetch[url];
        const res = await (early || fetch(url, attempt ? { ...opts, cache: 'no-store' } : opts));
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return await read(res);
      } catch (e) {
        if (disposed || attempt >= 4) throw e;
        const wait = 500 * 2 ** attempt;
        console.warn(`Photo clouds: ${url.split('/').pop()} failed (${e.message || e}), retrying in ${wait / 1000} s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  // Runs this loader's own GL calls and checks them alone: errors other code left in the queue
  // (a frame drawn while the downloads were in flight) are cleared first, not blamed on the upload.
  function glChecked(what, calls) {
    while (gl.getError() !== gl.NO_ERROR) { /* clear errors raised elsewhere */ }
    calls();
    const err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error(`Photo clouds: ${what} upload failed (GL error 0x${err.toString(16)})`);
  }

  async function loadImage(url, internal, format) {
    // createImageBitmap: decodes in a hidden tab too (img.decode() can stall there) and keeps the
    // alpha channel separate (properties.png holds data, not colour, in RGB)
    const img = await retry(url, async (res) => createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
    if (disposed) { img.close(); return null; }
    const tex = gl.createTexture();
    try {
      glChecked(url.split('/').pop(), () => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, format, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
      });
    } catch (e) {
      gl.deleteTexture(tex);
      throw e;
    } finally {
      img.close();
    }
    return tex;
  }

  async function load() {
    const t0 = performance.now();
    const ext = gl.getExtension('EXT_texture_compression_rgtc');
    if (!ext) throw new Error('Photo clouds need EXT_texture_compression_rgtc (BC4)');
    meta = await retry(base + 'photo/photo.json', (res) => res.json());
    const T = meta.tile, layers = meta.cols * meta.rows, levels = Math.log2(T) - 1;   // 8192 .. 4
    // the eight layers (235 MB) start downloading at once, at high priority: they share the
    // browser's ~6 connections per server with the ground tiles streaming in at start-up
    const fetched = [...Array(layers).keys()].map((i) => retry(`${base}photo/L${i}.bc4.gz`,
      async (res) => new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
      { priority: 'high' }));
    const sideP = Promise.all([
      loadImage(base + 'properties.png', gl.RGBA8, gl.RGBA),
      loadImage(base + 'photo/' + meta.cityglow.file, gl.R8, gl.RED),
    ]);
    // The full set is ~340 MB of GPU memory in one allocation. On a GPU that is nearly full it
    // fails silently (GL_OUT_OF_MEMORY, a clear sky), so check, and step down a level (half the
    // resolution, a quarter of the memory) until it fits.
    while (gl.getError() !== gl.NO_ERROR) { /* clear stale errors */ }
    for (skip = 0; skip <= 3; skip++) {
      covTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, covTex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels - skip, ext.COMPRESSED_RED_RGTC1_EXT, T >> skip, T >> skip, layers);
      const err = gl.getError();
      if (err === gl.NO_ERROR) break;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      gl.deleteTexture(covTex); covTex = null;
      console.warn(`Photo clouds: GPU allocation at ${T >> skip} px per layer failed (GL error 0x${err.toString(16)}), trying half`);
    }
    if (!covTex) throw new Error('Photo clouds: not enough GPU memory even at a quarter resolution');
    tile = T >> skip;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    // uploaded as each arrives
    await Promise.all(fetched.map(async (bp, i) => {
      const buf = await bp;
      if (disposed) return;
      glChecked(`layer L${i}`, () => {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, covTex);
        let off = 0;
        for (let l = 0, s = T; l < levels; l++, s >>= 1) {
          const bytes = (s / 4) * (s / 4) * 8;
          if (l >= skip) gl.compressedTexSubImage3D(gl.TEXTURE_2D_ARRAY, l - skip, 0, 0, i, s, s, 1, ext.COMPRESSED_RED_RGTC1_EXT, buf.subarray(off, off + bytes));
          off += bytes;
        }
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      });
    }));
    const side = [propsTex, glowTex] = await sideP;
    if (disposed || side.includes(null)) return;
    // mips for the smoothed cloud-top height the sunlight uses (topKmSun)
    glChecked('properties mipmap', () => {
      gl.bindTexture(gl.TEXTURE_2D, propsTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);
    });
    if (disposed) return;
    ready = true;
    console.info(`Photo clouds ready (${date}, ${tile * meta.cols} x ${tile * meta.rows} on the GPU${skip ? `, reduced ${2 ** skip}x for GPU memory` : ''}, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }

  function bindData(p, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, covTex);
    gl.uniform1i(p.loc('uCov'), unit++);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, propsTex);
    gl.uniform1i(p.loc('uProps'), unit++);
    gl.uniform1f(p.loc('uReady'), ready ? 1 : 0);
    gl.uniform1f(p.loc('uCovTile'), tile);
    gl.uniform1f(p.loc('uSignal'), api.signal);
    gl.uniform1f(p.loc('uTopMin'), api.topMin);
    gl.uniform1f(p.loc('uTopScale'), api.topScale);
    return unit;
  }

  const api = {
    shadowMapSize: 2048,
    shadowAlt: true,
    renderScale: 1,
    // live knobs
    signal: 0.85,            // reflectance of a full-scale cloud signal
    topMin: 1.5,             // km: cloud-top floor where the retrieval has none
    topScale: 1,
    relief: 1.6,             // km of height across the signal's range (shading only)
    selfShadow: 1.2,
    groundAlb: 0.12,
    seeThrough: 0.25,        // share of optical depth that hides the ground's detail
    cityK: 1,                // city glow vs the ground lights (1 = the same radiance, diffused)
    slabKm: 1.5,
    cine: 1,                 // sunset / sunrise magic: tall tops lit late, richer reddening, silver
                             // linings, long relief shadows, twilight afterglow (0 = plain physics)
    lining: 1,               // silver-lining strength toward a low sun (scaled by cine)
    debug: 0,                // 1: show the raw image signal
    get ready() { return ready; },
    get gpuTile() { return tile; },

    init(glCtx, hub) {
      gl = glCtx; lighting = hub;
      vao = gl.createVertexArray();
      colorProg = compile(pcColorFrag(hub.glsl));
      shadowProg = compile(pcShadowFrag(hub.glsl));
      load().catch((e) => console.error('Photo clouds failed to load:', e));
    },
    render(f) {
      if (!ready) return;
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);

      // 1. shared shadow map
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.shadow.framebuffer);
      gl.viewport(0, 0, f.shadow.size, f.shadow.size);
      gl.useProgram(shadowProg);
      let u = lighting.bind(gl, shadowProg, 0);
      bindData(shadowProg, u);
      gl.uniform3fv(shadowProg.loc('uShOrigin'), f.shadow.origin);
      gl.uniform3fv(shadowProg.loc('uShRight'), f.shadow.right);
      gl.uniform3fv(shadowProg.loc('uShUp'), f.shadow.up);
      gl.uniform3fv(shadowProg.loc('uShDir'), f.shadow.dir);
      gl.uniform1f(shadowProg.loc('uShExtent'), f.shadow.extent);
      const texKm = 2 * Math.PI * 6371 / (tile * meta.cols);
      gl.uniform1f(shadowProg.loc('uShLod'), Math.max(Math.log2((2 * f.shadow.extent / f.shadow.size) / texKm), 0));
      gl.uniform1f(shadowProg.loc('uSlabKm'), api.slabKm);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. the clouds (premultiplied)
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.color.framebuffer);
      gl.viewport(0, 0, f.color.width, f.color.height);
      gl.useProgram(colorProg);
      u = lighting.bind(gl, colorProg, 0);
      u = bindData(colorProg, u);
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, glowTex);
      gl.uniform1i(colorProg.loc('uGlow'), u++);
      const U = lighting.uniforms;
      const md = U.uMoonDir.value;
      gl.uniform3f(colorProg.loc('uMoonDir'), md.x, md.y, md.z);
      gl.uniform1f(colorProg.loc('uMoonE'), U.uMoonE.value);
      gl.uniform1f(colorProg.loc('uNightGlowE'), U.uNightGlowE.value);
      gl.uniform1f(colorProg.loc('uLights'), lightsGain());
      gl.uniform1f(colorProg.loc('uGlowLmax'), meta.cityglow.lmax);
      gl.uniform1f(colorProg.loc('uCityK'), api.cityK);
      gl.uniform1f(colorProg.loc('uRelief'), api.relief);
      gl.uniform1f(colorProg.loc('uSelfShadow'), api.selfShadow);
      gl.uniform1f(colorProg.loc('uGroundAlb'), api.groundAlb);
      gl.uniform1f(colorProg.loc('uSeeThrough'), api.seeThrough);
      gl.uniform1f(colorProg.loc('uDebug'), api.debug);
      gl.uniform1f(colorProg.loc('uCine'), api.cine);
      gl.uniform1f(colorProg.loc('uLining'), api.cine * api.lining);
      gl.uniformMatrix4fv(colorProg.loc('uInvProj'), false, f.camera.invProjection);
      gl.uniformMatrix4fv(colorProg.loc('uCamWorld'), false, f.camera.cameraWorld);
      gl.uniform3fv(colorProg.loc('uCamPos'), f.camera.position);
      gl.uniform1f(colorProg.loc('uPixelAngle'), f.camera.pixelAngle);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
    dispose() {
      disposed = true;
      gl.deleteProgram(colorProg); gl.deleteProgram(shadowProg); gl.deleteVertexArray(vao);
      for (const t of [covTex, propsTex, glowTex]) if (t) gl.deleteTexture(t);
    },
  };
  return api;
}
