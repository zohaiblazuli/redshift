import * as THREE from 'three';
import { HULL_CAMS } from './spherex.js';
import { R_EARTH } from './earth.js';

// Pure camera poses for the spacecraft cameras (chase + hull cameras), shared by the live camera
// (main.js updateCamera) and the background land loading, which needs the exact view each camera
// will have -- now and further along the orbit. Free flight is not handled here.

const cpM = new THREE.Matrix4(), cpV = new THREE.Vector3(), cpV2 = new THREE.Vector3(), cpV3 = new THREE.Vector3();
const cpQ = new THREE.Quaternion(), cpE = new THREE.Euler(0, 0, 0, 'YXZ');
const CP_ORIGIN = new THREE.Vector3();

// mode: 0 = chase, 1..HULL_CAMS.length = hull cameras. sim needs .p, .f, .att.
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
