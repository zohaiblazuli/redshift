// ---------------------------------------------------------------------------------------------
// Example cloud provider: a template for plugging an external raw-WebGL2 cloud renderer into the
// app (contract in cloudslot.js). Not the app's cloud system -- one analytic cumulus cluster,
// raymarched with nothing but WebGL2 and the Lighting hub:
//   - lighting.glsl supplies sunTransmittance(), skyIrradiance(), aerial() and the uniforms;
//   - lighting.bind() uploads them; the provider writes its image and the shared shadow map, and
//     the ground, sea, haze and spacecraft pick the shadow up on their own.
// Attach with ?clouds=example or __sx.setCloudProvider(__sx.createExampleCloudProvider()).
// ---------------------------------------------------------------------------------------------

const exVert = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));   // one full-screen triangle
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const exHeader = '#version 300 es\nprecision highp float;\nprecision highp sampler2D;\n';

// density field shared by both programs: a cluster of soft blobs in the cloud's local frame
const exDensityGLSL = /* glsl */ `
uniform vec3 uC;                 // cluster centre (world km, at cloud base)
uniform vec3 uE, uN, uU;         // local east / north / up
uniform float uSize;             // horizontal radius, km
uniform float uBound;            // bounding-sphere radius, km
const int NB = 7;
uniform vec4 uBlobs[NB];         // xyz local offset (km), w radius (km)

float exHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float exNoise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(exHash(i), exHash(i + vec3(1,0,0)), f.x), mix(exHash(i + vec3(0,1,0)), exHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(exHash(i + vec3(0,0,1)), exHash(i + vec3(1,0,1)), f.x), mix(exHash(i + vec3(0,1,1)), exHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// extinction, 1/km
float exSigma(vec3 p){
  vec3 d = p - uC;
  vec3 q = vec3(dot(d, uE), dot(d, uN), dot(d, uU));
  if (q.z < 0.0) return 0.0;                       // flat cloud base
  float m = 0.0;
  for (int i = 0; i < NB; i++){
    vec3 o = (q - uBlobs[i].xyz) / uBlobs[i].w;
    m = max(m, 1.0 - dot(o, o));
  }
  if (m <= 0.0) return 0.0;
  float n = exNoise(q * 0.25) * 0.6 + exNoise(q * 0.9) * 0.3 + exNoise(q * 3.1) * 0.1;
  float dens = clamp(m * 1.6 - (1.0 - n) * 0.9, 0.0, 1.0);
  return dens * 0.6 * smoothstep(0.0, 0.6, q.z);   // soft base
}
vec2 exBounds(vec3 ro, vec3 rd){
  vec3 c = uC + uU * uBound * 0.35;
  vec3 oc = ro - c; float b = dot(oc, rd), h = b * b - dot(oc, oc) + uBound * uBound;
  if (h < 0.0) return vec2(1.0, 0.0);
  h = sqrt(h); return vec2(max(-b - h, 0.0), -b + h);
}
`;

const exColorFrag = (lightingGLSL) => `${exHeader}${lightingGLSL}
${exDensityGLSL}
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos;
uniform float uFrame;
in vec2 vUv;
out vec4 outColor;

float hg(float mu, float g){ float gg = g * g; return (1.0 - gg) / (4.0 * PI * pow(1.0 + gg - 2.0 * g * mu, 1.5)); }

void main(){
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 ro = uCamPos;
  vec2 tb = exBounds(ro, rd);
  vec2 tg = raySphere(ro, rd, Rg);                 // the planet hides what lies behind it
  if (tg.x > 0.0) tb.y = min(tb.y, tg.x);
  if (tb.y <= tb.x){ outColor = vec4(0.0); return; }

  const int STEPS = 96;
  float dt = (tb.y - tb.x) / float(STEPS);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame * 0.618034);
  float mu = dot(rd, uSunDir);
  float ph = mix(hg(mu, 0.8), hg(mu, -0.2), 0.3);
  vec3 acc = vec3(0.0);
  float T = 1.0, tHit = -1.0;
  for (int i = 0; i < STEPS; i++){
    float t = tb.x + (float(i) + jit) * dt;
    vec3 p = ro + rd * t;
    float s = exSigma(p);
    if (s < 1e-3) continue;
    if (tHit < 0.0) tHit = t;
    float r = length(p), muS = dot(p, uSunDir) / r;
    // optical depth toward the sun: 6 growing steps
    float od = 0.0, ls = 0.4, lt = 0.0;
    for (int j = 0; j < 6; j++){ lt += ls; od += exSigma(p + uSunDir * lt) * ls; ls *= 1.8; }
    // the hub's lighting: sunlight after the air, skylight from the irradiance table
    vec3 sun = uSunE * sunTransmittance(r, muS);
    vec3 S = sun * (ph * exp(-od) + 0.08 * exp(-od * 0.25))
           + skyIrradiance(r, muS) / PI * 0.8;
    float Ts = exp(-s * dt);
    acc += T * S * (1.0 - Ts);
    T *= Ts;
    if (T < 0.01) break;
  }
  float a = 1.0 - T;
  if (a < 0.002){ outColor = vec4(0.0); return; }
  vec3 Sa, Ta;
  aerial(ro, rd, tHit, Sa, Ta);                    // the same air haze as the planet
  outColor = vec4(acc * Ta + Sa * a, a);
}`;

const exShadowFrag = (lightingGLSL) => `${exHeader}${lightingGLSL}
${exDensityGLSL}
uniform vec3 uShOrigin, uShRight, uShUp, uShDir;
uniform float uShExtent;
in vec2 vUv;
out vec4 outShadow;
void main(){
  // this texel's shadow ray (see frame.shadow in cloudslot.js): t along it is the stored depth
  vec3 ro = uShOrigin + (uShRight * (vUv.x * 2.0 - 1.0) + uShUp * (vUv.y * 2.0 - 1.0)) * uShExtent;
  vec2 tb = exBounds(ro, uShDir);
  if (tb.y <= tb.x) discard;                       // cleared to "no cloud"
  const int STEPS = 48;
  float dt = (tb.y - tb.x) / float(STEPS);
  float od = 0.0, front = -1.0, back = 0.0;
  for (int i = 0; i < STEPS; i++){
    float t = tb.x + (float(i) + 0.5) * dt;
    float s = exSigma(ro + uShDir * t);
    if (s < 1e-3) continue;
    if (front < 0.0) front = t - 0.5 * dt;
    back = t + 0.5 * dt;
    od += s * dt;
  }
  if (od < 1e-3) discard;
  outShadow = vec4(front, od / max(back - front, 0.01), od, 1.0);
}`;

export function createExampleCloudProvider({ lat = null, lon = null, sizeKm = 25 } = {}) {
  let gl, lighting, vao, colorProg, shadowProg, frameNo = 0;
  const frame = { C: null, E: null, N: null, U: null };
  const blobs = new Float32Array(7 * 4);

  function compile(fragSrc) {
    const mk = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, exVert));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const locs = new Map();
    p.loc = (n) => { if (!locs.has(n)) locs.set(n, gl.getUniformLocation(p, n)); return locs.get(n); };
    return p;
  }

  // local frame on the planet at (lat, lon); a heap of blobs from a fixed seed
  function place(latDeg, lonDeg) {
    const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
    const U = [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
    const E = [Math.cos(lo), 0, -Math.sin(lo)];
    const N = [U[1] * E[2] - U[2] * E[1], U[2] * E[0] - U[0] * E[2], U[0] * E[1] - U[1] * E[0]];
    const base = 6371 + 1.5;
    Object.assign(frame, { C: U.map((x) => x * base), E, N, U });
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 7; i++) {
      const a = rnd() * Math.PI * 2, d = i === 0 ? 0 : sizeKm * (0.35 + 0.45 * rnd());
      const r = sizeKm * (i === 0 ? 0.55 : 0.3 + 0.2 * rnd());
      blobs.set([Math.cos(a) * d, Math.sin(a) * d, r * (i === 0 ? 0.9 : 0.6), r], i * 4);
    }
  }

  function setCommon(p) {
    gl.uniform3fv(p.loc('uC'), frame.C); gl.uniform3fv(p.loc('uE'), frame.E);
    gl.uniform3fv(p.loc('uN'), frame.N); gl.uniform3fv(p.loc('uU'), frame.U);
    gl.uniform1f(p.loc('uSize'), sizeKm); gl.uniform1f(p.loc('uBound'), sizeKm * 1.6);
    gl.uniform4fv(p.loc('uBlobs'), blobs);
  }

  return {
    shadowMapSize: 2048,
    init(glCtx, hub) {
      gl = glCtx; lighting = hub;
      vao = gl.createVertexArray();
      colorProg = compile(exColorFrag(hub.glsl));
      shadowProg = compile(exShadowFrag(hub.glsl));
      if (lat !== null && lon !== null) place(lat, lon);
    },
    // move the cluster (degrees)
    moveTo(latDeg, lonDeg) { place(latDeg, lonDeg); },
    render(f) {
      if (!frame.C) {
        // first frame: put it where the camera looks (or below it if it looks at space)
        const c = f.camera, P = c.position, m = c.cameraWorld;
        const d = [-m[8], -m[9], -m[10]];
        const b = P[0] * d[0] + P[1] * d[1] + P[2] * d[2], cc = P[0] ** 2 + P[1] ** 2 + P[2] ** 2 - 6371 ** 2;
        const h = b * b - cc;
        const t = h > 0 && -b - Math.sqrt(h) > 0 ? -b - Math.sqrt(h) : 0;
        const q = [P[0] + d[0] * t, P[1] + d[1] * t, P[2] + d[2] * t], ql = Math.hypot(...q);
        place(Math.asin(q[1] / ql) * 180 / Math.PI, Math.atan2(q[0], q[2]) * 180 / Math.PI);
      }
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);

      // 1. shared shadow map (only where the cluster is; the rest stays cleared)
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.shadow.framebuffer);
      gl.viewport(0, 0, f.shadow.size, f.shadow.size);
      gl.useProgram(shadowProg);
      lighting.bind(gl, shadowProg, 0);
      setCommon(shadowProg);
      gl.uniform3fv(shadowProg.loc('uShOrigin'), f.shadow.origin);
      gl.uniform3fv(shadowProg.loc('uShRight'), f.shadow.right);
      gl.uniform3fv(shadowProg.loc('uShUp'), f.shadow.up);
      gl.uniform3fv(shadowProg.loc('uShDir'), f.shadow.dir);
      gl.uniform1f(shadowProg.loc('uShExtent'), f.shadow.extent);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. the cloud image (premultiplied)
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.color.framebuffer);
      gl.viewport(0, 0, f.color.width, f.color.height);
      gl.useProgram(colorProg);
      lighting.bind(gl, colorProg, 0);
      setCommon(colorProg);
      gl.uniformMatrix4fv(colorProg.loc('uInvProj'), false, f.camera.invProjection);
      gl.uniformMatrix4fv(colorProg.loc('uCamWorld'), false, f.camera.cameraWorld);
      gl.uniform3fv(colorProg.loc('uCamPos'), f.camera.position);
      gl.uniform1f(colorProg.loc('uFrame'), frameNo++ % 64);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
    dispose() {
      gl.deleteProgram(colorProg); gl.deleteProgram(shadowProg); gl.deleteVertexArray(vao);
    },
  };
}
