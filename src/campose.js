import * as THREE from 'three';
import { HULL_CAMS } from './spherex.js';
import { R_EARTH } from './earth.js';

// Pure camera poses for the spacecraft cameras (chase + hull cameras), shared by the live camera
// (main.js updateCamera) and the background land loading, which needs the exact view each camera
// will have -- now and further along the orbit. Free flight is not handled here.

const cpM = new THREE.Matrix4(), cpV = new THREE.Vector3(), cpV2 = new THREE.Vector3(), cpV3 = new THREE.Vector3();
const cpQ = new THREE.Quaternion(), cpE = new THREE.Euler(0, 0, 0, 'YXZ');
const CP_ORIGIN = new THREE.Vector3();

// HERO camera (mode HULL_CAMS.length + 1): a fixed framing only -- the camera faces the Sun's bearing
// with the limb across the frame and the spacecraft (in its real attitude) at HERO.sat. Rendering
// is the same as every other camera. Frame coordinates are NDC (-1..1, y up).
// Tune live via __sx.HERO.
export const HERO_MODE = HULL_CAMS.length + 1;
export const HERO = {
  fov: 38,              // vertical, degrees
  sunX: -0.06,          // the camera faces the Sun's bearing, turned so the Sun sits here across ...
  limbY: -0.16,         // ... with the limb (under the Sun) at this height ...
  roll: -0.38,          // ... rolled so the limb climbs to the right
  sat: [0.44, 0.2],     // where the spacecraft (aim point) sits in frame
  dist: 15,             // camera to spacecraft, metres
  aim: [0, 0.8, 0],     // body-frame aim point (mid photon shield)
};
const heroM = new THREE.Matrix4(), heroQ = new THREE.Quaternion(), heroF = new THREE.Vector3(), heroU = new THREE.Vector3(), heroR = new THREE.Vector3();

// camera orientation for the HERO camera (depends only on where the Sun and the horizon are)
export function heroCamQuat(sim, hullLook, out) {
  const up = sim.p, aspect = hullLook.aspect || 16 / 9;
  const tV = Math.tan(THREE.MathUtils.degToRad(HERO.fov) / 2), tH = tV * aspect;   // fixed: no look-around or zoom
  // the real Sun, not the [ / ]-shifted light: shifting the light must not swing the camera
  const sun = sim.sunDirReal || sim.sunDir;
  heroF.copy(sun).addScaledVector(up, -sun.dot(up));
  if (heroF.lengthSq() < 1e-8) heroF.copy(sim.f);
  heroF.normalize().applyAxisAngle(up, Math.atan(HERO.sunX * tH));
  const dip = Math.acos(R_EARTH / (R_EARTH + sim.alt));
  const el = -dip + Math.atan(-HERO.limbY * tV);
  heroF.multiplyScalar(Math.cos(el)).addScaledVector(up, Math.sin(el));
  heroR.crossVectors(heroF, up).normalize();
  heroU.crossVectors(heroR, heroF);
  heroM.makeBasis(heroR, heroU, heroF.negate());
  out.setFromRotationMatrix(heroM);
  return out.multiply(heroQ.setFromAxisAngle(heroF.set(0, 0, 1), HERO.roll));
}

// mode: 0 = chase, 1..HULL_CAMS.length = hull cameras, HERO_MODE = hero. sim needs .p, .f, .att, .sunDir.
// out: { offset: Vector3 (metres, world axes, camera relative to the spacecraft), quat, fov }
export function cameraPose(mode, sim, orbitCam, hullLook, out) {
  const up = sim.p;
  if (mode === 0) {
    const fwd = sim.f, right = cpV2.crossVectors(fwd, up);
    const look = cpV.set(0, 0, 0)
      .addScaledVector(fwd, Math.cos(orbitCam.pitch) * Math.cos(orbitCam.yaw))
      .addScaledVector(right, Math.cos(orbitCam.pitch) * Math.sin(orbitCam.yaw))
      .addScaledVector(up, -Math.sin(orbitCam.pitch));
    const aim = cpV3.set(0, 0.55, 0).applyQuaternion(sim.att);
    out.offset.copy(look).multiplyScalar(-orbitCam.dist).add(aim);
    cpM.lookAt(out.offset, aim, up);
    out.quat.setFromRotationMatrix(cpM);
    out.fov = 50;
  } else if (mode === HERO_MODE) {
    // the camera faces the Sun on the limb; it stands where the spacecraft lands at HERO.sat
    heroCamQuat(sim, hullLook, out.quat);
    out.fov = HERO.fov;
    const tV = Math.tan(THREE.MathUtils.degToRad(out.fov) / 2), tH = tV * (hullLook.aspect || 16 / 9);
    const toSat = cpV.set(HERO.sat[0] * tH, HERO.sat[1] * tV, -1).normalize().applyQuaternion(out.quat);
    const aim = cpV2.set(...HERO.aim).applyQuaternion(sim.att);
    out.offset.copy(aim).addScaledVector(toSat, -HERO.dist);
  } else {
    const hc = HULL_CAMS[mode - 1];
    cpV.set(...hc.dir).normalize();
    cpV2.set(...hc.up);
    cpM.lookAt(CP_ORIGIN, cpV, cpV2);
    cpQ.setFromRotationMatrix(cpM);
    cpE.set(hullLook.pitch, hullLook.yaw, 0, 'YXZ');
    out.quat.copy(sim.att).multiply(cpQ).multiply(new THREE.Quaternion().setFromEuler(cpE));
    out.offset.set(...hc.pos).applyQuaternion(sim.att);
    out.fov = hc.fov * hullLook.fovMul;
  }
  return out;
}

// The world-space view (km) a pose gives: what the tile manager selects land for.
// out: { pos: Vector3 (km), quat, fov, aspect, viewportH }
export function viewFromPose(sim, pose, aspect, viewportH, out) {
  out.pos.copy(sim.p).multiplyScalar(R_EARTH + sim.alt).addScaledVector(pose.offset, 0.001);
  out.quat.copy(pose.quat);
  out.fov = pose.fov;
  out.aspect = aspect;
  out.viewportH = viewportH;
  return out;
}

export const makePose = () => ({ offset: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 50 });
export const makeView = () => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 50, aspect: 1, viewportH: 1 });
