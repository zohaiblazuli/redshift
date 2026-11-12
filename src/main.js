import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { createWorld, R_EARTH, tileCache, CLOUDS_ENABLED, PROCEDURAL_CLOUDS, ATMOSPHERE_ENABLED } from './earth.js';
import { CATALYST_SUN_TAN, SUN_DISC_TAN } from './earth.js';
import { loadSphereX, HULL_CAMS } from './spherex.js';
import { cameraPose, viewFromPose, makePose, makeView } from './campose.js';
import { Sim, PLACES } from './sim.js';
import { CloudPass, CloudCompositePass } from './clouds.js';
import { Lighting } from './lighting.js';
import { CloudSlotPass, CloudSlotCompositePass } from './cloudslot.js';
import { createExampleCloudProvider } from './exampleclouds.js';
import { createRegionCloudProvider } from './regionclouds.js';
import { createCloudWorksProvider } from './cwclouds.js';
import { FlightPlanner } from './planner.js';
import { AutoExposurePass, SunFlarePass, CatalystLensReflectionPass, ActionCamPass, loadCatalystLighting } from './lens.js';
import { catalystLut, catalystLens } from './flare10.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Renderer & post
// ---------------------------------------------------------------------------------------------
class ScaledScenePass extends Pass {
  constructor(scene, camera) {
    super();
    this.needsSwap = false;
    this.scene = scene;
    this.camera = camera;
    this.scale = 1;
    this._w = this._h = 2;
    this.target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: true });
    this.target.texture.minFilter = this.target.texture.magFilter = THREE.LinearFilter;
    this.copy = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tScene: { value: this.target.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tScene; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tScene, vUv); }',
      depthTest: false, depthWrite: false,
    }));
  }

  setScale(scale) {
    this.scale = THREE.MathUtils.clamp(scale, 0.1, 1);
    this.setSize(this._w, this._h);
  }

  setSize(w, h) {
    this._w = w; this._h = h;
    if (this.scale < 0.999) this.target.setSize(Math.max(1, Math.floor(w * this.scale)), Math.max(1, Math.floor(h * this.scale)));
    else this.target.setSize(1, 1);
  }

  render(renderer, writeBuffer, readBuffer) {
    const output = this.renderToScreen ? null : readBuffer;
    if (this.scale >= 0.999) {
      renderer.setRenderTarget(output);
      renderer.clear(true, true, true);
      renderer.render(this.scene, this.camera);
      return;
    }
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, true);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(output);
    renderer.clear(true, true, true);
    this.copy.render(renderer);
  }
}

// Scene stage. The planet (and cloud composites) render single-sampled: it is a smooth textured
// surface, and writing it at 4 samples per pixel (sky shell blending included) cost ~3 ms at 1440p.
// The spacecraft, whose thin edges need it, renders into its own 4x MSAA layer on a transparent
// background, composited (premultiplied) over the planet. The last pass (AO) then copies the result
// into the composer's buffer.
class SceneStagePass extends Pass {
  constructor(planetPasses, satPass, last) {
    super();
    this.planetPasses = planetPasses;
    this.satPass = satPass;
    this.last = last;
    this.needsSwap = true;
    this.base = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
    this.sat = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 });
    this.comp = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tSat: { value: this.sat.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tSat; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tSat, vUv); }',
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
  }

  setSize(w, h) {
    this.base.setSize(w, h);
    this.sat.setSize(w, h);
    for (const p of this.planetPasses) p.setSize(w, h);
    this.satPass.setSize(w, h);
    this.last.setSize(w, h);
  }

  render(renderer, writeBuffer, readBuffer, dt, maskActive) {
    for (const p of this.planetPasses) if (p.enabled) p.render(renderer, writeBuffer, this.base, dt, maskActive);
    if (this.satPass.enabled) {
      this.satPass.render(renderer, writeBuffer, this.sat, dt, maskActive);
      const ac = renderer.autoClear;
      renderer.autoClear = false;   // blend over the planet, don't clear it
      renderer.setRenderTarget(this.base);
      this.comp.render(renderer);
      renderer.autoClear = ac;
    }
    this.last.render(renderer, writeBuffer, this.base, dt, maskActive);
  }
}

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const CLOUD_STEPS = 48;
let groundScale = 1.0;
let cloudScale = 0.38;
let outputScale = Math.max(groundScale, cloudScale);
renderer.setPixelRatio(outputScale);
renderer.setSize(innerWidth, innerHeight);
// Tone curve: Groundview's default, AgX "punchy" (Sobotka's AgX, Wrensch's polynomial fit, then
// more contrast and saturation), copied from CloudWorks/src/template.html so the clouds keep their
// look here. ACES compressed bright clouds into flat white. Installed as three's custom curve.
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
  'vec3 CustomToneMapping( vec3 color ) { return color; }', /* glsl */ `
vec3 agxPunchyCurve(vec3 x){ vec3 x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + .4298 * x2 + .1191 * x - .00232; }
vec3 CustomToneMapping( vec3 v ) {
  v = mat3(.842479062253094, .0423282422610123, .0423756549057051, .0784335999999992, .878468636469772, .0784336, .0792237451477643, .0791661274605434, .879142973793104) * max(v, vec3(1e-10));
  v = clamp(log2(v), -12.47393, 4.026069); v = agxPunchyCurve((v + 12.47393) / 16.499999);
  float l; v = pow(max(v, 0.), vec3(1.35)); l = dot(v, vec3(.2126, .7152, .0722)); v = l + 1.4 * (v - l);
  v = mat3(1.19687900512017, -.0528968517574562, -.0529716355144438, -.0980208811401368, 1.15190312990417, -.0980434501171241, -.0990297440797205, -.0989611768448433, 1.15107367264116) * v;
  return pow(max(v, 0.), vec3(2.2));
}`);
// The output pass uses three's unused Linear slot for the captured Catalyst transform.
const CATALYST_OUTPUT = THREE.LinearToneMapping;
renderer.toneMapping = CATALYST_OUTPUT;
renderer.toneMappingExposure = 1.0;   // exposure is set by the camera model (AutoExposurePass)
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;   // refreshed every other frame in tick() (a 2048 PCF map; one frame of lag is invisible)
$('app').appendChild(renderer.domElement);

const manager = new THREE.LoadingManager();
manager.onProgress = (_u, loaded, total) => { $('loadbar').style.width = `${(loaded / total) * 100}%`; };

// the single source of light (sun, atmosphere, shared cloud shadows) for every pass below
const lighting = new Lighting(renderer);
const world = createWorld(renderer, manager, lighting);
const worldCam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 10, 2.5e5);
worldCam.layers.enable(1);

const satScene = new THREE.Scene();
const satCam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.03, 8000);
const spherex = loadSphereX(renderer, manager);
satScene.add(spherex);

const sunLight = new THREE.DirectionalLight(0xffffff, 20);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
Object.assign(sunLight.shadow.camera, { left: -3.4, right: 3.4, top: 3.4, bottom: -3.4, near: 0.5, far: 30 });
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.012;
satScene.add(sunLight, sunLight.target);

// environment probe: renders the real planet/atmosphere around the spacecraft for reflections
const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
const cubeCam = new THREE.CubeCamera(5, 2.5e5, cubeRT);
for (const c of cubeCam.children) c.layers.enable(2); // sees the cheap 2D cloud deck
let cubeFace = 0;
satScene.environment = cubeRT.texture;
satScene.environmentIntensity = 1.0;

// Post chain ping-pong buffers: single-sampled. Only the scene passes need MSAA (SceneStagePass has
// its own 4x target); a multisampled post chain cost ~4 ms at 1440p in writes and resolves.
const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, depthBuffer: false });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(outputScale);
composer.setSize(innerWidth, innerHeight);
const worldPass = new ScaledScenePass(world.scene, worldCam);
const satPass = new RenderPass(satScene, satCam);
// own transparent MSAA layer (SceneStagePass composites it over the planet)
satPass.clear = true;
satPass.clearColor = new THREE.Color(0x000000);
satPass.clearAlpha = 0;
const exposurePass = new AutoExposurePass();
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.32, 0.55, 3.75);
const catalystPack = loadCatalystLighting().catch((error) => console.warn(error));
// Fit the five browser blur levels to city4's recorded half-res bloom SRV
// (1f7352560), using the same frame's HDR scene (1f7a98260) as input.
const catalystBloomWeights = [
  [0.003423, 0.033504, 0.029794], [0.059512, 0.015331, 0.015576],
  [0.259994, 0.160157, 0.124772], [0.026661, 0.031481, 0.054440],
  [0.166066, 0.114114, 0.085214],
];
const bloomFactors = bloom.compositeMaterial.uniforms.bloomFactors;
const originalBloomFactors = bloomFactors.value;
const catalystBloomUniforms = bloom.blendMaterial.uniforms;
catalystBloomUniforms.uCatalystBloom = { value: false };
catalystBloomUniforms.uDirt = { value: null };
catalystBloomUniforms.uDirtReady = { value: false };
catalystPack.then((pack) => {
  if (!pack) return;
  catalystBloomUniforms.uDirt.value = pack.dirt;
  catalystBloomUniforms.uDirtReady.value = true;
});
bloom.blendMaterial.fragmentShader = bloom.blendMaterial.fragmentShader.replace('void main()', `
  uniform bool uCatalystBloom, uDirtReady;
  uniform sampler2D uDirt;
  void main()`).replace(/gl_FragColor\s*=\s*opacity\s*\*\s*texel\s*;/, `
    if (uCatalystBloom) {
      vec3 dirt = uDirtReady ? texture2D(uDirt, vec2(vUv.x, 1.0 - vUv.y)).rgb : vec3(0.0);
      vec3 response = dirt * vec3(${catalystLens.dirtFactor.join(', ')}) + vec3(${catalystLens.dirtBias.join(', ')});
      gl_FragColor = vec4(texel.rgb * response * vec3(${catalystLens.bloomScale.join(', ')}), 1.0);
    } else {
      gl_FragColor = opacity * texel;
    }`);
function setBloomProfile(catalyst) {
  if (catalyst === catalystBloomUniforms.uCatalystBloom.value) return;
  catalystBloomUniforms.uCatalystBloom.value = catalyst;
  bloom.strength = catalyst ? 1 : 0.32;
  bloom.radius = catalyst ? 0 : 0.55;
  // The native bloom buffer contains a contribution even from unlit areas.
  bloom.threshold = catalyst ? -0.01 : 3.75;
  bloomFactors.value = catalyst ? [1, 1, 1, 1, 1] : originalBloomFactors;
  // Each level keeps the capture's fitted strength, but as neutral grey: the fitted hues (red and
  // orange mid levels) belonged to that capture's scene and tinted the sun's halo red. Sunlight is white.
  const grey = (w) => { const l = 0.2126 * w[0] + 0.7152 * w[1] + 0.0722 * w[2]; return [l, l, l]; };
  bloom.bloomTintColors.forEach((tint, i) => tint.fromArray(catalyst ? grey(catalystBloomWeights[i]) : [1, 1, 1]));
}
const flarePass = new SunFlarePass();   // Catalyst's five-element sun flare
catalystPack.then((pack) => { if (pack) flarePass.setTextures(pack.textures); });
const actionPass = new ActionCamPass();
const lensPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uDistort: { value: 0 }, uAspect: { value: 1 },
    uVignette: { value: 0.32 }, uGrain: { value: 0.012 },
    uFish: { value: 0 }, uTanV: { value: 1 }, uThetaMax: { value: 1.17 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uDistort, uAspect, uVignette, uGrain;
    uniform float uFish, uTanV, uThetaMax;
    varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5; c.x *= uAspect;
      float r2 = dot(c, c);
      // gentle barrel distortion for the wide hull cameras, rescaled to keep the frame filled
      vec2 cd = c * (1.0 + uDistort * r2) / (1.0 + uDistort * 0.25 * (uAspect * uAspect + 1.0));
      if (uFish > 0.5){
        // equidistant fisheye (action-camera lens): image radius proportional to the view angle,
        // uThetaMax at the frame corner; resampled from a wide rectilinear render
        float rdiag = 0.5 * sqrt(uAspect * uAspect + 1.0);
        float ro = length(c);
        float th = ro / rdiag * uThetaMax;
        float rp = tan(th) / uTanV * 0.5;
        cd = ro > 1e-6 ? c * (rp / ro) : c;
      }
      cd.x /= uAspect;
      vec2 uv = cd + 0.5;
      vec3 col = texture2D(tDiffuse, uv).rgb;
      col *= 1.0 - uVignette * smoothstep(0.15, 0.95, r2 / (0.25 * (uAspect * uAspect + 1.0)) );
      col += (h(vUv * 917.0) - 0.5) * uGrain * (0.4 + col);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
});
const cloudPass = new CloudPass(world.shared, world.shared.uNoise3D.value, worldCam);
cloudPass.setQuality(cloudScale / outputScale, CLOUD_STEPS);
// slot for an external (raw WebGL2) cloud renderer: draws first, so its shadow map is ready for
// the planet; idle until setCloudProvider() attaches one
const cloudSlot = new CloudSlotPass(renderer, lighting, worldCam);
composer.addPass(cloudSlot);
const scenePasses = [];
if (CLOUDS_ENABLED) scenePasses.push(cloudPass);
scenePasses.push(worldPass);
if (CLOUDS_ENABLED) scenePasses.push(new CloudCompositePass(cloudPass));
scenePasses.push(new CloudSlotCompositePass(cloudSlot));
// ambient occlusion on the spacecraft only (its own depth/normals; space and the planet are untouched)
const aoPass = new GTAOPass(satScene, satCam, innerWidth, innerHeight);
aoPass.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: 12 });
aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
aoPass.blendIntensity = 0.85;
// AO is low-frequency: compute it (normals, GTAO, denoise) at half resolution; the blend upsamples
{ const fullSize = aoPass.setSize.bind(aoPass); aoPass.setSize = (w, h) => fullSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); }
// AO's first step copies the (resolved) scene into the composer buffer: that copy also scrubs any
// stray NaN/Inf before bloom spreads it across the frame (bit-level test: D3D/ANGLE may compile
// isnan() away) and clamps runaway highlights
aoPass.copyMaterial.fragmentShader = aoPass.copyMaterial.fragmentShader
  .replace('void main()', 'bool badF(float x){ return (floatBitsToUint(x) & 0x7fffffffu) >= 0x7f800000u; }\nvoid main()')
  .replace(/gl_FragColor\s*=\s*opacity\s*\*\s*texel\s*;/, `vec3 c = texel.rgb;
    if (badF(c.r) || badF(c.g) || badF(c.b)) c = vec3(0.0);
    gl_FragColor = vec4(clamp(c, 0.0, 400.0), 1.0);`);
if (!aoPass.copyMaterial.fragmentShader.includes('badF(c.r)')) console.warn('NaN scrub not installed in the AO copy');
aoPass.copyMaterial.needsUpdate = true;
const sceneStage = new SceneStagePass(scenePasses, satPass, aoPass);
composer.addPass(sceneStage);
composer.addPass(exposurePass);
composer.addPass(flarePass.visPass); // how much of the sun's disc is lit, measured before bloom
composer.addPass(bloom);
composer.addPass(flarePass);
composer.addPass(lensPass);
class OpenWorldOutputPass extends OutputPass {
  constructor() {
    super();
    this.material.uniforms.uCatalystLut = { value: null };
    this.material.uniforms.uCatalystReady = { value: false };
    catalystPack.then((pack) => {
      if (!pack) return;
      this.material.uniforms.uCatalystLut.value = pack.toneLut;
      this.material.uniforms.uCatalystReady.value = true;
    });
    this.material.fragmentShader = this.material.fragmentShader.replace('void main()', `
      uniform sampler2D uCatalystLut;
      uniform bool uCatalystReady;
      const float LUT_SIDE = ${catalystLut.size}.0;
      vec3 catalystSlice(vec2 rg, float slice){
        const vec2 tiles = vec2(${catalystLut.columns}.0, ${catalystLut.rows}.0);
        vec2 tile = vec2(mod(slice, tiles.x), floor(slice / tiles.x));
        return texture2D(uCatalystLut, (tile * LUT_SIDE + rg + 0.5) / (tiles * LUT_SIDE)).rgb;
      }
      vec3 catalystTone(vec3 hdr){
        if (!uCatalystReady) return hdr;
        // city4 PS 29390603, cbuffer slots 12 and 22–26.
        const vec4 vig = vec4(${catalystLens.vignette.join(', ')});
        vec2 d = (vUv - 0.5) * vig.xy;
        hdr *= vec3(${catalystLut.colorScale.join(', ')}) * pow(clamp(1.0 - dot(d, d) * vig.w, 0.0, 1.0), vig.z);
        const vec4 a = vec4(${catalystLut.coeffA.join(', ')});
        const vec4 b = vec4(${catalystLut.coeffB.join(', ')});
        vec3 c = vec3(-0.2, 0.23, 0.18) * (a.xzx / a.ywy) + vec3(0.57, 0.01, 0.02);
        float ab = c.x * c.y, ct = c.z * 0.02, cs = c.z * 0.3;
        float w = b.z;
        float n = 1.0 / ((w * (0.2 * w + ab) + ct) / (w * (0.2 * w + c.x) + cs) - 0.066667);
        vec3 x = hdr * n;
        vec3 y = ((x * (0.2 * x + ab) + ct) / (x * (0.2 * x + c.x) + cs) - 0.066667) * n / b.w;
        vec3 encoded = mix(1.055 * pow(abs(y), vec3(0.416667)) - 0.055, y * 12.92,
          step(y, vec3(0.003131)));
        // The game's hardware sampler uses the original 32³ grade in display space.
        vec3 p = clamp(encoded, 0.0, 1.0) * (LUT_SIDE - 1.0);
        float lo = floor(p.z);
        vec3 srgb = mix(catalystSlice(p.xy, lo), catalystSlice(p.xy, min(lo + 1.0, LUT_SIDE - 1.0)), fract(p.z));
        // The captured grade tops out at 0.86 (219/255): a clipped sun came out grey. A sensor clips to
        // white, so blend to white as the curve runs past its clip point (y ~1.15 is exposed HDR ~6,
        // brighter than any sunlit surface; the sun and hard glints reach the curve's ceiling ~1.33).
        srgb = mix(srgb, vec3(1.0), smoothstep(1.15, 1.33, max(max(y.r, y.g), y.b)));
        // Decode before OutputPass's normal sRGB conversion.
        return mix(srgb / 12.92, pow((srgb + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), srgb));
      }
      void main()`).replace('LinearToneMapping( gl_FragColor.rgb )', 'catalystTone( gl_FragColor.rgb )')
      .replace('#elif defined( NEUTRAL_TONE_MAPPING )',
      `#elif defined( CUSTOM_TONE_MAPPING )
        gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );
      #elif defined( NEUTRAL_TONE_MAPPING )`);
  }
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // OutputPass rebuilds its defines when the curve changes; give the custom curve its define first
    if (renderer.toneMapping === THREE.CustomToneMapping && this._toneMapping !== renderer.toneMapping) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);   // sets up colour space
      this.material.defines.CUSTOM_TONE_MAPPING = '';
      this.material.needsUpdate = true;
    }
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
composer.addPass(new OpenWorldOutputPass());
const lensReflectionPass = new CatalystLensReflectionPass(bloom);
composer.addPass(lensReflectionPass);
composer.addPass(actionPass);   // action-camera image processing, in display space

// ---------------------------------------------------------------------------------------------
// Simulation & cameras
// ---------------------------------------------------------------------------------------------
let starI = 0;
const sim = new Sim();
sim.setLocation(PLACES[0].lat, PLACES[0].lon);
// the sun stands where it really is right now; the clock then runs in real time (x warp)
sim.setRealTime();

const CAM_MODES = ['CHASE', ...HULL_CAMS.map((c) => c.name), 'FREE FLIGHT'];
let camMode = 1;
const orbitCam = { yaw: 2.35, pitch: 0.22, dist: 9.5 };
const hullLook = { yaw: 0, pitch: 0, fovMul: 1 };
const free = { pos: new THREE.Vector3(), yaw: 0, pitch: -0.3, speed: 2.0 };
let showHud = true, showHelp = false;

const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.repeat && !['KeyW', 'KeyS', 'KeyA', 'KeyD'].includes(e.code)) { keys.add(e.code); return; }
  keys.add(e.code);
  const place = PLACES.find((p) => `Digit${p.key}` === e.code);
  if (place) teleport(place);
  switch (e.code) {
    case 'KeyC': case 'KeyV': setCamMode((camMode + (e.shiftKey ? CAM_MODES.length - 1 : 1)) % CAM_MODES.length); break;
    case 'KeyT': sim.cycleAttitude(); toast(`Attitude · ${sim.attModes[sim.attMode]}`); break;
    case 'Backspace': sim.attOffset.identity(); hullLook.yaw = hullLook.pitch = 0; toast('Attitude offsets reset'); break;
    case 'KeyH': showHud = !showHud; document.body.classList.toggle('nohud', !showHud); break;
    case 'Slash': case 'F1': showHelp = !showHelp; $('help').classList.toggle('open', showHelp); e.preventDefault(); break;
    case 'KeyM': world.tiles.hiRes = !world.tiles.hiRes; toast(`Sentinel-2 high-res imagery ${world.tiles.hiRes ? 'ON' : 'OFF'}`); break;
    case 'KeyG': cycleResolution('ground'); break;
    case 'KeyK': cycleResolution('cloud'); break;
    case 'KeyX': {
      const ex = [1, 1.6, 2.5][([1, 1.6, 2.5].indexOf(world.shared.uExag.value) + 1) % 3];
      world.shared.uExag.value = ex; toast(`Terrain relief ×${ex}`); break;
    }
    case 'KeyP': sim.paused = !sim.paused; toast(sim.paused ? 'Orbit paused' : 'Orbit resumed'); break;
    case 'Comma': sim.warp = Math.max(1, sim.warp / (sim.warp > 10 ? 5 : 2)); sim.warp = snapWarp(sim.warp); toast(`Time warp ×${sim.warp}`); break;
    case 'Period': sim.warp = snapWarp(Math.min(1000, sim.warp * (sim.warp >= 10 ? 5 : 2))); toast(`Time warp ×${sim.warp}`); break;
    case 'KeyB': {
      if (!ATMOSPHERE_ENABLED) break;
      const steps = [1, 0.75, 0.55, 0.3];
      const u = world.shared.uAerial;
      u.value = steps[(steps.findIndex((v) => Math.abs(v - u.value) < 0.01) + 1) % steps.length];
      toast(`Air haze ${Math.round(u.value * 100)}%`);
      break;
    }
    case 'Minus': if (!CLOUDS_ENABLED) break; cloudCover = Math.max(0, cloudCover - 0.1); toast(`Cloud cover ${(cloudCover * 100).toFixed(0)}%`); break;
    case 'Equal': if (!CLOUDS_ENABLED) break; cloudCover = Math.min(1.6, cloudCover + 0.1); toast(`Cloud cover ${(cloudCover * 100).toFixed(0)}%`); break;
    case 'KeyY': {
      const tms = [[CATALYST_OUTPUT, 'Catalyst (city4 capture)'], [THREE.CustomToneMapping, 'AgX punchy (Groundview)'], [THREE.AgXToneMapping, 'AgX'], [THREE.ACESFilmicToneMapping, 'ACES filmic'], [THREE.NeutralToneMapping, 'Khronos neutral']];
      const i = (tms.findIndex((t) => t[0] === renderer.toneMapping) + 1) % tms.length;
      renderer.toneMapping = tms[i][0]; toast(`Tonemapper · ${tms[i][1]}`); break;
    }
    case 'KeyU': exposurePass.auto = !exposurePass.auto; exposurePass.reset = true; toast(`Auto exposure ${exposurePass.auto ? 'ON' : 'OFF'}`); break;
    case 'KeyJ': flarePass.enabled = !flarePass.enabled; toast(`Lens flare ${flarePass.enabled ? 'ON' : 'OFF'}`); break;
    case 'Semicolon': exposurePass.compEV = Math.max(-3, exposurePass.compEV - 0.5); toast(`Exposure ${exposurePass.compEV >= 0 ? '+' : ''}${exposurePass.compEV.toFixed(1)} EV`); break;
    case 'Quote': exposurePass.compEV = Math.min(3, exposurePass.compEV + 0.5); toast(`Exposure ${exposurePass.compEV >= 0 ? '+' : ''}${exposurePass.compEV.toFixed(1)} EV`); break;
    case 'KeyN': sim.setRealTime(); toast(`Clock synced to now · ${sim.date.toUTCString().slice(5, 22)} UTC`); break;
    case 'KeyZ': {
      // only the Blender cloud models (with PROCEDURAL_CLOUDS off, switching them off clears the sky)
      const s = world.shared;
      if (!s.uModelsLoaded) { toast('Blender clouds not loaded'); break; }
      s.uModelsOn.value = s.uModelsOn.value > 0.5 ? 0 : 1;
      cloudPass.histValid = false;
      toast(`Blender clouds ${s.uModelsOn.value ? 'ON' : 'OFF'}`);
      break;
    }
    case 'KeyO': sim.speedMul = 1; toast('Orbital velocity restored'); break;
    case 'KeyL': setPlanOpen(!planOpen); break;
    case 'Escape': if (planOpen) setPlanOpen(false); break;
  }
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const snapWarp = (w) => [1, 2, 5, 10, 50, 250, 1000].reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));

let dragging = false, lastX = 0, lastY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointerup', () => { dragging = false; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = (e.clientX - lastX) / innerHeight, dy = (e.clientY - lastY) / innerHeight;
  lastX = e.clientX; lastY = e.clientY;
  if (camMode === 0) { orbitCam.yaw -= dx * 3.5; orbitCam.pitch = THREE.MathUtils.clamp(orbitCam.pitch + dy * 3.0, -1.45, 1.45); }
  else if (camMode === CAM_MODES.length - 1) { free.yaw -= dx * 2.2; free.pitch = THREE.MathUtils.clamp(free.pitch - dy * 2.2, -1.55, 1.55); }
  else { hullLook.yaw -= dx * 1.6; hullLook.pitch = THREE.MathUtils.clamp(hullLook.pitch - dy * 1.6, -1.2, 1.2); }
});
renderer.domElement.addEventListener('wheel', (e) => {
  const k = Math.exp(e.deltaY * 0.0012);
  if (camMode === 0) orbitCam.dist = THREE.MathUtils.clamp(orbitCam.dist * k, 4.2, 400);
  else if (camMode === CAM_MODES.length - 1) free.speed = THREE.MathUtils.clamp(free.speed / k, 0.005, 2000);
  else hullLook.fovMul = THREE.MathUtils.clamp(hullLook.fovMul * k, 0.25, 1.25);
  e.preventDefault();
}, { passive: false });

function setCamMode(m) {
  if (m === CAM_MODES.length - 1) {
    // detach the free camera where the current view is
    free.pos.copy(worldCam.position);
    const up = free.pos.clone().normalize();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(worldCam.quaternion);
    const { north, east } = sim.basisAt(up);
    free.pitch = Math.asin(THREE.MathUtils.clamp(fwd.dot(up), -1, 1));
    free.yaw = Math.atan2(-fwd.dot(east), fwd.dot(north));
  }
  camMode = m;
  hullLook.yaw = hullLook.pitch = 0; hullLook.fovMul = 1;
  toast(`Camera · ${CAM_MODES[m]}`);
}

const resolutionSteps = { ground: [50, 75, 100], cloud: [25, 38, 50, 75, 100] };
let resolutionTimer = 0;

function setRangeFill(input) {
  const fill = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
  input.style.setProperty('--fill', `${fill}%`);
}

function updateResolutionUi() {
  const gp = Math.round(groundScale * 100), cp = Math.round(cloudScale * 100);
  const groundInput = $('ground-resolution'), cloudInput = $('cloud-resolution');
  groundInput.value = gp; cloudInput.value = cp;
  setRangeFill(groundInput); setRangeFill(cloudInput);
  $('p-ground-res').textContent = `${gp}% · ${Math.max(1, Math.floor(innerWidth * groundScale))}×${Math.max(1, Math.floor(innerHeight * groundScale))}`;
  $('p-cloud-res').textContent = `${cp}% · ${Math.max(1, Math.floor(innerWidth * cloudScale))}×${Math.max(1, Math.floor(innerHeight * cloudScale))}`;
}

function applyResolutionScales(announce = '') {
  outputScale = Math.max(groundScale, cloudScale);
  worldPass.setScale(groundScale / outputScale);
  cloudPass.setQuality(cloudScale / outputScale, CLOUD_STEPS);
  renderer.setPixelRatio(outputScale);
  composer.setPixelRatio(outputScale);
  onResize();
  updateResolutionUi();
  if (announce) toast(`${announce} resolution · ${announce === 'Ground' ? Math.round(groundScale * 100) : Math.round(cloudScale * 100)}%`);
}

function setResolution(kind, percent, announce = true) {
  const value = THREE.MathUtils.clamp(Number(percent), kind === 'ground' ? 50 : 25, 100) / 100;
  if (kind === 'ground') groundScale = value; else cloudScale = value;
  applyResolutionScales(announce ? (kind === 'ground' ? 'Ground' : 'Cloud') : '');
}

function cycleResolution(kind) {
  const values = resolutionSteps[kind];
  const current = Math.round((kind === 'ground' ? groundScale : cloudScale) * 100);
  const nearest = values.reduce((best, value, i) => Math.abs(value - current) < Math.abs(values[best] - current) ? i : best, 0);
  setResolution(kind, values[(nearest + 1) % values.length]);
}

for (const kind of ['ground', 'cloud']) {
  const input = $(`${kind}-resolution`);
  input.addEventListener('input', () => {
    if (kind === 'ground') groundScale = Number(input.value) / 100; else cloudScale = Number(input.value) / 100;
    updateResolutionUi();
    clearTimeout(resolutionTimer);
    resolutionTimer = setTimeout(() => applyResolutionScales(), 80);
  });
  input.addEventListener('change', () => {
    clearTimeout(resolutionTimer);
    setResolution(kind, input.value);
  });
}
applyResolutionScales();

function teleport(place) {
  sim.setLocation(place.lat, place.lon);
  sim.speedMul = 1;
  if (camMode === CAM_MODES.length - 1) setCamMode(1);
  toast(place.name, true);
  if (planOpen) replan();
}

// ---------------------------------------------------------------------------------------------
// Flight plan: pre-download the orbit ahead into the local disk cache
// ---------------------------------------------------------------------------------------------
const planner = new FlightPlanner(world);
let planOpen = false, planOrbits = 1, planToken = 0;
const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`);
async function refreshCacheStat() {
  const st = tileCache.available ? await planner.cacheStats() : null;
  $('p-cache').textContent = st ? `${st.files.toLocaleString()} tiles · ${fmtBytes(st.bytes)}` : 'not available (open via start.bat)';
}
async function replan() {
  const token = ++planToken;
  $('p-dl').disabled = true;
  $('p-size').textContent = '—';
  $('p-bar').style.width = '0';
  $('p-msg').textContent = '';
  // the narrowest camera decides the finest tiles (wider ones use those tiles' parents, also fetched)
  const minFov = Math.min(50, ...HULL_CAMS.map((c) => c.fov));
  const plan = await planner.compute(sim, planOrbits, renderer.domElement.height, minFov, (f) => {
    if (token === planToken) $('p-tiles').textContent = `computing… ${(f * 100).toFixed(0)}%`;
  });
  if (token !== planToken) return;
  planner.adopt(plan);
  planner.line.visible = planOpen;
  $('p-track').textContent = `${Math.round(plan.trackKm).toLocaleString()} km · ${Math.round(plan.durationS / 60)} min`;
  $('p-tiles').textContent = `${plan.img.toLocaleString()} imagery · ${plan.dem.toLocaleString()} terrain`;
  if (!tileCache.available) {
    $('p-msg').textContent = 'Start the world with start.bat (local server) to download and cache tiles on disk.';
    return;
  }
  $('p-size').textContent = 'estimating…';
  const est = await planner.estimate(plan);
  if (token !== planToken) return;
  const pct = Math.round(est.cachedFrac * 100);
  $('p-size').textContent = `≈ ${fmtBytes(est.bytes * (1 - est.cachedFrac))}` + (pct > 0 ? ` (${pct}% already on disk)` : '');
  $('p-dl').disabled = planner.busy;
  refreshCacheStat();
}
function setPlanOpen(open) {
  planOpen = open;
  $('plan').classList.toggle('open', open);
  planner.line.visible = open && !!planner.plan;
  if (open) {
    sim.paused = true; // the plan starts from where the spacecraft is now
    showHelp = false; $('help').classList.remove('open');
    replan();
  }
}
document.querySelectorAll('#plan-len button').forEach((b) => b.addEventListener('click', () => {
  planOrbits = Number(b.dataset.orbits);
  document.querySelectorAll('#plan-len button').forEach((o) => o.classList.toggle('on', o === b));
  replan();
}));
$('p-dl').addEventListener('click', async () => {
  $('p-dl').disabled = true;
  $('p-msg').textContent = 'Downloading…';
  const r = await planner.download((p) => {
    $('p-bar').style.width = `${(p.done / p.total) * 100}%`;
    $('p-msg').textContent = `${p.done.toLocaleString()} / ${p.total.toLocaleString()} tiles · ${fmtBytes(p.downloaded)} downloaded`;
  });
  if (r) $('p-msg').textContent = `Ready — ${(r.total - r.failed).toLocaleString()} tiles on disk (${fmtBytes(r.downloaded)} new)${r.failed ? `, ${r.failed} unavailable` : ''}. Press Fly.`;
  $('p-dl').disabled = false;
  refreshCacheStat();
});
$('p-fly').addEventListener('click', () => { setPlanOpen(false); sim.paused = false; toast('Flight plan engaged'); });
$('p-clear').addEventListener('click', async () => { await planner.clearCache(); refreshCacheStat(); });

let cloudCover = CLOUDS_ENABLED ? 1.0 : 0.0;   // user cover (- / =)
let toastTimer;
function toast(text, big = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = big ? 'show big' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, big ? 3200 : 1800);
}

// ---------------------------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------------------------
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4();
const sunColor = new THREE.Color();
const camOffset = new THREE.Vector3(); // metres, world axes, camera relative to spacecraft
const livePose = makePose();
let frameNo = 0, last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 60, hudTimer = 0;

function readInput(dt) {
  const k = (c) => (keys.has(c) ? 1 : 0);
  const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
  const inFree = camMode === CAM_MODES.length - 1;
  const input = {
    turn: inFree ? 0 : k('KeyD') - k('KeyA'),
    throttle: inFree ? 0 : (k('KeyW') - k('KeyS')) * boost,
    climb: inFree ? 0 : (k('KeyR') - k('KeyF')) * boost,
    timeShift: (k('BracketRight') - k('BracketLeft')) * boost,
    rot: null,
  };
  const rx = k('ArrowUp') - k('ArrowDown'), ry = k('ArrowLeft') - k('ArrowRight'), rz = k('KeyQ') - k('KeyE');
  if (!inFree && (rx || ry || rz)) input.rot = { x: rx * 0.5, y: ry * 0.5, z: rz * 0.5 };
  if (inFree) {
    const up = free.pos.clone().normalize();
    const { north, east } = sim.basisAt(up);
    const fwd = north.clone().multiplyScalar(Math.cos(free.yaw)).addScaledVector(east, -Math.sin(free.yaw));
    const right = new THREE.Vector3().crossVectors(fwd, up);
    const look = fwd.clone().multiplyScalar(Math.cos(free.pitch)).addScaledVector(up, Math.sin(free.pitch));
    const v = free.speed * boost * dt;
    free.pos.addScaledVector(look, (k('KeyW') - k('KeyS')) * v)
      .addScaledVector(right, (k('KeyD') - k('KeyA')) * v)
      .addScaledVector(up, (k('KeyE') - k('KeyQ') + k('KeyR') - k('KeyF')) * v);
    const minR = R_EARTH + 0.3;
    if (free.pos.length() < minR) free.pos.setLength(minR);
  }
  return input;
}

function updateCamera() {
  const satPos = sim.posKm;
  const up = sim.p;
  if (camMode === CAM_MODES.length - 1) {
    const upF = free.pos.clone().normalize();
    const { north, east } = sim.basisAt(upF);
    const fwd = north.clone().multiplyScalar(Math.cos(free.yaw)).addScaledVector(east, -Math.sin(free.yaw));
    const look = fwd.multiplyScalar(Math.cos(free.pitch)).addScaledVector(upF, Math.sin(free.pitch));
    tmpM.lookAt(new THREE.Vector3(), look, upF);
    satCam.quaternion.setFromRotationMatrix(tmpM);
    camOffset.copy(free.pos).sub(satPos).multiplyScalar(1000);
    satCam.fov = 62;
  } else {
    cameraPose(camMode, sim, orbitCam, hullLook, livePose);
    camOffset.copy(livePose.offset);
    satCam.quaternion.copy(livePose.quat);
    satCam.fov = livePose.fov;
  }
  satCam.position.copy(camOffset);
  satCam.updateProjectionMatrix();
  satCam.updateMatrixWorld();

  worldCam.position.copy(satPos).addScaledVector(camOffset, 0.001);
  worldCam.quaternion.copy(satCam.quaternion);
  worldCam.fov = satCam.fov;
  const camAlt = worldCam.position.length() - R_EARTH;
  worldCam.near = THREE.MathUtils.clamp(camAlt * 0.35, 0.02, 120);
  worldCam.far = 2.5e5;
  worldCam.updateProjectionMatrix();
  worldCam.updateMatrixWorld();
  const hc = camMode >= 1 && camMode <= HULL_CAMS.length ? HULL_CAMS[camMode - 1] : null;
  const action = !!(hc && hc.action);
  const lu = lensPass.uniforms;
  lu.uDistort.value = hc && !action ? 0.16 * hullLook.fovMul : 0.0;
  lu.uFish.value = action ? 1 : 0;
  lu.uTanV.value = Math.tan(THREE.MathUtils.degToRad(satCam.fov) / 2);
  // keep the fisheye's corner angle just inside the rectilinear render
  lu.uThetaMax.value = Math.atan(lu.uTanV.value * Math.sqrt(1 + satCam.aspect * satCam.aspect)) * 0.995;
  lu.uVignette.value = action ? 0.45 : 0.32;
  lu.uGrain.value = action ? 0.0 : 0.012;
  actionPass.enabled = action;
  // action cameras meter the whole frame, black space included, so the sunlit Earth and the
  // hardware come out bright, close to clipping
  exposurePass.flatMetering = action;
  exposurePass.biasEV = action ? -0.75 : 0;   // net ~+0.4 EV over the cinema cameras in the default view
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  tick(dt, now);
}

function tick(dt, now = performance.now()) {
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

  const input = readInput(dt);
  sim.update(dt, input);
  spherex.quaternion.copy(sim.att);
  updateCamera();

  lighting.update(sim);
  const sunDir = lighting.sunDir;
  // Stars are ~1e-6 of the sunlit Earth's brightness: a camera exposed for daylight (the
  // spacecraft or the day side in frame) records black space. They only come out in eclipse.
  starI = 0.35 * (1 - THREE.MathUtils.smoothstep(sunColor.g, 0.0, 0.05));
  // sunlight on the spacecraft: eclipse + limb reddening (sunColor, also drives the HUD and the
  // stars), times the shadow of a plugged-in cloud provider's clouds (probed a frame late)
  lighting.sunColorAt(sim.posKm, sunColor);
  lighting.setProbe(sim.posKm);
  sunLight.color.copy(sunColor).multiplyScalar(lighting.probeT);
  sunLight.intensity = lighting.sunE;
  cloudSlot.simTimeMs = sim.date.getTime();
  cloudSlot.dt = dt;
  sunLight.position.copy(sunDir).multiplyScalar(12);
  sunLight.target.position.set(0, 0, 0);

  // clouds are static: uWind / uCloudTime stay at 0 (no drift, no evolution as time passes)
  // the procedural shapes are disabled: without the Blender models there is no cloud (nor its shadows)
  world.shared.uCloudCover.value = (PROCEDURAL_CLOUDS || world.shared.uModelsOn.value > 0.5) ? cloudCover : 0;
  const catalyst = renderer.toneMapping === CATALYST_OUTPUT;
  world.update(worldCam, worldCam.position, renderer.domElement.height, sunDir, catalyst);

  // environment probe at the spacecraft: one cube face every other frame (odd frames; the shadow
  // map refreshes on even ones), re-filtered after a full turn (~12 frames, 0.2 s)
  if ((frameNo & 1) === 1 || frameNo < 12) {
    if (cubeCam.coordinateSystem !== renderer.coordinateSystem) { cubeCam.coordinateSystem = renderer.coordinateSystem; cubeCam.updateCoordinateSystem(); }
    cubeCam.position.copy(sim.posKm);
    cubeCam.updateMatrixWorld();
    world.starUniforms.uStarI.value = 0;
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(cubeRT, cubeFace);
    renderer.clear();
    renderer.render(world.scene, cubeCam.children[cubeFace]);
    renderer.setRenderTarget(prevRT);
    world.starUniforms.uStarI.value = starI;
    cubeFace = (cubeFace + 1) % 6;
    if (cubeFace === 0 || frameNo < 6) cubeRT.texture.needsPMREMUpdate = true;
  }

  lensPass.uniforms.uTime.value = (now * 0.001) % 100;
  exposurePass.dt = dt;
  // the exposure model was tuned under three's ACES, which scales its input by 1 / 0.6 itself; the
  // other curves get that gain here so the frame keeps its
  // brightness -- and a grey card lands near Groundview's in flight views
  exposurePass.curveGain = renderer.toneMapping === THREE.ACESFilmicToneMapping ? 1 : 1 / 0.6;
  setBloomProfile(catalyst);
  // Catalyst's two lens-reflection planes (pink and blue rings mirrored from the bloom), with the sun flare
  lensReflectionPass.enabled = catalyst && flarePass.enabled;
  if (catalyst) lensPass.uniforms.uVignette.value = 0; // applied by the captured output transform
  flarePass.update(worldCam, sunDir, renderer.domElement.width, renderer.domElement.height);
  actionPass.update(now, innerWidth, innerHeight, hullLook.fovMul);
  if ((frameNo & 1) === 0) renderer.shadowMap.needsUpdate = true;
  composer.render(dt);
  frameNo++;

  hudTimer += dt;
  if (hudTimer > 0.1) { hudTimer = 0; updateHud(); }
}

function fmtLat(v, p, n) { return `${Math.abs(v).toFixed(3)}°${v >= 0 ? p : n}`; }
function fmtTime(h) {
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = Math.floor(((h - hh) * 60 - mm) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
function updateHud() {
  const lit = sunColor.g > 0.02;
  $('t-alt').textContent = `${sim.alt.toFixed(1)} km`;
  $('t-vel').textContent = `${sim.groundSpeed.toFixed(3)} km/s`;
  $('t-lat').textContent = fmtLat(sim.lat, 'N', 'S');
  $('t-lon').textContent = fmtLat(sim.lon, 'E', 'W');
  $('t-hdg').textContent = `${sim.heading.toFixed(1)}°`;
  $('t-lst').textContent = fmtTime(sim.localSolarTime);
  $('t-utc').textContent = `${sim.date.toUTCString().slice(5, 11).toUpperCase()} ${fmtTime(sim.utc)} UTC`;
  $('t-sun').textContent = lit ? (sunColor.b < 0.6 ? 'TERMINATOR' : 'SUNLIT') : 'ECLIPSE';
  $('t-sun').className = lit ? '' : 'warn';
  $('t-warp').textContent = sim.paused ? 'PAUSED' : `×${sim.warp}`;
  $('t-period').textContent = `${(2 * Math.PI * (R_EARTH + sim.alt) / sim.orbitalSpeed / 60).toFixed(1)} min`;
  $('cam-mode').textContent = CAM_MODES[camMode];
  $('att-mode').textContent = sim.attModes[sim.attMode];
  $('fps').textContent = `${fps.toFixed(0)} FPS · G ${Math.round(groundScale * 100)}% · C ${Math.round(cloudScale * 100)}%`;
  const p = world.tiles.pending;
  $('tiles').textContent = p > 0 ? `STREAMING IMAGERY · ${p}` : 'IMAGERY LOCKED';
  $('tiles').classList.toggle('busy', p > 0);
}

function onResize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  worldCam.aspect = satCam.aspect = w / h;
  lensPass.uniforms.uAspect.value = w / h;
  worldCam.updateProjectionMatrix(); satCam.updateProjectionMatrix();
  updateResolutionUi();
}
addEventListener('resize', onResize);
onResize();

// places list in the help panel
$('places').innerHTML = PLACES.map((p) => `<li><kbd>${p.key}</kbd>${p.name}</li>`).join('');

manager.onLoad = () => {
  $('loader').classList.add('done');
  setTimeout(() => toast(PLACES[0].name, true), 600);
};
// External cloud renderer (see cloudslot.js for the contract): setCloudProvider(provider) attaches
// one, setCloudProvider(null) detaches it. A provider with a lat/lon `box` owns that region: the
// built-in clouds are cut out of it.
function setCloudProvider(p) {
  cloudSlot.setProvider(p);
  const b = cloudSlot.provider?.box, d = Math.PI / 180;
  world.shared.uCloudCutOn.value = b ? 1 : 0;
  if (b) world.shared.uCloudCut.value.set(b.lon0 * d, b.lat0 * d, b.lon1 * d, b.lat1 * d);
}
// No clouds by default. On request: ?clouds=cloudworks (CloudWorks clouds over the planet, from the
// observed day), ?clouds=cloudworks-lineup (the ten genera in a row), ?clouds=greece (raymarched region clouds over the Ionian Sea / Greece),
// ?clouds=example (the template provider).
const CLOUD_TEST = new URLSearchParams(location.search).get('clouds') || 'none';
if (CLOUD_TEST === 'greece') setCloudProvider(createRegionCloudProvider());
else if (CLOUD_TEST === 'example') setCloudProvider(createExampleCloudProvider());
else if (CLOUD_TEST === 'cloudworks') setCloudProvider(createCloudWorksProvider());
else if (CLOUD_TEST === 'cloudworks-lineup') setCloudProvider(createCloudWorksProvider({ mode: 'lineup' }));

// shader warm-up so the first visible frame doesn't hitch
renderer.compile(world.scene, worldCam);
renderer.compile(satScene, satCam);
requestAnimationFrame(frame);

// debug handle
window.__sx = { cameraPose, viewFromPose, makePose, makeView, lighting, cloudSlot, setCloudProvider, createExampleCloudProvider, createRegionCloudProvider, createCloudWorksProvider, planner, setPlanOpen, aoPass, step: (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) tick(dt); }, sim, world, renderer, worldCam, satCam, setCamMode, orbitCam, hullLook, free, bloom, composer, lensPass, spherex, sunLight, cloudPass, exposurePass, flarePass, actionPass };
// test helper: step frames (works even while the tab is in the background) until imagery settles
window.__sx.settle = async (ms = 15000) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    tick(0);
    await new Promise((r) => setTimeout(r, 40));
    if (world.tiles.pending === 0 && world.tiles.inflight === 0) { for (let i = 0; i < 9; i++) tick(0); break; }
  }
  return world.tiles.loadedCount;
};
