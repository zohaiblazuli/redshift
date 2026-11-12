import { CW_FULLSCREEN_VS, TYPES, TYPE_ORDER, TYPE_INDEX, cwAtlasDims, cwCommonGLSL, cwGenGLSL, cwOccGLSL, cwBakeGLSL, cwDetailNoise, cwGenusSetup, cwGenusLayers, cwClearAtlas, cwBuildOccupancy, cwBuildEmptyDist } from '../../CloudWorks/src/cloudcore.js';
import { CW_PROFILE_BINS, cwStatsColumnFS, cwStatsLevelFS, cwLevelsFromRows, cwDetailMean, cwGenusStats, cwFarTables } from './cwstats.js';
import { cwFarColorFS, cwFarShadowFS, cwWeatherSource, cwCalibGLSL, CW_HIMAX_W, CW_HIMAX_H, CW_HIMAX_LEVELS, cwHiMaxBaseFS, cwHiMaxDilateFS } from './cwfar.js';
import { CLOUD_DATE } from './earth.js';

// ---------------------------------------------------------------------------------------------
// CloudWorks clouds in OpenWorld (cloud provider, contract in cloudslot.js).
//
// Plan: docs/superpowers/specs/2026-10-15-cloudworks-integration-design.md.
//   Phase 1: the CloudWorks atlas (ten genera + the original cumulus) is generated here by
//            CloudWorks' own code (cloudcore.js, shared with Groundview). mode 'lineup' shows the
//            ten genera in a row, for a side-by-side check against Groundview.
//   Phase 2: mode 'planet' (default) measures each genus from the atlas (cwstats.js) and draws the
//            observed day over the whole planet as a far field (cwfar.js), with its cloud shadows.
//   The mid and near fields (real shapes up close) come in later phases.
//
// The atlas is generated a few layers per frame inside render(), where the cloud slot isolates
// GL state from three.js (CloudWorks' own async generator would leave state behind between frames).
// Units: CloudWorks shapes live in a local box of +-3.7 x 2.6 x 2.8 units, scaled to metres per
// genus (TYPES[...].scale x size); the line-up frame is east / up / south in metres, as Groundview.
// ---------------------------------------------------------------------------------------------

const CW_LAYERS_PER_FRAME = 24;
// Near field (phase 4): CloudWorks' far self-shadow cache for the ten genera x eight orientations,
// baked for the sun in the cube-face frame around the camera, used within CW_NEAR_KM of it.
const CW_NEAR_KM = 60, CW_BAKE_LAYERS_PER_FRAME = 480, CW_ORIENTS = 8;

// The mid field's equal-angle cube (cwfar.js, cwCubeFace / cwFaceUv) on the CPU
function cwCubeFaceJS(n) {
  const a = n.map(Math.abs);
  if (a[0] >= a[1] && a[0] >= a[2]) return n[0] > 0 ? 0 : 1;
  if (a[1] >= a[2]) return n[1] > 0 ? 2 : 3;
  return n[2] > 0 ? 4 : 5;
}
function cwFaceUvJS(n, f) {
  const m = f < 2 ? [n[0], n[2], n[1]] : f < 4 ? [n[1], n[0], n[2]] : [n[2], n[0], n[1]], s = f % 2 === 0 ? 1 : -1;
  return [Math.atan2(m[1] * s, m[0] * s) * 6371, Math.atan2(m[2], m[0] * s) * 6371];
}
// CloudWorks' toLocal (45 degree turns, mirrored on odd steps)
function cwToLocalJS(v, k) {
  const a = k * Math.PI / 4, c = Math.cos(a), s = Math.sin(a), r = [c * v[0] + s * v[2], v[1], c * v[2] - s * v[0]];
  if (k & 1) r[0] = -r[0];
  return r;
}
// The sun in a shape's frame (x along face F.x, y up, z along F.y, before its own turn) at nadir n
function cwNearFrame(n, sun) {
  const face = cwCubeFaceJS(n), nn = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const t1 = nn(Math.abs(n[1]) < 0.9 ? [n[2], 0, -n[0]] : [0, -n[2], n[1]]);
  const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
  const e = 1e-4, F0 = cwFaceUvJS(n, face);
  const dF = (t) => { const F = cwFaceUvJS(nn(n.map((x, i) => x + e * t[i])), face); return [(F[0] - F0[0]) / (e * 6371), (F[1] - F0[1]) / (e * 6371)]; };
  const j1 = dF(t1), j2 = dF(t2), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const a = dot(sun, t1), b = dot(sun, t2);
  return { face, Lf: nn([j1[0] * a + j2[0] * b, dot(sun, n), j1[1] * a + j2[1] * b]) };
}

// Line-up renderer: CloudWorks' density sampling and in-cloud lighting terms (light march, far
// shadow, two-lobe phase, multiple-scattering and ambient terms, constants as Groundview's real-
// time engine), with sun, sky and haze from the Lighting hub. A debug view for comparing shapes;
// the production marcher arrives in phase 4.
const cwLineupFS = (common, lightingGLSL, n) => `${common}
precision highp sampler2D;
${lightingGLSL.replace(/#version[^\n]*\n/, '')}
${cwCalibGLSL}
uniform vec2 uRes;
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos;            // world, km
uniform vec3 uEyeL;              // camera in the line-up frame, m
uniform vec3 uC, uE, uU, uN;     // line-up origin (world km) and basis
uniform vec4 inst[${n}];         // xyz centre (line-up frame, m), w metres per shape unit
uniform vec4 instB[${n}];        // density, slab, base (shape units)
uniform float count, densityK;
const float RT_DIRECT=.386,RT_MULTI=.0857;
float hg(float c,float g){return (1.-g*g)/pow(max(.01,1.+g*g-2.*g*c),1.5);}
bool box(vec3 ro,vec3 rd,out float n,out float f){vec3 inv=1./(rd+vec3(1e-7)),t0=(-bounds-ro)*inv,t1=(bounds-ro)*inv,tn=min(t0,t1),tf=max(t0,t1);n=max(0.,max(tn.x,max(tn.y,tn.z)));f=min(tf.x,min(tf.y,tf.z));return f>n;}
vec3 toWorld(vec3 l){ return uC + (uE * l.x + uU * l.y - uN * l.z) * 0.001; }

void main(){
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(ndc, 1.0, 1.0);
  vec3 rdW = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 rd = vec3(dot(rdW, uE), dot(rdW, uU), -dot(rdW, uN));
  vec3 ro = uEyeL;
  vec2 tg = raySphere(uCamPos, rdW, Rg);
  float far = tg.x > 0.0 ? tg.x * 1000.0 : 1e12;
  vec3 Ll = vec3(dot(uSunDir, uE), dot(uSunDir, uU), -dot(uSunDir, uN));
  float mu = dot(rd, Ll), phase = .82 * hg(mu, .58) + .18 * hg(mu, -.25);

  // boxes this ray crosses, near to far (the line-up's boxes never overlap)
  float hn[${n}], hf[${n}]; int hi[${n}]; int nh = 0;
  for (int i = 0; i < ${n}; i++){
    if (float(i) >= count) break;
    vec4 a = inst[i]; float n0, f0;
    if (!box((ro - a.xyz) / a.w, rd, n0, f0)) continue;
    n0 *= a.w; f0 = min(f0 * a.w, far); if (f0 <= n0) continue;
    int j = nh;
    for (int m = ${n} - 1; m > 0; m--){ if (m > j) continue; if (hn[m - 1] <= n0) break; hn[m] = hn[m - 1]; hf[m] = hf[m - 1]; hi[m] = hi[m - 1]; j = m - 1; }
    hn[j] = n0; hf[j] = f0; hi[j] = i; nh++;
  }
  if (nh == 0){ frag = vec4(0.0); return; }

  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 color = vec3(0.0); float trans = 1.0, tHit = -1.0;
  for (int h = 0; h < ${n}; h++){
    if (h >= nh || trans < 0.004) break;
    int i = hi[h]; vec4 a = inst[i]; vec4 b = instB[i];
    float dens = b.x * densityK, slab = b.y, base = b.z;
    vec3 rol = (ro - a.xyz) / a.w;
    // CloudWorks' step rule: several samples across thin ice layers
    float maxStep = slab < .5 ? .16 : slab < 3.5 ? .028 : slab < 8.5 ? .06 : .16;
    float s0 = hn[h] / a.w, s1 = hf[h] / a.w;
    float dt = (s1 - s0) / max(1.0, ceil((s1 - s0) / maxStep)), t = s0 + dt * jit;
    for (int s = 0; s < 640; s++){
      if (t >= s1 || trans < 0.004) break;
      vec3 pos = rol + rd * t;
      float d = sampleCloud(pos, dens, slab);
      if (d > .003){
        if (tHit < 0.0) tHit = t * a.w;
        // light: CloudWorks' three short steps, then its far-shadow march (as baked in its cache)
        float optical = 0., stepLight = .025, travel = .012;
        for (int j = 0; j < 18; j++){
          optical += (j < 3 ? sampleCloud(pos + Ll * travel, dens, slab) : shadowDensity(pos + Ll * travel, slab) * dens) * stepLight;
          travel += stepLight; stepLight *= 1.29;
        }
        optical *= 22.;
        float direct = exp(-optical) * phase;
        float multiple = .38 * exp(-optical * .40) + .12 * exp(-optical * .12);
        // the hub's light at this point, calibrated to Groundview
        vec3 pw = toWorld(a.xyz + pos * a.w);
        float r = length(pw), muS = dot(pw, uSunDir) / r;
        vec3 sunL, ambTop, ambLow;
        cwCloudLight(r, muS, sunL, ambTop, ambLow);
        float height = smoothstep(base - .2, base + 2.7, pos.y);
        float topOcclusion = sampleCloud(pos + vec3(0, .3, 0), dens, slab) * .9 + sampleCloud(pos + vec3(0, .75, 0), dens, slab) * .55;
        vec3 ambient = mix(ambLow, ambTop, height) * exp(-topOcclusion * .7);
        vec3 ill = ambient + sunL * (direct * RT_DIRECT + multiple * RT_MULTI);
        float tau = d * 22. * dt, al = 1. - exp(-tau);
        color += trans * al * ill; trans *= 1. - al;
      }
      t += dt;
    }
  }
  if (trans < 0.004) trans = 0.0;
  float alpha = 1.0 - trans;
  if (alpha < 0.002){ frag = vec4(0.0); return; }
  vec3 S, T;
  aerial(uCamPos, rdW, tHit * 0.001, S, T);
  frag = vec4(color * T + S * alpha, alpha);
}`;

export function createCloudWorksProvider({ mode = 'planet', shapeSeed = 1, size = 270, density = 1.0, cover = 1.0, lineup = null, date = CLOUD_DATE, legacyCumulus = true } = {}) {
  let gl, hub, dims, A, lineupProg, lu;
  // planet mode: per-genus statistics, the observed day, far-field programs
  let stats = null, farTables = null, profTex = null, weather = null, farColor = null, farColorNear = null, farShadow = null, fcu = null, fcuNear = null, fsu = null;
  let hiMaxTex = null, hiBaseProg = null, hiDilateProg = null;
  let nearTex = null, bakeProg = null, bu = null, bake = null, baked = null;   // near field self-shadow cache
  const units = { volume: 0, families: 1, detail: 2, emptyDist: 3, occupancy: 4 };
  const ready = new Array(11).fill(false);
  let legacy = null;              // decompressed original cumulus, until uploaded
  let job = null;                 // generation in progress: {slab, g, z}
  let nextSlab = 1;
  const lineFrame = { C: null, E: null, U: null, N: null };
  const N_INST = TYPE_ORDER.length;
  const inst = new Float32Array(N_INST * 4), instB = new Float32Array(N_INST * 4);

  function program(fs) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, CW_FULLSCREEN_VS));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  const locs = (p, names) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
  function tex3D(w, h, d, data, filter, wrap) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, w, h, d, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, wrap);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
    return t;
  }

  // Pixel transfer state as CloudWorks expects it. three.js's async readbacks (the Lighting hub's
  // spacecraft probe) leave a PIXEL_PACK_BUFFER bound, which makes the empty-distance pass's
  // readPixels into an array fail; its uploads leave UNPACK_FLIP_Y / PREMULTIPLY_ALPHA set, which
  // WebGL 2 rejects for 3D textures.
  function unpackDefaults() {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  // line-up frame on the planet at (lat, lon): east, up, north (Groundview's z points south)
  function placeLineup(latDeg, lonDeg) {
    const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180;
    const U = [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
    const E = [Math.cos(lo), 0, -Math.sin(lo)];
    const N = [U[1] * E[2] - U[2] * E[1], U[2] * E[0] - U[0] * E[2], U[0] * E[1] - U[1] * E[0]];
    Object.assign(lineFrame, { C: U.map((x) => x * 6371), E, U, N, lat: latDeg, lon: lonDeg });
    // Groundview's line-up: one of each genus in a row, natural altitude band, size x genus scale
    const gap = Math.max(1500, size * 10);
    TYPE_ORDER.forEach((t, i) => {
      const P = TYPES[t], sc = size * P.scale, base = (P.alt[0] + P.alt[1]) * 0.5, off = (i - (N_INST - 1) / 2) * gap;
      inst.set([off, base - P.b * sc, 0, sc], i * 4);
      instB.set([P.density, TYPE_INDEX[t], P.b, 0], i * 4);
    });
  }

  // One step of atlas work per frame: a batch of genus layers, then that genus's occupancy grids.
  function stepGeneration() {
    if (legacy) {
      gl.activeTexture(gl.TEXTURE0 + units.volume);
      gl.bindTexture(gl.TEXTURE_3D, A.tex.volume);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, dims.W, dims.H, dims.D, gl.RED, gl.UNSIGNED_BYTE, legacy);
      legacy = null;
      cwBuildOccupancy(A, 0); cwBuildEmptyDist(A, 0); ready[0] = true;
      return;
    }
    if (!job && nextSlab < 11) { job = { slab: nextSlab, g: cwGenusSetup(shapeSeed, nextSlab), z: 0 }; nextSlab++; }
    if (!job) return;
    const z1 = Math.min(job.z + CW_LAYERS_PER_FRAME, dims.FD);
    cwGenusLayers(A, job.slab, job.g, job.z, z1);
    job.z = z1;
    if (job.z >= dims.FD) {
      cwBuildOccupancy(A, job.slab); cwBuildEmptyDist(A, job.slab);
      ready[job.slab] = true;
      if (provider.onProgress) provider.onProgress(provider.progress);
      job = null;
    }
  }

  const provider = {
    shadowMapSize: 1024,
    // the far field is drawn from ~5 km observations: 38 % resolution keeps it sharp for ~3 ms at 1440p
    renderScale: mode === 'planet' ? 0.38 : 0.5,
    temporal: mode === 'planet',   // the cloud slot accumulates frames (jittered rays, depth output)
    near: true,                    // Groundview's own light for the clouds near the camera (phase 4)
    cover,          // overall cover multiplier (1 = as observed)
    drawShadowMap: true,   // planet mode: write the shared cloud shadow map (diagnostics: false skips it)
    drawClouds: true,      // planet mode: draw the cloud image (diagnostics: false skips it)
    // diagnostics: set to the EXT_disjoint_timer_query_webgl2 extension to time each pass on the GPU;
    // gpuTimes then holds the latest results in ms ({ shadow, clouds })
    gpuTimer: null, gpuTimes: {},
    get progress() { return ready.slice(1).filter(Boolean).length / 10; },
    get readySlabs() { return ready.map((r, i) => (r ? i : -1)).filter((i) => i >= 0); },
    init(glCtx, lighting) {
      gl = glCtx; hub = lighting;
      // a re-attached provider starts over: its textures are new and empty
      ready.fill(false); job = null; nextSlab = 1; legacy = null;
      unpackDefaults();
      // CloudWorks' bake/cache sizes are not used yet (phase 4); the dims object only needs them named
      dims = { ...cwAtlasDims(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)), CX: 108, CY: 76, CZ: 24 };
      const S = dims.S;
      const tex = {
        volume: tex3D(dims.W, dims.H, dims.D, null, gl.LINEAR, gl.CLAMP_TO_EDGE),
        families: tex3D(dims.FW, dims.FH, dims.FD * dims.FAMILY_COUNT, null, gl.LINEAR, gl.CLAMP_TO_EDGE),
        detail: tex3D(64, 64, 64, Uint8Array.from(cwDetailNoise(), (v) => Math.round(v * 255)), gl.LINEAR, gl.REPEAT),
        occupancy: tex3D(32, 24, 24 * S, null, gl.NEAREST, gl.CLAMP_TO_EDGE),
        emptyDist: tex3D(32, 24, 24 * S, null, gl.NEAREST, gl.CLAMP_TO_EDGE),
      };
      const genP = program(cwGenGLSL(dims)), occP = program(cwOccGLSL(dims));
      A = {
        gl, dims, fbo: gl.createFramebuffer(), waitGPU: () => Promise.resolve(), tex, units,
        gen: { program: genP, u: locs(genP, ['detail', 'layer', 'baseY', 'lobeCount', 'seedOff', 'lc', 'lr', 'genCtl', 'morphology']) },
        occ: { program: occP, u: locs(occP, ['volume', 'families', 'layer', 'slab']) },
      };
      cwClearAtlas(A);
      lineupProg = program(cwLineupFS(cwCommonGLSL(dims), hub.glsl, N_INST));
      lu = locs(lineupProg, ['uRes', 'uInvProj', 'uCamWorld', 'uCamPos', 'uEyeL', 'uC', 'uE', 'uU', 'uN', 'inst', 'instB', 'count', 'densityK', 'volume', 'families', 'detail']);
      if (lineup) placeLineup(lineup.lat, lineup.lon);
      stats = null; farTables = null; measuring = null; profTex = null; hiMaxTex = null; bake = baked = null;
      if (mode === 'planet') {
        weather = cwWeatherSource(date);
        const common = cwCommonGLSL(dims);
        farColor = program(cwFarColorFS(common, hub.glsl, dims));
        farColorNear = program(cwFarColorFS(common, hub.glsl, dims, true));
        farShadow = program(cwFarShadowFS(common, hub.glsl, dims));
        const names = ['uCwCov', 'uCwProps', 'uCwTerrain', 'uCwProf', 'uCwGenus', 'uCwCover', 'uRes', 'uCwMidA', 'uCwMidB', 'uCwLodScale', 'families', 'detail', 'emptyDist', 'uCwHiMax', 'uCwShadow', 'uCwNearLf', 'uCwNearC', 'uCwNear'];
        const colorNames = [...names, 'uInvProj', 'uCamWorld', 'uCamPos', 'uPixAngle', 'uJitter', 'uFrame'];
        fcu = locs(farColor, colorNames); fcuNear = locs(farColorNear, colorNames);
        fsu = locs(farShadow, [...names, 'uShOrigin', 'uShRight', 'uShUp', 'uShDir', 'uShExtent']);
        hiBaseProg = program(cwHiMaxBaseFS(common, hub.glsl));
        bakeProg = program(cwBakeGLSL(dims));
        bu = locs(bakeProg, ['volume', 'families', 'lightLocal', 'layer', 'slab']);
        nearTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_3D, nearTex);
        gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R16F, dims.CX, dims.CY, dims.CZ * 10 * CW_ORIENTS);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
        hiDilateProg = program(cwHiMaxDilateFS);
      }
      // the original cumulus (slab 0), when served: data/cloudworks/legacy-cumulus.gz (node build.js)
      if (legacyCumulus && location.protocol.startsWith('http')) {
        fetch('data/cloudworks/legacy-cumulus.gz')
          .then((r) => (r.ok ? r.body.pipeThrough(new DecompressionStream('gzip')) : Promise.reject(new Error(r.status))))
          .then((s) => new Response(s).arrayBuffer())
          .then((b) => { if (b.byteLength === dims.W * dims.H * dims.D) legacy = new Uint8Array(b); else console.warn('CloudWorks: legacy cumulus volume has the wrong size'); })
          .catch((e) => console.warn('CloudWorks: legacy cumulus volume unavailable:', e));
      }
    },
    // FNV-1a hash and occupied-voxel count of the generated genera, read back from the GPU, to
    // check that this atlas is byte-identical to Groundview's for the same shape seed. Debug only:
    // call between frames, then renderer.resetState().
    // perGenus: also the occupied-voxel count of each genus, in TYPE_ORDER.
    atlasChecksum(perGenus = false) {
      if (!A) return null;
      const { FW, FH, FD, FAMILY_COUNT } = dims, plane = new Uint8Array(FW * FH * 4), counts = new Array(FAMILY_COUNT).fill(0), layers = [];
      let x = 2166136261, n = 0;
      unpackDefaults();
      gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
      for (let z = 0; z < FD * FAMILY_COUNT; z++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, A.tex.families, 0, z);
        gl.readPixels(0, 0, FW, FH, gl.RGBA, gl.UNSIGNED_BYTE, plane);
        let ln = 0;
        for (let i = 0; i < plane.length; i += 4) { x = Math.imul(x ^ plane[i], 16777619); if (plane[i]) { n++; ln++; counts[Math.floor(z / FD)]++; } }
        layers.push(ln);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const sum = `${(x >>> 0).toString(16)}/${n}`;
      return perGenus ? { sum, counts, layers } : sum;
    },
    // Puts the line-up at a place (degrees); by default it goes where the camera first looks.
    lineupAt(latDeg, lonDeg) { placeLineup(latDeg, lonDeg); },
    get lineup() { return lineFrame.C ? { lat: lineFrame.lat, lon: lineFrame.lon } : null; },
    // per-genus statistics (after generation), or null
    get stats() { return stats; },
    get weatherReady() { return !!(weather && weather.ready); },
    render(f) {
      gl.bindVertexArray(null);
      unpackDefaults();
      stepGeneration();
      if (mode === 'planet') renderPlanet(f); else renderLineup(f);
    },
    dispose() {
      if (!gl) return;
      for (const t of Object.values(A.tex)) gl.deleteTexture(t);
      gl.deleteFramebuffer(A.fbo);
      for (const p of [A.gen.program, A.occ.program, lineupProg, farColor, farColorNear, farShadow, hiBaseProg, hiDilateProg, bakeProg]) if (p) gl.deleteProgram(p);
      if (profTex) gl.deleteTexture(profTex);
      if (nearTex) gl.deleteTexture(nearTex);
      if (hiMaxTex) gl.deleteTexture(hiMaxTex);
      if (weather) for (const t of Object.values(weather.tex)) gl.deleteTexture(t);
    },
  };

  function renderLineup(f) {
      if (!lineFrame.C) {
        const c = f.camera, P = c.position, m = c.cameraWorld, d = [-m[8], -m[9], -m[10]];
        const b = P[0] * d[0] + P[1] * d[1] + P[2] * d[2], cc = P[0] ** 2 + P[1] ** 2 + P[2] ** 2 - 6371 ** 2, h = b * b - cc;
        const t = h > 0 && -b - Math.sqrt(h) > 0 ? -b - Math.sqrt(h) : 0;
        const q = [P[0] + d[0] * t, P[1] + d[1] * t, P[2] + d[2] * t], ql = Math.hypot(...q);
        placeLineup(Math.asin(q[1] / ql) * 180 / Math.PI, Math.atan2(q[0], q[2]) * 180 / Math.PI);
      }
      // only genera whose volumes are finished
      const count = TYPE_ORDER.filter((t) => ready[TYPE_INDEX[t]]).length;
      if (!count) return;
      const live = new Float32Array(N_INST * 4), liveB = new Float32Array(N_INST * 4);
      let k = 0;
      TYPE_ORDER.forEach((t, i) => { if (ready[TYPE_INDEX[t]]) { live.set(inst.subarray(i * 4, i * 4 + 4), k * 4); liveB.set(instB.subarray(i * 4, i * 4 + 4), k * 4); k++; } });

      // camera in the line-up frame (metres), computed in double precision
      const { C, E, U, N } = lineFrame, cp = f.camera.position;
      const dx = cp[0] - C[0], dy = cp[1] - C[1], dz = cp[2] - C[2];
      const eye = [(dx * E[0] + dy * E[1] + dz * E[2]) * 1000, (dx * U[0] + dy * U[1] + dz * U[2]) * 1000, -(dx * N[0] + dy * N[1] + dz * N[2]) * 1000];

      gl.bindFramebuffer(gl.FRAMEBUFFER, f.color.framebuffer);
      gl.viewport(0, 0, f.color.width, f.color.height);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
      gl.useProgram(lineupProg);
      let unit = hub.bind(gl, lineupProg, 5);
      for (const [name, t] of [['volume', A.tex.volume], ['families', A.tex.families], ['detail', A.tex.detail]]) {
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_3D, t); gl.uniform1i(lu[name], unit++);
      }
      gl.uniform2f(lu.uRes, f.color.width, f.color.height);
      gl.uniformMatrix4fv(lu.uInvProj, false, f.camera.invProjection);
      gl.uniformMatrix4fv(lu.uCamWorld, false, f.camera.cameraWorld);
      gl.uniform3fv(lu.uCamPos, f.camera.position);
      gl.uniform3fv(lu.uEyeL, eye);
      gl.uniform3fv(lu.uC, C); gl.uniform3fv(lu.uE, E); gl.uniform3fv(lu.uU, U); gl.uniform3fv(lu.uN, N);
      gl.uniform4fv(lu.inst, live); gl.uniform4fv(lu.instB, liveB);
      gl.uniform1f(lu.count, count); gl.uniform1f(lu.densityK, density);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Measures every genus from the finished atlas: two small GPU reductions per genus, one genus per
  // frame, read back asynchronously (pixel-pack buffers + fences) and turned into statistics once
  // all ten have arrived. (All twenty reductions in one frame, read back synchronously, made Chrome
  // fail the next planet draw.)
  let measuring = null;
  function stepMeasuring() {
    if (!measuring) {
      const common = cwCommonGLSL(dims);
      const tex = gl.createTexture(), fbo = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, Math.max(dims.FW, dims.FH), dims.FD, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      measuring = { colP: program(cwStatsColumnFS(common, dims)), levP: program(cwStatsLevelFS(common, dims)), tex, fbo, next: 0, reads: [] };
      return null;
    }
    const M = measuring, H = dims.FD;
    if (M.next < TYPE_ORDER.length) {
      // this frame's genus: column and row sums into pixel-pack buffers
      const t = TYPE_ORDER[M.next++];
      gl.bindFramebuffer(gl.FRAMEBUFFER, M.fbo);
      gl.activeTexture(gl.TEXTURE0 + units.families); gl.bindTexture(gl.TEXTURE_3D, A.tex.families);
      for (const [prog, w] of [[M.colP, dims.FW], [M.levP, dims.FH]]) {
        gl.viewport(0, 0, w, H);
        gl.useProgram(prog);
        gl.uniform1i(gl.getUniformLocation(prog, 'families'), units.families);
        gl.uniform1f(gl.getUniformLocation(prog, 'uSlab'), TYPE_INDEX[t]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, w * H * 16, gl.STREAM_READ);
        gl.readPixels(0, 0, w, H, gl.RGBA, gl.FLOAT, 0);
        M.reads.push({ t, w, buf });
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (M.next === TYPE_ORDER.length) { M.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); }
      return null;
    }
    if (gl.getSyncParameter(M.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return null;
    gl.deleteSync(M.fence);
    const sums = {};
    for (const r of M.reads) {
      const raw = new Float32Array(r.w * H * 4), out = new Float32Array(r.w * H);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, r.buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, raw);
      gl.deleteBuffer(r.buf);
      for (let i = 0; i < out.length; i++) out[i] = raw[i * 4];
      (sums[r.t] = sums[r.t] || []).push(out);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteFramebuffer(M.fbo); gl.deleteTexture(M.tex);
    gl.deleteProgram(M.colP); gl.deleteProgram(M.levP);
    measuring = null;
    const detailMean = cwDetailMean(cwDetailNoise());
    const result = TYPE_ORDER.map((t) => cwGenusStats(t, sums[t][0], cwLevelsFromRows(sums[t][1], dims), dims, size, detailMean));
    result.detailMean = detailMean;
    return result;
  }

  const pendingTimes = [];
  function timed(name, fn) {
    const ext = provider.gpuTimer;
    if (!ext) { fn(); return; }
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q); fn(); gl.endQuery(ext.TIME_ELAPSED_EXT);
    pendingTimes.push({ name, q });
  }
  function collectTimes() {
    while (pendingTimes.length && gl.getQueryParameter(pendingTimes[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { name, q } = pendingTimes.shift();
      provider.gpuTimes[name] = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
    }
  }

  // the highest cloud top around each place (cwHiMaxBaseFS), once the day is loaded
  function buildHiMax(bindFar) {
    const mkTex = (levels) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.R16F, CW_HIMAX_W, CW_HIMAX_H);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    const base = mkTex(1), fbo = gl.createFramebuffer();
    hiMaxTex = mkTex(CW_HIMAX_LEVELS);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, base, 0);
    gl.viewport(0, 0, CW_HIMAX_W, CW_HIMAX_H);
    bindFar(hiBaseProg, locs(hiBaseProg, ['uCwCov', 'uCwProps', 'uCwTerrain', 'uCwProf', 'uCwGenus', 'uCwCover', 'uCwMidA', 'uCwMidB']), CW_HIMAX_W, CW_HIMAX_H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(hiDilateProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, base);
    gl.uniform1i(gl.getUniformLocation(hiDilateProg, 'uBase'), 0);
    for (let l = 0; l < CW_HIMAX_LEVELS; l++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hiMaxTex, l);
      gl.viewport(0, 0, CW_HIMAX_W >> l, CW_HIMAX_H >> l);
      gl.uniform1i(gl.getUniformLocation(hiDilateProg, 'uLevel'), l);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo); gl.deleteTexture(base);
  }

  // CloudWorks' far self-shadow cache for the sun around the camera, a few hundred layers per frame;
  // a new bake starts when the sun has moved ~0.5 degrees in that frame, or the camera's face changed
  function stepNearBake(f) {
    const c = f.camera.position, l = Math.hypot(c[0], c[1], c[2]);
    if (l - 6371 > CW_NEAR_KM + 16.5) return;   // no cloud is near (orbit)
    const want = cwNearFrame([c[0] / l, c[1] / l, c[2] / l], [f.sunDir[0], f.sunDir[1], f.sunDir[2]]);
    const ref = bake || baked;
    if (!ref || ref.face !== want.face || Math.hypot(...ref.Lf.map((v, i) => v - want.Lf[i])) > 0.01) bake = { ...want, next: 0 };
    if (!bake) return;
    const CZ = dims.CZ, total = CZ * 10 * CW_ORIENTS, end = Math.min(bake.next + CW_BAKE_LAYERS_PER_FRAME, total);
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
    gl.viewport(0, 0, dims.CX, dims.CY);
    gl.useProgram(bakeProg); gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, A.tex.volume); gl.uniform1i(bu.volume, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, A.tex.families); gl.uniform1i(bu.families, 1);
    let combo = -1;
    for (let i = bake.next; i < end; i++) {
      const cmb = Math.floor(i / CZ), z = i % CZ;
      if (cmb !== combo) {
        combo = cmb;
        gl.uniform1f(bu.slab, Math.floor(cmb / CW_ORIENTS) + 1);
        gl.uniform3fv(bu.lightLocal, cwToLocalJS(bake.Lf, cmb % CW_ORIENTS));
      }
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, nearTex, 0, i);
      gl.uniform1f(bu.layer, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    bake.next = end;
    if (end >= total) { baked = { face: bake.face, Lf: bake.Lf }; bake = null; }
  }

  function renderPlanet(f) {
    collectTimes();
    if (!stats) {
      if (provider.progress < 1) return;
      stats = stepMeasuring();
      return;
    }
    if (!profTex) {
      // the mid field samples the atlas at a level of detail: mipmaps for it and the detail noise
      // (Groundview has none; the line-up mode keeps it without)
      for (const t of [A.tex.families, A.tex.detail]) {
        gl.bindTexture(gl.TEXTURE_3D, t);
        gl.generateMipmap(gl.TEXTURE_3D);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      }
      farTables = cwFarTables(stats);
      profTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, profTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, CW_PROFILE_BINS, TYPE_ORDER.length, 0, gl.RED, gl.FLOAT, farTables.prof);
      // R32F is not filterable everywhere; the profile is sampled at bin centres anyway
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return;
    }
    if (!weather.ready && !weather.upload(gl)) return;
    const bindFar = (prog, u, w, h) => {
      gl.useProgram(prog);
      let unit = hub.bind(gl, prog, 0);
      for (const [name, t] of [['uCwCov', weather.tex['coverage.webp']], ['uCwProps', weather.tex['properties.png']], ['uCwTerrain', weather.tex['terrain.png']], ['uCwProf', profTex], ['uCwHiMax', hiMaxTex]]) {
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u[name], unit++);
      }
      gl.uniform4fv(u.uCwGenus, farTables.genus);
      gl.uniform4fv(u.uCwMidA, farTables.midA);
      gl.uniform4fv(u.uCwMidB, farTables.midB);
      gl.uniform1f(u.uCwLodScale, f.scale);
      for (const [name, t] of [['families', A.tex.families], ['detail', A.tex.detail], ['emptyDist', A.tex.emptyDist], ['uCwShadow', nearTex]]) {
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_3D, t); gl.uniform1i(u[name], unit++);
      }
      gl.uniform4f(u.uCwNear, baked ? baked.face : 0, CW_NEAR_KM, baked && provider.near ? 1 : 0, 0);
      gl.uniform3fv(u.uCwNearC, f.camera.position);
      if (baked) gl.uniform3fv(u.uCwNearLf, baked.Lf);
      gl.uniform1f(u.uCwCover, provider.cover);
      gl.uniform2f(u.uRes, w, h);
    };
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    if (!hiMaxTex) { buildHiMax(bindFar); return; }
    stepNearBake(f);
    gl.disable(gl.BLEND);

    // 1. the shared cloud shadow map (ground, sea, haze, spacecraft, and the clouds' own shadows)
    const sh = f.shadow;
    if (provider.drawShadowMap) timed('shadow', () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, sh.framebuffer);
    gl.viewport(0, 0, sh.size, sh.size);
    bindFar(farShadow, fsu, sh.size, sh.size);
    gl.uniform3fv(fsu.uShOrigin, sh.origin); gl.uniform3fv(fsu.uShRight, sh.right);
    gl.uniform3fv(fsu.uShUp, sh.up); gl.uniform3fv(fsu.uShDir, sh.dir);
    gl.uniform1f(fsu.uShExtent, sh.extent);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    if (provider.drawClouds) {
    // 2. the clouds, lit with that map
    timed('clouds', () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.color.framebuffer);
    gl.viewport(0, 0, f.color.width, f.color.height);
    // the near field's light only where clouds can be near the camera
    const c = f.camera.position, near = provider.near && baked && Math.hypot(c[0], c[1], c[2]) - 6371 < CW_NEAR_KM + 16.5;
    const prog = near ? farColorNear : farColor, u = near ? fcuNear : fcu;
    bindFar(prog, u, f.color.width, f.color.height);
    gl.uniformMatrix4fv(u.uInvProj, false, f.camera.invProjection);
    gl.uniformMatrix4fv(u.uCamWorld, false, f.camera.cameraWorld);
    gl.uniform3fv(u.uCamPos, f.camera.position);
    gl.uniform1f(u.uPixAngle, f.camera.pixelAngle);
    gl.uniform2f(u.uJitter, f.temporal ? f.jitter[0] : 0, f.temporal ? f.jitter[1] : 0);
    gl.uniform1f(u.uFrame, f.temporal ? f.frameIndex % 64 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    }
  }
  return provider;
}
