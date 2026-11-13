import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { lightingGLSL } from './shaders.js';
import { createAtmosphereLUTs } from './atmosphere.js';
import { sunTransmittanceJS, R_EARTH, ATMOSPHERE_ENABLED } from './earth.js';

// ---------------------------------------------------------------------------------------------
// Lighting hub: the single source of light for everything in the app.
//
// It owns the sun (direction, irradiance, colour after the air), the precomputed atmosphere and
// the shared cloud shadow map, and hands them out in two forms:
//   - three.js: lighting.uniforms (spread into any ShaderMaterial) + lighting.glsl (the library);
//   - raw WebGL2: lighting.glsl + lighting.bind(gl, program, unit), which uploads the same uniforms
//     and binds the raw WebGLTextures, so code that never touches three.js lights things the same.
//
// Whatever blocks sunlight (a cloud provider, see cloudslot.js) writes the cloud shadow map; every
// lit thing reads it through cloudShadowT(p): ground, ocean, haze, the environment probe and the
// spacecraft (via a 1-texel async probe). Units: km, Earth-centred world space, +Y = north pole.
// ---------------------------------------------------------------------------------------------

// solar irradiance at 1 AU in scene units (the exposure model is calibrated against it)
export const SUN_E = 20.0;
// shadow-map texel meaning "no cloud along this sun ray": no optical depth. Its depth is 0, not
// "infinitely far": filtering between a cloud texel and an empty one then fades the shadow out over
// the texel instead of cutting it off at the texel's edge (blocky shadows).
export const CLOUD_SHADOW_EMPTY = 0;
// Full-moon irradiance on the ground, in the units of the night lights (not SUN_E: physically it
// is SUN_E * 2.3e-6, but the lights are scaled for the eye, not for the sun). Tuned by eye against
// astronaut full-moon photos: with towns in frame the auto exposure meters for them, and moonlit
// land then reads clearly but stays well below the lights.
export const MOON_E = 1.4;
// night ambient: starlight + airglow. Physically ~0.4 % of the full moon (0.005), which left the
// moonless night side black; 0.2 (user, 2026-11-13: "light up the night side a little bit") shows
// the land and clouds as faint navy under the lights, as in long-exposure orbit photos.
export const NIGHT_GLOW_E = 0.2;

export class Lighting {
  constructor(renderer) {
    this.renderer = renderer;
    this.glsl = lightingGLSL;
    this.sunDir = new THREE.Vector3(1, 0, 0);
    this.moonGain = 1;   // artistic boost of the moonlight (1 = calibrated)
    this.nightBoost = 1; // night ambient multiplier, set by updateNightBoost
    const luts = createAtmosphereLUTs(renderer);

    // 1x1 "no occluder" stand-in until a cloud provider asks for the real map
    this.emptyShadow = new THREE.DataTexture(new Float32Array([CLOUD_SHADOW_EMPTY, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    this.emptyShadow.needsUpdate = true;

    this.uniforms = {
      uSunDir: { value: this.sunDir },
      uSunE: { value: SUN_E },
      uMoonDir: { value: new THREE.Vector3(0, 0, 1) },
      uMoonE: { value: 0 },        // MOON_E * phase law * moonGain
      uNightGlowE: { value: NIGHT_GLOW_E },
      uAtmo: { value: ATMOSPHERE_ENABLED ? 1 : 0 },
      uAerial: { value: 1.0 },     // air haze over the ground: physical (user choice 2026-11-13; B cycles 1/0.75/0.55/0.3)
      uTransLUT: { value: luts.transmittance },
      uMsLUT: { value: luts.multiScatter },
      uIrrLUT: { value: luts.irradiance },
      uCloudShadowMap: { value: this.emptyShadow },
      uCloudShadowMatrix: { value: new THREE.Matrix4() },
      uCloudShadowOn: { value: 0 },
      uCloudShadowAlt: { value: 0 },  // provider writes the front altitude (cloudslot.js shadowAlt)
    };

    // cloud shadow map frame (valid while enabled); see updateShadowFrame()
    this.shadow = {
      enabled: false, size: 2048, target: null,
      center: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(),
      origin: new THREE.Vector3(),   // world position of the map's centre on its near plane
      dir: new THREE.Vector3(),      // direction the map looks along (away from the sun)
      extent: 1000,                  // half-width covered, km
      nearDist: 2000,                // km from the centre toward the sun to the near plane
    };

    // async probe: cloud transmittance at one world point (the spacecraft), one frame late
    this.probeT = 1;
    this._probePos = new THREE.Vector3();
    this._probeBusy = false;
    this._probeBuf = new Float32Array(4);
    this._locs = new WeakMap();
  }

  // Once per frame, before anything renders.
  update(sim) {
    this.uniforms.uNightGlowE.value = NIGHT_GLOW_E * this.nightBoost;
    this.sunDir.copy(sim.sunDir);
    // solar irradiance follows the Earth-Sun distance (+-3.4 % over the year)
    this.uniforms.uSunE.value = SUN_E / (sim.sunDistAU * sim.sunDistAU);
    this.uniforms.uMoonDir.value.copy(sim.moonDir);
    this.uniforms.uMoonE.value = MOON_E * sim.moonPhase * this.moonGain;
  }

  get sunE() { return this.uniforms.uSunE.value; }

  // Keeps the night side as bright on screen as at full night when daylight (or a sunlit
  // spacecraft) is in frame and the auto exposure drops for it. ev: the exposure in use; maxEV: the
  // exposure at full night. The boost itself brightens the night pixels the exposure meters (a
  // log-average, 75 % compensated), which would lower the exposure and raise the boost again; that
  // share, nightShare x log2(boost) x 0.75, is added back before the boost is worked out.
  updateNightBoost(ev, maxEV, nightShare, dt) {
    const ev0 = ev + 0.75 * nightShare * Math.log2(this.nightBoost);
    const target = 2 ** THREE.MathUtils.clamp(maxEV - ev0, 0, 3);
    this.nightBoost += (target - this.nightBoost) * (1 - Math.exp(-dt * 2));
    this.uniforms.uNightGlowE.value = NIGHT_GLOW_E * this.nightBoost;
  }

  // Share of the Earth seen by the camera that is on the night side (coarse ray grid).
  nightShareOf(camera) {
    const v = this._v ||= new THREE.Vector3(), p = this._p ||= new THREE.Vector3(), o = camera.position;
    let earth = 0, night = 0;
    for (let j = 0; j < 6; j++) for (let i = 0; i < 10; i++) {
      v.set((i + 0.5) / 5 - 1, (j + 0.5) / 3 - 1, 0.5).unproject(camera).sub(o).normalize();
      const b = o.dot(v), h = b * b - o.dot(o) + R_EARTH * R_EARTH;
      if (h < 0) continue;
      const t = -b - Math.sqrt(h);
      if (t < 0) continue;
      earth++;
      if (p.copy(o).addScaledVector(v, t).dot(this.sunDir) < 0) night++;
    }
    return earth ? night / earth : 0;
  }

  // Colour of the sunlight arriving at a world point after the air (limb reddening, Earth shadow).
  // withClouds: also the cloud shadow -- only valid for the point given to setProbe().
  // Moonlight reaching a point (scene units, same as the planet's uMoonE): the phase law, the air
  // it crosses and the Earth hiding the moon, as sunColorAt does for the sun.
  moonColorAt(posKm, out = new THREE.Color()) {
    sunTransmittanceJS(posKm, this.uniforms.uMoonDir.value, out);
    return out.multiplyScalar(this.uniforms.uMoonE.value);
  }

  sunColorAt(posKm, out = new THREE.Color(), withClouds = false) {
    sunTransmittanceJS(posKm, this.sunDir, out);
    return withClouds ? out.multiplyScalar(this.probeT) : out;
  }

  // ---- cloud shadow map ---------------------------------------------------------------------

  // Allocated only while a cloud provider is attached (RGBA32F: depths reach thousands of km).
  setCloudShadowEnabled(on, size = this.shadow.size) {
    const sh = this.shadow;
    if (on && (!sh.target || sh.size !== size)) {
      sh.target?.dispose();
      sh.size = size;
      sh.target = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, depthBuffer: false });
      const t = sh.target.texture;
      const linear = this.renderer.extensions.has('OES_texture_float_linear');
      t.minFilter = t.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
    }
    if (!on && sh.target) { sh.target.dispose(); sh.target = null; }
    sh.enabled = on;
    this.uniforms.uCloudShadowMap.value = on ? sh.target.texture : this.emptyShadow;
    this.uniforms.uCloudShadowOn.value = on ? 1 : 0;
    this.probeT = 1;
  }

  // Lays the shadow map out for this frame: centred on the ground below the camera, as wide as the
  // camera's horizon, facing the sun. The centre snaps to whole texels and the width to 25 % steps,
  // so a moving camera does not make the shadows shimmer.
  updateShadowFrame(camPos) {
    const sh = this.shadow;
    if (!sh.enabled) return;
    const L = this.sunDir;
    const alt = Math.max(camPos.length() - R_EARTH, 0.1);
    const horizon = Math.sqrt(2 * R_EARTH * alt + alt * alt);
    const want = THREE.MathUtils.clamp(horizon * 1.1, 150, 3500);
    sh.extent = 150 * Math.pow(1.25, Math.ceil(Math.log(want / 150) / Math.log(1.25)));
    sh.right.set(0, 1, 0).cross(L);
    if (sh.right.lengthSq() < 1e-6) sh.right.set(1, 0, 0).cross(L);
    sh.right.normalize();
    sh.up.crossVectors(L, sh.right);
    const texel = (2 * sh.extent) / sh.size;
    const g = camPos.clone().setLength(R_EARTH);
    const x = Math.round(g.dot(sh.right) / texel) * texel, y = Math.round(g.dot(sh.up) / texel) * texel;
    // depths stay positive: the near plane sits beyond the curvature drop and oblique sun of the map
    sh.nearDist = sh.extent + 1000;
    sh.center.copy(sh.right).multiplyScalar(x).addScaledVector(sh.up, y).addScaledVector(L, g.dot(L));
    sh.origin.copy(sh.center).addScaledVector(L, sh.nearDist);
    sh.dir.copy(L).negate();
    // world -> (u, v, depth): u, v = 0.5 + offset / (2 extent), depth = distance from the near plane
    const s = 1 / (2 * sh.extent), o = sh.origin;
    this.uniforms.uCloudShadowMatrix.value.set(
      sh.right.x * s, sh.right.y * s, sh.right.z * s, 0.5 - o.dot(sh.right) * s,
      sh.up.x * s, sh.up.y * s, sh.up.z * s, 0.5 - o.dot(sh.up) * s,
      -L.x, -L.y, -L.z, o.dot(L),
      0, 0, 0, 1,
    );
  }

  // Clears the map to "no cloud" (providers then only write where there is cloud).
  clearCloudShadow() {
    const sh = this.shadow;
    if (!sh.enabled) return;
    const r = this.renderer, gl = r.getContext();
    const prev = r.getRenderTarget();
    r.setRenderTarget(sh.target);
    gl.clearBufferfv(gl.COLOR, 0, [CLOUD_SHADOW_EMPTY, 0, 0, 0]);
    r.setRenderTarget(prev);
  }

  // ---- spacecraft probe ---------------------------------------------------------------------

  setProbe(posKm) { this._probePos.copy(posKm); }

  // Evaluates cloudShadowT at the probe point on the GPU and reads it back without stalling
  // (pixel-pack buffer + fence): the result lands in probeT a frame or two later.
  runProbe() {
    if (!this.shadow.enabled || this._probeBusy || !this.renderer.readRenderTargetPixelsAsync) return;
    if (!this._probe) {
      this._probe = {
        target: new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false }),
        quad: new FullScreenQuad(new THREE.ShaderMaterial({
          uniforms: { ...this.uniforms, uProbePos: { value: this._probePos } },
          vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
          fragmentShader: `${this.glsl}\nuniform vec3 uProbePos;\nvoid main(){ gl_FragColor = vec4(cloudShadowT(uProbePos)); }`,
          depthTest: false, depthWrite: false,
        })),
      };
    }
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this._probe.target);
    this._probe.quad.render(r);
    r.setRenderTarget(prev);
    this._probeBusy = true;
    r.readRenderTargetPixelsAsync(this._probe.target, 0, 0, 1, 1, this._probeBuf)
      .then(() => { if (this.shadow.enabled) this.probeT = THREE.MathUtils.clamp(this._probeBuf[0], 0, 1); })
      .catch(() => {})
      .finally(() => { this._probeBusy = false; });
  }

  // ---- raw WebGL2 access --------------------------------------------------------------------

  // The raw WebGLTexture behind a three.js texture (uploads it first if needed).
  rawTexture(tex) {
    let p = this.renderer.properties.get(tex);
    if (!p.__webglTexture) { this.renderer.initTexture(tex); p = this.renderer.properties.get(tex); }
    return p.__webglTexture;
  }

  // Uploads every lighting uniform the program declares (by name, as in lighting.glsl) and binds
  // the lighting textures from texture unit `unit` on. Call with the program in use (gl.useProgram).
  // Returns the next free texture unit.
  bind(gl, program, unit = 0) {
    let locs = this._locs.get(program);
    if (!locs) {
      locs = {};
      for (const name of Object.keys(this.uniforms)) locs[name] = gl.getUniformLocation(program, name);
      this._locs.set(program, locs);
    }
    for (const [name, u] of Object.entries(this.uniforms)) {
      const loc = locs[name];
      if (!loc) continue;
      const v = u.value;
      if (v && v.isTexture) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.rawTexture(v));
        gl.uniform1i(loc, unit++);
      } else if (v && v.isVector3) gl.uniform3f(loc, v.x, v.y, v.z);
      else if (v && v.isMatrix4) gl.uniformMatrix4fv(loc, false, v.elements);
      else gl.uniform1f(loc, v);
    }
    return unit;
  }
}
