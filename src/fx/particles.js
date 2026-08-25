import * as THREE from 'three';
import { makeSoftDotTexture } from './textures.js';

// Pooled additive point-sprite particles (trails, sparks, embers, pickups).
const MAX = 3000;

export class ParticleSystem {
  constructor(scene) {
    this.particles = [];
    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX * 3);
    this.colors = new Float32Array(MAX * 4);
    this.sizes = new Float32Array(MAX);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: makeSoftDotTexture() } },
      vertexShader: `
        attribute vec4 aColor;
        attribute float aSize;
        varying vec4 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (240.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uTex;
        varying vec4 vColor;
        void main() {
          vec4 tex = texture2D(uTex, gl_PointCoord);
          gl_FragColor = vec4(vColor.rgb, vColor.a) * tex;
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this._color = new THREE.Color();
  }

  // opts: pos, vel, life, size, sizeEnd, color, colorEnd, gravity, drag, alpha
  spawn(opts) {
    if (this.particles.length >= MAX) return;
    this.particles.push({
      x: opts.pos.x, y: opts.pos.y, z: opts.pos.z,
      vx: opts.vel?.x ?? 0, vy: opts.vel?.y ?? 0, vz: opts.vel?.z ?? 0,
      life: opts.life ?? 1, maxLife: opts.life ?? 1,
      size: opts.size ?? 0.3, sizeEnd: opts.sizeEnd ?? (opts.size ?? 0.3) * 0.3,
      c0: new THREE.Color(opts.color ?? 0xffffff),
      c1: opts.colorEnd !== undefined ? new THREE.Color(opts.colorEnd) : null,
      gravity: opts.gravity ?? 0,
      drag: opts.drag ?? 0,
      alpha: opts.alpha ?? 1,
    });
  }

  burst(pos, count, optsFn) {
    for (let i = 0; i < count; i++) this.spawn(optsFn(i));
  }

  update(dt) {
    const ps = this.particles;
    let write = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= p.gravity * dt;
      if (p.drag > 0) {
        const f = Math.max(0, 1 - p.drag * dt);
        p.vx *= f; p.vy *= f; p.vz *= f;
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      ps[write++] = p;
    }
    ps.length = write;

    for (let i = 0; i < write; i++) {
      const p = ps[i];
      const t = 1 - p.life / p.maxLife;
      this.positions[i * 3] = p.x;
      this.positions[i * 3 + 1] = p.y;
      this.positions[i * 3 + 2] = p.z;
      const c = p.c1 ? this._color.copy(p.c0).lerp(p.c1, t) : p.c0;
      const fade = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      this.colors[i * 4] = c.r;
      this.colors[i * 4 + 1] = c.g;
      this.colors[i * 4 + 2] = c.b;
      this.colors[i * 4 + 3] = fade * p.alpha;
      this.sizes[i] = p.size + (p.sizeEnd - p.size) * t;
    }
    this.geometry.setDrawRange(0, write);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
  }

  clear() { this.particles.length = 0; }
}

// Fixed-size rig of point lights for every dynamic light in the game — muzzle
// flashes, explosions, spawn portals, bolts in flight, the held beam, the Mega
// Blast sun, and the beacons over dropped relics.
//
// Every slot is added to the scene at construction and is then never removed,
// never hidden, and never re-added. That is not tidiness, it is the whole
// point: three bakes the scene's light *counts* into each material's program
// cache key, so a single point light appearing or vanishing re-keys every lit
// material in the arena and recompiles it from source. A wave opening nine
// portals used to cost seconds of frozen frames that way. An idle slot sits at
// intensity zero instead — a few ALU ops per fragment, and no recompiles ever.
//
// Sustained users take a slot with acquire(), drive it each frame with hold(),
// and hand it back with release(). A slot can be revoked under a low-priority
// holder when something more important needs one; the stale handle then goes
// quietly inert rather than writing over the new owner.
//
// The rig is deliberately small. A point light costs the fragment shader real
// work on every lit pixel whether or not it is switched on, and measured on an
// M4 that is around a millisecond per light in a busy frame — so the budget is
// sized to what the game actually asks for. Sampling a full run, all but a
// fraction of frames want zero or one dynamic light; only the burst of portals
// that opens a wave wants more, and there the ones that miss out still have
// their emissive ring and its bloom. Four slots leaves the resting scene close
// to where it was before the rig existed and is *cheaper* than the old code in
// the middle of a fight, where six flashes could be lit at once.
export class LightPool {
  constructor(scene, count = 4) {
    this.slots = [];
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 20, 2);
      light.castShadow = false;
      scene.add(light);
      this.slots.push({ light, gen: 0, time: 0, duration: 1, peak: 0, held: false, prio: -1 });
    }
  }

  _free(s) {
    s.held = false;
    s.prio = -1;
    s.time = 0;
    s.peak = 0;
    s.light.intensity = 0;
  }

  // Pick a slot for a request of the given priority: an idle one first, then
  // the flash closest to burning out, then the weakest sustained holder — but
  // only if the newcomer actually outranks it. Returns null when everything in
  // the rig matters more than what is asking.
  _claim(prio, evict = true) {
    let best = null;
    for (const s of this.slots) {
      if (!s.held && s.time <= 0) { best = s; break; }
    }
    if (!best && evict) {
      for (const s of this.slots) {
        if (s.held) continue;
        if (!best || s.time < best.time) best = s;
      }
    }
    if (!best && evict) {
      for (const s of this.slots) {
        if (s.prio < prio && (!best || s.prio < best.prio)) best = s;
      }
    }
    if (!best) return null;
    best.gen++; // revoke whatever handle was pointing here
    return best;
  }

  // ---------- transient flashes ----------
  flash(pos, color, intensity = 60, distance = 16, duration = 0.35) {
    const s = this._claim(0);
    if (!s) return;
    s.held = false;
    s.prio = 0;
    s.light.position.copy(pos);
    s.light.color.setHex(color);
    s.light.distance = distance;
    s.peak = intensity;
    s.duration = duration;
    s.time = duration;
  }

  // ---------- sustained holds ----------
  // prio ranks what may evict what: flashes 0, bolts in flight 1, the beacon
  // over a dropped relic 2, spawn portals 3, and the beam or the gathering Mega
  // Blast 4 — what the player is holding wins over what the room is doing.
  acquire(prio = 1) {
    const s = this._claim(prio);
    // A handle is still worth having when the rig is full: hold() takes a slot
    // back for it as soon as one frees, so a beacon that lost its light to a
    // wave of portals lights up again when they close.
    const h = { slot: s, gen: s ? s.gen : -1, prio };
    if (s) this._seat(s, prio);
    return h;
  }

  _seat(s, prio) {
    s.held = true;
    s.prio = prio;
    s.time = 0;
    s.peak = 0;
    s.light.intensity = 0;
  }

  alive(h) {
    return !!h && !!h.slot && h.slot.gen === h.gen;
  }

  // Drive a held slot, re-seating the handle first if it was turned out by
  // something more important and a slot has since come free. Silently does
  // nothing while the rig is full, so a caller never has to check.
  hold(h, pos, color, intensity, distance) {
    if (!h) return;
    if (!h.slot || h.slot.gen !== h.gen) {
      // Waiting, not evicting: a holder that was turned out takes an idle slot
      // when one appears, and never cuts a live flash short to get back in.
      const s = this._claim(h.prio, false);
      if (!s) return;
      this._seat(s, h.prio);
      h.slot = s;
      h.gen = s.gen;
    }
    const l = h.slot.light;
    l.position.copy(pos);
    if (color !== undefined) l.color.setHex(color);
    if (distance !== undefined) l.distance = distance;
    l.intensity = intensity;
  }

  release(h) {
    if (!h || !h.slot || h.slot.gen !== h.gen) return;
    const s = h.slot;
    h.slot = null;
    s.gen++;
    this._free(s);
  }

  update(dt) {
    for (const s of this.slots) {
      if (s.held || s.time <= 0) continue;
      s.time -= dt;
      const t = Math.max(0, s.time / s.duration);
      s.light.intensity = s.peak * t * t;
      if (s.time <= 0) this._free(s);
    }
  }

  // Wave reset / run teardown: nothing keeps a slot across a scene clear.
  clear() {
    for (const s of this.slots) { s.gen++; this._free(s); }
  }
}
