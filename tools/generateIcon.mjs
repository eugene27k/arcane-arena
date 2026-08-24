#!/usr/bin/env node
// The app icon, rendered from code — `npm run icon`.
//
// Arcane Arena ships no image files, so the desktop icon is generated the same
// way the surfaces and the soundtrack are: a deterministic script, checked in as
// source, its output left in build/ and never committed.
//
// Every size is drawn natively rather than downsampled from a 1024 master. Fine
// sigil linework turns to grey mush under Lanczos, and the 16px Windows taskbar
// icon is the one people actually look at most. Drawing each size from the same
// signed-distance description keeps all of them crisp, and lets detail drop out
// by tier instead of dissolving.
//
// The composition — "the sigil and the ember": a summoning circle seen from
// directly above, a fireball burning at its centre, framed by the HUD's gold on
// cathedral dark. Three concentric hues (gold ring, violet sigil, orange core)
// is what makes it survive at 16px, where none of the detail does.

import { deflateSync } from 'node:zlib';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mulberry32, fbm } from '../src/fx/noise.js';

// ---------------------------------------------------------------- palette ---
// Every value is lifted from the running game so the icon and the arena cannot
// drift apart; the citation is the file it came from.
const C = {
  plateTop: [0x14, 0x0a, 0x1e],   // styles.css void, lit edge
  plateBot: [0x05, 0x03, 0x0a],   // styles.css void, deep
  stone:    [0x4e, 0x48, 0x58],   // src/fx/surfaces.js ashlar
  gold:     [0xd8, 0xb4, 0x6a],   // styles.css --gold
  goldDim:  [0x8a, 0x74, 0x4a],   // styles.css --gold-dim
  ink:      [0xb2, 0x96, 0xff],   // src/fx/textures.js:150 arcane circle ink
  hot:      [0xe8, 0xd6, 0xff],   // src/fx/textures.js:151 arcane circle hot
  // src/fx/textures.js:75-81 — the stained-glass ramp, apex to sill.
  glass: [
    [0.00, [0xcf, 0xd8, 0xff]], [0.14, [0x7f, 0x86, 0xe0]],
    [0.34, [0x4a, 0x2f, 0x78]], [0.56, [0x8e, 0x1f, 0x3c]],
    [0.74, [0xd8, 0x54, 0x2a]], [1.00, [0x7a, 0x14, 0x14]],
  ],
  // The fireball, src/config/spellConfig.js:42 (0xff7a30) opened out into a core.
  emberCore: [0xff, 0xf2, 0xd8],
  emberMid:  [0xff, 0x7a, 0x30],
  emberEdge: [0x8e, 0x1f, 0x0c],
};

const G = {
  plateA: 0.4375,   // squircle half-extent: 6.25% margin, so macOS Dock sizing is right
  plateN: 4.6,      // superellipse exponent — the macOS corner
  goldR: 0.4025, goldW: 0.0085,
  ringA: 0.335, ringAW: 0.0075,
  ringB: 0.305, ringBW: 0.0022,
  ringC: 0.148, ringCW: 0.0026,
  starR: 0.288,     // heptagram circumradius
  emberR: 0.104,    // fireball core radius
};

// ------------------------------------------------------------ PNG encoder ---
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(rgba, w, h) {
  const stride = w * 4, need = stride * h;
  // rgba.buffer reaches past the view's own length, so a short array would
  // silently encode whatever bytes happen to follow it rather than failing.
  if (!ArrayBuffer.isView(rgba) || rgba.BYTES_PER_ELEMENT !== 1) {
    throw new TypeError('encodePNG: rgba must be a byte view');
  }
  if (rgba.length !== need) {
    throw new RangeError(`encodePNG: need ${need} bytes for ${w}x${h}, got ${rgba.length}`);
  }
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, need);
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;  // filter 0 = None; the image is noisy, so filters buy little
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type 6 = RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ ICO encoder ---
// Vista and later read a PNG payload straight out of an .ico, so the container
// is a 6-byte directory plus one 16-byte entry per image and no BMP/DIB
// encoding at all. electron-builder only ever parses the directory.
function encodeICO(images) {
  const count = images.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type 1 = icon
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const o = 6 + i * 16;
    header[o] = img.size >= 256 ? 0 : img.size;      // 0 is the spec's encoding for 256
    header[o + 1] = img.size >= 256 ? 0 : img.size;
    header[o + 2] = 0;   // palette entries — none, truecolour
    header[o + 3] = 0;   // reserved
    header.writeUInt16LE(1, o + 4);    // colour planes
    header.writeUInt16LE(32, o + 6);   // bits per pixel
    header.writeUInt32LE(img.buf.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += img.buf.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.buf)]);
}

// -------------------------------------------------------------- sdf tools ---
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// Coverage from a signed distance: 1 well inside, 0 well outside, analytically
// antialiased across a pixel. No supersampling, which is what keeps 16px sharp.
const cover = (d, e) => clamp01(0.5 - d / (2 * e));

const ring = (r, r0, w) => Math.abs(r - r0) - w;

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

function ramp(stops, t) {
  t = clamp01(t);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
      return mix(c0, c1, (t - p0) / (p1 - p0 || 1));
    }
  }
  return stops[stops.length - 1][1];
}

// Paint `col` over the accumulator at strength `a`. Additive for anything that
// glows, so overlapping sigil strokes brighten the way the in-game bloom does.
function over(dst, i, col, a) {
  if (a <= 0) return;
  dst[i] = lerp(dst[i], col[0], a);
  dst[i + 1] = lerp(dst[i + 1], col[1], a);
  dst[i + 2] = lerp(dst[i + 2], col[2], a);
}

function add(dst, i, col, a) {
  if (a <= 0) return;
  dst[i] = Math.min(255, dst[i] + col[0] * a);
  dst[i + 1] = Math.min(255, dst[i + 1] + col[1] * a);
  dst[i + 2] = Math.min(255, dst[i + 2] + col[2] * a);
}

// ---------------------------------------------------------------- the art ---
export function renderIcon(S) {
  // Detail tiers. Below 64px the sigil ticks and the stone grain are sub-pixel
  // noise that only muddies the silhouette, so they simply do not exist there.
  const tier = S >= 256 ? 3 : S >= 128 ? 2 : S >= 64 ? 1 : 0;
  const e = 1.5 / S;                    // antialias width, one and a half pixels
  const tiny = S <= 32;                 // widen hairlines so they land as a solid pixel

  const rgb = new Float32Array(S * S * 3);
  const alpha = new Float32Array(S * S);

  // Stone grain, the same fbm the arena's ashlar uses. Generated once per size.
  const grain = tier >= 2 ? fbm(S, 5, 5, mulberry32(1337)) : null;

  const starPts = [];
  for (let i = 0; i < 7; i++) {
    const a = (i * 2 * Math.PI) / 7 - Math.PI / 2;
    starPts.push([Math.cos(a) * G.starR, Math.sin(a) * G.starR]);
  }

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = y * S + x;
      const u = (x + 0.5) / S - 0.5;
      const v = (y + 0.5) / S - 0.5;
      const r = Math.hypot(u, v);
      const p = idx * 3;

      // 1. Plate — the macOS superellipse, so it sits right in the Dock.
      const dPlate = Math.pow(
        Math.pow(Math.abs(u / G.plateA), G.plateN) + Math.pow(Math.abs(v / G.plateA), G.plateN),
        1 / G.plateN
      ) - 1;
      const a = cover(dPlate * G.plateA, e);
      if (a <= 0) continue;
      alpha[idx] = a;

      let col = mix(C.plateTop, C.plateBot, Math.pow(clamp01((v + G.plateA) / (2 * G.plateA)), 0.85));
      const vig = 1 - 0.35 * clamp01((r - 0.24) / 0.30);
      col = [col[0] * vig, col[1] * vig, col[2] * vig];
      rgb[p] = col[0]; rgb[p + 1] = col[1]; rgb[p + 2] = col[2];

      // 2. Stone grain — gone by 64px, which is the point.
      if (grain) over(rgb, p, C.stone, 0.045 * Math.abs(grain[idx] - 0.5) * 2);

      // 3. Lancet windows. A whisper of the ruined cathedral behind the circle;
      //    pure depth cue, never legible as a shape.
      if (tier >= 2) {
        const sill = 0.30, spring = -0.02, apex = -0.20, halfW = 0.0425;
        for (const uc of [-0.19, 0, 0.19]) {
          if (v > sill || v < apex) continue;
          // The ogive: a plain half-width gives a round arch, the exponent makes
          // it point.
          const prof = v >= spring
            ? 1
            : Math.sqrt(Math.max(0, 1 - Math.pow((spring - v) / (spring - apex), 1.7)));
          const d = Math.abs(u - uc) - halfW * prof;
          const c = cover(d, e);
          if (c > 0) over(rgb, p, ramp(C.glass, (v - apex) / (sill - apex)), 0.13 * c);
        }
      }

      // 4. Gold arena ring, lit from the fire below.
      {
        const w = tiny ? 0.014 : G.goldW;
        const c = cover(ring(r, G.goldR, w), e);
        if (c > 0) over(rgb, p, mix(C.goldDim, C.gold, clamp01(0.5 - v / 0.8)), c);
        // A hairline of void inside it, so the gold reads as a rim and not a disc edge.
        if (!tiny) over(rgb, p, C.plateBot, 0.4 * cover(ring(r, G.goldR - 0.016, 0.0016), e));
      }

      // 5. The summoning circle. Additive — overlapping strokes bloom.
      {
        const wA = tiny ? 0.016 : G.ringAW;
        add(rgb, p, C.ink, 0.95 * cover(ring(r, G.ringA, wA), e));
        if (tier >= 1) {
          add(rgb, p, C.ink, 0.7 * cover(ring(r, G.ringB, G.ringBW), e));
          add(rgb, p, C.ink, 0.7 * cover(ring(r, G.ringC, G.ringCW), e));
        }
        // Tick band between rings A and B.
        if (tier >= 2) {
          const n = tier >= 3 ? 96 : 32;
          const ang = Math.atan2(v, u);
          const k = Math.round((ang / (2 * Math.PI)) * n);
          const long = k % 8 === 0;
          const inner = long ? G.ringB - 0.012 : G.ringB + 0.004;
          if (r > inner && r < G.ringA - 0.004) {
            const ta = (k / n) * 2 * Math.PI;
            const d = Math.abs(Math.sin(ang - ta)) * r - (long ? 0.0022 : 0.0013);
            add(rgb, p, long ? C.hot : C.ink, 0.8 * cover(d, e));
          }
        }
        // Heptagram {7/3} — seven spells, and a star that only a wizard draws.
        if (tier >= 1) {
          let d = 1e9;
          for (let i = 0; i < 7; i++) {
            const A = starPts[i], B = starPts[(i + 3) % 7];
            d = Math.min(d, sdSegment(u, v, A[0], A[1], B[0], B[1]));
          }
          add(rgb, p, C.ink, 0.85 * cover(d - (tier >= 2 ? 0.0026 : 0.004), e));
        }
      }

      // 6. The ember at the centre — a fireball mid-cast, core to edge.
      {
        const t = r / G.emberR;
        if (t < 1.35) {
          const core = mix(C.emberCore, C.emberMid, clamp01(Math.pow(t, 0.7)));
          over(rgb, p, mix(core, C.emberEdge, clamp01((t - 0.72) / 0.5)), cover(r - G.emberR, e));
          // Halo: the bloom the postfx stack would put around a live projectile.
          add(rgb, p, C.emberMid, 0.5 * Math.exp(-Math.pow(t * 1.55, 2.1)));
        }
        add(rgb, p, C.ink, 0.14 * Math.exp(-Math.pow(r / G.ringA * 1.5, 3)));
      }
    }
  }

  // Compose to straight RGBA.
  const out = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    out[i * 4] = Math.round(clamp01(rgb[i * 3] / 255) * 255);
    out[i * 4 + 1] = Math.round(clamp01(rgb[i * 3 + 1] / 255) * 255);
    out[i * 4 + 2] = Math.round(clamp01(rgb[i * 3 + 2] / 255) * 255);
    out[i * 4 + 3] = Math.round(clamp01(alpha[i]) * 255);
  }
  return encodePNG(out, S, S);
}

// ------------------------------------------------------------------ main ----
// iconutil enforces these exact basenames, and 64 is not among them — it is
// icon_32x32@2x. Several pixel sizes therefore appear twice under two names.
const ICONSET = [
  [16, '16x16'], [32, '16x16@2x'], [32, '32x32'], [64, '32x32@2x'],
  [128, '128x128'], [256, '128x128@2x'], [256, '256x256'],
  [512, '256x256@2x'], [512, '512x512'], [1024, '512x512@2x'],
];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function has(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

function main() {
  const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build');
  mkdirSync(OUT, { recursive: true });

  // 1024, not 512: electron-builder 26.15 refuses an icns source under 512, and
  // the master doubles as the Linux icon.
  writeFileSync(join(OUT, 'icon.png'), renderIcon(1024));

  writeFileSync(join(OUT, 'icon.ico'), encodeICO(ICO_SIZES.map((s) => ({ size: s, buf: renderIcon(s) }))));

  let icns = false;
  if (has('iconutil')) {
    const setDir = join(OUT, 'icon.iconset');
    rmSync(setDir, { recursive: true, force: true });
    mkdirSync(setDir, { recursive: true });
    for (const [px, name] of ICONSET) writeFileSync(join(setDir, `icon_${name}.png`), renderIcon(px));
    execFileSync('iconutil', ['-c', 'icns', setDir, '-o', join(OUT, 'icon.icns')]);
    rmSync(setDir, { recursive: true, force: true });
    icns = true;
  } else {
    console.warn('iconutil not found (macOS only) — skipping icon.icns');
  }

  // A misresolved icon makes electron-builder ship the stock Electron atom with
  // nothing but a log warning, so assert here rather than discover it in a .dmg.
  const n = readFileSync(join(OUT, 'icon.ico')).readUInt16LE(4);
  if (n !== ICO_SIZES.length) throw new Error(`icon.ico: expected ${ICO_SIZES.length} entries, got ${n}`);

  console.log(`build/icon.png 1024  build/icon.ico ${n} entries${icns ? '  build/icon.icns' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
