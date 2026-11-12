import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { commonGLSL, atmoMediumGLSL } from './shaders.js';

// ---------------------------------------------------------------------------------------------
// Precomputed atmospheric scattering (Hillaire 2020, "A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique"; parameterisation from Bruneton 2017). Three small tables are
// rendered once on the GPU at start-up:
//   transmittance   256x64  sunlight surviving the air from any height/angle to space
//   multi-scatter    32x32  every scattering order beyond the first, as a transfer function
//   sky irradiance   64x16  skylight falling on a horizontal surface (for terrain ambient)
// The sky, aerial perspective and ground lighting then read them per pixel.
// ---------------------------------------------------------------------------------------------

const lutVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const transFrag = /* glsl */ `
${commonGLSL}
${atmoMediumGLSL}
varying vec2 vUv;
void main(){
  vec2 x = (gl_FragCoord.xy - 0.5) / (TLUT - 1.0);
  float rho = ATM_H * x.y;
  float r = sqrt(rho * rho + Rg * Rg);
  float dmin = Rt - r, dmax = rho + ATM_H;
  float d = dmin + x.x * (dmax - dmin);
  float mu = d <= 0.0 ? 1.0 : clamp((ATM_H * ATM_H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  float len = distToTop(r, mu);
  vec3 tau = vec3(0.0);
  const int N = 64;
  float ds = len / float(N);
  for (int i = 0; i < N; i++){
    float t = (float(i) + 0.5) * ds;
    float ri = sqrt(r * r + t * t + 2.0 * r * mu * t);
    tau += mediumAt(ri - Rg).ext * ds;
  }
  gl_FragColor = vec4(exp(-tau), 1.0);
}`;

// shared helpers for the two LUTs that need sunlight inside the atmosphere
const sunGLSL = /* glsl */ `
uniform sampler2D uTransLUT;
vec3 sunT(float r, float mu){
  r = clamp(r, Rg + 0.001, Rt);
  float muH = -sqrt(max(1.0 - (Rg / r) * (Rg / r), 0.0));
  if (mu < muH) return vec3(0.0);
  return texture2D(uTransLUT, transUv(r, mu)).rgb;
}
vec2 sphereHit(vec3 ro, vec3 rd, float R){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float d = b * b - c;
  if (d < 0.0) return vec2(-1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
`;

const msFrag = /* glsl */ `
${commonGLSL}
${atmoMediumGLSL}
${sunGLSL}
varying vec2 vUv;
void main(){
  vec2 x = (gl_FragCoord.xy - 0.5) / (MLUT - 1.0);
  float muS = x.x * 2.0 - 1.0;
  float r = Rg + max(x.y, 0.002) * (Rt - Rg);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 sun = vec3(sqrt(max(1.0 - muS * muS, 0.0)), muS, 0.0);
  vec3 Lsum = vec3(0.0), Fsum = vec3(0.0);
  const int SQ = 8;
  const float ISO = 1.0 / (4.0 * PI);
  for (int i = 0; i < SQ; i++) for (int j = 0; j < SQ; j++){
    float ct = 1.0 - 2.0 * (float(i) + 0.5) / float(SQ);
    float st = sqrt(max(1.0 - ct * ct, 0.0));
    float ph = 2.0 * PI * (float(j) + 0.5) / float(SQ);
    vec3 rd = vec3(st * cos(ph), ct, st * sin(ph));
    vec2 tg = sphereHit(ro, rd, Rg);
    bool ground = tg.x > 0.0;
    float tMax = ground ? tg.x : sphereHit(ro, rd, Rt).y;
    const int N = 20;
    float ds = tMax / float(N);
    vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
    for (int k = 0; k < N; k++){
      float t = (float(k) + 0.5) * ds;
      vec3 p = ro + rd * t;
      float rp = length(p);
      Medium m = mediumAt(rp - Rg);
      vec3 sc = m.scatR + m.scatM;
      vec3 stepT = exp(-m.ext * ds);
      vec3 integ = (vec3(1.0) - stepT) / max(m.ext, vec3(1e-7));
      L += T * sc * ISO * sunT(rp, dot(p, sun) / rp) * integ;
      F += T * sc * integ;
      T *= stepT;
    }
    if (ground){
      vec3 gp = ro + rd * tg.x;
      vec3 gn = normalize(gp);
      L += T * sunT(Rg + 0.001, dot(gn, sun)) * max(dot(gn, sun), 0.0) * GROUND_ALBEDO / PI;
    }
    Lsum += L; Fsum += F;
  }
  float n = float(SQ * SQ);
  // uniform-sphere average (solid angle 4pi times the isotropic phase 1/4pi = 1)
  vec3 L2 = Lsum / n, fms = Fsum / n;
  gl_FragColor = vec4(L2 / max(vec3(1.0) - fms, vec3(1e-3)), 1.0);
}`;

const irrFrag = /* glsl */ `
${commonGLSL}
${atmoMediumGLSL}
${sunGLSL}
uniform sampler2D uMsLUT;
varying vec2 vUv;
vec3 ms(float r, float muS){
  return texture2D(uMsLUT, lutUv(vec2(muS * 0.5 + 0.5, clamp((r - Rg) / (Rt - Rg), 0.0, 1.0)), MLUT)).rgb;
}
void main(){
  vec2 x = (gl_FragCoord.xy - 0.5) / (ILUT - 1.0);
  float muS = x.x * 2.0 - 1.0;
  float r = Rg + max(x.y, 0.0005) * (Rt - Rg);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 sun = vec3(sqrt(max(1.0 - muS * muS, 0.0)), muS, 0.0);
  vec3 E = vec3(0.0);
  const int NZ = 8, NA = 16, N = 24;
  float dTheta = 0.5 * PI / float(NZ), dPhi = 2.0 * PI / float(NA);
  for (int i = 0; i < NZ; i++) for (int j = 0; j < NA; j++){
    float th = (float(i) + 0.5) * dTheta, ph = (float(j) + 0.5) * dPhi;
    vec3 rd = vec3(sin(th) * cos(ph), cos(th), sin(th) * sin(ph));
    float tMax = sphereHit(ro, rd, Rt).y;
    float ds = tMax / float(N);
    float mu = dot(rd, sun);
    float pR = phaseR(mu), pM = phaseM(mu);
    vec3 T = vec3(1.0), L = vec3(0.0);
    for (int k = 0; k < N; k++){
      float t = (float(k) + 0.5) * ds;
      vec3 p = ro + rd * t;
      float rp = length(p);
      Medium m = mediumAt(rp - Rg);
      float mS = dot(p, sun) / rp;
      vec3 sc = (m.scatR * pR + m.scatM * pM) * sunT(rp, mS) + (m.scatR + m.scatM) * ms(rp, mS);
      vec3 stepT = exp(-m.ext * ds);
      L += T * (sc - sc * stepT) / max(m.ext, vec3(1e-7));
      T *= stepT;
    }
    E += L * cos(th) * sin(th) * dTheta * dPhi;
  }
  gl_FragColor = vec4(E, 1.0);
}`;

export function createAtmosphereLUTs(renderer) {
  const mk = (w, h) => {
    const t = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
    t.texture.wrapS = t.texture.wrapT = THREE.ClampToEdgeWrapping;
    t.texture.generateMipmaps = false;
    return t;
  };
  const trans = mk(256, 64), ms = mk(32, 32), irr = mk(64, 16);
  const run = (frag, target, uniforms = {}) => {
    const q = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms, vertexShader: lutVert, fragmentShader: frag, depthTest: false, depthWrite: false }));
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    q.render(renderer);
    renderer.setRenderTarget(prev);
    q.material.dispose(); q.dispose();
  };
  run(transFrag, trans);
  run(msFrag, ms, { uTransLUT: { value: trans.texture } });
  run(irrFrag, irr, { uTransLUT: { value: trans.texture }, uMsLUT: { value: ms.texture } });
  return { transmittance: trans.texture, multiScatter: ms.texture, irradiance: irr.texture };
}
