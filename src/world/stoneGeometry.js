import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Turns layout AABBs into stone geometry that doesn't look like a box:
//
//  - chamfered edges, so silhouettes catch a highlight instead of reading as
//    a perfect 90 degree corner;
//  - triplanar UVs derived from *world* position, so a 55 m wall and a 0.4 m
//    trim piece get identical texel density and the masonry runs continuously
//    across neighbouring blocks;
//  - baked per-vertex ambient occlusion, so inside corners, stair undersides
//    and column bases darken even with screen-space AO turned off.

// One extra ring of segments per ~5 m of extent: enough vertices for the baked
// AO to read as a gradient on big surfaces, without wasting them on trim.
function segmentsFor(w, h, d) {
  return Math.max(1, Math.min(4, Math.round(Math.max(w, h, d) / 6)));
}

// Per-triangle world-axis projection. Done per *face* rather than per vertex:
// the chamfer's blended vertex normals would otherwise straddle two projection
// axes inside one triangle and smear the texture across the whole tile.
function projectTriplanarUVs(geo, texel) {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const ax = new THREE.Vector3(), bx = new THREE.Vector3(), cx = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 3) {
    ax.fromBufferAttribute(pos, i);
    bx.fromBufferAttribute(pos, i + 1);
    cx.fromBufferAttribute(pos, i + 2);
    e1.subVectors(bx, ax); e2.subVectors(cx, ax);
    n.crossVectors(e1, e2);

    const nx = Math.abs(n.x), ny = Math.abs(n.y), nz = Math.abs(n.z);
    let uAxis, vAxis;
    if (ny >= nx && ny >= nz) { uAxis = 'x'; vAxis = 'z'; }       // floors, ceilings, stair treads
    else if (nx >= nz) { uAxis = 'z'; vAxis = 'y'; }              // east/west faces
    else { uAxis = 'x'; vAxis = 'y'; }                            // north/south faces

    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? ax : k === 1 ? bx : cx;
      uv[(i + k) * 2] = v[uAxis] / texel;
      uv[(i + k) * 2 + 1] = v[vAxis] / texel;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// ---------------------------------------------------------------- baked AO ---

// Uniform grid over the occluder AABBs so an occlusion sample only tests the
// handful of boxes near it instead of all ~250. Flat Int32 buckets rather than
// a Map: the bake does millions of lookups and string keys dominated the cost.
export function buildOccluderGrid(boxes, cell = 4) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let a = 0; a < 3; a++) {
      if (b.min[a] < lo[a]) lo[a] = b.min[a];
      if (b.max[a] > hi[a]) hi[a] = b.max[a];
    }
  }
  const origin = lo.map((v) => Math.floor(v / cell) - 1);
  const dims = [0, 1, 2].map((a) => Math.ceil(hi[a] / cell) + 2 - origin[a]);
  const total = dims[0] * dims[1] * dims[2];

  // two-pass CSR build: count per cell, prefix-sum, then fill
  const counts = new Int32Array(total + 1);
  const spans = [];
  for (const b of boxes) {
    const i0 = Math.floor(b.min[0] / cell) - origin[0], i1 = Math.floor(b.max[0] / cell) - origin[0];
    const j0 = Math.floor(b.min[1] / cell) - origin[1], j1 = Math.floor(b.max[1] / cell) - origin[1];
    const k0 = Math.floor(b.min[2] / cell) - origin[2], k1 = Math.floor(b.max[2] / cell) - origin[2];
    spans.push([i0, i1, j0, j1, k0, k1]);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++) counts[(i * dims[1] + j) * dims[2] + k + 1]++;
  }
  for (let c = 0; c < total; c++) counts[c + 1] += counts[c];
  const items = new Int32Array(counts[total]);
  const cursor = counts.slice(0, total);
  for (let b = 0; b < spans.length; b++) {
    const [i0, i1, j0, j1, k0, k1] = spans[b];
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++) items[cursor[(i * dims[1] + j) * dims[2] + k]++] = b;
  }
  return { starts: counts, items, cell, origin, dims, boxes };
}

function pointInsideAny(grid, x, y, z) {
  const { starts, items, cell, origin, dims, boxes } = grid;
  const i = Math.floor(x / cell) - origin[0];
  if (i < 0 || i >= dims[0]) return false;
  const j = Math.floor(y / cell) - origin[1];
  if (j < 0 || j >= dims[1]) return false;
  const k = Math.floor(z / cell) - origin[2];
  if (k < 0 || k >= dims[2]) return false;
  const c = (i * dims[1] + j) * dims[2] + k;
  for (let n = starts[c]; n < starts[c + 1]; n++) {
    const { min, max } = boxes[items[n]];
    if (x > min[0] && x < max[0] && y > min[1] && y < max[1] && z > min[2] && z < max[2]) return true;
  }
  return false;
}

// Cosine-ish hemisphere in tangent space (z = surface normal), plus the radii
// each ring is probed at. Near samples dominate — that is what makes inside
// corners go dark while an open wall face stays bright.
const AO_DIRS = [
  [0, 0, 1, 1.0],
  [0.66, 0, 0.75, 0.7], [-0.66, 0, 0.75, 0.7], [0, 0.66, 0.75, 0.7], [0, -0.66, 0.75, 0.7],
  [0.47, 0.47, 0.75, 0.7], [-0.47, 0.47, 0.75, 0.7], [0.47, -0.47, 0.75, 0.7], [-0.47, -0.47, 0.75, 0.7],
  [0.94, 0, 0.34, 0.4], [-0.94, 0, 0.34, 0.4], [0, 0.94, 0.34, 0.4], [0, -0.94, 0.34, 0.4],
];
const AO_RADII = [0.30, 0.95, 2.4];
const AO_RADIUS_W = [1.0, 0.62, 0.30];

export function bakeVertexAO(geo, grid, strength = 1) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const out = new Float32Array(pos.count);
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), n = new THREE.Vector3();

  let total = 0;
  for (const d of AO_DIRS) for (let r = 0; r < AO_RADII.length; r++) total += d[3] * AO_RADIUS_W[r];

  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(nor, i).normalize();
    // any tangent basis will do — the sample set is symmetric about the normal
    if (Math.abs(n.y) < 0.9) t1.set(0, 1, 0).cross(n).normalize();
    else t1.set(1, 0, 0).cross(n).normalize();
    t2.crossVectors(n, t1);

    const px = pos.getX(i) + n.x * 0.02;
    const py = pos.getY(i) + n.y * 0.02;
    const pz = pos.getZ(i) + n.z * 0.02;

    let occ = 0;
    for (const [dx, dy, dz, w] of AO_DIRS) {
      const wx = t1.x * dx + t2.x * dy + n.x * dz;
      const wy = t1.y * dx + t2.y * dy + n.y * dz;
      const wz = t1.z * dx + t2.z * dy + n.z * dz;
      for (let r = 0; r < AO_RADII.length; r++) {
        const rad = AO_RADII[r];
        if (pointInsideAny(grid, px + wx * rad, py + wy * rad, pz + wz * rad)) {
          occ += w * AO_RADIUS_W[r];
          break; // once blocked at this angle, the longer rays are blocked too
        }
      }
    }
    out[i] = Math.max(0.16, 1 - (occ / total) * strength);
  }
  return out;
}

// ------------------------------------------------------------------- boxes ---

/**
 * Build one chamfered, world-UV'd stone box from a layout AABB.
 * `b` is { min:[x,y,z], max:[x,y,z], tint, rot? }.
 */
export function stoneBoxGeometry(b, { texel, bevel = 0.06 } = {}) {
  const w = b.max[0] - b.min[0];
  const h = b.max[1] - b.min[1];
  const d = b.max[2] - b.min[2];
  if (w <= 0 || h <= 0 || d <= 0) return null;

  // keep the chamfer proportional so trim pieces don't turn into pills
  const r = Math.min(bevel, Math.min(w, h, d) * 0.22);
  const geo = new RoundedBoxGeometry(w, h, d, segmentsFor(w, h, d), r);
  if (b.rot) geo.rotateY(b.rot);
  geo.translate(b.min[0] + w / 2, b.min[1] + h / 2, b.min[2] + d / 2);
  projectTriplanarUVs(geo, texel);
  return geo;
}

/**
 * Write per-vertex colour = tint × baked AO. The stone material samples this
 * through vertexColors, so AO survives even with the post stack disabled.
 */
export function applyVertexTint(geo, tintHex, ao, jitter = 0.03, rand = Math.random, gain = 1) {
  const count = geo.attributes.position.count;
  // The layout palette was authored against a flat, unlit-ish material; in
  // linear space those hexes land near 0.11 albedo, which is darker than real
  // stone and leaves the hall unreadable once tone mapping is doing its job.
  const c = new THREE.Color(tintHex).multiplyScalar(gain);
  // Only a whisper of per-block jitter: the texture supplies the variation now,
  // and heavy tint jitter would break up walls the masonry runs continuously across.
  c.multiplyScalar(1 - jitter + rand() * jitter * 2);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = ao ? ao[i] : 1;
    colors[i * 3] = c.r * a;
    colors[i * 3 + 1] = c.g * a;
    colors[i * 3 + 2] = c.b * a;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}
