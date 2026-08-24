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

// Small pool of reusable point lights for explosions / muzzle flashes / impacts.
export class LightPool {
  constructor(scene, count = 6) {
    this.lights = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 20, 2);
      l.visible = false;
      scene.add(l);
      this.lights.push({ light: l, time: 0, duration: 1, peak: 0 });
    }
  }

  flash(pos, color, intensity = 60, distance = 16, duration = 0.35) {
    let slot = this.lights.find((s) => s.time <= 0);
    if (!slot) {
      slot = this.lights.reduce((a, b) => (a.time < b.time ? a : b));
    }
    slot.light.position.copy(pos);
    slot.light.color.setHex(color);
    slot.light.distance = distance;
    slot.peak = intensity;
    slot.duration = duration;
    slot.time = duration;
    slot.light.visible = true;
  }

  update(dt) {
    for (const s of this.lights) {
      if (s.time > 0) {
        s.time -= dt;
        const t = Math.max(0, s.time / s.duration);
        s.light.intensity = s.peak * t * t;
        if (s.time <= 0) s.light.visible = false;
      }
    }
  }
}
