#!/usr/bin/env node
// Procedural soundtrack generator for Arcane Arena.
//
// The game's SFX are synthesized at runtime (src/audio/audioEngine.js); the
// music is synthesized the same way, just offline — three tracks rendered to
// WAV here and encoded to MP3 for the repo. Everything is deterministic: the
// same seed always produces the same recording, so a tweak to one instrument
// is an audible diff rather than a new roll of the dice.
//
//   npm run music          # renders music/*.mp3
//
// Tuning lives in the TRACKS section at the bottom.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'music');

// ---------------------------------------------------------------- utilities

// Seeded PRNG — noise bursts and humanized timing stay identical run to run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEMI = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

// 'D2' -> Hz. Everything below is written in note names so the harmony stays readable.
function hz(name) {
  const m = /^([A-G][b#]?)(-?\d+)$/.exec(name);
  if (!m) throw new Error(`bad note: ${name}`);
  const midi = SEMI[m[1]] + (Number(m[2]) + 1) * 12;
  return 440 * 2 ** ((midi - 69) / 12);
}

const saw = (p) => 2 * (p - Math.floor(p + 0.5));
const tri = (p) => 4 * Math.abs(p - Math.floor(p + 0.75) + 0.25) - 1;
const sine = (p) => Math.sin(2 * Math.PI * p);

// Piecewise ADSR in seconds since note-on; `dur` is the sustain-through point.
function adsr(x, dur, a, d, s, r) {
  if (x < 0) return 0;
  if (x < a) return x / a;
  if (x < a + d) return 1 + (s - 1) * ((x - a) / d);
  if (x < dur) return s;
  const t = x - dur;
  return t < r ? s * (1 - t / r) : 0;
}

// ------------------------------------------------------------------- canvas

// Four buses: dry L/R and a reverb send L/R. Voices choose how much of
// themselves goes down the send, which is what puts the organ at the far end
// of the nave and the drums right in front of you.
class Canvas {
  constructor(seconds) {
    this.n = Math.ceil(seconds * SR);
    this.seconds = seconds;
    this.dl = new Float32Array(this.n);
    this.dr = new Float32Array(this.n);
    this.wl = new Float32Array(this.n);
    this.wr = new Float32Array(this.n);
  }

  add(i, s, pan, send) {
    if (i < 0 || i >= this.n) return;
    const a = (pan + 1) * (Math.PI / 4);
    const l = s * Math.cos(a);
    const r = s * Math.sin(a);
    const dry = 1 - send;
    this.dl[i] += l * dry; this.dr[i] += r * dry;
    this.wl[i] += l * send; this.wr[i] += r * send;
  }
}

// ------------------------------------------------------------------ reverb

function comb(input, acc, delay, feedback, damp) {
  const buf = new Float32Array(delay);
  let idx = 0, filt = 0;
  for (let i = 0; i < input.length; i++) {
    const y = buf[idx];
    acc[i] += y;
    filt = y * (1 - damp) + filt * damp;
    buf[idx] = input[i] + filt * feedback;
    if (++idx === delay) idx = 0;
  }
}

function allpass(io, delay, g) {
  const buf = new Float32Array(delay);
  let idx = 0;
  for (let i = 0; i < io.length; i++) {
    const bufOut = buf[idx];
    const out = bufOut - io[i];
    buf[idx] = io[i] + bufOut * g;
    if (++idx === delay) idx = 0;
    io[i] = out;
  }
}

// Freeverb topology with the delay line stretched: `size` 1.8 is a stone room
// long enough to smear an organ chord into the next one.
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPS = [556, 441, 341, 225];

function reverb(input, { size = 1.8, decay = 0.9, damp = 0.28, spread = 0 }) {
  const acc = new Float32Array(input.length);
  for (const d of COMBS) comb(input, acc, Math.round(d * size) + spread, decay, damp);
  const k = 1 / COMBS.length;
  for (let i = 0; i < acc.length; i++) acc[i] *= k;
  for (const d of ALLPS) allpass(acc, Math.round(d * size) + spread, 0.5);
  return acc;
}

// ------------------------------------------------------------------ voices

// Two cascaded one-poles: gentle, and the right shape for pads that should
// sound like they're behind something.
function lp2(cutoffAt) {
  let z1 = 0, z2 = 0;
  return (x, i) => {
    const k = 1 - Math.exp(-2 * Math.PI * Math.max(20, cutoffAt(i)) / SR);
    z1 += k * (x - z1);
    z2 += k * (z1 - z2);
    return z2;
  };
}

// Detuned saw stack through a moving lowpass — strings, choir, brass, all of
// it, separated only by envelope and cutoff.
function pad(C, { at, dur, notes, gain, send = 0.55, pan = 0, attack = 1.4, release = 2.4,
                  cut0 = 500, cut1 = 900, detune = 7, voices = 3, wave = saw }) {
  const i0 = Math.round(at * SR);
  const total = Math.ceil((dur + release) * SR);
  const freqs = notes.map(hz);
  const phases = freqs.flatMap((f) => Array.from({ length: voices }, (_, v) => ({
    f: f * 2 ** ((((v - (voices - 1) / 2) * detune) / 1200)), p: (v * 0.37 + f) % 1,
  })));
  const filt = lp2((i) => cut0 + (cut1 - cut0) * (i / total));
  const norm = gain / phases.length;
  for (let i = 0; i < total; i++) {
    const x = i / SR;
    const e = adsr(x, dur, attack, 0.001, 1, release);
    if (e <= 0) continue;
    let s = 0;
    for (const v of phases) {
      v.p += v.f / SR;
      s += wave(v.p);
    }
    C.add(i0 + i, filt(s * norm, i) * e, pan, send);
  }
}

// Additive sine stack, drawbar-organ style — the cathedral's own instrument.
function organ(C, { at, dur, notes, gain, send = 0.7, pan = 0, attack = 0.35, release = 2.0,
                    bars = [1, 0.5, 0.33, 0.22, 0.14, 0.09] }) {
  const i0 = Math.round(at * SR);
  const total = Math.ceil((dur + release) * SR);
  const parts = notes.flatMap((n) => {
    const f = hz(n);
    return bars.map((amp, h) => ({ f: f * (h + 1), amp, p: (h * 0.11 + f) % 1 }));
  });
  const norm = gain / (notes.length * bars.reduce((a, b) => a + b, 0));
  for (let i = 0; i < total; i++) {
    const e = adsr(i / SR, dur, attack, 0.001, 1, release);
    if (e <= 0) continue;
    let s = 0;
    for (const v of parts) {
      v.p += v.f / SR;
      s += sine(v.p) * v.amp;
    }
    C.add(i0 + i, s * norm * e, pan, send);
  }
}

// Sub drone: a sine with a barely-moving saw shadow so it isn't a dead tone.
function drone(C, { at, dur, note, gain, send = 0.3, pan = 0, fade = 6, wobble = 0.06 }) {
  const i0 = Math.round(at * SR);
  const total = Math.ceil(dur * SR);
  const f = hz(note);
  let p = 0, q = 0;
  for (let i = 0; i < total; i++) {
    const x = i / SR;
    const e = Math.min(1, x / fade) * Math.min(1, (dur - x) / fade);
    const det = 1 + wobble * 0.01 * Math.sin(2 * Math.PI * 0.043 * x);
    p += f / SR; q += (f * det) / SR;
    C.add(i0 + i, (sine(p) * 0.8 + saw(q) * 0.12) * gain * e, pan, send);
  }
}

// Inharmonic FM — a struck bell, the only thing left ringing in a ruin.
function bell(C, { at, note, gain, send = 0.85, pan = 0, decay = 5.5, ratio = 1.413, index = 6 }) {
  const i0 = Math.round(at * SR);
  const total = Math.ceil(decay * SR);
  const f = hz(note);
  let cp = 0, mp = 0;
  for (let i = 0; i < total; i++) {
    const x = i / SR;
    const e = Math.exp(-3.2 * x / decay) * Math.min(1, x / 0.004);
    mp += (f * ratio) / SR;
    cp += f / SR;
    const s = Math.sin(2 * Math.PI * cp + index * e * Math.sin(2 * Math.PI * mp));
    C.add(i0 + i, s * gain * e, pan, send);
  }
}

// Karplus-Strong — a dry plucked string, cheap and unmistakably human.
function pluck(C, { at, note, gain, send = 0.6, pan = 0, decay = 0.996, rand }) {
  const f = hz(note);
  const N = Math.max(2, Math.round(SR / f));
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) buf[i] = rand() * 2 - 1;
  const i0 = Math.round(at * SR);
  const total = Math.min(C.n - i0, Math.ceil(4 * SR));
  let idx = 0, prev = 0;
  for (let i = 0; i < total; i++) {
    const cur = buf[idx];
    const y = 0.5 * (cur + prev) * decay;
    buf[idx] = y;
    prev = cur;
    if (++idx === N) idx = 0;
    C.add(i0 + i, y * gain, pan, send);
  }
}

// Pitch-dropping sine with a noise transient — taiko, war drum, heartbeat.
function drum(C, { at, gain, send = 0.35, pan = 0, f0 = 150, f1 = 42, dur = 0.5, noise = 0.35, rand }) {
  const i0 = Math.round(at * SR);
  const total = Math.ceil(dur * SR);
  let p = 0;
  const filt = lp2(() => 1800);
  for (let i = 0; i < total; i++) {
    const x = i / SR;
    const e = Math.exp(-5 * x / dur);
    const f = f1 + (f0 - f1) * Math.exp(-14 * x);
    p += f / SR;
    const n = filt((rand() * 2 - 1) * noise * Math.exp(-40 * x), i);
    C.add(i0 + i, (sine(p) + n) * gain * e, pan, send);
  }
}

// Bandpass noise — wind through the vaulting, or stone dragging on stone.
function wind(C, { at, dur, gain, send = 0.5, pan = 0, f0 = 320, f1 = 320, q = 0.7, rand }) {
  const i0 = Math.round(at * SR);
  const total = Math.ceil(dur * SR);
  let lo = 0, band = 0;
  for (let i = 0; i < total; i++) {
    const x = i / SR;
    const e = Math.min(1, x / (dur * 0.35)) * Math.min(1, (dur - x) / (dur * 0.45));
    const fc = f0 + (f1 - f0) * (x / dur);
    const f = 2 * Math.sin(Math.PI * Math.min(0.45, fc / SR));
    const input = rand() * 2 - 1;
    lo += f * band;
    const high = input - lo - q * band;
    band += f * high;
    C.add(i0 + i, band * gain * e, pan, send);
  }
}

// ------------------------------------------------------------------ master

function render(C, { revSize, revDecay, revDamp, fadeIn = 2.5, fadeOut = 5, peak = 0.89 }) {
  const wl = reverb(C.wl, { size: revSize, decay: revDecay, damp: revDamp, spread: 0 });
  const wr = reverb(C.wr, { size: revSize, decay: revDecay, damp: revDamp, spread: 23 });
  const L = C.dl, R = C.dr;
  for (let i = 0; i < C.n; i++) { L[i] += wl[i]; R[i] += wr[i]; }

  // Soft-clip before normalizing: the tanh knee glues the mix instead of
  // letting one drum transient dictate the level of the whole track.
  let max = 0;
  for (let i = 0; i < C.n; i++) {
    L[i] = Math.tanh(L[i] * 1.05);
    R[i] = Math.tanh(R[i] * 1.05);
    max = Math.max(max, Math.abs(L[i]), Math.abs(R[i]));
  }
  const g = max > 0 ? peak / max : 1;
  const nIn = Math.ceil(fadeIn * SR);
  const nOut = Math.ceil(fadeOut * SR);
  for (let i = 0; i < C.n; i++) {
    let e = g;
    if (i < nIn) e *= i / nIn;
    if (i > C.n - nOut) e *= (C.n - i) / nOut;
    L[i] *= e; R[i] *= e;
  }
  return { L, R };
}

function wav16({ L, R }) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  const clamp = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(clamp(L[i]), 44 + i * 4);
    buf.writeInt16LE(clamp(R[i]), 46 + i * 4);
  }
  return buf;
}

// ------------------------------------------------------------------ tracks
//
// D Phrygian throughout (D Eb F G A Bb C). The flattened second is what makes
// the mode read as dread rather than plain minor, and it is the interval the
// whole soundtrack leans on: every track resolves onto D, and every track
// reaches for Eb to get there.

const CHORDS = {
  Dm: ['D3', 'F3', 'A3'],
  Eb: ['Eb3', 'G3', 'Bb3'],
  Cm: ['C3', 'Eb3', 'G3'],
  Gm: ['G3', 'Bb3', 'D4'],
};

// --- 1. Cathedral of Ash -----------------------------------------------
// The menu / between-waves piece. An organ in an empty nave, a bell that
// nobody rings any more, and a harp line that arrives late and alone.
function cathedralOfAsh() {
  const BAR = 4;               // 60 BPM, 4/4
  const BARS = 32;
  const dur = BAR * BARS;      // 128 s
  const C = new Canvas(dur + 8);
  const rand = rng(0x4341);

  drone(C, { at: 0, dur: dur + 6, note: 'D1', gain: 0.5, send: 0.25, fade: 8 });
  drone(C, { at: 32, dur: dur - 26, note: 'D2', gain: 0.22, send: 0.4, fade: 10, pan: -0.15 });

  const cycle = ['Dm', 'Eb', 'Dm', 'Cm'];
  for (let bar = 0; bar < BARS; bar += 2) {
    const chord = CHORDS[cycle[(bar / 2) % cycle.length]];
    const at = bar * BAR;
    organ(C, { at, dur: BAR * 2 - 0.6, notes: chord, gain: 0.34, send: 0.72, attack: 0.5, release: 2.6 });
    // The choir doubles the organ an octave up for the second half of the piece.
    if (bar >= 16) {
      pad(C, {
        at: at + 0.4, dur: BAR * 2 - 1.2, notes: chord.map((n) => n.replace(/\d/, (d) => +d + 1)),
        gain: 0.16, send: 0.8, attack: 2.2, release: 3, cut0: 620, cut1: 1150, detune: 11, pan: 0.2,
      });
    }
  }

  // One toll at the head of each 8-bar cycle; a lower answer halfway through.
  for (let i = 0; i < 4; i++) bell(C, { at: i * 32, note: 'D5', gain: 0.2, decay: 7, pan: -0.3 });
  bell(C, { at: 48, note: 'Bb4', gain: 0.15, decay: 7, pan: 0.35 });
  bell(C, { at: 112, note: 'A4', gain: 0.13, decay: 8, pan: 0.1 });

  // Harp: the chord tones, ascending, entering in the last half.
  for (let bar = 16; bar < BARS; bar += 2) {
    const chord = CHORDS[cycle[(bar / 2) % cycle.length]];
    const notes = [...chord, chord[0].replace(/\d/, (d) => +d + 1)];
    for (let k = 0; k < 8; k++) {
      const at = bar * BAR + k * (BAR / 2) + (rand() - 0.5) * 0.02;
      const n = notes[k % notes.length].replace(/\d/, (d) => +d + 1);
      pluck(C, { at, note: n, gain: 0.13 * (1 - 0.4 * (k % 2)), send: 0.66, pan: -0.4 + 0.1 * k, rand });
    }
  }

  for (let at = 0; at < dur; at += 11) {
    wind(C, { at, dur: 16, gain: 0.05, send: 0.6, f0: 240 + rand() * 200, f1: 180 + rand() * 300, q: 0.5, pan: rand() * 1.6 - 0.8, rand });
  }

  return { canvas: C, master: { revSize: 2.1, revDecay: 0.915, revDamp: 0.24, fadeIn: 3, fadeOut: 6 } };
}

// --- 2. Demonfall -------------------------------------------------------
// The combat piece: a war drum, a bass that refuses to move off D, and brass
// that only arrives once the wave is genuinely on top of you.
function demonfall() {
  const BEAT = 0.6;            // 100 BPM
  const BAR = BEAT * 4;
  const BARS = 60;
  const dur = BAR * BARS;      // 144 s
  const C = new Canvas(dur + 6);
  const rand = rng(0xde3d0f);

  drone(C, { at: 0, dur: dur + 4, note: 'D1', gain: 0.34, send: 0.2, fade: 4 });

  // Eight-note bass ostinato, two bars long. It is the engine of the track.
  const ostinato = ['D2', 'D2', 'Eb2', 'D2', 'D2', 'C2', 'D2', 'Bb1'];
  for (let bar = 0; bar < BARS; bar++) {
    for (let k = 0; k < 8; k++) {
      const at = bar * BAR + k * (BEAT / 2);
      const note = ostinato[(bar % 2 === 0 ? k : (k + 4)) % 8];
      const accent = k % 4 === 0 ? 1 : 0.62;
      pad(C, {
        at, dur: BEAT / 2 * 0.8, notes: [note], gain: 0.3 * accent, send: 0.16,
        attack: 0.006, release: 0.14, cut0: 260, cut1: 150, detune: 4, voices: 2,
      });
    }
  }

  // War drum: downbeat and beat 3, with a double-time push closing each phrase.
  for (let bar = 0; bar < BARS; bar++) {
    const at = bar * BAR;
    drum(C, { at, gain: 0.62, f0: 165, f1: 44, dur: 0.62, pan: -0.1, rand });
    drum(C, { at: at + BEAT * 2, gain: 0.44, f0: 140, f1: 42, dur: 0.5, pan: 0.12, rand });
    if (bar % 4 === 3) {
      for (let k = 0; k < 4; k++) {
        drum(C, { at: at + BEAT * 3 + k * (BEAT / 4), gain: 0.2 + k * 0.09, f0: 190, f1: 60, dur: 0.22, pan: -0.3 + k * 0.2, rand });
      }
    }
  }

  // Four-bar harmony, sections stacking as the fight escalates.
  const prog = ['Dm', 'Dm', 'Eb', 'Cm'];
  for (let bar = 0; bar < BARS; bar += 4) {
    const chord = CHORDS[prog[(bar / 4) % prog.length]];
    const at = bar * BAR;
    const section = bar < 16 ? 'A' : bar < 32 ? 'B' : bar < 48 ? 'C' : 'A2';

    pad(C, {
      at, dur: BAR * 4 - 0.4, notes: chord, gain: section === 'A' ? 0.12 : 0.2,
      send: 0.5, attack: 1.6, release: 1.8, cut0: 420, cut1: 780, detune: 9,
    });

    if (section === 'B' || section === 'C') {
      // Brass stabs on beat 3 of every bar. They sit at the written octave,
      // not under it: an octave down puts them inside the ostinato's register
      // and the bass simply swallows them.
      for (let b = 0; b < 4; b++) {
        pad(C, {
          at: at + b * BAR + BEAT * 2, dur: 0.3, notes: chord,
          gain: 0.26, send: 0.34, attack: 0.012, release: 0.34, cut0: 2600, cut1: 900, detune: 16, pan: 0.15,
        });
      }
      // Tremolo strings under the stabs — the layer that actually separates
      // section B from A on its own, without waiting for a stab to land.
      for (let b = 0; b < 4; b++) {
        for (let k = 0; k < 8; k++) {
          pad(C, {
            at: at + b * BAR + k * (BEAT / 2), dur: BEAT / 2 * 0.85,
            notes: chord.map((n) => n.replace(/\d/, (d) => +d + 1)),
            gain: 0.07, send: 0.6, attack: 0.03, release: 0.12,
            cut0: 1400, cut1: 1900, detune: 12, voices: 2, pan: -0.3,
          });
        }
      }
    }

    if (section === 'C') {
      // A high line finally states the melody: the chord's third and fifth,
      // two octaves up, tremolo'd so it shakes.
      const lead = [chord[2], chord[1], chord[0], chord[2]].map((n) => n.replace(/\d/, (d) => +d + 2));
      lead.forEach((n, i) => {
        pad(C, {
          at: at + i * BAR, dur: BAR * 0.9, notes: [n], gain: 0.11, send: 0.66,
          attack: 0.3, release: 0.7, cut0: 1500, cut1: 2400, detune: 16, pan: -0.25,
        });
      });
    }
  }

  return { canvas: C, master: { revSize: 1.5, revDecay: 0.86, revDamp: 0.34, fadeIn: 1.5, fadeOut: 5 } };
}

// --- 3. The Abyss Waits -------------------------------------------------
// For the breaches in the floor. Almost nothing happens, slowly: a tritone
// that opens under the tonic and never resolves.
function theAbyssWaits() {
  const dur = 150;
  const C = new Canvas(dur + 10);
  const rand = rng(0xabbe55);

  drone(C, { at: 0, dur: dur + 8, note: 'D1', gain: 0.55, send: 0.35, fade: 12, wobble: 0.2 });
  // The tritone opens at 45 s and closes again before the end — the floor
  // giving way and settling.
  drone(C, { at: 45, dur: 78, note: 'Ab1', gain: 0.26, send: 0.55, fade: 20, pan: 0.3, wobble: 0.4 });
  drone(C, { at: 20, dur: dur - 14, note: 'D2', gain: 0.14, send: 0.6, fade: 16, pan: -0.25 });

  // A heartbeat that is never quite regular.
  for (let at = 6, i = 0; at < dur - 6; at += 6.5 + (rand() - 0.5) * 1.4, i++) {
    drum(C, { at, gain: 0.4, f0: 92, f1: 30, dur: 1.1, noise: 0.1, send: 0.5, pan: (rand() - 0.5) * 0.5, rand });
    if (i % 3 === 2) drum(C, { at: at + 0.42, gain: 0.22, f0: 80, f1: 28, dur: 0.9, noise: 0.08, send: 0.55, rand });
  }

  for (const [at, note] of [[14, 'A2'], [56, 'Eb3'], [98, 'A2'], [128, 'D2']]) {
    bell(C, { at, note, gain: 0.18, decay: 11, send: 0.9, ratio: 1.71, index: 8, pan: (rand() - 0.5) * 0.8 });
  }

  // Stone on stone, somewhere below.
  for (let at = 8; at < dur - 10; at += 9 + rand() * 7) {
    wind(C, { at, dur: 6 + rand() * 5, gain: 0.07, send: 0.75, f0: 900 + rand() * 1400, f1: 160 + rand() * 240, q: 0.28, pan: rand() * 1.7 - 0.85, rand });
  }

  // The cluster: a minor second held high and quiet, the sound of being watched.
  pad(C, {
    at: 84, dur: 40, notes: ['D5', 'Eb5', 'A5'], gain: 0.075, send: 0.92,
    attack: 14, release: 16, cut0: 1300, cut1: 2100, detune: 13, pan: 0.15,
  });

  return { canvas: C, master: { revSize: 2.6, revDecay: 0.932, revDamp: 0.2, fadeIn: 6, fadeOut: 10 } };
}

// -------------------------------------------------------------------- main

const TRACKS = [
  { file: '01-cathedral-of-ash', build: cathedralOfAsh },
  { file: '02-demonfall', build: demonfall },
  { file: '03-the-abyss-waits', build: theAbyssWaits },
];

function encode(wavPath, mp3Path) {
  const r = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', wavPath,
    '-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', mp3Path,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed — install it, or keep the .wav');
}

mkdirSync(OUT_DIR, { recursive: true });
const only = process.argv[2];
for (const t of TRACKS) {
  if (only && !t.file.includes(only)) continue;
  const t0 = Date.now();
  process.stdout.write(`rendering ${t.file} … `);
  const { canvas, master } = t.build();
  const mixed = render(canvas, master);
  const wavPath = join(OUT_DIR, `${t.file}.wav`);
  const mp3Path = join(OUT_DIR, `${t.file}.mp3`);
  writeFileSync(wavPath, wav16(mixed));
  encode(wavPath, mp3Path);
  unlinkSync(wavPath);
  const secs = (canvas.n / SR).toFixed(0);
  process.stdout.write(`${secs}s, ${((Date.now() - t0) / 1000).toFixed(1)}s to build\n`);
}
if (!existsSync(join(OUT_DIR, 'README.md'))) {
  writeFileSync(join(OUT_DIR, 'README.md'),
`# music/

The game's built-in soundtrack. Every file here is picked up automatically and
listed in **Settings → Background Music** alongside anything you upload.

These three are generated, not recorded — \`node tools/generateMusic.mjs\`
(or \`npm run music\`) re-renders them from the synthesizer in that file.
Drop your own MP3 or WAV in this folder and it joins the list on the next
reload; the leading number just controls where it sorts.
`);
}
console.log(`\ndone → ${OUT_DIR}`);
