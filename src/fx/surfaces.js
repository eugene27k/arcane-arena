import * as THREE from 'three';
import {
  mulberry32, fbm, ridged, worley, blurField, heightToAO,
  heightToNormalCanvas, fieldToCanvas, colorToCanvas, clamp01, lerp,
} from './noise.js';

// Procedural PBR surfaces. Each builder produces a *height field* first, then
// derives albedo / normal / roughness / AO from it, so every map agrees: a
// mortar joint is dark in albedo, dented in the normal, rough in the spec and
// occluded in AO. No image files — it all comes out of Math.
//
// Authored at TEXEL_SCALE metres per tile; arenaBuilder divides world
// coordinates by that to get uniform texel density on every surface.
export const TEXEL_SCALE = 2.4;

let anisotropy = 4;
export function setSurfaceAnisotropy(v) { anisotropy = v; }

const cache = new Map();

function toTexture(canvas, { srgb = false } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Lay out a running-bond brick grid. Returns per-texel block identity plus the
// joint mask and edge distance, which the surface builders use to recess
// mortar, vary block tone, and round off worn block corners.
function brickLayout(size, cols, rows, jointPx, rng, stagger = 0.5) {
  const bw = size / cols, bh = size / rows;
  const idRand = new Float32Array(size * size);
  const idRand2 = new Float32Array(size * size);
  const joint = new Float32Array(size * size);
  const edge = new Float32Array(size * size);

  // per-block randoms (rows must be even for the stagger to tile)
  const rA = new Float32Array(rows * cols);
  const rB = new Float32Array(rows * cols);
  for (let i = 0; i < rA.length; i++) { rA[i] = rng(); rB[i] = rng(); }

  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / bh) % rows;
    const off = (row % 2) * bw * stagger;
    const ly = y - Math.floor(y / bh) * bh;
    for (let x = 0; x < size; x++) {
      const bxf = (x - off + size) % size;
      const col = Math.floor(bxf / bw) % cols;
      const lx = bxf - Math.floor(bxf / bw) * bw;
      const i = y * size + x;
      const k = row * cols + col;
      idRand[i] = rA[k];
      idRand2[i] = rB[k];
      const d = Math.min(lx, bw - lx, ly, bh - ly);
      edge[i] = clamp01(d / (Math.min(bw, bh) * 0.5));
      joint[i] = 1 - clamp01(d / jointPx);
    }
  }
  return { joint, edge, idRand, idRand2 };
}

// Carve branching cracks into a height field by random-walking and stamping a
// soft, tapering groove. Wraps at the edges so the texture still tiles.
function carveCracks(h, size, count, rng, depth = 0.5, len = 90) {
  const stamp = (cx, cy, r, amount) => {
    const ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const x = (((cx + dx) % size) + size) % size;
        const y = (((cy + dy) % size) + size) % size;
        const f = 1 - d / r;
        const i = y * size + x;
        h[i] -= amount * f * f;
      }
    }
  };
  for (let c = 0; c < count; c++) {
    let x = rng() * size, y = rng() * size;
    let a = rng() * Math.PI * 2;
    const steps = Math.round(len * (0.5 + rng()));
    let width = 1 + rng() * 1.8;
    for (let s = 0; s < steps; s++) {
      a += (rng() - 0.5) * 0.55;
      x += Math.cos(a); y += Math.sin(a);
      const taper = 1 - s / steps;
      stamp(Math.round(x), Math.round(y), Math.max(0.8, width * taper), depth * taper);
      if (rng() < 0.012) { a += (rng() - 0.5) * 2.2; width *= 0.75; } // branch kink
    }
  }
}

// Knock chips out of the surface — shallow craters, denser near block edges.
function chipSurface(h, size, count, rng, edge, depth = 0.35) {
  for (let c = 0; c < count; c++) {
    const cx = Math.floor(rng() * size), cy = Math.floor(rng() * size);
    // bias toward worn corners: reject most hits in the middle of a block
    if (edge && edge[cy * size + cx] > 0.45 && rng() < 0.8) continue;
    const r = 2 + rng() * 9;
    const ri = Math.ceil(r);
    const d0 = depth * (0.4 + rng());
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        const d = Math.hypot(dx, dy) / r;
        if (d > 1) continue;
        const x = (((cx + dx) % size) + size) % size;
        const y = (((cy + dy) % size) + size) % size;
        h[y * size + x] -= d0 * (1 - d * d) * (0.6 + 0.4 * rng());
      }
    }
  }
}

// Shared tail end of every builder: normal + roughness + AO textures.
function finishMaps(out, height, size, opts) {
  const ao = heightToAO(height, size, size / 22, opts.aoStrength ?? 2.4);
  out.normalMap = toTexture(heightToNormalCanvas(height, size, opts.normalStrength ?? 3.0));
  out.aoMap = toTexture(fieldToCanvas(ao, size));
  return ao;
}

// ---------------------------------------------------------------- ashlar ----
// Cathedral wall/column blockwork: staggered courses, recessed mortar, cracks,
// chipped corners, soot bloom above where torches sit.
function buildAshlar(size, seed) {
  const rng = mulberry32(seed);
  const { joint, edge, idRand, idRand2 } = brickLayout(size, 2, 4, size / 64, rng);

  const grain = fbm(size, 10, 5, rng);
  const pit = worley(size, 30, rng);
  const coarse = fbm(size, 3, 3, rng);
  // large-scale blotching so a wall never reads as one flat tone
  const patch = fbm(size, 2, 3, rng);

  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) {
    const blockLift = (idRand[i] - 0.5) * 0.24;          // courses sit unevenly
    const bevel = clamp01(edge[i] / 0.14);               // worn arris, flat face
    h[i] = 0.55
      + blockLift
      + grain[i] * 0.26
      + (pit[i] - 0.5) * 0.13
      + coarse[i] * 0.08
      - joint[i] * 0.62 * (0.8 + 0.4 * idRand2[i])       // mortar recess
      - (1 - bevel) * 0.10;
  }
  carveCracks(h, size, 5, rng, 0.30, 110);
  chipSurface(h, size, 110, rng, edge, 0.22);

  // weathering: slow vertical drips + a broad soot gradient toward the top
  const drip = fbm(size, 26, 3, rng);
  const dripV = blurField(drip, size, size / 60);
  const moss = fbm(size, 6, 4, rng);

  const out = {};
  const ao = finishMaps(out, h, size, { normalStrength: 3.4, aoStrength: 2.6 });

  out.map = toTexture(colorToCanvas(size, (i, x, y) => {
    const hv = h[i];
    // base limestone, tinted per block so courses read individually
    const tone = 0.66 + (idRand[i] - 0.5) * 0.34 + (hv - 0.55) * 0.42 + (patch[i] - 0.5) * 0.20;
    let r = tone * 1.00, g = tone * 0.975, b = tone * 0.95;

    // mortar: colder, paler, and it stays visibly separate from the blocks
    const j = joint[i];
    r = lerp(r, tone * 0.70, j); g = lerp(g, tone * 0.71, j); b = lerp(b, tone * 0.78, j);

    // damp green-grey moss creeping out of the joints, low on the wall
    const m = clamp01((moss[i] - 0.56) * 3.4) * clamp01(j * 1.4 + 0.22) * (y / size);
    r = lerp(r, tone * 0.44, m * 0.75); g = lerp(g, tone * 0.60, m * 0.75); b = lerp(b, tone * 0.44, m * 0.75);

    // soot: heavier toward the top of the tile, streaked by the drip field
    const soot = clamp01((1 - y / size) * 0.55 + dripV[i] * 0.5 - 0.32) * 0.55;
    r *= 1 - soot * 0.72; g *= 1 - soot * 0.76; b *= 1 - soot * 0.72;

    // bake a little cavity darkening into albedo so it survives flat lighting
    const c = 0.55 + ao[i] * 0.45;
    return [r * c, g * c, b * c];
  }), { srgb: true });

  out.roughnessMap = toTexture(fieldToCanvas(new Float32Array(h.length).map((_, i) => {
    // polished-ish block faces, gritty mortar, rougher where chipped
    const base = 0.72 - (h[i] - 0.55) * 0.30 + (idRand2[i] - 0.5) * 0.10;
    return clamp01(base + joint[i] * 0.24 + (1 - ao[i]) * 0.12);
  }), size));

  return out;
}

// ------------------------------------------------------------------ slab ----
// Big floor flagstones: wider, flatter, scuffed rather than chipped. The camera
// spends most of its time looking at this, so it gets the finest grain.
function buildSlab(size, seed) {
  const rng = mulberry32(seed);
  const { joint, edge, idRand, idRand2 } = brickLayout(size, 2, 2, size / 110, rng, 0.5);

  const grain = fbm(size, 14, 5, rng);
  const swirl = ridged(size, 5, 4, rng);
  const pit = worley(size, 34, rng);

  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) {
    const bevel = clamp01(edge[i] / 0.18);
    h[i] = 0.60
      + (idRand[i] - 0.5) * 0.14
      + grain[i] * 0.20
      + (pit[i] - 0.5) * 0.07
      + swirl[i] * 0.05
      - joint[i] * 0.55
      - (1 - bevel) * 0.13;
  }
  carveCracks(h, size, 7, rng, 0.26, 150);
  chipSurface(h, size, 70, rng, edge, 0.16);

  // scuff paths — worn, polished tracks where feet have crossed the flagstones
  const scuff = blurField(fbm(size, 4, 3, rng), size, size / 40);

  const out = {};
  const ao = finishMaps(out, h, size, { normalStrength: 2.6, aoStrength: 2.2 });

  out.map = toTexture(colorToCanvas(size, (i) => {
    const tone = 0.64 + (idRand[i] - 0.5) * 0.24 + (h[i] - 0.6) * 0.55;
    let r = tone * 0.99, g = tone * 0.97, b = tone * 1.00;
    const j = joint[i];
    r = lerp(r, tone * 0.60, j); g = lerp(g, tone * 0.60, j); b = lerp(b, tone * 0.66, j);
    // faint iron-rust bleed out of the cracks
    const rust = clamp01((0.5 - h[i]) * 2.2) * clamp01(swirl[i] * 1.4 - 0.35);
    r = lerp(r, tone * 0.72, rust * 0.6); g = lerp(g, tone * 0.46, rust * 0.6); b = lerp(b, tone * 0.34, rust * 0.6);
    const c = (0.58 + ao[i] * 0.42) * (0.94 + scuff[i] * 0.12);
    return [r * c, g * c, b * c];
  }), { srgb: true });

  out.roughnessMap = toTexture(fieldToCanvas(new Float32Array(h.length).map((_, i) => {
    // scuffed tracks are burnished — noticeably glossier than the raw stone
    return clamp01(0.80 - scuff[i] * 0.34 + joint[i] * 0.18 + (idRand2[i] - 0.5) * 0.08);
  }), size));

  return out;
}

// ---------------------------------------------------------------- marble ----
// The dais: dark polished stone with bright veining. Low roughness so torches
// and the arcane circle actually reflect off it.
function buildMarble(size, seed) {
  const rng = mulberry32(seed);
  const vein = ridged(size, 4, 5, rng, 0.55);
  const vein2 = ridged(size, 11, 4, rng, 0.5);
  const grain = fbm(size, 20, 4, rng);
  const { joint } = brickLayout(size, 2, 2, size / 200, rng, 0);

  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) {
    h[i] = 0.62 + grain[i] * 0.06 + Math.pow(vein[i], 3) * 0.07 - joint[i] * 0.5;
  }
  carveCracks(h, size, 2, rng, 0.16, 70);

  const out = {};
  const ao = finishMaps(out, h, size, { normalStrength: 1.5, aoStrength: 1.8 });

  out.map = toTexture(colorToCanvas(size, (i) => {
    const v = clamp01(Math.pow(vein[i], 4) * 2.6 + Math.pow(vein2[i], 6) * 1.4);
    // near-black violet body, cold pale veins
    let r = lerp(0.30, 0.86, v), g = lerp(0.27, 0.84, v), b = lerp(0.36, 0.94, v);
    const g2 = 0.9 + grain[i] * 0.2;
    const j = joint[i];
    r = lerp(r * g2, 0.16, j); g = lerp(g * g2, 0.15, j); b = lerp(b * g2, 0.21, j);
    const c = 0.6 + ao[i] * 0.4;
    return [r * c, g * c, b * c];
  }), { srgb: true });

  out.roughnessMap = toTexture(fieldToCanvas(new Float32Array(h.length).map((_, i) => {
    return clamp01(0.30 + grain[i] * 0.18 + joint[i] * 0.4 - Math.pow(vein[i], 4) * 0.1);
  }), size));

  out.metalnessMap = toTexture(fieldToCanvas(new Float32Array(h.length).map((_, i) => {
    return clamp01(0.18 + Math.pow(vein[i], 5) * 0.5);
  }), size));

  return out;
}

// ----------------------------------------------------------------- rough ----
// Raw broken rock for rubble, jagged abyss edges and column stumps: no
// blockwork at all, just fracture.
function buildRough(size, seed) {
  const rng = mulberry32(seed);
  const cell = worley(size, 9, rng);
  const cellFine = worley(size, 30, rng);
  const rid = ridged(size, 7, 5, rng);
  const grain = fbm(size, 18, 4, rng);

  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) {
    // faceted planes from the coarse cells, then fracture detail on top
    h[i] = 0.5 + Math.pow(cell[i], 0.7) * 0.34 + cellFine[i] * 0.14 + rid[i] * 0.12 + grain[i] * 0.10;
  }
  carveCracks(h, size, 9, rng, 0.34, 70);
  chipSurface(h, size, 300, rng, null, 0.30);

  const out = {};
  const ao = finishMaps(out, h, size, { normalStrength: 4.2, aoStrength: 3.0 });

  out.map = toTexture(colorToCanvas(size, (i) => {
    const tone = 0.56 + (h[i] - 0.5) * 0.5 + grain[i] * 0.1;
    // freshly broken faces are paler than the weathered outside
    const fresh = clamp01((cell[i] - 0.55) * 2.4);
    let r = lerp(tone * 0.92, tone * 1.06, fresh);
    let g = lerp(tone * 0.90, tone * 1.03, fresh);
    let b = lerp(tone * 0.96, tone * 1.08, fresh);
    const c = 0.45 + ao[i] * 0.55;
    return [r * c, g * c, b * c];
  }), { srgb: true });

  out.roughnessMap = toTexture(fieldToCanvas(new Float32Array(h.length).map((_, i) => {
    return clamp01(0.90 - (h[i] - 0.5) * 0.2 + (1 - ao[i]) * 0.1);
  }), size));

  return out;
}

// ------------------------------------------------------------ characters ----
// Coarse woven wool for the wizard's robe: a visible weave plus sag folds.
function buildCloth(size, seed) {
  const rng = mulberry32(seed);
  const grain = fbm(size, 24, 3, rng);
  const folds = ridged(size, 3, 3, rng);
  const h = new Float32Array(size * size);
  const period = Math.max(3, Math.round(size / 96));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // over/under weave: warp and weft alternate which one sits proud
      const wx = Math.sin((x / period) * Math.PI * 2);
      const wy = Math.sin((y / period) * Math.PI * 2);
      const over = ((Math.floor(x / period) + Math.floor(y / period)) % 2) ? wx : wy;
      h[i] = 0.5 + over * 0.16 + grain[i] * 0.12 + folds[i] * 0.30;
    }
  }
  const out = {};
  const ao = finishMaps(out, h, size, { normalStrength: 2.0, aoStrength: 2.0 });
  out.map = toTexture(colorToCanvas(size, (i) => {
    const t = (0.72 + (h[i] - 0.5) * 0.5) * (0.55 + ao[i] * 0.45);
    return [t, t * 0.98, t * 1.02];
  }), { srgb: true });
  out.roughnessMap = toTexture(fieldToCanvas(new Float32Array(h.length).map((_, i) => {
    return clamp01(0.88 - (h[i] - 0.5) * 0.18);
  }), size));
  return out;
}

// Demon hide: pebbled scale cells with raised veins between them.
function buildHide(size, seed) {
  const rng = mulberry32(seed);
  const scales = worley(size, 22, rng);
  const veins = ridged(size, 6, 4, rng);
  const grain = fbm(size, 30, 3, rng);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) {
    h[i] = 0.5 + Math.pow(1 - scales[i], 1.6) * 0.34 + Math.pow(veins[i], 4) * 0.22 + grain[i] * 0.08;
  }
  const out = {};
  const ao = finishMaps(out, h, size, { normalStrength: 3.2, aoStrength: 2.6 });
  out.map = toTexture(colorToCanvas(size, (i) => {
    const t = (0.70 + (h[i] - 0.5) * 0.55) * (0.5 + ao[i] * 0.5);
    const hot = Math.pow(veins[i], 5); // cracks between scales glow warm
    return [t + hot * 0.5, t * 0.86, t * 0.82];
  }), { srgb: true });
  out.roughnessMap = toTexture(fieldToCanvas(new Float32Array(h.length).map((_, i) => {
    return clamp01(0.62 + (1 - scales[i]) * 0.2 + grain[i] * 0.12);
  }), size));
  // the inter-scale veins are what the emissive should burn through
  out.emissiveMap = toTexture(fieldToCanvas(new Float32Array(h.length).map((_, i) => {
    return clamp01(Math.pow(veins[i], 6) * 2.4);
  }), size), { srgb: true });
  return out;
}

const BUILDERS = { ashlar: buildAshlar, slab: buildSlab, marble: buildMarble, rough: buildRough, cloth: buildCloth, hide: buildHide };

// Cached so repeated requests (and hot module reloads) reuse the GPU textures.
export function getSurface(kind, size = 512, seed = 1337) {
  const key = `${kind}:${size}:${seed}`;
  let s = cache.get(key);
  if (!s) {
    const build = BUILDERS[kind];
    if (!build) throw new Error(`unknown surface "${kind}"`);
    s = build(size, seed);
    cache.set(key, s);
  }
  return s;
}

export function disposeSurfaces() {
  for (const s of cache.values()) for (const t of Object.values(s)) t.dispose?.();
  cache.clear();
}
