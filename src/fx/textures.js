import * as THREE from 'three';
import { mulberry32, fbm, clamp01 } from './noise.js';

// Sprite, decal and emissive-panel textures drawn with the canvas 2D API.
// Tiling *surface* textures (stone, marble, cloth, hide) and their normal /
// roughness / AO maps live in surfaces.js — this file is the flat stuff.

export function makeRadialGlowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeSoftDotTexture(size = 64) {
  return makeRadialGlowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', size);
}

// A hotter falloff than a plain radial gradient: white-hot core, long tail.
// Used for flames and impact flashes, where a linear ramp reads as a fuzzy
// ball rather than as something burning.
export function makeFlameTexture(size = 128, hot = '255,236,190', mid = '255,150,40', cool = '190,40,10') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, `rgba(${hot},1)`);
  grad.addColorStop(0.22, `rgba(${hot},0.92)`);
  grad.addColorStop(0.45, `rgba(${mid},0.55)`);
  grad.addColorStop(0.72, `rgba(${cool},0.18)`);
  grad.addColorStop(1.0, `rgba(${cool},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------- gothic windows ---

// A lancet window: pointed arch, stone tracery, leaded quarries and a
// quatrefoil in the head. Emissive, so the post stack blooms it into the room.
export function makeWindowTexture(w = 256, h = 1024) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const rng = mulberry32(2024);

  g.fillStyle = '#05010a';
  g.fillRect(0, 0, w, h);

  // the lit aperture: a lancet, i.e. a rectangle capped by a pointed arch
  const inset = w * 0.13;
  const archTop = h * 0.06;
  const springLine = h * 0.30;
  const lancet = () => {
    g.beginPath();
    g.moveTo(inset, h - inset);
    g.lineTo(inset, springLine);
    g.quadraticCurveTo(inset, archTop, w / 2, archTop);
    g.quadraticCurveTo(w - inset, archTop, w - inset, springLine);
    g.lineTo(w - inset, h - inset);
    g.closePath();
  };

  // glass: cold at the head where the moon strikes, hellish at the sill
  const grad = g.createLinearGradient(0, archTop, 0, h);
  grad.addColorStop(0.00, '#cfd8ff');
  grad.addColorStop(0.14, '#7f86e0');
  grad.addColorStop(0.34, '#4a2f78');
  grad.addColorStop(0.56, '#8e1f3c');
  grad.addColorStop(0.74, '#d8542a');
  grad.addColorStop(0.90, '#7a1414');
  grad.addColorStop(1.00, '#1b0206');
  g.save();
  lancet();
  g.clip();
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // leaded quarries — a diamond lattice of came lines over the glass
  g.strokeStyle = 'rgba(6,4,10,0.72)';
  g.lineWidth = Math.max(1, w / 90);
  const step = w / 4;
  for (let d = -h; d < w + h; d += step) {
    g.beginPath(); g.moveTo(d, 0); g.lineTo(d + h, h); g.stroke();
    g.beginPath(); g.moveTo(d + h, 0); g.lineTo(d, h); g.stroke();
  }

  // a few blown-out panes: brighter, mismatched glass catching the light
  for (let i = 0; i < 26; i++) {
    const x = rng() * w, y = archTop + rng() * (h - archTop);
    g.fillStyle = `rgba(255,${180 + rng() * 60 | 0},${90 + rng() * 90 | 0},${0.10 + rng() * 0.22})`;
    g.fillRect(x - step / 2, y - step / 2, step, step);
  }
  g.restore();

  // stone tracery: mullions, transoms and the quatrefoil in the arch head
  g.strokeStyle = '#0a0710';
  g.fillStyle = '#0a0710';
  const bar = w * 0.055;
  g.fillRect(w / 2 - bar / 2, springLine * 0.82, bar, h - springLine * 0.82 - inset);
  for (let y = springLine + (h - springLine) * 0.24; y < h - inset; y += (h - springLine) * 0.26) {
    g.fillRect(inset, y, w - inset * 2, bar * 0.8);
  }
  g.lineWidth = bar * 0.8;
  const qcx = w / 2, qcy = archTop + (springLine - archTop) * 0.62, qr = w * 0.17;
  g.beginPath(); g.arc(qcx, qcy, qr, 0, Math.PI * 2); g.stroke();
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    g.beginPath();
    g.arc(qcx + Math.cos(a) * qr * 0.62, qcy + Math.sin(a) * qr * 0.62, qr * 0.42, 0, Math.PI * 2);
    g.stroke();
  }

  // the surrounding stone jamb
  g.lineWidth = w * 0.1;
  g.strokeStyle = '#0c0912';
  lancet();
  g.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ----------------------------------------------------------- arcane circle ---

// The summoning circle on the dais. Drawn at high resolution with real glyph
// bands and a soft outer bloom halo, so it holds up when the player stands
// right on top of it.
export function makeArcaneCircleTexture(size = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2;
  const rng = mulberry32(808);
  g.clearRect(0, 0, size, size);

  const glow = (blur, color) => { g.shadowBlur = blur; g.shadowColor = color; };
  g.lineCap = 'round';

  const ink = 'rgba(178,150,255,0.95)';
  const hot = 'rgba(232,214,255,1)';
  g.strokeStyle = ink;
  g.fillStyle = ink;
  glow(size * 0.02, 'rgba(150,110,255,0.9)');

  const ring = (r, w, style = ink) => {
    g.strokeStyle = style; g.lineWidth = w;
    g.beginPath(); g.arc(cx, cx, r * cx, 0, Math.PI * 2); g.stroke();
  };

  ring(0.96, size * 0.006);
  ring(0.925, size * 0.0022);
  ring(0.80, size * 0.004);
  ring(0.545, size * 0.0035);
  ring(0.50, size * 0.0016);
  ring(0.20, size * 0.0028);
  ring(0.085, size * 0.005, hot);

  // heptagram — the classic seven-pointed summoning star
  g.strokeStyle = hot;
  g.lineWidth = size * 0.0045;
  g.beginPath();
  for (let i = 0; i <= 7; i++) {
    const a = (i * 3 * Math.PI * 2) / 7 - Math.PI / 2;
    const x = cx + Math.cos(a) * cx * 0.5, y = cx + Math.sin(a) * cx * 0.5;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();

  // radial tick band between the outer rings
  g.strokeStyle = ink;
  for (let i = 0; i < 96; i++) {
    const a = (i * Math.PI * 2) / 96;
    const long = i % 8 === 0;
    const r0 = 0.925, r1 = long ? 0.845 : (i % 2 ? 0.885 : 0.90);
    g.lineWidth = long ? size * 0.005 : size * 0.0022;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * cx * r0, cx + Math.sin(a) * cx * r0);
    g.lineTo(cx + Math.cos(a) * cx * r1, cx + Math.sin(a) * cx * r1);
    g.stroke();
  }

  // two counter-set glyph bands
  const glyphBand = (radius, count, sizePx, offset) => {
    g.font = `${sizePx}px Georgia, serif`;
    g.textAlign = 'center';
    g.fillStyle = ink;
    for (let i = 0; i < count; i++) {
      const a = (i * Math.PI * 2) / count + offset;
      g.save();
      g.translate(cx + Math.cos(a) * cx * radius, cx + Math.sin(a) * cx * radius);
      g.rotate(a + Math.PI / 2);
      // runic block: elder futhark shapes read as "arcane" without spelling anything
      g.fillText(String.fromCharCode(0x16a0 + Math.floor(rng() * 75)), 0, 0);
      g.restore();
    }
  };
  glyphBand(0.675, 24, size * 0.048, 0.06);
  glyphBand(0.36, 14, size * 0.036, 0.4);

  // sigil spokes joining the inner ring to the star
  g.lineWidth = size * 0.0026;
  for (let i = 0; i < 14; i++) {
    const a = (i * Math.PI * 2) / 14;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * cx * 0.20, cx + Math.sin(a) * cx * 0.20);
    g.lineTo(cx + Math.cos(a) * cx * 0.50, cx + Math.sin(a) * cx * 0.50);
    g.stroke();
  }

  g.shadowBlur = 0;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ------------------------------------------------------------------ decals ---

// Soot bloom for the wall above a torch and scorch marks under braziers.
export function makeScorchTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const rng = mulberry32(555);
  const n = fbm(size, 5, 5, rng);
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dx = x / size - 0.5, dy = y / size - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const a = clamp01((1 - r) * 1.5 - 0.15) * clamp01(n[i] * 1.6);
      const j = i * 4;
      d[j] = 12; d[j + 1] = 9; d[j + 2] = 8;
      d[j + 3] = clamp01(a) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
