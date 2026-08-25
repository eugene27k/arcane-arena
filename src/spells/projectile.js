import * as THREE from 'three';
import { segmentHitsSphere } from '../core/mathUtils.js';

// Generic magic projectile (Fireball, meteors, & future projectile spells).
// Swept collision: world raycast + segment-vs-sphere per enemy each frame.
export class Projectile {
  constructor(game, opts) {
    this.game = game;
    this.pos = opts.pos;
    this.vel = opts.dir.clone().multiplyScalar(opts.speed);
    this.radius = opts.radius;
    this.damage = opts.damage;
    this.aoeRadius = opts.aoeRadius;
    this.life = opts.life;
    this.color = opts.color;
    this.source = opts.source ?? 'fireball'; // damage tag (detonation reads it)
    this.traumaMult = opts.traumaMult ?? 1;
    this.onExplode = opts.onExplode ?? null; // impact fx/audio override
    this.trailFn = opts.trailFn ?? ((pos) => game.fx.fireballTrail(pos));
    this.trailInterval = opts.trailInterval ?? 0.016;
    // Optional guidance (Mega Blast): bend toward a live enemy at `turnRate`
    // rad/s. Deliberately a steer and not a snap — a slow orb that arcs after a
    // demon reads as hunting it; one that pivots instantly reads as a cheat.
    this.homing = opts.homing ?? null;   // { target, turnRate }
    this.alive = true;

    const mat = new THREE.MeshBasicMaterial({ color: opts.coreColor });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(opts.radius, 10, 8), mat);
    this.mesh.position.copy(this.pos);
    game.scene.add(this.mesh);

    // Optional: a light per bolt is what sells a fireball, and what makes a
    // sky full of them a slideshow — a barrage lights only its big rocks.
    if (opts.light !== false) {
      this.glowColor = opts.color;
      this.glowIntensity = opts.lightIntensity ?? 40;
      this.glowRange = opts.lightRange ?? 9;
      // a slot from the permanent rig — a real light per bolt would recompile
      // every lit material in the arena on the way in and again on the way out
      this.glow = game.lightPool.acquire(1);
      this._glow();
    }
    this._trailAcc = 0;
  }

  _glow() {
    if (!this.glow) return;
    this.game.lightPool.hold(this.glow, this.pos, this.glowColor, this.glowIntensity, this.glowRange);
  }

  update(dt) {
    if (!this.alive) return;
    this.life -= dt;
    if (this.life <= 0) { this.explode(); return; }

    if (this.homing) this._steer(dt);

    const from = this.pos.clone();
    const move = this.vel.clone().multiplyScalar(dt);
    const dist = move.length();
    const dir = move.clone().divideScalar(dist || 1);
    const to = from.clone().add(move);

    // enemies first (closest along path)
    let hitT = Infinity;
    for (const e of this.game.enemies) {
      if (!e.alive) continue;
      const t = segmentHitsSphere(from, to, e.center, e.cfg.radius + this.radius);
      if (t >= 0 && t < hitT) hitT = t;
    }
    // world
    const worldHit = dist > 0 ? this.game.world.raycast(from, dir, dist + this.radius) : null;
    if (worldHit && worldHit.t / (dist + this.radius) < hitT) {
      this.pos.copy(from).addScaledVector(dir, Math.max(0, worldHit.t - this.radius * 0.5));
      this.explode();
      return;
    }
    if (hitT !== Infinity) {
      this.pos.copy(from).lerp(to, hitT);
      this.explode();
      return;
    }

    this.pos.copy(to);
    this.mesh.position.copy(this.pos);
    this._glow();

    this._trailAcc += dt;
    while (this._trailAcc > this.trailInterval) {
      this._trailAcc -= this.trailInterval;
      this.trailFn(this.pos);
    }
  }

  // Rotate the velocity toward the mark, capped at turnRate. A dead target
  // releases the orb: it flies on straight and detonates wherever it lands,
  // rather than chasing a corpse or stopping dead in mid-air.
  _steer(dt) {
    const target = this.homing.target;
    if (!target?.alive) { this.homing = null; return; }
    const speed = this.vel.length();
    if (speed < 1e-4) return;
    const desired = target.center.sub(this.pos);
    const len = desired.length();
    if (len < 1e-4) return;
    desired.divideScalar(len);
    const cur = this.vel.clone().divideScalar(speed);
    const angle = Math.acos(Math.min(1, Math.max(-1, cur.dot(desired))));
    const maxTurn = this.homing.turnRate * dt;
    if (angle <= maxTurn) this.vel.copy(desired).multiplyScalar(speed);
    else this.vel.copy(cur.lerp(desired, maxTurn / angle).normalize().multiplyScalar(speed));
  }

  explode() {
    if (!this.alive) return;
    this.alive = false;
    const game = this.game;
    if (this.onExplode) this.onExplode(this.pos);
    else {
      game.fx.explosion(this.pos, this.aoeRadius);
      game.audio.play('explosion');
    }
    const d = this.pos.distanceTo(game.player.pos);
    game.cameraRig.addTrauma(Math.max(0.12, 0.42 - d * 0.012) * this.traumaMult);

    // AoE damage (PRD: enemies inside the radius take damage)
    const fireMod = game.caster.spellState.fireball;
    const fireBase = game.caster.stats('fireball');
    let anyHit = false, anyKill = false;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      if (e.center.distanceTo(this.pos) <= this.aoeRadius + e.cfg.radius) {
        e.takeDamage(this.damage, this.pos, this.source);
        anyHit = true;
        if (!e.alive) anyKill = true;
        else if (this.source === 'fireball' && fireMod.ignite) {
          e.applyBurn(this.damage * fireBase.igniteDpsFrac, fireBase.igniteDuration);
        }
      }
    }
    if (anyHit) game.hud.hitmarker(anyKill);
    this.dispose();
  }

  dispose() {
    this.game.scene.remove(this.mesh);
    if (this.glow) { this.game.lightPool.release(this.glow); this.glow = null; }
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
