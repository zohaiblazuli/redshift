import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { catalystPackUrl, catalystTextureLayout, catalystLut, catalystLens, flare10Constants, flare10Angles, flare10Elements } from './flare10.js';

// ---------------------------------------------------------------------------------------------
// Camera model: auto-exposure (eye adaptation) and an optical lens-flare system.
// Everything runs on the GPU; nothing is read back to the CPU.
// ---------------------------------------------------------------------------------------------

const quadVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const lum = 'float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }';

// ---- Auto exposure ---------------------------------------------------------------------------
// Centre-weighted log-average luminance of the HDR frame (64x64 samples, reduced 64->16->4->1),
// adapted over time like a camera's metering (fast towards darker, slower towards brighter, as an
// eye does), then applied as a multiplier before bloom and tonemapping.
export class AutoExposurePass extends Pass {
  constructor() {
    super();
    const rt = (n) => new THREE.WebGLRenderTarget(n, n, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.lum64 = rt(64); this.lum16 = rt(16); this.lum4 = rt(4); this.lum1 = rt(1);
    this.adapt = [rt(1), rt(1)];
    this.ping = 0;
    this.enabled = true;
    this.auto = true;
    this.base = 0.5;          // exposure for the reference scene luminance
    this.refLum = 0.4;        // log-average HDR luminance of the default Shield Cam view (base exposure)
    this.compEV = 0;          // user exposure compensation
    this.biasEV = 0;          // camera-model bias (e.g. the action cam's brighter metering)
    this.curveGain = 1;       // the tone curve's own input gain is missing (three's ACES has x 1/0.6)
    this.flatMetering = false; // whole-frame average including black space (action cam)
    this.minEV = -1.5; this.maxEV = 2.5;
    this.dt = 0.016;
    this.reset = true;

    this.measure = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uFlat: { value: 0 } },
      vertexShader: quadVert,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; uniform float uFlat; varying vec2 vUv; ${lum}
        void main(){
          vec2 o = vec2(0.25 / 64.0);
          float l = 0.25 * (luma(texture2D(tSrc, vUv + o).rgb) + luma(texture2D(tSrc, vUv - o).rgb)
                          + luma(texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb) + luma(texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb));
          vec2 c = vUv - 0.5;
          float w = mix(exp(-dot(c, c) * 6.0), 1.0, uFlat);   // centre-weighted (or flat) metering
          // ignore black space (unless metering flat) and the sun disc itself
          float valid = max(step(1e-4, l), uFlat) * step(l, 60.0);
          l = max(l, 0.02);                              // flat metering: black counts as deep shadow
          gl_FragColor = vec4(log(max(l, 1e-4)) * w * valid, w * valid, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    }));
    this.reduce = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: 0 } },
      vertexShader: quadVert,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; uniform float uTexel; varying vec2 vUv;
        void main(){
          vec2 s = vec2(0.0);
          for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++)
            s += texture2D(tSrc, vUv + (vec2(float(x), float(y)) - 1.5) * uTexel).rg;
          gl_FragColor = vec4(s, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    }));
    this.adaptQ = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tCur: { value: null }, tPrev: { value: null }, uDt: { value: 0 }, uReset: { value: 1 } },
      vertexShader: quadVert,
      fragmentShader: /* glsl */ `
        uniform sampler2D tCur, tPrev; uniform float uDt, uReset; varying vec2 vUv;
        void main(){
          vec2 c = texture2D(tCur, vec2(0.5)).rg;
          float cur = c.y > 1e-3 ? c.x / c.y : log(0.06);
          float prev = texture2D(tPrev, vec2(0.5)).r;
          float speed = cur > prev ? 2.2 : 1.1;
          float a = uReset > 0.5 ? 1.0 : 1.0 - exp(-uDt * speed);
          gl_FragColor = vec4(mix(prev, cur, a), 0.0, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    }));
    this.apply = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tAdapt: { value: null }, uBase: { value: 0.5 }, uRef: { value: 0.06 },
        uComp: { value: 0 }, uMin: { value: -1.5 }, uMax: { value: 2.5 }, uAuto: { value: 1 },
      },
      vertexShader: quadVert,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse, tAdapt; uniform float uBase, uRef, uComp, uMin, uMax, uAuto; varying vec2 vUv;
        void main(){
          // compensate 75 % of the difference, as a camera's metering bias does: dim scenes stay a little dim
          float ev = uAuto > 0.5 ? clamp(0.75 * (log2(uRef) - texture2D(tAdapt, vec2(0.5)).r / log(2.0)), uMin, uMax) : 0.0;
          gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb * uBase * exp2(ev + uComp), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    }));
  }

  get adapted() { return this.adapt[this.ping].texture; }

  render(renderer, writeBuffer, readBuffer) {
    if (this.auto) {
      this.measure.material.uniforms.tSrc.value = readBuffer.texture;
      this.measure.material.uniforms.uFlat.value = this.flatMetering ? 1 : 0;
      renderer.setRenderTarget(this.lum64); this.measure.render(renderer);
      const steps = [[this.lum64, this.lum16], [this.lum16, this.lum4], [this.lum4, this.lum1]];
      for (const [src, dst] of steps) {
        this.reduce.material.uniforms.tSrc.value = src.texture;
        this.reduce.material.uniforms.uTexel.value = 1 / src.width;
        renderer.setRenderTarget(dst); this.reduce.render(renderer);
      }
      const prev = this.adapt[this.ping], next = this.adapt[1 - this.ping];
      const u = this.adaptQ.material.uniforms;
      u.tCur.value = this.lum1.texture; u.tPrev.value = prev.texture; u.uDt.value = this.dt; u.uReset.value = this.reset ? 1 : 0;
      renderer.setRenderTarget(next); this.adaptQ.render(renderer);
      this.ping = 1 - this.ping;
      this.reset = false;
    }
    const a = this.apply.material.uniforms;
    a.tDiffuse.value = readBuffer.texture; a.tAdapt.value = this.adapted;
    a.uBase.value = this.base * this.curveGain; a.uRef.value = this.refLum; a.uComp.value = this.compEV + this.biasEV;
    a.uMin.value = this.minEV; a.uMax.value = this.maxEV; a.uAuto.value = this.auto ? 1 : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.apply.render(renderer);
  }
}

export async function loadCatalystLighting() {
  const response = await fetch(catalystPackUrl);
  if (!response.ok || !response.body) throw new Error('Catalyst lighting pack unavailable');
  const bytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  let offset = 0;
  const texture = (w, h) => {
    const data = new Uint16Array(bytes, offset, w * h * 4);
    offset += data.byteLength;
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  };
  const textures = Object.fromEntries(Object.entries(catalystTextureLayout).map(([key, [w, h]]) => [key, texture(w, h)]));
  textures.uCore.wrapS = THREE.MirroredRepeatWrapping;
  textures.uNoise.wrapS = textures.uHalo.wrapS = THREE.RepeatWrapping;
  textures.uNoise.minFilter = textures.uNoise.magFilter = THREE.NearestFilter;
  textures.uRainbow.wrapS = textures.uRainbow.wrapT = THREE.RepeatWrapping;
  textures.uMask.wrapS = textures.uMask.wrapT = THREE.RepeatWrapping;
  const toneLut = texture(catalystLut.size * catalystLut.columns, catalystLut.size * catalystLut.rows);
  const dirt = texture(...catalystLens.dirtSize);
  return { textures, toneLut, dirt };
}

// ---- Catalyst sun flare -------------------------------------------------------------------------
// Mirror's Edge Catalyst's SunFlareComponent, rebuilt from the Flare10 capture: five sprites at the
// sun (or along the line through the screen centre), each the game's own pixel shader on the game's
// own textures (Catalyst2Roblox tools/flare_match.py e1_model, tools/flare_live.py e2..e5):
//  e1 core   polar rays (gradient_col_06_clean, red->green by intensity) x polar streak noise
//            x a screen-space soft box mask x cb0 colour, spun by the captured angle table
//  e2 halo   chromatic glow ramp (polar), radial
//  e3 red    bokeh ghost (T_BokehFlare) at ray 0.62
//  e4 green  bump ring ghost (t_circlebump_01) at ray 0.75
//  e5 yellow polar rainbow through a circular lookup, iris-disc shaped, at ray 1.5
// Placement: centre = sun + ray * (-2 sun) in NDC; side (fraction of screen width) and intensity
// are the VE's cubic curves over t = |sun NDC| and over the occluded fraction o. The game measures
// o with an occlusion quad; here it is the share of the sun's disc that is not lit (spacecraft,
// planet, atmosphere), measured on the exposed frame before bloom. Light is added in exposed HDR,
// before the tone curve, with the capture's flare-time exposure, as the game does.
const FLARE_C3 = [4.953847, 1.927529, 1.516838];
const FLARE_C4 = [0.347478, 0.737911, 0.359216];

class SunVisibilityPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uR: { value: 0.01 }, uAspect: { value: 1 } },
      vertexShader: quadVert,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; uniform vec2 uSun; uniform float uR, uAspect; varying vec2 vUv; ${lum}
        float lit(vec2 uv){
          // off screen counts as occluded, as the game's clipped occlusion quad does
          float on = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
          return on * smoothstep(2.0, 10.0, luma(texture2D(tSrc, uv).rgb));
        }
        void main(){
          float v = lit(uSun);
          for (int i = 0; i < 12; i++){
            float a = float(i) * 0.523599;
            v += lit(uSun + vec2(cos(a) / uAspect, sin(a)) * uR * 0.6);
          }
          gl_FragColor = vec4(1.0 - v / 13.0, 0.0, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    }));
  }

  render(renderer, writeBuffer, readBuffer) {
    this.quad.material.uniforms.tSrc.value = readBuffer.texture;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }

  dispose() { this.target.dispose(); this.quad.material.dispose(); this.quad.dispose(); }
}

const flareVert = /* glsl */ `
  uniform sampler2D tVis;
  uniform vec2 uSun;
  uniform float uT, uAspect, uRay, uSize, uAngle;
  uniform vec4 uPosSize, uPosAlpha, uOccSize, uOccAlpha;
  varying vec2 vUv;
  varying float vI;
  float cubic(vec4 c, float t){ return clamp(((c.x * t + c.y) * t + c.z) * t + c.w, 0.0, 1.0); }
  void main(){
    float o = texture2D(tVis, vec2(0.5)).r;
    vI = cubic(uPosAlpha, uT) * cubic(uOccAlpha, o);
    float side = uSize * cubic(uPosSize, uT) * cubic(uOccSize, o);
    vec2 centre = uSun - 2.0 * uRay * uSun;
    // D3D sprite UV: u along the angle, v = u turned -90 deg (down on screen at angle 0)
    vUv = vec2(uv.x, 1.0 - uv.y);
    float c = cos(uAngle), s = sin(uAngle);
    vec2 U = 2.0 * side * vec2(c, s * uAspect), V = 2.0 * side * vec2(s, -c * uAspect);
    vec2 p = centre + (vUv.x - 0.5) * U + (vUv.y - 0.5) * V;
    gl_Position = vI > 0.0 && side > 0.0 ? vec4(p, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  }`;

const flareCommon = /* glsl */ `
  uniform float uExp, uT, uNeutral, uRays, uGhost;
  uniform vec3 uCol0, uCol5;
  // the game's sun sits on a bright blue sky, which cancels the core rays' warm cast; over black
  // space they read orange. Sunlight is white: the rays keep their luminance, lose most of their tint.
  vec3 neutral(vec3 c){ return mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), uNeutral); }
  uniform vec2 uRes;
  varying vec2 vUv;
  varying float vI;
  // the flare PS's own atan expansion (e1/e2 disassembly): (angle in radians, radius)
  vec2 shaderAngle(vec2 uv){
    float x = 2.0 * uv.x - 1.0, y = 2.0 * uv.y - 1.0;
    float mx = max(abs(y), abs(x)), mn = min(abs(y), abs(x));
    float z = mn / (mx == 0.0 ? 1.0 : mx);
    float w = z * z;
    float p = (((0.020835 * w - 0.085133) * w + 0.180141) * w - 0.330299) * w + 0.999866;
    float r1 = abs(y) < abs(x) ? p * z * -2.0 + 1.570796 : 0.0;
    float a = z * p + r1;
    a += y < -y ? -3.1415927 : 0.0;
    bool neg = min(y, x) < -min(y, x) && max(y, x) >= -max(y, x);
    return vec2(neg ? -a : a, sqrt(x * x + y * y));
  }`;

const flareFrag = {
  core: /* glsl */ `
    uniform sampler2D uCore, uNoise, uMask;
    void main(){
      vec2 ar = shaderAngle(vUv);
      vec4 a = texture2D(uCore, ar);                       // MIRROR U / CLAMP V
      float base = a.r + vI * (a.g - a.r);
      vec3 r = texture2D(uNoise, ar * 2.0 + vI).rgb;       // point, WRAP U / CLAMP V
      r += 0.76 * vec3(0.0, r.r - r.g, r.r - r.b);
      vec3 col = base * (1.0 + 0.565 * (r - 1.0));
      vec2 sc = gl_FragCoord.xy / uRes;
      col *= clamp(texture2D(uMask, vec2(sc.x, 1.0 - sc.y) * 0.833333).rgb, 0.05, 1.0);
      gl_FragColor = vec4(neutral(col * uCol0 * vI * vec3(uExp, uExp * 0.719672, uExp * 0.323143)) * uRays, 1.0);
    }`,
  halo: /* glsl */ `
    uniform sampler2D uHalo;
    void main(){
      vec2 ar = shaderAngle(vUv);
      // the blue halo: its own ramp colours (white-blue core, orange ring, blue tail), not neutralised
      gl_FragColor = vec4(texture2D(uHalo, vec2(ar.x * 0.159155 + 0.5, ar.y)).rgb * uCol0 * vI * uExp, 1.0);
    }`,
  red: /* glsl */ `
    uniform sampler2D uRed;
    void main(){ gl_FragColor = vec4(uGhost * texture2D(uRed, vUv).r * vec3(${FLARE_C3.join(', ')}) * vI * uExp, 1.0); }`,
  green: /* glsl */ `
    uniform sampler2D uGreen;
    void main(){ gl_FragColor = vec4(uGhost * texture2D(uGreen, vUv).r * vec3(${FLARE_C4.join(', ')}) * vI * uExp, 1.0); }`,
  yellow: /* glsl */ `
    uniform sampler2D uLookup, uRainbow, uIris;
    void main(){
      vec2 off = texture2D(uLookup, vUv).xy + (uT + 1.0);
      vec3 c = texture2D(uRainbow, off).rgb * uCol5 * texture2D(uIris, vUv).rgb;
      gl_FragColor = vec4(c * vI * uExp, 1.0);
    }`,
};

export class SunFlarePass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.strength = 1;
    this.visPass = new SunVisibilityPass();
    this.ready = false;
    this.on = false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    const k = flare10Constants;
    this.shared = {
      tVis: { value: this.visPass.target.texture }, uSun: { value: new THREE.Vector2() }, uT: { value: 0 },
      uAspect: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) },
      uExp: { value: k.flareExposure }, uCol0: { value: new THREE.Vector3(...k.cb0Colour) },
      uCol5: { value: new THREE.Vector3(...k.e5Colour) },
      uNeutral: { value: 0.85 },   // core rays: 0 = the game's warm tint, 1 = pure white
      uGhost: { value: 2.5 },      // red/green ghosts: over black space the game's level is barely visible
      uRays: { value: 0.6 },       // e1 ray strength against the game's (rays read stronger over black)
    };
    const names = ['core', 'halo', 'red', 'green', 'yellow'];
    this.elements = flare10Elements.map((e, i) => {
      const uniforms = {
        ...this.shared,
        uRay: { value: e.ray }, uSize: { value: e.size }, uAngle: { value: 0 },
        uPosSize: { value: new THREE.Vector4(...e.pos.size) }, uPosAlpha: { value: new THREE.Vector4(...e.pos.alpha) },
        uOccSize: { value: new THREE.Vector4(...e.occ.size) }, uOccAlpha: { value: new THREE.Vector4(...e.occ.alpha) },
        uCore: { value: null }, uNoise: { value: null }, uMask: { value: null }, uHalo: { value: null },
        uRed: { value: null }, uGreen: { value: null }, uLookup: { value: null }, uRainbow: { value: null }, uIris: { value: null },
      };
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
        uniforms, vertexShader: flareVert, fragmentShader: flareCommon + flareFrag[names[i]],
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        depthTest: false, depthWrite: false, transparent: true,
      }));
      mesh.frustumCulled = false;
      mesh.renderOrder = i;
      this.scene.add(mesh);
      return uniforms;
    });
  }

  setTextures(textures) {
    for (const u of this.elements) for (const name of Object.keys(textures)) if (u[name]) u[name].value = textures[name];
    this.ready = true;
  }

  // e1's spin over the sun position: inverse-distance blend of the three nearest captured angles
  coreAngle(x, y) {
    const near = flare10Angles.map(([sx, sy, a]) => [Math.hypot(x - sx, y - sy), a]).sort((p, q) => p[0] - q[0]).slice(0, 3);
    const ref = near[0][1];
    let sw = 0, sa = 0;
    for (const [d, a] of near) {
      const w = 1 / Math.max(d, 1e-4);
      sw += w; sa += w * ((((a - ref + 180) % 360) + 360) % 360 - 180 + ref);
    }
    return sa / sw;
  }

  update(camera, sunWorldDir, width, height) {
    this.on = false;
    this.visPass.enabled = false;
    if (!this.enabled || !this.ready || this.strength <= 0 || !camera || !sunWorldDir) return;
    const p = (this._p ||= new THREE.Vector3()).copy(sunWorldDir).transformDirection(camera.matrixWorldInverse);
    if (p.z >= 0) return;
    p.applyMatrix4(camera.projectionMatrix);
    if (Math.abs(p.x) > 1.2 || Math.abs(p.y) > 1.2) return;
    const s = this.shared;
    s.uSun.value.set(p.x, p.y);
    s.uT.value = Math.hypot(p.x, p.y);
    s.uAspect.value = camera.aspect;
    s.uRes.value.set(width, height);
    s.uExp.value = flare10Constants.flareExposure * this.strength;
    // e1's angle is in pixel space with y down (D3D); ours has y up
    this.elements[0].uAngle.value = -THREE.MathUtils.degToRad(this.coreAngle(p.x, p.y));
    const v = this.visPass.quad.material.uniforms;
    v.uSun.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    v.uR.value = Math.tan(THREE.MathUtils.degToRad(0.265)) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.5;
    v.uAspect.value = camera.aspect;
    this.visPass.enabled = true;
    this.on = true;
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.on) return;
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = ac;
  }

  dispose() {
    this.visPass.dispose();
    this.scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
}

// LensReflection_reflection_planes=2, PS 13287991 and VS 268699 in systems/shaderprogramdb.
// cbuffer 0 from the 1536x864 gameplay capture, draw 2 (3b954c39e677af237105abbd2361ba6f).
const catalystReflectionPlanes = [
  {
    outer: [0.24424642324447632, 0.0422409363090992, 0.08463117480278015, 1.2722645998001099],
    inner: [0.019327910616993904, 0.04370185732841492, 0.06793727725744247, -0.27226462960243225],
    input: [1.3393832445144653, 1.9324736595153809, -0.7071067690849304, 0.3319999873638153],
    maxOpacity: 0.2726089358329773,
  },
  {
    outer: [0.03605107590556145, 0.1333300769329071, 0.38087448477745056, 2.2271714210510254],
    inner: [0.015285934321582317, 0.04161897301673889, 0.07289020717144012, -1.2271714210510254],
    input: [1.3393832445144653, 1.6369552612304688, -0.2357022613286972, 0.4819999933242798],
    maxOpacity: 0.23630449175834656,
  },
];

export class CatalystLensReflectionPass extends Pass {
  constructor(bloom) {
    super();
    this.bloom = bloom;
    this.uniforms = {
      tScene: { value: null }, tBloom: { value: null }, uBloomSize: { value: new THREE.Vector2() },
    };
    const vec4 = (values) => `vec4(${values.join(', ')})`;
    const planes = catalystReflectionPlanes.map(({ outer, inner, input, maxOpacity }) =>
      `plane(d, r, ${vec4(outer)}, ${vec4(inner)}, ${vec4(input)}, ${maxOpacity})`).join(' + ');
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: quadVert,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tScene, tBloom;
        uniform vec2 uBloomSize;
        ${lum}

        // Emulate the capture's D3D linear sampler with a black border.
        vec3 bloomAt(vec2 uv){
          vec2 border = clamp(min(uv, 1.0 - uv) * uBloomSize + 0.5, 0.0, 1.0);
          return texture2D(tBloom, uv).rgb * border.x * border.y;
        }
        vec3 plane(vec2 d, float r, vec4 outer, vec4 inner, vec4 inputParams, float opacity){
          vec2 direction = r > 0.0 ? d / r : vec2(0.0);
          float radius = r + inputParams.w * (r * r - r);
          // The D3D sample flips Y for its top-origin texture coordinates.
          vec3 light = bloomAt(vec2(0.5) + direction * radius * inputParams.z);
          float intensity = min(pow(max(luma(light), 0.0) * inputParams.x, inputParams.y), 1.0) * opacity;
          return mix(inner.rgb, outer.rgb, clamp(r * outer.a + inner.a, 0.0, 1.0)) * intensity;
        }
        vec4 rgba8(vec4 color){
          return floor(clamp(color, 0.0, 1.0) * 255.0 + 0.5) / 255.0;
        }
        void main(){
          vec2 d = (vUv * 2.0 - 1.0) * 0.707107;
          float r = length(d);
          vec3 reflection = ${planes};
          // The game blends ONE + ONE into the already graded RGBA8 backbuffer.
          gl_FragColor = rgba8(rgba8(texture2D(tScene, vUv)) + vec4(reflection, 0.0));
        }`,
      depthTest: false, depthWrite: false,
    }));
  }

  render(renderer, writeBuffer, readBuffer) {
    const bloomTarget = this.bloom.renderTargetsHorizontal[0];
    this.uniforms.tScene.value = readBuffer.texture;
    this.uniforms.tBloom.value = bloomTarget.texture;
    this.uniforms.uBloomSize.value.set(bloomTarget.width, bloomTarget.height);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.quad.material.dispose();
    this.quad.dispose();
  }
}

// ---- Action camera ----------------------------------------------------------------------------
// The consumer action-camera image pipeline, applied after tonemapping (display space):
// soft fisheye corners, aggressive sharpening, a punchy
// "vibrant" colour profile with an S-curve (neutral white balance), harder highlight clipping and
// small-sensor chroma noise in the shadows.
export class ActionCamPass extends Pass {
  constructor() {
    super();
    this.enabled = false;
    this.uniforms = { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uAspect: { value: 1 }, uSoft: { value: 1 } };
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: quadVert,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform vec2 uTexel; uniform float uTime, uAspect, uSoft;
        varying vec2 vUv;
        ${lum}
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 7.31) * 43758.5453); }
        vec3 tap(vec2 uv){ return texture2D(tDiffuse, uv).rgb; }
        void main(){
          vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
          float r2 = dot(c, c) / (0.25 * (uAspect * uAspect + 1.0));   // 0 centre .. 1 corner
          // corners of a cheap wide lens are soft: blur grows towards them. Zooming is a crop of the
          // sharp centre of the lens, so the softness fades out as the camera zooms in (uSoft).
          vec2 bo = uTexel * (0.6 + 2.0 * r2 * r2);
          vec3 b = 0.25 * (tap(vUv + vec2(bo.x, 0.0)) + tap(vUv - vec2(bo.x, 0.0)) + tap(vUv + vec2(0.0, bo.y)) + tap(vUv - vec2(0.0, bo.y)));
          vec3 m = tap(vUv);
          vec3 col = mix(m, b, smoothstep(0.45, 1.0, r2) * 0.5 * uSoft);
          // in-camera sharpening (unsharp mask), strongest in the centre
          vec3 n1 = 0.25 * (tap(vUv + vec2(uTexel.x, 0.0)) + tap(vUv - vec2(uTexel.x, 0.0)) + tap(vUv + vec2(0.0, uTexel.y)) + tap(vUv - vec2(0.0, uTexel.y)));
          col += (m - n1) * 0.9 * (1.0 - smoothstep(0.3, 1.0, r2));
          // "vibrant" profile: S-curve contrast, saturation weighted to muted colours (no colour cast)
          col = clamp(col, 0.0, 1.0);
          col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
          float l = luma(col);
          float sat = max(max(col.r, col.g), col.b) - min(min(col.r, col.g), col.b);
          // moderate boost: a strong one turns the blue air haze over land into a blue cast
          col = mix(vec3(l), col, 1.12 + 0.12 * (1.0 - sat));
          // small sensor: highlights clip harder, shadows carry chroma noise
          col = clamp(col * 1.05 - 0.02, 0.0, 1.0);        // black level crush: space goes pure black
          vec3 nz = vec3(hash(vUv * 1013.0), hash(vUv * 1013.0 + 17.0), hash(vUv * 1013.0 + 41.0)) - 0.5;
          // sensor noise lives in dim, lit areas; crushed black stays clean (the encoder flattens it)
          float shadow = smoothstep(0.02, 0.08, l) * (1.0 - smoothstep(0.1, 0.5, l));
          col += nz * 0.03 * shadow;
          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    }));
  }

  update(now, w, h, zoom = 1) {
    this.uniforms.uSoft.value = THREE.MathUtils.smoothstep(zoom, 0.45, 1.0);
    this.uniforms.uTime.value = (now * 0.001) % 100;
    this.uniforms.uAspect.value = w / h;
  }

  setSize(w, h) { this.uniforms.uTexel.value.set(1 / w, 1 / h); }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}
