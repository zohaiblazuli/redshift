import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { commonGLSL, atmosphereGLSL, volumeGLSL } from './shaders.js';

// ---------------------------------------------------------------------------------------------
// Tileable 3D cloud noise, generated once on the GPU slice by slice.
//   R: Perlin-Worley (base shapes)   G/B/A: inverted Worley fbm at 4 / 8 / 16 cells per period
// ---------------------------------------------------------------------------------------------
const noiseFrag = /* glsl */ `
precision highp float;
uniform float uZ;
varying vec2 vUv;

vec3 hash33(vec3 p){
  uvec3 q = uvec3(ivec3(p)) * uvec3(1597334673u, 3812015801u, 2798796415u);
  q = (q.x ^ q.y ^ q.z) * uvec3(1597334673u, 3812015801u, 2798796415u);
  return vec3(q) * (1.0 / 4294967295.0);
}
float worley(vec3 x, float freq){
  vec3 p = x * freq, id = floor(p), f = fract(p);
  float md = 1.0;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec3 o = vec3(float(i), float(j), float(k));
    vec3 c = mod(id + o, freq);
    vec3 d = o + hash33(c) - f;
    md = min(md, dot(d, d));
  }
  return 1.0 - sqrt(md);
}
float gnoise(vec3 x, float freq){
  vec3 p = x * freq, i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n[8];
  for (int c = 0; c < 8; c++){
    vec3 o = vec3(float(c & 1), float((c >> 1) & 1), float((c >> 2) & 1));
    vec3 g = hash33(mod(i + o, freq)) * 2.0 - 1.0;
    n[c] = dot(normalize(g + 1e-4), f - o);
  }
  return mix(mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y),
             mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y), u.z);
}
float perlinFbm(vec3 x, float freq){
  float s = 0.0, a = 1.0, w = 0.0;
  for (int o = 0; o < 6; o++){ s += gnoise(x, freq) * a; w += a; a *= 0.5; freq *= 2.0; }
  return s / w;
}
float worleyFbm(vec3 x, float freq){
  return worley(x, freq) * 0.625 + worley(x, freq * 2.0) * 0.25 + worley(x, freq * 4.0) * 0.125;
}
void main(){
  vec3 x = vec3(vUv, uZ);
  float pf = clamp(perlinFbm(x, 4.0) * 0.85 + 0.5, 0.0, 1.0);
  float wf = worleyFbm(x, 4.0);
  float pw = clamp(wf + pf * (1.0 - wf) - 0.25, 0.0, 1.0) / 0.75;   // Perlin-Worley
  gl_FragColor = vec4(pw, worleyFbm(x, 4.0), worleyFbm(x, 8.0), worleyFbm(x, 16.0));
}`;

export function createCloudNoise(renderer, size = 128) {
  const rt = new THREE.WebGL3DRenderTarget(size, size, size, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false,
  });
  const t = rt.texture;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uZ: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: noiseFrag,
  });
  const quad = new FullScreenQuad(mat);
  const prev = renderer.getRenderTarget();
  for (let z = 0; z < size; z++) {
    mat.uniforms.uZ.value = (z + 0.5) / size;
    renderer.setRenderTarget(rt, z);
    quad.render(renderer);
  }
  renderer.setRenderTarget(prev);
  // build a mip chain by hand (three does not mip 3D render targets) for alias-free distant clouds
  const gl = renderer.getContext();
  const glTex = renderer.properties.get(t).__webglTexture;
  gl.bindTexture(gl.TEXTURE_3D, glTex);
  gl.generateMipmap(gl.TEXTURE_3D);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.bindTexture(gl.TEXTURE_3D, null);
  const { lut, detailMean } = buildLodLut(gl, glTex, size);
  renderer.resetState();
  quad.dispose(); mat.dispose();
  return { noise: t, lut, detailMean };
}

// ---------------------------------------------------------------------------------------------
// One cloud field at every distance. A blurred (mipped) noise has a narrower value distribution
// than the full-resolution one, so the same coverage threshold makes distant clouds fatter and
// merged. This LUT maps each mip level's base-shape value to its rank (quantile), so every LOD
// covers exactly the observed fraction of sky, the same as the close-up.
// ---------------------------------------------------------------------------------------------
export const LUT_LEVELS = 5, LUT_SIZE = 256;

function buildLodLut(gl, glTex, size) {
  const BINS = 2048;
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const cdfs = [];
  let dSum = 0, dN = 0;
  for (let L = 0; L < LUT_LEVELS; L++) {
    const s = size >> L, buf = new Uint8Array(s * s * 4), h = new Float64Array(BINS);
    for (let z = 0; z < s; z += L === 0 ? 2 : 1) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, glTex, L, z);
      gl.readPixels(0, 0, s, s, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      for (let i = 0; i < buf.length; i += 4) {
        const r = buf[i] / 255, wf = (buf[i + 1] * 0.625 + buf[i + 2] * 0.25 + buf[i + 3] * 0.125) / 255;
        const b = (r - wf + 1) / Math.max(2 - wf, 1e-4); // = remap(r, wf - 1, 1, 0, 1) in volumeGLSL
        h[Math.min(BINS - 1, Math.max(0, Math.floor(b * BINS)))]++;
        if (L === 0) { dSum += wf; dN++; }
      }
    }
    const c = new Float64Array(BINS);
    let acc = 0, tot = 0;
    for (let k = 0; k < BINS; k++) tot += h[k];
    for (let k = 0; k < BINS; k++) { acc += h[k]; c[k] = acc / tot; }
    cdfs.push(c);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);

  const cdfAt = (c, x) => { // F(x), piecewise linear across bins
    const p = Math.min(Math.max(x, 0), 1) * BINS, k = Math.min(BINS - 1, Math.floor(p));
    const lo = k > 0 ? c[k - 1] : 0;
    return lo + (c[k] - lo) * (p - k);
  };
  // Each level maps a value to its rank within that level's own distribution: uniform 0..1 at
  // every LOD, so "rank > 1 - coverage" covers exactly the observed cloud fraction at any distance.
  const data = new Uint16Array(LUT_SIZE * LUT_LEVELS);
  for (let L = 0; L < LUT_LEVELS; L++) {
    for (let j = 0; j < LUT_SIZE; j++) {
      data[L * LUT_SIZE + j] = THREE.DataUtils.toHalfFloat(cdfAt(cdfs[L], j / (LUT_SIZE - 1)));
    }
  }
  const lut = new THREE.DataTexture(data, LUT_SIZE, LUT_LEVELS, THREE.RedFormat, THREE.HalfFloatType);
  lut.minFilter = lut.magFilter = THREE.LinearFilter;
  lut.wrapS = lut.wrapT = THREE.ClampToEdgeWrapping;
  lut.needsUpdate = true;
  return { lut, detailMean: dSum / Math.max(dN, 1) };
}

// ---------------------------------------------------------------------------------------------
// Raymarched multi-regime weather volume, rendered before the planet pass and later
// composited (premultiplied) onto the HDR frame between the planet and the spacecraft passes.
// ---------------------------------------------------------------------------------------------
const marchVert = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec2 uJitNdc;
varying vec3 vRay;
varying vec2 vUv;
void main(){
  vUv = uv;
  vec4 v = uInvProj * vec4(position.xy + uJitNdc, 1.0, 1.0);
  vRay = (uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const marchFrag = /* glsl */ `
${commonGLSL}
${atmosphereGLSL}
${volumeGLSL}
uniform vec3 uCamPos;
uniform float uPixAngle;
uniform vec2 uRes;
uniform float uFrame;
varying vec3 vRay;

float hg(float mu, float g){ float gg = g * g; return (1.0 - gg) / (4.0 * PI * pow(max(1.0 + gg - 2.0 * g * mu, 1e-4), 1.5)); }

// dual-lobe phase function; c scales anisotropy down for the higher scattering octaves
float phaseC(float mu, float c){ return mix(hg(mu, 0.80 * c), hg(mu, -0.30 * c), 0.22); }

void main(){
  vec3 ro = uCamPos;
  vec3 rd = normalize(vRay);
  vec2 to = raySphere(ro, rd, Rct);
  if (to.y <= 0.0 || to.x > 1e8){ gl_FragColor = vec4(0.0); return; }
  float rc = length(ro);
  float t0 = max(to.x, 0.0), t1 = to.y;
  vec2 ti = raySphere(ro, rd, Rcb);
  if (rc >= Rcb){
    if (ti.x > 0.0 && ti.x < 1e8) t1 = min(t1, ti.x);
  } else {
    t0 = max(ti.y, 0.0);
  }
  vec2 tg = raySphere(ro, rd, Rg);
  if (tg.x > 0.0 && tg.x < 1e8) t1 = min(t1, tg.x);
  t1 = min(t1, t0 + 1600.0);
  if (t1 <= t0){ gl_FragColor = vec4(0.0); return; }

  // step jitter changes every frame; the temporal resolve averages it into a clean result
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame * 0.6180339);
  vec3 L = uSunDir;
  float mu = dot(rd, L);
  float ph0 = phaseC(mu, 1.0), ph1 = phaseC(mu, 0.5), ph2 = phaseC(mu, 0.25);

  // Empty space is crossed in coarse steps with cheap lookups; on contact the march steps back and
  // samples finely (~150 m near the camera, growing with distance) until the cloud is left again.
  // Front-to-back with early exit, so opaque decks cost only a few samples.
  int budget = int(uCloudSteps);
  float T = 1.0;
  vec3 acc = vec3(0.0);
  float tHit = -1.0;
  float t = t0;
  float tW = -1e9;
  CloudWx w = CloudWx(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0);
  int fine = 0, empty = 99;
  bool first = true;
  for (int i = 0; i < 320; i++){
    if (t >= t1 || fine >= budget) break;
    float dtF = clamp(0.15 + t * 0.0005, 0.15, 1.8);
    // the observed high-resolution layer is thin: sample it more finely
    dtF = mix(dtF, clamp(0.08 + t * 0.00025, 0.08, 0.9), w.region);
    float dtC = dtF * 4.0;
    if (first){ t += dtF * jitter; first = false; }
    vec3 p = ro + rd * t;
    float r = length(p);
    float fp = max(t * uPixAngle, 0.02);
    // the observation maps change over ~5 km: refresh the column weather every ~2.5 km of ray
    if (abs(t - tW) > 2.5){ w = cloudWeather(p / r, p, wxLod(fp)); tW = t; }
    float alt = r - Rg;
    if (alt < w.ground) break;   // the ray ran into a mountain: what lies beyond is hidden
    if (w.cov < 0.01 || alt < w.lo - 0.02 || alt > w.hi + 0.02){ t += dtC; empty = 99; continue; }
    float lod = cloudViewLod(fp, dtF);
    if (empty >= 6){
      if (cloudExtinction(p, r, w, lod + 1.0, false) < 0.02){ t += dtC; continue; }
      t = max(t - dtC * 0.75, t0);
      empty = 0;
      continue;
    }
    float sigma = cloudExtinction(p, r, w, lod, true);
    fine++;
    if (sigma < 0.02){ empty++; t += dtF; continue; }
    empty = 0;
    if (tHit < 0.0) tHit = t;

    vec3 n = p / r;
    float muS = dot(n, L);
    vec3 sunC = uSunE * sunTransmittance(r, muS);
    // Optical depth toward the sun, sampled in a cone (Schneider 2015): short first steps resolve
    // billow self-shadowing, later ones spread sideways so a flank is shaded by the cloud volume
    // around the light path, not one line through it. The pattern rotates per pixel and frame
    // and the temporal resolve averages it. A last long-range sample catches the shadow of a
    // neighbouring tower.
    vec3 lT1 = normalize(cross(L, abs(L.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 lT2 = cross(L, lT1);
    float rot = jitter * 6.2831853;
    float od = 0.0, ls = 0.1, lt = 0.0;
    for (int j = 0; j < 5; j++){
      lt += ls * 0.5;
      float a = rot + float(j) * 2.3999632;      // golden angle
      vec3 lp = p + L * lt + (lT1 * cos(a) + lT2 * sin(a)) * (lt * 0.36 * sqrt((float(j) + 0.5) / 5.0));
      od += cloudExtinction(lp, length(lp), w, lod + 0.5 + float(j) * 0.4, false) * ls;
      lt += ls * 0.5;
      ls *= 2.3;
    }
    {
      vec3 lp = p + L * 10.0;
      float rl = length(lp);
      CloudWx wl = cloudWeather(lp / rl, lp, wxLod(fp) + 1.0);
      od += cloudExtinction(lp, rl, wl, lod + 2.0, false) * 4.0;
    }
    // multiple scattering as three octaves of attenuated extinction / anisotropy
    float hf = w.region > 0.5 ? clamp((alt - w.lo) / max(w.hi - w.lo, 0.1), 0.0, 1.0)
                              : clamp((alt - w.base) / max(w.top - w.base, 0.1), 0.0, 1.0);
    // Higher orders diffuse with the transport extinction (1 - g) sigma, about 0.15 sigma for cloud
    // droplets: that is what carries light deep into a dense cumulus (the baked library clouds use
    // physical extinctions of 45-80 /km, where single-scatter octaves alone leave them grey).
    vec3 sunL = sunC * (ph0 * exp(-od) + 0.5 * ph1 * exp(-od * 0.3) + 0.35 * ph2 * exp(-od * 0.1)) * 1.7;
    float powder = 1.0 - 0.35 * exp(-sigma * 0.6);
    vec3 skyAmb = vec3(0.30, 0.42, 0.62) * mix(0.014, 0.034, hf);
    vec3 bounce = vec3(0.022, 0.022, 0.02) * (1.0 - hf) * clamp(muS * 2.0, 0.0, 1.0);
    vec3 amb = uSunE * (skyAmb + bounce) * smoothstep(-0.15, 0.2, muS) * exp(-od * 0.05);
    vec3 S = sunL * powder + amb;
    float Ts = exp(-sigma * dtF);
    acc += T * S * (1.0 - Ts);
    T *= Ts;
    t += dtF;
    if (T < 0.01) break;
  }
  float alpha = 1.0 - T;
  if (alpha < 0.002){ gl_FragColor = vec4(0.0); return; }
  vec3 Sa, Ta;
  aerial(ro, rd, tHit, Sa, Ta);
  gl_FragColor = vec4(acc * Ta + Sa * alpha, alpha);
}`;

// ---------------------------------------------------------------------------------------------
// Temporal resolve: each frame marches the clouds at reduced resolution with a new sub-pixel ray
// offset and step jitter; this pass reprojects last frame's full-resolution result and blends in
// the new samples where they land. Over ~16 frames that converges to a sharp, anti-aliased, noise-
// free full-resolution image (temporal super-sampling), for the price of one cheap pass.
// From orbit every cloud is hundreds of km away, so reprojecting through a sphere at mid-cloud
// height is accurate to a small fraction of a pixel.
// ---------------------------------------------------------------------------------------------
const resolveFrag = /* glsl */ `
uniform sampler2D tCur, tHist;
uniform vec2 uLowRes, uFullRes, uJit;
uniform mat4 uInvProj, uCamWorld, uPrevVP;
uniform vec3 uCamPos;
uniform float uValid;
varying vec2 vUv;

vec4 sampleCatmullRom(sampler2D tex, vec2 uv, vec2 size){
  vec2 sp = uv * size, t1 = floor(sp - 0.5) + 0.5, f = sp - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, t12 = (t1 + w2 / w12) / size, t0 = (t1 - 1.0) / size, t3 = (t1 + 2.0) / size;
  vec4 r = texture(tex, vec2(t0.x, t0.y)) * w0.x * w0.y + texture(tex, vec2(t12.x, t0.y)) * w12.x * w0.y
         + texture(tex, vec2(t3.x, t0.y)) * w3.x * w0.y + texture(tex, vec2(t0.x, t12.y)) * w0.x * w12.y
         + texture(tex, vec2(t12.x, t12.y)) * w12.x * w12.y + texture(tex, vec2(t3.x, t12.y)) * w3.x * w12.y
         + texture(tex, vec2(t0.x, t3.y)) * w0.x * w3.y + texture(tex, vec2(t12.x, t3.y)) * w12.x * w3.y
         + texture(tex, vec2(t3.x, t3.y)) * w3.x * w3.y;
  return max(r, 0.0);
}

void main(){
  // nearest new sample to this pixel, and how far from it that sample landed (in full-res pixels)
  vec2 x = vUv * uLowRes - 0.5 - uJit;
  vec2 k = floor(x + 0.5);
  vec2 dFull = (x - k) * uFullRes / uLowRes;
  vec2 tx = 1.0 / uLowRes;
  vec2 kuv = (k + 0.5) * tx;
  vec4 cur = vec4(0.0), m1 = vec4(0.0), m2 = vec4(0.0), mn = vec4(1e9), mx = vec4(-1e9);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec4 c = texture(tCur, kuv + vec2(float(i), float(j)) * tx);
    if (i == 0 && j == 0) cur = c;
    m1 += c; m2 += c * c; mn = min(mn, c); mx = max(mx, c);
  }
  vec4 mean = m1 / 9.0, sd = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
  mn = max(mn, mean - 1.5 * sd); mx = min(mx, mean + 1.5 * sd);

  // reproject through a sphere at mid-cloud height
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  float R = 6371.0 + 3.0, b = dot(uCamPos, rd), c = dot(uCamPos, uCamPos) - R * R, h = b * b - c;
  float t = h > 0.0 ? (c > 0.0 ? -b - sqrt(h) : -b + sqrt(h)) : max(-b, 0.0);
  vec4 cp = uPrevVP * vec4(uCamPos + rd * t, 1.0);
  vec2 puv = cp.xy / cp.w * 0.5 + 0.5;
  bool ok = uValid > 0.5 && cp.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)));
  if (!ok){ gl_FragColor = texture(tCur, vUv - uJit * tx); return; }
  vec4 hist = clamp(sampleCatmullRom(tHist, puv, uFullRes), mn, mx);
  float a = 0.04 + 0.16 * exp(-dot(dFull, dFull) * 1.4);
  // At flight level the fixed mid-layer reprojection sphere is not accurate enough for a volume
  // spanning twelve kilometres. Trust the current full-resolution sample so nearby silhouettes
  // remain crisp; retain deep temporal accumulation from orbit where the approximation is exact.
  float camAlt = length(uCamPos) - 6371.0;
  float nearClouds = 1.0 - smoothstep(80.0, 260.0, camAlt);
  float renderScale = min(uLowRes.x / uFullRes.x, uLowRes.y / uFullRes.y);
  a = max(a, nearClouds * mix(0.36, 0.68, renderScale));
  gl_FragColor = mix(hist, cur, a);
}`;

const HALTON = Array.from({ length: 16 }, (_, i) => {
  const h = (n, b) => { let f = 1, r = 0; for (let k = n; k > 0; k = Math.floor(k / b)) { f /= b; r += f * (k % b); } return r; };
  return [h(i + 1, 2) - 0.5, h(i + 1, 3) - 0.5];
});

export class CloudPass extends Pass {
  constructor(shared, noiseTex, camera) {
    super();
    this.needsSwap = false;
    this.camera = camera;
    this.scale = 0.5;
    this.steps = 64;
    this.frame = 0;
    const mkRT = () => {
      const t = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
      t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
      return t;
    };
    this.rt = mkRT();
    this.hist = [mkRT(), mkRT()];
    this.histValid = false;
    this.prevVP = new THREE.Matrix4();
    this.prevTime = null;
    this.uniforms = {
      ...shared,
      uNoise3D: { value: noiseTex },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uPixAngle: { value: 0.002 },
      uRes: { value: new THREE.Vector2(2, 2) },
      uJitNdc: { value: new THREE.Vector2() },
      uFrame: { value: 0 },
    };
    this.march = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: marchVert, fragmentShader: marchFrag, depthTest: false, depthWrite: false,
    }));
    const quadVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    this.resolveU = {
      tCur: { value: this.rt.texture }, tHist: { value: null },
      uLowRes: { value: new THREE.Vector2(2, 2) }, uFullRes: { value: new THREE.Vector2(2, 2) }, uJit: { value: new THREE.Vector2() },
      uInvProj: this.uniforms.uInvProj, uCamWorld: this.uniforms.uCamWorld, uCamPos: this.uniforms.uCamPos,
      uPrevVP: { value: this.prevVP }, uValid: { value: 0 },
    };
    this.resolve = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: this.resolveU, vertexShader: quadVert, fragmentShader: resolveFrag, depthTest: false, depthWrite: false,
    }));
    this.comp = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tClouds: { value: null } },
      vertexShader: quadVert,
      fragmentShader: 'uniform sampler2D tClouds; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tClouds, vUv); }',
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      depthTest: false, depthWrite: false, transparent: true,
    }));
    this._w = 2; this._h = 2;
  }

  setSize(w, h) {
    this._w = w; this._h = h;
    const cw = Math.max(1, Math.floor(w * this.scale)), ch = Math.max(1, Math.floor(h * this.scale));
    this.rt.setSize(cw, ch);
    // Keep temporal history at cloud resolution. Upscaling happens once during composition; this
    // avoids two full-screen half-float buffers (about 128 MB at 4K) just for cloud history.
    for (const t of this.hist) t.setSize(cw, ch);
    this.histValid = false;
    this.uniforms.uRes.value.set(cw, ch);
    this.resolveU.uLowRes.value.set(cw, ch);
    this.resolveU.uFullRes.value.set(cw, ch);
  }

  setQuality(scale, steps) {
    this.scale = scale; this.steps = steps; this.setSize(this._w, this._h);
    // shared with the ground's shadow lookups, so shadows resolve the same cloud detail
    if (this.uniforms.uCloudRes) this.uniforms.uCloudRes.value = scale;
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    // history is reprojected without the cloud drift: drop it when the clouds moved > ~250 m
    // (fast time warp) instead of smearing
    const time = this.uniforms.uCloudTime.value;
    if (this.prevTime !== null && Math.abs(time - this.prevTime) * 15 > 250) this.histValid = false;
    this.prevTime = time;
    const j = HALTON[this.frame % HALTON.length];
    this.uniforms.uInvProj.value.copy(cam.projectionMatrixInverse);
    this.uniforms.uCamWorld.value.copy(cam.matrixWorld);
    this.uniforms.uCamPos.value.copy(cam.position);
    // full-resolution pixel angle, so the clouds pick the same noise LOD as the ground's shadow lookups
    this.uniforms.uPixAngle.value = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / Math.max(this._h, 1);
    this.uniforms.uCloudSteps.value = this.steps;
    this.uniforms.uFrame.value = this.frame % 64;
    const lr = this.uniforms.uRes.value;
    this.uniforms.uJitNdc.value.set(2 * j[0] / lr.x, 2 * j[1] / lr.y);
    this.resolveU.uJit.value.set(j[0], j[1]);

    const oldClear = renderer.getClearColor(new THREE.Color()), oldAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.rt);
    renderer.clear(true, false, false);
    this.march.render(renderer);

    const [src, dst] = this.hist;
    this.resolveU.tHist.value = src.texture;
    this.resolveU.uValid.value = this.histValid ? 1 : 0;
    renderer.setRenderTarget(dst);
    this.resolve.render(renderer);
    renderer.setClearColor(oldClear, oldAlpha);
    this.hist.reverse();
    this.comp.material.uniforms.tClouds.value = dst.texture;
    this.histValid = true;
    this.prevVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse.copy(cam.matrixWorld).invert());
    this.frame++;
  }
}

// Composites the clouds onto the frame. Must run directly after the planet pass with no render-
// target switch in between (switching resolves + invalidates the multisampled frame buffer).
export class CloudCompositePass extends Pass {
  constructor(cloudPass) { super(); this.needsSwap = false; this.cloudPass = cloudPass; }
  render(renderer, writeBuffer, readBuffer) {
    const ac = renderer.autoClear;
    renderer.autoClear = false; // FullScreenQuad.render() would otherwise wipe the frame first
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.cloudPass.comp.render(renderer);
    renderer.autoClear = ac;
  }
}
