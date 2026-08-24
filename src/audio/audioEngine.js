import { SETTINGS } from '../core/settings.js';

// Procedural WebAudio SFX (PRD §34) — every sound synthesized, no assets.
// Context is created on first user gesture (autoplay policy).
const BASE_GAIN = 0.42; // tuned master level at volume = 1
// The Mega Blast charge sweeps between these while the orb grows.
const CHARGE_F0 = 46, CHARGE_F1 = 230;
const WYRM_F0 = 96; // the braid's root note

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null; // background-music bus (see musicPlayer.js)
    this._noiseBuf = null;
    this._beam = null;   // held voice: Lightning's beam loop
    this._charge = null; // held voice: Mega Blast's rising charge
    this.enabled = true;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 8;
    this.master = this.ctx.createGain();
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    // Music sits beside the SFX chain, not inside it: routed through `comp`,
    // every explosion would duck the soundtrack for half a second.
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0;
    this.musicGain.connect(this.ctx.destination);
    this.applySettings();
    this._startAmbient();
  }

  // Level for the music bus, ramped so slider drags don't click.
  setMusicGain(v) {
    if (!this.musicGain) return;
    this.musicGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  // Master gain follows the settings panel (also silences the ambient bed).
  applySettings() {
    if (!this.master) return;
    const v = SETTINGS.muted ? 0 : BASE_GAIN * SETTINGS.volume * SETTINGS.volume;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  get noiseBuf() {
    if (!this._noiseBuf) {
      const len = this.ctx.sampleRate * 2;
      this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this._noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return this._noiseBuf;
  }

  _startAmbient() {
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.value = 0.05;
    g.connect(this.master);
    for (const [freq, det] of [[54, 0], [55.3, 4]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(g);
      o.start(t);
    }
    // wind
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 300;
    f.Q.value = 0.4;
    const ng = this.ctx.createGain();
    ng.gain.value = 0.025;
    n.connect(f); f.connect(ng); ng.connect(this.master);
    n.start(t);
    // slow LFO on the wind
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = 0.012;
    lfo.connect(lfoG); lfoG.connect(ng.gain);
    lfo.start(t);
  }

  // ---- building blocks ----
  _tone(type, f0, f1, dur, vol, { attack = 0.005, detune = 0, delay = 0 } = {}) {
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, f0), t);
    if (f1 !== null && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    o.detune.value = detune + (Math.random() - 0.5) * 12;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  _noise(dur, vol, { type = 'lowpass', f0 = 1000, f1 = null, q = 0.8, attack = 0.004, delay = 0 } = {}) {
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== null) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  // ---- held beam loop (Lightning) ----
  // A continuous voice, not a one-shot: two detuned saws buzzing under a band of
  // crackle, built once and then gated by its own envelope. Start/stop ramp the
  // gate rather than creating and killing nodes, so a player feathering the
  // trigger doesn't machine-gun the audio graph.
  startBeamLoop() {
    if (!this.ctx || !this.enabled) return;
    if (!this._beam) {
      const t = this.ctx.currentTime;
      const gate = this.ctx.createGain();
      gate.gain.value = 0;
      gate.connect(this.master);
      const oscs = [];
      for (const [type, freq, det, vol] of [['sawtooth', 78, -7, 0.1], ['sawtooth', 117, 9, 0.06]]) {
        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        o.detune.value = det;
        const g = this.ctx.createGain();
        g.gain.value = vol;
        o.connect(g); g.connect(gate);
        o.start(t);
        oscs.push(o);
      }
      // the crackle: looping noise through a resonant band, wobbled by an LFO
      const n = this.ctx.createBufferSource();
      n.buffer = this.noiseBuf;
      n.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 2400;
      f.Q.value = 3.5;
      const ng = this.ctx.createGain();
      ng.gain.value = 0.34;
      n.connect(f); f.connect(ng); ng.connect(gate);
      n.start(t);
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sawtooth';
      lfo.frequency.value = 19; // ~ the beam's own tick rate: the buzz pulses with it
      const lfoG = this.ctx.createGain();
      lfoG.gain.value = 1100;
      lfo.connect(lfoG); lfoG.connect(f.frequency);
      lfo.start(t);
      this._beam = { gate, oscs, noise: n, lfo };
    }
    // a short snap of contact on top of the loop coming up
    this._beam.gate.gain.cancelScheduledValues(this.ctx.currentTime);
    this._beam.gate.gain.setTargetAtTime(0.5, this.ctx.currentTime, 0.012);
  }

  stopBeamLoop() {
    if (!this._beam || !this.ctx) return;
    this._beam.gate.gain.cancelScheduledValues(this.ctx.currentTime);
    this._beam.gate.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
  }

  // ---- held charge loop (Mega Blast) ----
  // Five seconds of gathering, so the voice has to *go somewhere*: a sub, two
  // saws and a band of shimmer that all climb as the orb grows. Built and gated
  // like the beam, and driven from the charge's own progress rather than from a
  // scheduled ramp — an interrupted charge has to be able to stop mid-climb.
  startChargeLoop() {
    if (!this.ctx || !this.enabled) return;
    if (!this._charge) {
      const t = this.ctx.currentTime;
      const gate = this.ctx.createGain();
      gate.gain.value = 0;
      gate.connect(this.master);
      const oscs = [];
      for (const [type, det, vol] of [['sine', 0, 0.16], ['sawtooth', -9, 0.05], ['sawtooth', 11, 0.04]]) {
        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.value = CHARGE_F0;
        o.detune.value = det;
        const g = this.ctx.createGain();
        g.gain.value = vol;
        o.connect(g); g.connect(gate);
        o.start(t);
        oscs.push(o);
      }
      // the shimmer: looping noise through a band that climbs with the pitch
      const n = this.ctx.createBufferSource();
      n.buffer = this.noiseBuf;
      n.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 700;
      f.Q.value = 2.2;
      const ng = this.ctx.createGain();
      ng.gain.value = 0.22;
      n.connect(f); f.connect(ng); ng.connect(gate);
      n.start(t);
      this._charge = { gate, oscs, band: f };
    }
    this._charge.gate.gain.cancelScheduledValues(this.ctx.currentTime);
    this._charge.gate.gain.setTargetAtTime(0.55, this.ctx.currentTime, 0.08);
    this.updateChargeLoop(0);
  }

  // t01: how far through the charge we are. Pitch rises by a little over two
  // octaves across it, weighted late so the final second is the scary one.
  updateChargeLoop(t01) {
    const c = this._charge;
    if (!c || !this.ctx) return;
    const t = this.ctx.currentTime;
    const k = t01 * t01;
    const f = CHARGE_F0 + (CHARGE_F1 - CHARGE_F0) * k;
    for (const o of c.oscs) o.frequency.setTargetAtTime(f, t, 0.05);
    c.band.frequency.setTargetAtTime(700 + 5200 * k, t, 0.05);
  }

  stopChargeLoop() {
    if (!this._charge || !this.ctx) return;
    this._charge.gate.gain.cancelScheduledValues(this.ctx.currentTime);
    this._charge.gate.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
  }

  play(name) {
    if (!this.ctx || !this.enabled) return;
    const fn = this.sounds[name];
    if (fn) fn.call(this);
  }

  sounds = {
    fireballCast() {
      this._noise(0.32, 0.5, { type: 'bandpass', f0: 600, f1: 140, q: 1.2 });
      this._tone('sine', 190, 80, 0.22, 0.35);
    },
    explosion() {
      this._noise(0.55, 0.9, { f0: 1400, f1: 70 });
      this._tone('sine', 90, 38, 0.5, 0.75);
      this._noise(0.06, 0.5, { type: 'highpass', f0: 2000 });
    },
    frostCast() {
      // crystalline: a descending sine pair under a high shimmer of noise
      this._tone('sine', 1400, 500, 0.34, 0.26);
      this._tone('sine', 2100, 760, 0.2, 0.13, { delay: 0.03 });
      this._noise(0.4, 0.26, { type: 'highpass', f0: 3000, f1: 6500, q: 0.7 });
      this._noise(0.07, 0.3, { type: 'bandpass', f0: 5600, q: 2 });
    },
    // Meteor Storm: a long rising summon, then rock arriving in two weights.
    meteorCast() {
      this._tone('sawtooth', 34, 96, 0.9, 0.3);
      this._tone('sine', 68, 192, 0.85, 0.22, { attack: 0.12, detune: 7 });
      this._noise(0.95, 0.42, { f0: 180, f1: 1600, q: 0.5, attack: 0.25 });
      this._noise(0.3, 0.2, { type: 'bandpass', f0: 3200, f1: 900, q: 1.4, delay: 0.55 });
    },
    meteorImpact() {
      this._noise(0.7, 0.95, { f0: 1100, f1: 48 });
      this._tone('sine', 74, 26, 0.66, 0.85);
      this._tone('sawtooth', 120, 40, 0.3, 0.3);
    },
    meteorHit() {
      this._noise(0.34, 0.55, { f0: 900, f1: 90 });
      this._tone('sine', 110, 42, 0.26, 0.4);
    },
    // Mega Blast: the sun tearing off the hands, and then the arena moving.
    megaLaunch() {
      this._tone('sawtooth', 320, 74, 0.5, 0.34, { detune: -14 });
      this._tone('sine', 640, 120, 0.4, 0.24, { detune: 8 });
      this._noise(0.55, 0.5, { f0: 3600, f1: 260, q: 0.7 });
    },
    megaImpact() {
      // Deeper and longer than explosion(): a sub that keeps falling under a
      // wall of noise, with a late tail so the boom has a room around it.
      this._noise(1.1, 1, { f0: 2200, f1: 40 });
      this._tone('sine', 96, 20, 1.05, 0.95);
      this._tone('sine', 150, 34, 0.7, 0.4, { detune: -18 });
      this._tone('sawtooth', 210, 46, 0.45, 0.3);
      this._noise(0.6, 0.3, { type: 'highpass', f0: 2600, delay: 0.1 });
      this._noise(1.3, 0.2, { f0: 300, f1: 60, q: 0.5, attack: 0.2, delay: 0.18 });
    },
    // The well going under: a sour, sagging pair of tones, no bottom to them.
    manaDebt() {
      this._tone('square', 180, 66, 0.5, 0.2, { detune: -22 });
      this._tone('sawtooth', 122, 44, 0.6, 0.16, { detune: 26, delay: 0.05 });
      this._noise(0.5, 0.16, { f0: 420, f1: 90, q: 0.8 });
    },
    // The strike that opens a beam (and the Tempest Step discharge) — the
    // sustained part is startBeamLoop(), this is just the contact.
    lightningCast() {
      this._tone('sawtooth', 900, 110, 0.13, 0.32);
      this._noise(0.16, 0.4, { type: 'highpass', f0: 2600, q: 0.6 });
      this._noise(0.05, 0.45, { type: 'bandpass', f0: 5000, q: 1.5 });
    },
    gruntAttack() {
      this._tone('sawtooth', 110, 55, 0.22, 0.3);
      this._noise(0.14, 0.22, { type: 'bandpass', f0: 400, q: 1 });
    },
    enemyHit() {
      this._tone('sine', 150, 65, 0.12, 0.4);
      this._noise(0.05, 0.28, { f0: 900 });
    },
    gruntDeath() {
      this._tone('sawtooth', 130, 32, 0.5, 0.4);
      this._noise(0.4, 0.3, { f0: 700, f1: 100 });
    },
    flyerDeath() {
      this._tone('square', 950, 160, 0.42, 0.22);
      this._tone('sawtooth', 500, 90, 0.4, 0.2, { delay: 0.04 });
    },
    flyerShoot() {
      this._tone('sine', 520, 190, 0.2, 0.3);
      this._noise(0.14, 0.2, { type: 'bandpass', f0: 900, f1: 300, q: 2 });
    },
    playerHit() {
      this._tone('sine', 110, 45, 0.28, 0.6);
      this._noise(0.12, 0.4, { f0: 500 });
    },
    playerDeath() {
      this._tone('sawtooth', 240, 28, 1.3, 0.4);
      this._tone('sine', 120, 30, 1.2, 0.4, { delay: 0.1 });
      this._noise(1.1, 0.3, { f0: 800, f1: 60 });
    },
    manaPickup() {
      this._tone('sine', 660, null, 0.1, 0.22);
      this._tone('sine', 990, null, 0.12, 0.2, { delay: 0.05 });
      this._tone('sine', 1320, null, 0.16, 0.16, { delay: 0.1 });
    },
    healthPickup() {
      this._tone('triangle', 440, null, 0.14, 0.26);
      this._tone('triangle', 660, null, 0.2, 0.22, { delay: 0.07 });
    },
    // Life relics. The call is a struck bell with a long tail — warm where
    // bladeCall is steel, so the two beacons are never confused by ear.
    relicCall() {
      this._tone('sine', 523, null, 1.4, 0.2, { attack: 0.03 });
      this._tone('sine', 784, null, 1.1, 0.13, { delay: 0.04, attack: 0.03 });
      this._tone('triangle', 262, null, 1.6, 0.1, { attack: 0.06 });
    },
    // Taking one: a rising major third that resolves, i.e. the only sound in
    // the game that goes somewhere good.
    relicHeal() {
      this._tone('triangle', 392, null, 0.22, 0.26);
      this._tone('triangle', 523, null, 0.26, 0.24, { delay: 0.08 });
      this._tone('sine', 784, null, 0.4, 0.18, { delay: 0.16, attack: 0.02 });
    },
    // A font empties: the same shape, an octave wider and with the hall on it.
    relicFull() {
      this._tone('triangle', 392, null, 0.3, 0.26);
      this._tone('triangle', 523, null, 0.34, 0.26, { delay: 0.09 });
      this._tone('triangle', 659, null, 0.4, 0.24, { delay: 0.18 });
      this._tone('sine', 1046, null, 0.9, 0.2, { delay: 0.27, attack: 0.02 });
      this._tone('sine', 130, null, 1.1, 0.14, { attack: 0.05 });
      this._noise(0.7, 0.1, { type: 'bandpass', f0: 3200, f1: 900, q: 1.3, attack: 0.02 });
    },
    // staff: a dry wooden whoosh, and a hard arcane crack when it connects
    // Wyrmlance. The pair has to be audible as a pair, so every voice here is
    // built out of two things a beat apart rather than one thing twice as loud.
    wyrmCast() {
      // two saws a fifth apart, sweeping down as the braid leaves the hands
      this._tone('sawtooth', WYRM_F0 * 3, WYRM_F0, 0.26, 0.16);
      this._tone('sawtooth', WYRM_F0 * 4.5, WYRM_F0 * 1.5, 0.26, 0.1, { delay: 0.012 });
      this._noise(0.22, 0.4, { type: 'bandpass', f0: 2600, f1: 700, q: 1.4 });
    },
    // The doubled thud: the SECOND tone 28 ms behind the first is the whole
    // readout. A centred hit sounds like two things landing; a graze like one.
    wyrmBite() {
      this._tone('sine', 320, 120, 0.16, 0.3);
      this._noise(0.09, 0.28, { type: 'bandpass', f0: 1800, q: 1.6 });
      this._tone('sine', 320, 120, 0.16, 0.26, { delay: 0.028 });
      this._noise(0.09, 0.24, { type: 'bandpass', f0: 1800, q: 1.6, delay: 0.028 });
    },
    wyrmGraze() {
      this._tone('sine', 900, 520, 0.07, 0.1);
      this._noise(0.05, 0.12, { type: 'highpass', f0: 3400 });
    },
    wyrmWall() {
      this._noise(0.18, 0.22, { type: 'bandpass', f0: 2200, f1: 500, q: 1.1 });
    },
    staffSwing() {
      this._noise(0.17, 0.2, { type: 'bandpass', f0: 1500, f1: 420, q: 1.1 });
    },
    staffHit() {
      this._tone('triangle', 300, 105, 0.15, 0.34);
      this._tone('sine', 760, 380, 0.08, 0.14);
      this._noise(0.09, 0.3, { type: 'bandpass', f0: 950, f1: 280, q: 1.4 });
    },
    // Onikiri: steel, not wood — the swing is air torn open, the hit is a
    // clean cut with a ring behind it, and the claim is a blade drawn.
    bladeSwing() {
      this._noise(0.12, 0.3, { type: 'bandpass', f0: 4200, f1: 1100, q: 2.2 });
      this._tone('sine', 2600, 900, 0.09, 0.07);
    },
    bladeHit() {
      this._noise(0.07, 0.42, { type: 'highpass', f0: 3600 });
      this._tone('triangle', 1500, 520, 0.11, 0.24);
      this._tone('sine', 3100, 1900, 0.22, 0.09, { delay: 0.01 });
      this._noise(0.14, 0.3, { type: 'bandpass', f0: 520, f1: 160, q: 1.3 });
    },
    bladeClaim() {
      this._tone('sine', 520, 2050, 0.42, 0.2, { attack: 0.05 });
      this._tone('sine', 1560, 3120, 0.5, 0.1, { attack: 0.08, delay: 0.03 });
      this._noise(0.35, 0.3, { type: 'bandpass', f0: 1800, f1: 5200, q: 1.6 });
      this._tone('sawtooth', 84, 44, 0.55, 0.22, { attack: 0.02 });
    },
    // Rung once when the binding is nearly out, and again when it fails.
    bladeLapse() {
      this._tone('sine', 1650, 380, 0.6, 0.16, { attack: 0.01 });
      this._tone('triangle', 820, 190, 0.45, 0.12, { detune: -18 });
      this._noise(0.4, 0.16, { f0: 900, f1: 120, q: 0.9 });
    },
    // The blade landing in the stone somewhere across the hall.
    bladeCall() {
      this._tone('sine', 300, 1400, 0.7, 0.16, { attack: 0.16 });
      this._noise(0.5, 0.22, { type: 'bandpass', f0: 2400, f1: 700, q: 1.1 });
      this._tone('sawtooth', 62, 40, 0.5, 0.18);
    },
    dash() {
      this._noise(0.24, 0.3, { type: 'highpass', f0: 700, f1: 2400, q: 0.5 });
    },
    // the ward: a rising hum as it goes up, a dull collapse as it drops, and a
    // short electric bite each beat something is leaning into it
    shieldUp() {
      this._tone('triangle', 180, 430, 0.3, 0.2);
      this._tone('sine', 90, 215, 0.34, 0.16, { delay: 0.02 });
      this._noise(0.3, 0.16, { type: 'bandpass', f0: 700, f1: 2400, q: 0.9 });
    },
    shieldDown() {
      this._tone('triangle', 400, 130, 0.26, 0.18);
      this._noise(0.22, 0.14, { f0: 1400, f1: 260 });
    },
    shieldZap() {
      this._tone('square', 620, 240, 0.07, 0.1);
      this._noise(0.09, 0.18, { type: 'bandpass', f0: 2600, f1: 900, q: 1.8 });
    },
    // the sense: a thin glass ping as the ear opens, the same figure falling
    // as it shuts. Quieter and higher than the ward — nothing here is spent on
    // damage, so it must not sound like a wall going up.
    senseOn() {
      this._tone('sine', 900, 1760, 0.26, 0.12);
      this._tone('triangle', 1350, 2640, 0.2, 0.055, { delay: 0.03 });
      this._noise(0.26, 0.08, { type: 'bandpass', f0: 3200, f1: 6400, q: 2.2 });
    },
    senseOff() {
      this._tone('sine', 1320, 620, 0.2, 0.09);
      this._noise(0.16, 0.06, { type: 'bandpass', f0: 5200, f1: 1800, q: 2.0 });
    },
    jump() {
      this._tone('sine', 240, 330, 0.09, 0.1);
    },
    // double jump: same shape a fifth up, with a short airy swell under it
    airJump() {
      this._tone('sine', 360, 520, 0.11, 0.11);
      this._noise(0.16, 0.14, { type: 'bandpass', f0: 900, f1: 2600, q: 0.8 });
    },
    // triple jump: an octave over that, with a second voice for the extra weight
    airJump2() {
      this._tone('sine', 540, 900, 0.14, 0.12);
      this._tone('triangle', 810, 1350, 0.1, 0.07, { delay: 0.03 });
      this._noise(0.22, 0.17, { type: 'bandpass', f0: 1200, f1: 4200, q: 0.7 });
    },
    land() {
      this._tone('sine', 120, 70, 0.09, 0.14);
      this._noise(0.05, 0.1, { f0: 500 });
    },
    portalOpen() {
      this._tone('sawtooth', 42, 95, 0.65, 0.25);
      this._noise(0.6, 0.22, { f0: 300, f1: 900, q: 0.6 });
    },
    waveStart() {
      this._tone('sawtooth', 110, null, 0.8, 0.3, { detune: -6 });
      this._tone('sawtooth', 165, null, 0.8, 0.22, { detune: 6 });
      this._tone('sine', 55, null, 0.9, 0.35);
    },
    waveComplete() {
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => this._tone('triangle', f, null, 0.3, 0.2, { delay: i * 0.09 }));
    },
    upgradePick() {
      this._tone('triangle', 880, null, 0.12, 0.24);
      this._tone('triangle', 1174, null, 0.2, 0.2, { delay: 0.06 });
    },
    spellSwitch() {
      this._tone('sine', 520, 700, 0.06, 0.14);
    },
    uiClick() {
      this._tone('sine', 700, 500, 0.06, 0.12);
    },
    manaFail() {
      this._tone('square', 130, 90, 0.16, 0.16);
    },
  };
}
