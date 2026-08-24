import * as THREE from 'three';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
// Frame-rate independent exponential smoothing factor.
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

const TAU = Math.PI * 2;

// Bring an angle home to one turn, in [−π, π). Yaw and world bearings both
// accumulate freely, so anything that subtracts two of them has to be wrapped
// before it is believed.
export const wrapAngle = (a) => {
  const t = (a + Math.PI) % TAU;
  return (t < 0 ? t + TAU : t) - Math.PI;
};

// The short way round from a to b. This is the whole reason a needle crossing
// due south sweeps four degrees instead of spinning three hundred and
// fifty-six the other way — which is precisely the moment the sense exists
// for, since due south is behind you.
export const angleDelta = (a, b) => wrapAngle(b - a);
export const randRange = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(randRange(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function horizontalDist(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Distance from point p to segment [a,b]; also returns closest point param t.
export function pointSegmentDist(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ap = new THREE.Vector3().subVectors(p, a);
  const len2 = ab.lengthSq();
  const t = len2 > 0 ? clamp(ap.dot(ab) / len2, 0, 1) : 0;
  const closest = new THREE.Vector3().copy(a).addScaledVector(ab, t);
  return { dist: closest.distanceTo(p), t, closest };
}

// Segment vs sphere (for sweeping fast projectiles / hitscan against enemies).
export function segmentHitsSphere(a, b, center, radius) {
  const { dist, t } = pointSegmentDist(center, a, b);
  return dist <= radius ? t : -1;
}
