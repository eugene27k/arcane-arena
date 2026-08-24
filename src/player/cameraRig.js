import * as THREE from 'three';
import { CAMERA } from '../config/playerConfig.js';
import { SETTINGS } from '../core/settings.js';
import { clamp, damp, randRange } from '../core/mathUtils.js';

// Third-person orbit camera (PRD §29): shoulder offset, geometry-aware arm,
// smooth follow, FOV kick, trauma-based shake.
export class CameraRig {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.yaw = Math.PI;      // facing -z at start? (set on spawn)
    this.pitch = 0.18;
    this.currentArm = CAMERA.armLength;
    this.trauma = 0;
    this.fovKick = 0;
    this._shakeT = Math.random() * 100;
    this.pivot = new THREE.Vector3();
    this.forward = new THREE.Vector3();
  }

  addTrauma(amount) {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  applyMouse(dx, dy) {
    const sens = CAMERA.sensitivity * SETTINGS.sensMult;
    if (SETTINGS.invertY) dy = -dy;
    this.yaw -= dx * sens;
    this.pitch = clamp(this.pitch + dy * sens, CAMERA.minPitch, CAMERA.maxPitch);
  }

  update(dt, playerPos, sprinting) {
    this._shakeT += dt * 30;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);

    this.pivot.set(playerPos.x, playerPos.y + CAMERA.pivotHeight, playerPos.z);

    // view basis
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    this.forward.set(sy * cp, -sp, cy * cp).normalize();
    const right = new THREE.Vector3(cy, 0, -sy);

    // desired camera position: pivot + shoulder - forward*arm
    const shoulderPivot = new THREE.Vector3().copy(this.pivot).addScaledVector(right, CAMERA.shoulderX);
    const back = new THREE.Vector3().copy(this.forward).multiplyScalar(-1);
    let targetArm = CAMERA.armLength;
    const hit = this.world.raycast(shoulderPivot, back, CAMERA.armLength + CAMERA.collisionPad);
    if (hit) targetArm = Math.max(0.4, hit.t - CAMERA.collisionPad);
    // snap in quickly when blocked, ease out when free
    const rate = targetArm < this.currentArm ? 30 : 6;
    this.currentArm += (targetArm - this.currentArm) * damp(rate, dt);

    const camPos = new THREE.Vector3().copy(shoulderPivot).addScaledVector(back, this.currentArm);

    // shake
    const t2 = this.trauma * this.trauma;
    if (t2 > 0.0001) {
      camPos.x += (Math.sin(this._shakeT * 1.3) + Math.sin(this._shakeT * 3.7)) * 0.09 * t2;
      camPos.y += (Math.sin(this._shakeT * 1.7 + 2) + Math.sin(this._shakeT * 4.3)) * 0.09 * t2;
      camPos.z += (Math.sin(this._shakeT * 1.1 + 4) + Math.sin(this._shakeT * 3.1)) * 0.07 * t2;
    }

    this.camera.position.copy(camPos);
    this.camera.lookAt(
      this.pivot.x + this.forward.x * 8,
      this.pivot.y + this.forward.y * 8,
      this.pivot.z + this.forward.z * 8
    );
    if (t2 > 0.0001) this.camera.rotation.z += Math.sin(this._shakeT * 2.3) * 0.018 * t2;

    // FOV: user base + sprint widen + cast kick
    this.fovKick = Math.max(0, this.fovKick - dt * 60);
    const baseFov = SETTINGS.fov + (sprinting ? CAMERA.sprintFov - CAMERA.fov : 0);
    const targetFov = baseFov + this.fovKick;
    this.camera.fov += (targetFov - this.camera.fov) * damp(10, dt);
    this.camera.updateProjectionMatrix();
  }

  // Where is the crosshair pointing? Ray starts near the player so geometry
  // behind/beside the character can't be hit.
  getAimPoint() {
    const origin = new THREE.Vector3().copy(this.camera.position).addScaledVector(this.forward, this.currentArm * 0.9);
    const hit = this.world.raycast(origin, this.forward, CAMERA.aimMaxDist);
    const point = hit ? hit.point : new THREE.Vector3().copy(origin).addScaledVector(this.forward, CAMERA.aimMaxDist);
    return { origin, dir: this.forward.clone(), point, hitWorld: !!hit, worldDist: hit ? hit.t : Infinity };
  }
}
