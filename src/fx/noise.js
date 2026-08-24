// Deterministic, tileable procedural noise + height-field utilities.
//
// Everything here operates on plain Float32Array height fields of size*size.
// That is the whole point: one field is generated per surface, then albedo,
// normal, roughness and AO are all *derived* from it, so the four maps agree
// with each other — a crack darkens the albedo, dents the normal, roughens the
// spec and occludes, because they all read the same heights.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => t * t * (3 - 2 * t);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// Smoothstep-interpolated value noise over a freq×freq lattice. Lattice lookups
// wrap, so the result tiles seamlessly — required, since every surface texture
// here is applied with RepeatWrapping across tens of metres of wall.
export function valueNoise(size, freq, rng) {
  freq = Math.max(2, Math.round(freq));
  const lat = new Float32Array(freq * freq);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();

  const out = new Float32Array(size * size);
  const scale = freq / size;
  for (let y = 0; y < size; y++) {
    const fy = y * scale, y0 = Math.floor(fy), ty = smooth(fy - y0);
    const rowA = (y0 % freq) * freq, rowB = ((y0 + 1) % freq) * freq;
    for (let x = 0; x < size; x++) {
      const fx = x * scale, x0 = Math.floor(fx), tx = smooth(fx - x0);
      const xa = x0 % freq, xb = (x0 + 1) % freq;
      const v0 = lerp(lat[rowA + xa], lat[rowA + xb], tx);
      const v1 = lerp(lat[rowB + xa], lat[rowB + xb], tx);
      out[y * size + x] = lerp(v0, v1, ty);
    }
  }
  return out;
}

// Fractal sum of value-noise octaves, normalized to 0..1.
export function fbm(size, baseFreq, octaves, rng, gain = 0.5, lacunarity = 2) {
  const out = new Float32Array(size * size);
  let amp = 1, freq = baseFreq, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(size, freq, rng);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// Ridged fbm — sharp creases instead of soft blobs. Good for marble veining
// and for the eroded, splintered look on broken stone.
export function ridged(size, baseFreq, octaves, rng, gain = 0.5, lacunarity = 2) {
  const out = new Float32Array(size * size);
  let amp = 1, freq = baseFreq, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(size, freq, rng);
    for (let i = 0; i < out.length; i++) out[i] += (1 - Math.abs(n[i] * 2 - 1)) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// Tileable Worley/cellular noise. Returns normalized distance to the nearest
// feature point (0 at a point, 1 far away) — the pebbled/chipped granularity
// that makes stone read as stone rather than as noise.
export function worley(size, cells, rng) {
  cells = Math.max(2, Math.round(cells));
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) { px[i] = rng(); py[i] = rng(); }

  const out = new Float32Array(size * size);
  const cell = size / cells;
  let maxD = 0;
  for (let y = 0; y < size; y++) {
    const cy = Math.floor(y / cell);
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cell);
      let best = Infinity;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = ((cx + ox) % cells + cells) % cells;
          const gy = ((cy + oy) % cells + cells) % cells;
          const i = gy * cells + gx;
          // feature point in *unwrapped* space so distances cross the seam
          const fx = (cx + ox + px[i]) * cell;
          const fy = (cy + oy + py[i]) * cell;
          const dx = x - fx, dy = y - fy;
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
      }
      best = Math.sqrt(best);
      if (best > maxD) maxD = best;
      out[y * size + x] = best;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] / (maxD || 1));
  return out;
}

// ---------- field ops ----------

export function field(size, value = 0) {
  const f = new Float32Array(size * size);
  if (value !== 0) f.fill(value);
  return f;
}

export function mapField(f, fn) {
  const out = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = fn(f[i], i);
  return out;
}

export function combine(a, b, fn) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = fn(a[i], b[i]);
  return out;
}

export function normalizeField(f) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
  const span = hi - lo || 1;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) / span;
  return f;
}

// Separable box blur with wraparound (keeps the field tileable).
export function blurField(src, size, radius) {
  radius = Math.max(1, Math.round(radius));
  const w = radius * 2 + 1;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[row + ((k % size) + size) % size];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = sum / w;
      sum -= src[row + (((x - radius) % size) + size) % size];
      sum += src[row + (((x + radius + 1) % size) + size) % size];
    }
  }
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[((((k % size) + size) % size) * size) + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = sum / w;
      sum -= tmp[(((((y - radius) % size) + size) % size) * size) + x];
      sum += tmp[(((((y + radius + 1) % size) + size) % size) * size) + x];
    }
  }
  return out;
}

// Cheap cavity/AO term: how far below its local neighbourhood a texel sits.
// Crevices, mortar joints and cracks come out dark; raised faces stay white.
export function heightToAO(height, size, radius = size / 24, strength = 2.2) {
  const wide = blurField(height, size, radius);
  const near = blurField(height, size, Math.max(1, radius / 4));
  const out = new Float32Array(height.length);
  for (let i = 0; i < height.length; i++) {
    const occ = (wide[i] - height[i]) * strength + (near[i] - height[i]) * strength * 0.6;
    out[i] = clamp01(1 - Math.max(0, occ));
  }
  return out;
}

// ---------- canvas encoders ----------

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// Tangent-space normal map (OpenGL / +Y-up convention, which is what three
// expects). Canvas row 0 becomes v=1 under the default flipY, so the v
// derivative is the negated canvas-y derivative.
export function heightToNormalCanvas(height, size, strength = 2.5) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = dy, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Single-channel field -> greyscale canvas (roughness / AO / metalness).
export function fieldToCanvas(f, size) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < f.length; i++) {
    const v = clamp01(f[i]) * 255;
    const j = i * 4;
    d[j] = d[j + 1] = d[j + 2] = v;
    d[j + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Per-texel colour callback -> canvas. `fn(i, x, y)` returns [r, g, b] in 0..1.
export function colorToCanvas(size, fn) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0, i = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) {
      const rgb = fn(i, x, y);
      const j = i * 4;
      d[j] = clamp01(rgb[0]) * 255;
      d[j + 1] = clamp01(rgb[1]) * 255;
      d[j + 2] = clamp01(rgb[2]) * 255;
      d[j + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

export { makeCanvas };
