// ---------------------------------------------------------------------------------------------
// Regional raymarched clouds: a cloud provider (contract in cloudslot.js) that fills one lat/lon
// box with a cumulus layer, for side-by-side comparison with an external cloud renderer.
//   - raw WebGL2 + GLSL ES 3.00, no three.js; density from a 3D texture (64^3 tileable
//     Perlin-Worley / Worley fbm, baked once on the CPU);
//   - lit only through the Lighting hub (sun after the air, sky irradiance, aerial haze);
//   - writes the shared cloud shadow map, so ground, sea, haze and spacecraft are shadowed.
// The app cuts its built-in clouds out of the same box (uCloudCut) while this runs.
// ---------------------------------------------------------------------------------------------

const rcVert = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const rcHeader = '#version 300 es\nprecision highp float;\nprecision highp sampler2D;\nprecision highp sampler3D;\n';

// cloud layer shared by both programs
const rcFieldGLSL = /* glsl */ `
uniform sampler3D uVol;          // R: Perlin-Worley (shapes), G: Worley fbm (erosion detail)
uniform vec4 uBox;               // lon0, lat0, lon1, lat1 (radians)
uniform float uCover;            // overall cover multiplier
const float BASE = 1.0;          // cloud base, km above sea level
const float TOPMAX = 7.0;        // highest tops, km

float rcBoxMask(vec3 n){
  vec2 ll = vec2(atan(n.x, n.z), asin(clamp(n.y, -1.0, 1.0)));
  vec2 e = min(ll - uBox.xy, uBox.zw - ll);
  return smoothstep(0.0, 0.025, min(e.x, e.y));
}

// mip level of the volume tiled every "tile" km, for a footprint of fp km (64 voxels per tile)
float rcLod(float fp, float tile){ return max(log2(fp * 64.0 / tile), 0.0); }

// weather at a point: x = coverage, y = cloud-top height (km); fp = footprint (km)
vec2 rcWeather(vec3 p, float fp){
  float big = textureLod(uVol, p / 260.0, rcLod(fp, 260.0)).r;         // ~250 km cloudy / clear regions
  // ~25 km open cells and gaps: two lookups on differently oriented grids, so a threshold never
  // traces the voxel grid of either
  float mid = textureLod(uVol, p / 90.0 + 0.31, rcLod(fp, 90.0)).g * 0.55
            + textureLod(uVol, p.zxy / 57.0 + 0.73, rcLod(fp, 57.0)).g * 0.45;
  float cov = smoothstep(0.45, 0.9, big * 0.6 + mid * 0.6) * 0.9 * uCover;
  cov *= rcBoxMask(normalize(p));
  float top = mix(2.6, TOPMAX, smoothstep(0.35, 0.8, textureLod(uVol, p / 420.0 + 0.57, rcLod(fp, 420.0)).g));
  return vec2(cov, top);
}

// extinction (1/km); detail = 0 skips the erosion lookup (light / shadow rays); fp = footprint (km):
// the volume is read at the mip that matches it, and detail finer than a pixel fades out
float rcSigma(vec3 p, float alt, vec2 w, float detail, float fp){
  if (w.x < 0.01) return 0.0;
  float h = (alt - BASE) / (w.y - BASE);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  float prof = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.45, 1.0, h));   // flat base, rounded tops
  float sl = rcLod(fp, 32.0);
  float shape = textureLod(uVol, p / 32.0, sl).r;
  float d = clamp((shape * prof - (1.0 - w.x)) / max(w.x, 0.08), 0.0, 1.0);
  // Thresholding a mip-averaged shape would turn every partly cloudy area solid. Where heaps are
  // smaller than the footprint, use an effective extinction instead: a column through a field with
  // cover c lets ~(1 - 0.9 c) of the light through (the gaps), however dense each heap is.
  float dEff = -log(max(1.0 - w.x * 0.9, 0.05)) / (max(w.y - BASE, 0.5) * 24.0) * prof * 1.7;
  d = mix(d, dEff, smoothstep(2.5, 4.5, sl));
  if (d <= 0.0) return 0.0;
  float dl = rcLod(fp, 3.2);
  detail *= 1.0 - smoothstep(2.0, 4.0, dl);
  if (detail > 0.0){
    float det = textureLod(uVol, p / 3.2, dl).g;
    d = clamp(d - (1.0 - det) * 0.35 * (1.0 - d) * detail, 0.0, 1.0);
  }
  return d * 24.0;
}

// first stretch of a ray inside the cloud layer
vec2 rcSlab(vec3 ro, vec3 rd){
  vec2 o = raySphere(ro, rd, Rg + TOPMAX);
  if (o.y <= 0.0) return vec2(1.0, 0.0);
  float t0 = max(o.x, 0.0), t1 = o.y;
  vec2 i = raySphere(ro, rd, Rg + BASE);
  if (i.y > 0.0){ if (i.x > 0.0) t1 = min(t1, i.x); else t0 = max(t0, i.y); }
  return vec2(t0, t1);
}
`;

const rcColorFrag = (lightingGLSL) => `${rcHeader}${lightingGLSL}
${rcFieldGLSL}
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos;
uniform float uPixAngle;        // radians per pixel of the colour target
in vec2 vUv;
out vec4 outColor;

float rcHG(float mu, float g){ float gg = g * g; return (1.0 - gg) / (4.0 * PI * pow(max(1.0 + gg - 2.0 * g * mu, 1e-4), 1.5)); }

void main(){
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 ro = uCamPos;
  vec2 tb = rcSlab(ro, rd);
  if (tb.y <= tb.x){ outColor = vec4(0.0); return; }
  // skip rays that never come near the box
  if (rcBoxMask(normalize(ro + rd * tb.x)) <= 0.0 && rcBoxMask(normalize(ro + rd * tb.y)) <= 0.0){ outColor = vec4(0.0); return; }

  const int STEPS = 128;
  float dt = max((tb.y - tb.x) / float(STEPS), 0.08);
  // static interleaved-gradient jitter: no temporal accumulation here, so keep the noise still
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float mu = dot(rd, uSunDir);
  vec3 acc = vec3(0.0);
  float T = 1.0, tHit = -1.0;
  vec2 w = vec2(0.0);
  float tW = -1e9;
  for (int i = 0; i < STEPS; i++){
    float t = tb.x + (float(i) + jit) * dt;
    if (t > tb.y) break;
    vec3 p = ro + rd * t;
    float fp = max(t * uPixAngle, dt);
    if (abs(t - tW) > 2.0){ w = rcWeather(p, fp); tW = t; }      // weather varies over ~10 km
    float r = length(p), alt = r - Rg;
    float s = rcSigma(p, alt, w, 1.0, fp);
    if (s < 0.01) continue;
    if (tHit < 0.0) tHit = t;
    float muS = dot(p, uSunDir) / r;
    // optical depth toward the sun, 5 growing steps (self-shadowing of the heap)
    float od = 0.0, ls = 0.12, lt = 0.0;
    for (int j = 0; j < 5; j++){
      lt += ls * 0.5;
      vec3 lp = p + uSunDir * lt;
      od += rcSigma(lp, length(lp) - Rg, w, 0.0, max(fp, ls)) * ls;
      lt += ls * 0.5;
      ls *= 2.2;
    }
    vec3 sun = uSunE * sunTransmittance(r, muS);
    // multiple scattering as attenuated octaves (Wrenninge), forward + back lobes
    float ph0 = mix(rcHG(mu, 0.8), rcHG(mu, -0.15), 0.35);
    float ph1 = mix(rcHG(mu, 0.4), rcHG(mu, -0.08), 0.35);
    float ph2 = 0.25 / PI;
    vec3 sunL = sun * (ph0 * exp(-od) + 0.5 * ph1 * exp(-od * 0.3) + 0.25 * ph2 * exp(-od * 0.1)) * 1.6;
    float powder = 1.0 - 0.4 * exp(-s * 0.4);
    float hh = clamp((alt - BASE) / (w.y - BASE), 0.0, 1.0);
    vec3 amb = skyIrradiance(r, muS) / PI * mix(0.45, 0.95, hh) * exp(-od * 0.04);
    vec3 S = sunL * powder + amb;
    float Ts = exp(-s * dt);
    acc += T * S * (1.0 - Ts);
    T *= Ts;
    if (T < 0.01) break;
  }
  float a = 1.0 - T;
  if (a < 0.002){ outColor = vec4(0.0); return; }
  vec3 Sa, Ta;
  aerial(ro, rd, tHit, Sa, Ta);
  outColor = vec4(acc * Ta + Sa * a, a);
}`;

const rcShadowFrag = (lightingGLSL) => `${rcHeader}${lightingGLSL}
${rcFieldGLSL}
uniform vec3 uShOrigin, uShRight, uShUp, uShDir;
uniform float uShExtent;
in vec2 vUv;
out vec4 outShadow;
void main(){
  vec3 ro = uShOrigin + (uShRight * (vUv.x * 2.0 - 1.0) + uShUp * (vUv.y * 2.0 - 1.0)) * uShExtent;
  vec2 tb = rcSlab(ro, uShDir);
  if (tb.y <= tb.x) discard;
  if (rcBoxMask(normalize(ro + uShDir * tb.x)) <= 0.0 && rcBoxMask(normalize(ro + uShDir * tb.y)) <= 0.0) discard;
  const int STEPS = 40;
  float dt = (tb.y - tb.x) / float(STEPS);
  float od = 0.0, front = -1.0, back = 0.0;
  for (int i = 0; i < STEPS; i++){
    float t = tb.x + (float(i) + 0.5) * dt;
    vec3 p = ro + uShDir * t;
    float fp = uShExtent * 2.0 / 2048.0;   // one shadow texel
    float s = rcSigma(p, length(p) - Rg, rcWeather(p, fp), 0.0, fp);
    if (s < 0.01) continue;
    if (front < 0.0) front = t - 0.5 * dt;
    back = t + 0.5 * dt;
    od += s * dt;
  }
  if (od < 1e-3) discard;
  outShadow = vec4(front, od / max(back - front, 0.05), od, 1.0);
}`;

// 64^3 tileable noise volume: R = Perlin-Worley, G = Worley fbm (one octave finer)
function rcBakeVolume(N = 64) {
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const worleyPts = (F) => { const a = new Float32Array(F * F * F * 3); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
  const pts = { 4: worleyPts(4), 8: worleyPts(8), 16: worleyPts(16), 32: worleyPts(32) };
  const worley = (x, y, z, F) => {
    const P = pts[F], px = x * F, py = y * F, pz = z * F;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    let md = 9;
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j, cz = iz + k;
      const w = ((((cz % F) + F) % F) * F + (((cy % F) + F) % F)) * F + (((cx % F) + F) % F);
      const dx = cx + P[w * 3] - px, dy = cy + P[w * 3 + 1] - py, dz = cz + P[w * 3 + 2] - pz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < md) md = d;
    }
    return 1 - Math.min(Math.sqrt(md), 1);
  };
  const lat = new Float32Array(32 * 32 * 32); for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const vnoise = (x, y, z, F) => {   // tileable value noise, smooth
    const px = x * F, py = y * F, pz = z * F, ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    const fx = px - ix, fy = py - iy, fz = pz - iz;
    const s = (t) => t * t * (3 - 2 * t), ux = s(fx), uy = s(fy), uz = s(fz);
    const g = (a, b, c) => lat[(((c % F) + F) % F) * 1024 + (((b % F) + F) % F) * 32 + (((a % F) + F) % F)];
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(g(ix, iy, iz), g(ix + 1, iy, iz), ux), l(g(ix, iy + 1, iz), g(ix + 1, iy + 1, iz), ux), uy),
      l(l(g(ix, iy, iz + 1), g(ix + 1, iy, iz + 1), ux), l(g(ix, iy + 1, iz + 1), g(ix + 1, iy + 1, iz + 1), ux), uy), uz);
  };
  const data = new Uint8Array(N * N * N * 2);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, w = z / N;
    const pf = (vnoise(u, v, w, 4) * 0.5 + vnoise(u, v, w, 8) * 0.25 + vnoise(u, v, w, 16) * 0.15 + vnoise(u, v, w, 32) * 0.1);
    const w4 = worley(u, v, w, 4), w8 = worley(u, v, w, 8), w16 = worley(u, v, w, 16), w32 = worley(u, v, w, 32);
    const wf = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
    const pw = Math.min(Math.max((wf + pf * (1 - wf) - 0.25) / 0.75, 0), 1);
    const i = ((z * N + y) * N + x) * 2;
    data[i] = Math.round(pw * 255);
    data[i + 1] = Math.round((w8 * 0.625 + w16 * 0.25 + w32 * 0.125) * 255);
  }
  return { data, N };
}

// box in degrees; defaults: the Ionian Sea and Greece, wide enough to fill the view from orbit along
// SPHEREx's pass there (Libya's coast to the Alps, Sardinia to the Turkish coast)
export function createRegionCloudProvider({ lat0 = 30, lat1 = 47, lon0 = 8, lon1 = 30, cover = 1.0 } = {}) {
  let gl, lighting, vao, vol, colorProg, shadowProg;
  const d = Math.PI / 180;
  const box = new Float32Array([lon0 * d, lat0 * d, lon1 * d, lat1 * d]);

  function compile(fragSrc) {
    const mk = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, rcVert));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const locs = new Map();
    p.loc = (n) => { if (!locs.has(n)) locs.set(n, gl.getUniformLocation(p, n)); return locs.get(n); };
    return p;
  }

  function useCommon(p) {
    gl.useProgram(p);
    const unit = lighting.bind(gl, p, 0);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, vol);
    gl.uniform1i(p.loc('uVol'), unit);
    gl.uniform4fv(p.loc('uBox'), box);
    gl.uniform1f(p.loc('uCover'), provider.cover);
  }

  const provider = {
    shadowMapSize: 2048,
    box: { lat0, lat1, lon0, lon1 },
    cover,
    init(glCtx, hub) {
      gl = glCtx; lighting = hub;
      vao = gl.createVertexArray();
      const t0 = performance.now();
      const { data, N } = rcBakeVolume(64);
      vol = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, vol);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, N, N, N, 0, gl.RG, gl.UNSIGNED_BYTE, data);
      gl.generateMipmap(gl.TEXTURE_3D);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
      colorProg = compile(rcColorFrag(hub.glsl));
      shadowProg = compile(rcShadowFrag(hub.glsl));
      console.info(`Region clouds ready (${(performance.now() - t0).toFixed(0)} ms)`);
    },
    render(f) {
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, f.shadow.framebuffer);
      gl.viewport(0, 0, f.shadow.size, f.shadow.size);
      useCommon(shadowProg);
      gl.uniform3fv(shadowProg.loc('uShOrigin'), f.shadow.origin);
      gl.uniform3fv(shadowProg.loc('uShRight'), f.shadow.right);
      gl.uniform3fv(shadowProg.loc('uShUp'), f.shadow.up);
      gl.uniform3fv(shadowProg.loc('uShDir'), f.shadow.dir);
      gl.uniform1f(shadowProg.loc('uShExtent'), f.shadow.extent);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, f.color.framebuffer);
      gl.viewport(0, 0, f.color.width, f.color.height);
      useCommon(colorProg);
      gl.uniformMatrix4fv(colorProg.loc('uInvProj'), false, f.camera.invProjection);
      gl.uniformMatrix4fv(colorProg.loc('uCamWorld'), false, f.camera.cameraWorld);
      gl.uniform3fv(colorProg.loc('uCamPos'), f.camera.position);
      gl.uniform1f(colorProg.loc('uPixAngle'), f.camera.pixelAngle);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
    dispose() {
      gl.deleteProgram(colorProg); gl.deleteProgram(shadowProg);
      gl.deleteTexture(vol); gl.deleteVertexArray(vao);
    },
  };
  return provider;
}
