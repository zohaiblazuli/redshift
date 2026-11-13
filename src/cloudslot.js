import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// ---------------------------------------------------------------------------------------------
// Cloud slot: plugs an external cloud renderer (raw WebGL2, no three.js) into the frame.
//
// A provider is a plain object:
//   init(gl, lighting)    once, on attach. lighting = the Lighting hub (lighting.js): prepend
//                         lighting.glsl to your fragment shaders, call lighting.bind(gl, prog, unit)
//                         after gl.useProgram to set the sun / atmosphere / shadow uniforms.
//   resize(w, h)          size of the colour target (optional)
//   render(frame)         every frame, before the planet draws; see makeFrame() below for fields.
//                         Writes two targets the app owns:
//                         - frame.color: premultiplied RGBA16F (rgb = cloud radiance already lit and
//                           hazed with lighting.glsl's aerial(), a = 1 - transmittance), cleared to 0.
//                           Composited over the planet, under the spacecraft.
//                         - frame.shadow: the shared cloud shadow map (RGBA32F, layout in shaders.js,
//                           cloudShadowGLSL), cleared to "no cloud" (0, 0, 0). Every lit thing reads it.
//   dispose()             on detach (optional)
//   shadowMapSize         optional, default 2048
//   shadowAlt             optional: the shadow map's alpha holds the altitude (km) where each texel's
//                         sun ray enters the cloud, times its optical depth (b); 0 where empty.
//                         Lets lookups drop shadows of clouds a low sun's ray passes over.
//   renderScale           optional: colour target resolution relative to the frame (default 0.5)
//   temporal              optional: the slot accumulates the clouds over frames (see below)
//
// Temporal accumulation (temporal: true). Each frame the provider offsets its rays by frame.jitter
// (colour-target pixels, within +-0.5) and varies its noise with frame.frameIndex, and writes a
// second output (location 1, in frame.color's framebuffer): r = the clouds' depth along the ray in
// km (opacity-weighted), 0 where there is none. The slot reprojects its display-resolution history
// with that depth, clamps it to the new frame's neighbourhood and blends the new frame in, so the
// low-resolution, dithered march resolves to a smooth, sharper image over a few frames.
//
// The provider may change any GL state: the app resets three.js's state cache around each call.
// Units: km, Earth-centred world space, +Y = north pole; sunDir points toward the sun.
// ---------------------------------------------------------------------------------------------

const slotQuadVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

// History resolve: reproject, clamp, blend (premultiplied RGBA throughout).
const slotResolveFrag = /* glsl */ `
uniform sampler2D tCur, tDepth, tHist;
uniform vec2 uCurRes, uJitter;
uniform mat4 uInvProj, uCamWorld, uPrevViewProj;
uniform vec3 uCamPos;
uniform float uReset, uAlpha;
varying vec2 vUv;
void main(){
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  // the new frame at this point (its samples sat uJitter pixels off their texel centres)
  vec2 cuv = vUv - uJitter / uCurRes;
  vec4 cur = texture2D(tCur, cuv);
  // its neighbourhood, and the depth of the most opaque texel there
  vec4 lo = cur, hi = cur; float dep = 0.0, best = 0.002;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = cuv + vec2(float(x), float(y)) / uCurRes;
    vec4 c = texture2D(tCur, o);
    lo = min(lo, c); hi = max(hi, c);
    float d = texture2D(tDepth, o).r;
    if (d > 0.0 && c.a > best){ best = c.a; dep = d; }
  }
  if (dep <= 0.0){
    // no cloud near: the ground, or far away
    float b = dot(uCamPos, rd), h = b * b - dot(uCamPos, uCamPos) + 6371.0 * 6371.0;
    float tg = h > 0.0 ? -b - sqrt(h) : -1.0;
    dep = tg > 0.0 ? tg : 1e5;
  }
  vec4 pc = uPrevViewProj * vec4(uCamPos + rd * dep, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  bool ok = uReset < 0.5 && pc.w > 0.0 && puv.x >= 0.0 && puv.y >= 0.0 && puv.x <= 1.0 && puv.y <= 1.0;
  vec4 hist = clamp(texture2D(tHist, puv), lo, hi);
  gl_FragColor = ok ? mix(hist, cur, uAlpha) : cur;
}`;
const slotHalton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };

export class CloudSlotPass extends Pass {
  constructor(renderer, lighting, camera) {
    super();
    this.needsSwap = false;
    this.renderer = renderer;
    this.lighting = lighting;
    this.camera = camera;
    this.provider = null;
    this.scale = 0.5;           // colour target resolution relative to the frame
    this.simTimeMs = 0;         // simulated UTC (ms since 1970), set by the app each frame
    this.dt = 0;
    this.frameIndex = 0;
    this.color = null;
    this._w = 2; this._h = 2;
    this._frame = null;
    // temporal accumulation (providers with temporal: true)
    this.temporal = false;
    this.history = [];            // two display-resolution targets, ping-ponged
    this.hp = 0;
    this.blend = 0.12;            // share of each new frame
    this.jitter = new Float32Array(2);
    this._reset = true;
    this._prevViewProj = new THREE.Matrix4();
    this._prevPos = new THREE.Vector3();
    this._prevFov = 0;
    this.resolve = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: {
        tCur: { value: null }, tDepth: { value: null }, tHist: { value: null },
        uCurRes: { value: new THREE.Vector2() }, uJitter: { value: new THREE.Vector2() },
        uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
        uReset: { value: 1 }, uAlpha: { value: 0.12 },
      },
      vertexShader: slotQuadVert, fragmentShader: slotResolveFrag,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    }));
    this.comp = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tClouds: { value: null } },
      vertexShader: slotQuadVert,
      fragmentShader: 'uniform sampler2D tClouds; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tClouds, vUv); }',
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      depthTest: false, depthWrite: false, transparent: true,
    }));
  }

  get active() { return !!this.provider; }

  setProvider(p) {
    const r = this.renderer;
    if (this.provider) {
      r.resetState();
      try { this.provider.dispose?.(); } catch (e) { console.error('Cloud provider dispose failed:', e); }
      r.resetState();
    }
    this.provider = null;
    this.color?.dispose(); this.color = null;
    for (const h of this.history) h.dispose();
    this.history = [];
    if (!p) { this.lighting.setCloudShadowEnabled(false); this.lighting.uniforms.uCloudShadowAlt.value = 0; return; }

    this.lighting.setCloudShadowEnabled(true, p.shadowMapSize || 2048);
    this.lighting.uniforms.uCloudShadowAlt.value = p.shadowAlt ? 1 : 0;
    this.scale = THREE.MathUtils.clamp(p.renderScale || 0.5, 0.1, 1);
    this.temporal = !!p.temporal;
    // colour (+ depth, location 1, for temporal providers)
    this.color = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false, count: this.temporal ? 2 : 1 });
    for (const t of this.color.textures) { t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; }
    if (this.temporal) {
      this.color.textures[1].minFilter = this.color.textures[1].magFilter = THREE.NearestFilter;
      this.history = [0, 1].map(() => new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false }));
      for (const h of this.history) { h.texture.minFilter = h.texture.magFilter = THREE.LinearFilter; h.texture.generateMipmaps = false; }
      this._reset = true;
    }
    this.comp.material.uniforms.tClouds.value = this.temporal ? this.history[this.hp].texture : this.color.texture;
    this.provider = p;
    this._frame = null;
    this.setSize(this._w, this._h);
    r.resetState();
    try { p.init(r.getContext(), this.lighting); } catch (e) { r.resetState(); this._fail('init', e); return; }
    r.resetState();
    this.provider.resize?.(this.color.width, this.color.height);
  }

  setScale(scale) { this.scale = THREE.MathUtils.clamp(scale, 0.1, 1); this.setSize(this._w, this._h); }

  setSize(w, h) {
    this._w = w; this._h = h;
    if (!this.color) return;
    for (const hr of this.history) if (hr.width !== w || hr.height !== h) { hr.setSize(w, h); this._reset = true; }
    const cw = Math.max(1, Math.floor(w * this.scale)), ch = Math.max(1, Math.floor(h * this.scale));
    if (cw === this.color.width && ch === this.color.height) return;
    this.color.setSize(cw, ch);
    this._frame = null;
    if (this.provider) {
      this.renderer.resetState();
      this.provider.resize?.(cw, ch);
      this.renderer.resetState();
    }
  }

  // raw framebuffer of a three.js render target (sets it up on first use)
  _rawFbo(rt) {
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.setRenderTarget(prev);
    return r.properties.get(rt).__webglFramebuffer;
  }

  // The per-frame description handed to provider.render(). Arrays are reused between frames.
  makeFrame() {
    const L = this.lighting, sh = L.shadow, cam = this.camera;
    let f = this._frame;
    if (!f) {
      f = this._frame = {
        gl: this.renderer.getContext(),
        lighting: L,
        color: { framebuffer: this._rawFbo(this.color), width: this.color.width, height: this.color.height },
        shadow: {
          framebuffer: this._rawFbo(sh.target), size: sh.size,
          matrix: new Float32Array(16),    // world -> (u, v, depth km), column-major (= uCloudShadowMatrix)
          origin: new Float32Array(3),     // world position of the map centre on its near plane
          right: new Float32Array(3),      // world direction of +u
          up: new Float32Array(3),         // world direction of +v
          dir: new Float32Array(3),        // direction of the shadow rays (away from the sun)
          extent: 0,                       // half-width covered, km: texel (u, v) starts its ray at
                                           // origin + (right (2u-1) + up (2v-1)) extent, along dir;
                                           // the distance along it is the depth the map stores
        },
        camera: {
          position: new Float32Array(3),      // km, world
          view: new Float32Array(16),         // world -> view (column-major, as three.js)
          projection: new Float32Array(16),
          invProjection: new Float32Array(16),
          cameraWorld: new Float32Array(16),  // view -> world (its rotation turns view rays to world)
          fovY: 1, aspect: 1, near: 1, far: 1,
          pixelAngle: 0.001,                  // radians per colour-target pixel (vertical)
        },
        sunDir: new Float32Array(3),
        sunE: 0,
        simTimeMs: 0, dt: 0, frameIndex: 0,
        scale: 1,                         // colour target resolution / frame resolution
        temporal: this.temporal,          // write depth (location 1), jitter rays, vary noise per frame
        jitter: this.jitter,              // this frame's ray offset, colour-target pixels
      };
    }
    const c = f.camera;
    cam.position.toArray(c.position);
    c.view.set(cam.matrixWorldInverse.elements);
    c.projection.set(cam.projectionMatrix.elements);
    c.invProjection.set(cam.projectionMatrixInverse.elements);
    c.cameraWorld.set(cam.matrixWorld.elements);
    c.fovY = THREE.MathUtils.degToRad(cam.fov); c.aspect = cam.aspect; c.near = cam.near; c.far = cam.far;
    c.pixelAngle = 2 * Math.tan(c.fovY / 2) / Math.max(f.color.height, 1);
    const s = f.shadow;
    s.matrix.set(L.uniforms.uCloudShadowMatrix.value.elements);
    sh.origin.toArray(s.origin); sh.right.toArray(s.right); sh.up.toArray(s.up); sh.dir.toArray(s.dir);
    s.extent = sh.extent;
    L.sunDir.toArray(f.sunDir);
    f.sunE = L.sunE;
    f.simTimeMs = this.simTimeMs; f.dt = this.dt; f.frameIndex = this.frameIndex;
    f.scale = f.color.height / Math.max(this._h, 1);
    return f;
  }

  render(renderer) {
    if (!this.provider) return;
    const L = this.lighting, gl = renderer.getContext();
    this.camera.updateMatrixWorld();
    L.updateShadowFrame(this.camera.position);
    L.clearCloudShadow();
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.color);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    renderer.setRenderTarget(prev);

    if (this.temporal) {
      renderer.setRenderTarget(this.color);
      gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
      renderer.setRenderTarget(prev);
      const k = (this.frameIndex % 16) + 1;
      this.jitter[0] = slotHalton(k, 2) - 0.5; this.jitter[1] = slotHalton(k, 3) - 0.5;
    }

    const frame = this.makeFrame();
    renderer.resetState();
    try { this.provider.render(frame); } catch (e) { renderer.resetState(); this._fail('render', e); return; }
    renderer.resetState();
    if (this.temporal) this._resolve(renderer);
    L.runProbe();
    this.frameIndex++;
  }

  // blend the new frame into the reprojected history
  _resolve(renderer) {
    const cam = this.camera, u = this.resolve.material.uniforms;
    // a jump of the camera (switch, teleport, time warp) or of the field of view starts over
    const alt = Math.max(cam.position.length() - 6371, 1);
    if (cam.position.distanceTo(this._prevPos) > 1 + 0.05 * alt || cam.fov !== this._prevFov) this._reset = true;
    const src = this.history[this.hp], dst = this.history[1 - this.hp];
    u.tCur.value = this.color.textures[0]; u.tDepth.value = this.color.textures[1]; u.tHist.value = src.texture;
    u.uCurRes.value.set(this.color.width, this.color.height); u.uJitter.value.set(this.jitter[0], this.jitter[1]);
    u.uInvProj.value.copy(cam.projectionMatrixInverse); u.uCamWorld.value.copy(cam.matrixWorld);
    u.uPrevViewProj.value.copy(this._prevViewProj); u.uCamPos.value.copy(cam.position);
    u.uReset.value = this._reset ? 1 : 0; u.uAlpha.value = this.blend;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(dst); this.resolve.render(renderer); renderer.setRenderTarget(prev);
    this.hp = 1 - this.hp;
    this.comp.material.uniforms.tClouds.value = dst.texture;
    this._prevViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._prevPos.copy(cam.position); this._prevFov = cam.fov;
    this._reset = false;
  }

  // a broken provider is detached (clear sky, no shadows) instead of taking the frame down with it
  _fail(stage, e) {
    console.error(`Cloud provider ${stage} failed, detaching it:`, e);
    this.provider = null;
    this.setProvider(null);
  }
}

// Composites the provider's clouds over the planet. Like CloudCompositePass, it must follow the
// planet pass with no render-target switch in between (multisampled frame buffer).
export class CloudSlotCompositePass extends Pass {
  constructor(slot) { super(); this.needsSwap = false; this.slot = slot; }
  render(renderer, writeBuffer, readBuffer) {
    if (!this.slot.active) return;
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.slot.comp.render(renderer);
    renderer.autoClear = ac;
  }
}
