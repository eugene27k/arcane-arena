import * as THREE from 'three';

// Static AABB collision world. The whole arena is authored from axis-aligned
// boxes (stairs are literal steps), so one robust resolver covers player,
// grunts and projectiles. Characters are vertical AABBs (feet-origin).
const EPS = 0.001;

export class CollisionWorld {
  constructor() {
    this.boxes = []; // { min:{x,y,z}, max:{x,y,z} }
  }

  addBox(minX, minY, minZ, maxX, maxY, maxZ) {
    this.boxes.push({
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    });
  }

  _overlapsAt(x, y, z, r, h, skip = -1) {
    for (let i = 0; i < this.boxes.length; i++) {
      if (i === skip) continue;
      const b = this.boxes[i];
      if (
        x + r > b.min.x && x - r < b.max.x &&
        z + r > b.min.z && z - r < b.max.z &&
        y + h > b.min.y && y < b.max.y
      ) return b;
    }
    return null;
  }

  // Move a feet-origin vertical AABB entity. Mutates pos and vel.
  // Returns { grounded, blocked }.
  moveEntity(pos, vel, dt, { radius: r, height: h, stepHeight = 0.45 }, wasGrounded = false) {
    let blocked = false;

    // --- Horizontal axes (X then Z), with step-up ---
    for (const axis of ['x', 'z']) {
      const delta = vel[axis] * dt;
      if (delta === 0) continue;
      pos[axis] += delta;
      let guard = 0;
      while (guard++ < 4) {
        const hit = this._hitAt(pos, r, h);
        if (!hit) break;
        // Try stepping up onto the obstacle (stairs, dais tiers, low rubble).
        const rise = hit.max.y - pos.y;
        const canTryStep = (wasGrounded || vel.y <= 0.5) && rise > 0 && rise <= stepHeight;
        if (canTryStep && !this._overlapsAt(pos.x, hit.max.y + EPS, pos.z, r, h)) {
          pos.y = hit.max.y + EPS;
          wasGrounded = true;
          continue; // re-check horizontal overlap from the raised position
        }
        // Clamp against the box face.
        if (delta > 0) pos[axis] = hit.min[axis] - r - EPS;
        else pos[axis] = hit.max[axis] + r + EPS;
        vel[axis] = 0;
        blocked = true;
        break;
      }
    }

    // --- Vertical axis ---
    let grounded = false;
    const dy = vel.y * dt;
    pos.y += dy;
    const hitY = this._hitAt(pos, r, h);
    if (hitY) {
      if (dy <= 0) {
        pos.y = hitY.max.y + EPS;
        vel.y = 0;
        grounded = true;
      } else {
        pos.y = hitY.min.y - h - EPS;
        vel.y = 0;
      }
      // Rare corner case: clamped into another box — nudge out upward.
      const still = this._hitAt(pos, r, h);
      if (still) pos.y = still.max.y + EPS;
    }
    // Grounded check when not moving down this frame (standing still).
    if (!grounded && Math.abs(dy) < EPS) {
      const below = this._overlapsAt(pos.x, pos.y - 0.06, pos.z, r, 0.05);
      if (below) grounded = true;
    }
    return { grounded, blocked };
  }

  _hitAt(pos, r, h) {
    return this._overlapsAt(pos.x, pos.y, pos.z, r, h);
  }

  // Highest walkable surface at (x,z) with top <= fromY + 0.5. Null over the void.
  groundHeight(x, z, fromY = 1000) {
    let best = null;
    for (const b of this.boxes) {
      if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) {
        if (b.max.y <= fromY + 0.5 && (best === null || b.max.y > best)) best = b.max.y;
      }
    }
    return best;
  }

  // Ray vs world. Returns { t, point, normal } or null. dir must be normalized.
  raycast(origin, dir, maxDist) {
    let bestT = maxDist;
    let bestNormal = null;
    for (const b of this.boxes) {
      const res = rayBox(origin, dir, b, bestT);
      if (res && res.t < bestT) {
        bestT = res.t;
        bestNormal = res.normal;
      }
    }
    if (bestNormal === null) return null;
    return {
      t: bestT,
      point: new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT),
      normal: bestNormal,
    };
  }

  // Line-of-sight between two points (true if unobstructed).
  lineOfSight(a, b) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const dist = dir.length();
    if (dist < EPS) return true;
    dir.divideScalar(dist);
    return this.raycast(a, dir, dist - EPS) === null;
  }

  // Does a point (with small radius) overlap the world? For projectiles.
  pointCollides(p, r = 0.2) {
    return this._overlapsAt(p.x, p.y - r, p.z, r, r * 2) !== null;
  }
}

function rayBox(origin, dir, box, maxT) {
  let tmin = 0;
  let tmax = maxT;
  let normal = null;
  for (const axis of ['x', 'y', 'z']) {
    const o = origin[axis], d = dir[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < box.min[axis] || o > box.max[axis]) return null;
    } else {
      const inv = 1 / d;
      let t1 = (box.min[axis] - o) * inv;
      let t2 = (box.max[axis] - o) * inv;
      let sign = -1;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; sign = 1; }
      if (t1 > tmin) {
        tmin = t1;
        normal = new THREE.Vector3();
        normal[axis] = sign;
      }
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  if (normal === null) return null; // ray started inside the box
  return { t: tmin, normal };
}
