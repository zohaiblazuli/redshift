import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { makeFoilTextures, makeSolarTextures, makeShieldTextures, makePanelBackTexture, mulberry32 } from './textures.js';

// NASA SPHEREx. The spacecraft is the Blender model models/spherex.glb (exported from
// SPHEREx_Master.blend); the procedural model below (buildSphereX) is only the fallback for when the
// GLB cannot be fetched (index.html opened as a plain file).
// Procedural model: Units: metres. Body frame: +Y = telescope boresight / photon-shield
// axis, +X = solar-array normal (sun side), Z completes the right-handed frame.

// --- small value-noise for geometric wrinkles -------------------------------------------------
function hash(x, y, z) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  let r = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    r += hash(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r;
}
function wrinkle(geo, amp, freq) {
  geo.computeVertexNormals();
  const p = geo.attributes.position, n = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const f = vnoise(x * freq, y * freq, z * freq) * 0.6 + vnoise(x * freq * 2.7 + 9, y * freq * 2.7, z * freq * 2.7) * 0.4 - 0.5;
    p.setXYZ(i, x + n.getX(i) * f * amp, y + n.getY(i) * f * amp, z + n.getZ(i) * f * amp);
  }
  geo.computeVertexNormals();
  return geo;
}

function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }

export function buildSphereX(renderer) {
  const root = new THREE.Group();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const foil = makeFoilTextures(1024, 7);
  const solar = makeSolarTextures();
  const shield = makeShieldTextures(16);
  const panelBack = makePanelBackTexture();
  for (const t of [foil.normal, foil.rough, foil.color, solar.map, solar.data, shield.map, shield.data, panelBack]) t.anisotropy = aniso;

  // --- materials -------------------------------------------------------------------------------
  const M = {
    shieldOuter: new THREE.MeshPhysicalMaterial({
      color: 0xf3f5f7, map: shield.map, roughnessMap: shield.data, bumpMap: shield.data, bumpScale: 0.9,
      roughness: 0.85, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.12, specularIntensity: 0.8,
    }),
    shieldInner: new THREE.MeshPhysicalMaterial({
      color: 0xf4f6f9, metalness: 1.0, roughness: 0.09, side: THREE.BackSide, anisotropy: 0.4,
    }),
    shieldUpper: new THREE.MeshPhysicalMaterial({
      color: 0xe9eaec, map: shield.map, roughnessMap: shield.data, bumpMap: shield.data, bumpScale: 0.7,
      roughness: 0.7, metalness: 0.75,
    }),
    rim: new THREE.MeshPhysicalMaterial({ color: 0xd9dbde, metalness: 1.0, roughness: 0.22 }),
    foil: new THREE.MeshPhysicalMaterial({
      color: 0xe2e4e8, map: foil.color, metalness: 1.0, roughness: 1.0, roughnessMap: foil.rough,
      normalMap: foil.normal, normalScale: new THREE.Vector2(1.1, 1.1),
    }),
    foilDark: new THREE.MeshPhysicalMaterial({
      color: 0x6f7378, map: foil.color, metalness: 1.0, roughness: 1.0, roughnessMap: foil.rough,
      normalMap: foil.normal, normalScale: new THREE.Vector2(0.9, 0.9),
    }),
    alu: new THREE.MeshPhysicalMaterial({ color: 0xb8bcc2, metalness: 1.0, roughness: 0.33 }),
    aluDark: new THREE.MeshPhysicalMaterial({ color: 0x8a8f96, metalness: 0.9, roughness: 0.42 }),
    white: new THREE.MeshPhysicalMaterial({ color: 0xdedcd6, metalness: 0.0, roughness: 0.55 }),
    black: new THREE.MeshPhysicalMaterial({ color: 0x0b0b0c, metalness: 0.2, roughness: 0.55 }),
    cable: new THREE.MeshPhysicalMaterial({ color: 0x141416, metalness: 0.0, roughness: 0.5, clearcoat: 0.3 }),
    cells: new THREE.MeshPhysicalMaterial({
      map: solar.map, roughnessMap: solar.data, metalnessMap: solar.data, roughness: 1.0, metalness: 1.0,
      clearcoat: 1.0, clearcoatRoughness: 0.04,
    }),
    panelBack: new THREE.MeshPhysicalMaterial({ map: panelBack, metalness: 0.3, roughness: 0.6 }),
    bolt: new THREE.MeshPhysicalMaterial({ color: 0xc9ccd1, metalness: 1.0, roughness: 0.25 }),
  };

  // --- photon shields (three nested cones; inner ones rise above the outer rim) -----------------
  const shields = [
    { r0: 0.86, r1: 1.31, y0: 0.10, y1: 1.56, outer: M.shieldOuter },
    { r0: 0.74, r1: 1.15, y0: 0.18, y1: 1.84, outer: M.shieldUpper },
    { r0: 0.62, r1: 0.99, y0: 0.26, y1: 2.10, outer: M.shieldUpper },
  ];
  const coneR = (s, y) => {
    const t = THREE.MathUtils.clamp((y - s.y0) / (s.y1 - s.y0), 0, 1);
    return s.r0 + (s.r1 - s.r0) * Math.pow(t, 1.3);
  };
  for (const s of shields) {
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, y = s.y0 + (s.y1 - s.y0) * t;
      pts.push(new THREE.Vector2(coneR(s, y), y));
    }
    const g = new THREE.LatheGeometry(pts, 160);
    root.add(shadowed(new THREE.Mesh(g, s.outer)));
    const inner = new THREE.Mesh(g, M.shieldInner);
    inner.scale.set(0.992, 1, 0.992);
    root.add(shadowed(inner));
    // rolled lip at the top + joint band at the bottom
    const lip = new THREE.Mesh(new THREE.TorusGeometry(s.r1 + 0.012, 0.022, 14, 200), M.rim);
    lip.rotation.x = Math.PI / 2; lip.position.y = s.y1;
    root.add(shadowed(lip));
    const band = new THREE.Mesh(new THREE.TorusGeometry(coneR(s, s.y0 + 0.05) + 0.004, 0.012, 8, 160), M.alu);
    band.rotation.x = Math.PI / 2; band.position.y = s.y0 + 0.05;
    root.add(shadowed(band));
  }

  // brackets / clips on the outer shield and stand-offs bridging the rims
  const rnd = mulberry32(5);
  const bracketGeo = new THREE.BoxGeometry(0.07, 0.15, 0.035);
  const boltGeo = new THREE.CylinderGeometry(0.009, 0.009, 0.02, 10);
  const placeOnCone = (s, ang, y, geo, mat, out = 0.018) => {
    const r = coneR(s, y) + out;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(Math.sin(ang) * r, y, Math.cos(ang) * r);
    // align with the surface: local Z = outward normal (with cone slope), local Y = along the slant
    const dy = 0.01, slope = (coneR(s, y + dy) - coneR(s, y - dy)) / (2 * dy);
    const outward = new THREE.Vector3(Math.sin(ang), -slope, Math.cos(ang)).normalize();
    const along = new THREE.Vector3(Math.sin(ang) * slope, 1, Math.cos(ang) * slope).normalize();
    const side = new THREE.Vector3().crossVectors(along, outward);
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, along, outward));
    root.add(shadowed(m));
    return m;
  };
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 16;
    for (const y of [0.55, 1.18]) {
      const b = placeOnCone(shields[0], a, y, bracketGeo, M.alu);
      for (const by of [-0.045, 0.045]) {
        const bolt = new THREE.Mesh(boltGeo, M.bolt);
        bolt.rotation.x = Math.PI / 2; bolt.position.set(0, by, 0.022);
        b.add(bolt);
      }
    }
    // stand-off struts from outer rim to middle shield
    const a2 = (k / 8) * Math.PI * 2;
    const p0 = new THREE.Vector3(Math.sin(a2) * (shields[0].r1 - 0.01), shields[0].y1 - 0.02, Math.cos(a2) * (shields[0].r1 - 0.01));
    const p1 = new THREE.Vector3(Math.sin(a2) * (coneR(shields[1], 1.62) + 0.01), 1.62, Math.cos(a2) * (coneR(shields[1], 1.62) + 0.01));
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, p0.distanceTo(p1), 8), M.aluDark);
    strut.position.copy(p0).add(p1).multiplyScalar(0.5);
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
    root.add(shadowed(strut));
    const clip = placeOnCone(shields[1], a2, 1.70, new THREE.BoxGeometry(0.05, 0.1, 0.03), M.alu, 0.015);
    clip.castShadow = true;
  }

  // telescope at the bottom of the cone stack
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.36, 0.42, 48, 1, true), M.black);
  tube.material = M.black.clone(); tube.material.side = THREE.DoubleSide;
  tube.position.y = 0.48; root.add(shadowed(tube));
  const mirror = new THREE.Mesh(new THREE.CircleGeometry(0.34, 48), new THREE.MeshPhysicalMaterial({ color: 0x222833, metalness: 1, roughness: 0.05 }));
  mirror.rotation.x = -Math.PI / 2; mirror.position.y = 0.3; root.add(mirror);
  for (let k = 0; k < 3; k++) {
    const vane = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.012, 0.012), M.black);
    vane.rotation.y = (k / 3) * Math.PI; vane.position.y = 0.66; root.add(vane);
  }
  const sec = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 24), M.black);
  sec.position.y = 0.66; root.add(sec);

  // --- spacecraft bus: hexagonal, wrapped in crinkled MLI ---------------------------------------
  const busR = 0.72, busTop = 0.06, busBot = -0.95, busH = busTop - busBot, apo = busR * Math.cos(Math.PI / 6);
  for (let k = 0; k < 6; k++) {
    const phi = (k / 6) * Math.PI * 2; // face normal direction in XZ plane (k=0 → +X)
    const g = new THREE.PlaneGeometry(busR * 0.98, busH * 0.98, 26, 34);
    const mat = k === 3 ? M.foilDark : M.foil;
    const m = new THREE.Mesh(g, mat);
    m.rotation.y = Math.PI / 2 - phi;
    m.position.set(Math.cos(phi) * apo, (busTop + busBot) / 2, Math.sin(phi) * apo);
    m.updateMatrix();
    g.applyMatrix4(m.matrix);
    m.position.set(0, 0, 0); m.rotation.set(0, 0, 0);
    wrinkle(g, 0.03, 7.5);
    root.add(shadowed(m));
    // corner posts
    const ca = phi + Math.PI / 6;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.035, busH, 0.035), M.alu);
    post.position.set(Math.cos(ca) * busR, (busTop + busBot) / 2, Math.sin(ca) * busR);
    post.rotation.y = -ca;
    root.add(shadowed(post));
  }
  const hexShape = new THREE.Shape();
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    const px = Math.cos(a) * (busR + 0.03), pz = Math.sin(a) * (busR + 0.03);
    k === 0 ? hexShape.moveTo(px, pz) : hexShape.lineTo(px, pz);
  }
  const deckGeo = new THREE.ExtrudeGeometry(hexShape, { depth: 0.03, bevelEnabled: false });
  deckGeo.rotateX(Math.PI / 2);
  const topDeck = new THREE.Mesh(deckGeo, M.alu); topDeck.position.y = busTop + 0.03; root.add(shadowed(topDeck));
  const botDeck = new THREE.Mesh(deckGeo, M.aluDark); botDeck.position.y = busBot; root.add(shadowed(botDeck));

  // MLI skirt wrapping the base of the cone stack
  const skirtPts = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    skirtPts.push(new THREE.Vector2(0.74 + 0.22 * Math.sin(t * Math.PI * 0.55) + 0.02 * Math.sin(t * 9), busTop + 0.03 + t * 0.34));
  }
  const skirtMat = M.foil.clone();
  for (const k of ['map', 'normalMap', 'roughnessMap']) { skirtMat[k] = M.foil[k].clone(); skirtMat[k].repeat.set(5, 1); }
  skirtMat.normalScale = new THREE.Vector2(1.1, 1.1);
  const skirt = new THREE.Mesh(wrinkle(new THREE.LatheGeometry(skirtPts, 180), 0.07, 9), skirtMat);
  root.add(shadowed(skirt));

  // launch-adapter ring + bottom hardware
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.09, 64, 1, true), M.alu);
  ring.material = M.alu.clone(); ring.material.side = THREE.DoubleSide;
  ring.position.y = busBot - 0.045; root.add(shadowed(ring));
  const omni = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.32, 12), M.white);
  omni.position.set(-0.4, busBot - 0.16, 0.25); root.add(shadowed(omni));
  const omniCap = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.08, 16), M.white);
  omniCap.position.set(-0.4, busBot - 0.34, 0.25); omniCap.rotation.x = Math.PI; root.add(shadowed(omniCap));
  const patch = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.025, 32), M.white);
  patch.position.set(0.2, busBot - 0.02, -0.3); root.add(shadowed(patch));

  // star trackers with baffles on the anti-sun side
  for (const [z, tilt] of [[0.22, 0.5], [-0.22, -0.5]]) {
    const st = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.13, 0.13), M.black); st.add(shadowed(body));
    const baffle = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.05, 0.2, 28, 1, true), M.black.clone());
    baffle.material.side = THREE.DoubleSide; baffle.rotation.z = Math.PI / 2; baffle.position.x = -0.17; st.add(shadowed(baffle));
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.006, 6, 32), M.alu);
    lip.rotation.y = Math.PI / 2; lip.position.x = -0.27; st.add(lip);
    st.position.set(-apo - 0.08, -0.35, z);
    st.rotation.set(tilt * 0.4, tilt, -0.35);
    root.add(st);
  }

  // cable harnesses with clamps (visible on the shield-cam side)
  const harness = (pts, r) => {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    root.add(shadowed(new THREE.Mesh(new THREE.TubeGeometry(curve, 80, r, 10, false), M.cable)));
    for (let i = 1; i < 6; i++) {
      const t = i / 6, p = curve.getPointAt(t), tg = curve.getTangentAt(t);
      const cl = new THREE.Mesh(new THREE.TorusGeometry(r * 1.25, r * 0.35, 6, 16), M.bolt);
      cl.position.copy(p); cl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tg);
      root.add(cl);
    }
  };
  const hx = Math.cos(Math.PI / 3) * apo + 0.06, hz = Math.sin(Math.PI / 3) * apo + 0.06;
  harness([[hx, busBot + 0.1, hz], [hx + 0.02, -0.5, hz + 0.01], [hx - 0.02, -0.15, hz + 0.03], [hx * 0.9, busTop + 0.12, hz * 0.95], [0.62, 0.3, 0.6]], 0.03);
  harness([[hx + 0.05, busBot + 0.1, hz - 0.1], [hx + 0.06, -0.4, hz - 0.08], [hx + 0.04, -0.05, hz - 0.06], [0.7, 0.25, 0.42]], 0.02);
  // connector boxes along the top deck edge
  for (let i = 0; i < 7; i++) {
    const a = 0.2 + i * 0.75;
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.07), i % 2 ? M.aluDark : M.alu);
    box.position.set(Math.cos(a) * (busR - 0.02), busTop + 0.08, Math.sin(a) * (busR - 0.02));
    box.rotation.y = -a; root.add(shadowed(box));
    for (const dz of [-0.025, 0.025]) {
      const b = new THREE.Mesh(boltGeo, M.bolt); b.position.set(0, 0.035, dz); box.add(b);
    }
  }

  // --- fixed solar array on the +X face --------------------------------------------------------
  const PW = 2.3, PH = 1.32, PT = 0.035;
  const panel = new THREE.Group();
  const panelMats = [M.cells, M.panelBack, M.alu, M.alu, M.alu, M.alu];
  const pgeo = new THREE.BoxGeometry(PT, PH, PW);
  const pmesh = new THREE.Mesh(pgeo, panelMats);
  panel.add(shadowed(pmesh));
  for (const [y, h] of [[PH / 2, 0.025], [-PH / 2, 0.025]]) {
    const e = new THREE.Mesh(new THREE.BoxGeometry(PT + 0.012, h, PW + 0.02), M.alu); e.position.y = y; panel.add(shadowed(e));
  }
  for (const z of [PW / 2, -PW / 2]) {
    const e = new THREE.Mesh(new THREE.BoxGeometry(PT + 0.012, PH + 0.02, 0.025), M.alu); e.position.z = z; panel.add(shadowed(e));
  }
  panel.position.set(apo + 0.17, -0.5, 0);
  root.add(panel);
  for (const z of [-0.5, 0.5]) for (const y of [-0.8, -0.2]) {
    const yoke = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.17, 10), M.aluDark);
    yoke.rotation.z = Math.PI / 2; yoke.position.set(apo + 0.075, y, z); root.add(shadowed(yoke));
  }

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return root;
}

// Hull-mounted camera presets (body frame).  dir is the look direction, up is a body-frame hint.
export const HULL_CAMS = [
  { name: 'SHIELD CAM', pos: [1.52, 1.02, 0.62], dir: [-0.12, -0.66, -1.0], up: [0, 1, 0], fov: 72 },
  { name: 'NADIR CAM', pos: [1.35, -1.35, 1.3], dir: [-0.25, -1.0, -0.25], up: [-1, 0.3, -1], fov: 74 },
  // body-mounted action camera: fisheye lens + consumer image processing (see ActionCamPass)
  { name: 'ACTION CAM', pos: [1.55, 0.55, 1.15], dir: [-0.05, -0.62, -1.0], up: [0, 1, 0], fov: 104, action: true },
  { name: 'LIMB CAM', pos: [-1.55, 0.38, -0.95], dir: [-0.42, -0.62, -1.0], up: [0, 1, 0], fov: 66 },
];

// Loads the Blender spacecraft into the same body frame as the procedural model. The GLB is Y-up
// (exporter converted Blender's Z-up) with the solar array facing +Z; a quarter turn about Y puts
// the array normal on +X (sun side), as the simulation and hull cameras expect.
// Returns the (empty) spacecraft group at once and fills it when the file arrives; the loading
// manager keeps the loading screen up until then.
export function loadSphereX(renderer, manager) {
  const root = new THREE.Group();
  root.name = 'SPHEREx';
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  new GLTFLoader(manager).loadAsync('models/spherex.glb').then((gltf) => {
    const model = gltf.scene;
    model.rotation.y = Math.PI / 2;
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) if (m[k]) m[k].anisotropy = aniso;
        // Physical transmission (the small dichroic beamsplitter) makes three.js re-render the whole
        // spacecraft into a mipmapped full-screen buffer every frame (~1.3 ms at 1440p). Plain
        // alpha-blended tinted glass looks the same at this size.
        if (m.transmission > 0) {
          m.opacity = 1 - 0.8 * m.transmission;
          m.transmission = 0;
          m.transparent = true;
          m.depthWrite = false;
        }
      }
    });
    root.add(model);
  }).catch((e) => {
    console.warn('SPHEREx model (models/spherex.glb) could not be loaded; using the procedural model.', e);
    root.add(buildSphereX(renderer));
  });
  return root;
}
