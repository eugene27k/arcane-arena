import * as THREE from 'three';
import { EnemyBase } from './enemyBase.js';
import { createFlyerModel, releaseFlyerModel, animateFlyer } from './enemyModels.js';
import { EnemyProjectile } from './enemyProjectile.js';
import { randRange, clamp } from '../core/mathUtils.js';

// Flying Demon (PRD §21): airborne ranged harasser. Orbits the player at a
// preferred range/altitude, denies high-ground camping.
export class Flyer extends EnemyBase {
  constructor(game, cfg, scaling, pos) {
    super(game, cfg, scaling, pos);
    this.model = createFlyerModel();
    this.model.root.position.copy(pos);
    game.scene.add(this.model.root);

    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    this.flipT = randRange(cfg.strafeFlipInterval[0], cfg.strafeFlipInterval[1]);
    this.altOffset = randRange(cfg.altitudeAbovePlayer[0], cfg.altitudeAbovePlayer[1]);
    this.attackCd = randRange(0.8, cfg.attackCooldown) * scaling.aggroMult;
    this.windup = 0;
    this.bank = 0;
    this.facing = 0;
  }

  updateAI(dt) {
    const game = this.game;
    const player = game.player;
    const cfg = this.cfg;

    // periodic strafe direction / altitude changes (PRD: reposition, change altitude)
    this.flipT -= dt;
    if (this.flipT <= 0) {
      this.flipT = randRange(cfg.strafeFlipInterval[0], cfg.strafeFlipInterval[1]);
      if (Math.random() < 0.7) this.orbitDir *= -1;
      this.altOffset = randRange(cfg.altitudeAbovePlayer[0], cfg.altitudeAbovePlayer[1]);
    }

    // ---------- steering ----------
    const toSelf = new THREE.Vector3(this.pos.x - player.pos.x, 0, this.pos.z - player.pos.z);
    let dist = toSelf.length();
    if (dist < 0.5) { toSelf.set(1, 0, 0); dist = 0.5; }
    toSelf.divideScalar(dist);
    const tangent = new THREE.Vector3(-toSelf.z, 0, toSelf.x).multiplyScalar(this.orbitDir);

    let radial = 0;
    if (dist < cfg.preferredRangeMin) radial = 1;
    else if (dist > cfg.preferredRangeMax) radial = -1;

    const desiredVel = new THREE.Vector3()
      .addScaledVector(toSelf, radial * this.effSpeed)
      .addScaledVector(tangent, this.effSpeed * (radial === 0 ? 1 : 0.55));

    // altitude: hover above the player, clamped into the hall
    let targetY = player.pos.y + this.altOffset;
    const ground = game.world.groundHeight(this.pos.x, this.pos.z, 25);
    if (ground !== null) targetY = Math.max(targetY, ground + 1.6);
    targetY = clamp(targetY, -1, 22);
    desiredVel.y = clamp((targetY - this.pos.y) * 2.2, -cfg.speed, cfg.speed);

    // keep inside walls (arena bounds come from the layout, not a copy here)
    const b = game.layout.bounds;
    const maxX = b.max[0] - cfg.wallPadding, minX = b.min[0] + cfg.wallPadding;
    const maxZ = b.max[2] - cfg.wallPadding, minZ = b.min[2] + cfg.wallPadding;
    if (this.pos.x > maxX) desiredVel.x -= (this.pos.x - maxX) * 4;
    if (this.pos.x < minX) desiredVel.x += (minX - this.pos.x) * 4;
    if (this.pos.z > maxZ) desiredVel.z -= (this.pos.z - maxZ) * 4;
    if (this.pos.z < minZ) desiredVel.z += (minZ - this.pos.z) * 4;

    const steer = new THREE.Vector3().subVectors(desiredVel, this.vel);
    const maxSteer = cfg.accel * dt;
    if (steer.length() > maxSteer) steer.setLength(maxSteer);
    this.vel.add(steer);
    this.bank = clamp(tangent.dot(this.vel) / this.effSpeed, -1, 1) * this.orbitDir * 0.6;

    // ---------- move (no gravity; world collisions slide) ----------
    game.world.moveEntity(this.pos, this.vel, dt, { radius: cfg.radius, height: cfg.height, stepHeight: 0 }, false);
    this.lastGroundedPos.copy(this.pos);

    // ---------- attack ----------
    this.attackCd -= dt;
    if (this.windup > 0) {
      this.windup -= dt;
      if (this.windup <= 0 && player.alive) {
        // fire with light target lead
        const origin = new THREE.Vector3(this.pos.x, this.pos.y + 0.7, this.pos.z);
        const target = player.center;
        const flightT = origin.distanceTo(target) / cfg.projectileSpeed;
        const lead = new THREE.Vector3()
          .copy(target)
          .addScaledVector(player.vel, flightT * 0.55);
        const dir = lead.sub(origin).normalize();
        game.enemyProjectiles.push(new EnemyProjectile(game, origin, dir.multiplyScalar(cfg.projectileSpeed), cfg.projectileRadius, this.damage));
        game.audio.play('flyerShoot');
      }
    } else if (this.attackCd <= 0 && player.alive) {
      if (game.world.lineOfSight(this.center, player.center)) {
        this.windup = cfg.attackWindup;
        this.attackCd = this.attackCooldownTime;
      } else {
        this.attackCd = 0.4; // retry soon once repositioned
      }
    }

    // ---------- visuals ----------
    this.facing = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.facing;
    animateFlyer(this.model, { windup: this.windup, bank: this.bank, dying: false }, dt, this._time);
  }

  updateDeath(dt) {
    this.pos.y -= 4 * dt * this.deathT;
    this.model.root.position.copy(this.pos);
    animateFlyer(this.model, { dying: true, deathT: this.deathT }, dt, this._time);
  }

  dispose() {
    this.hpBar?.dispose();
    this.hpBar = null;
    if (!this.model) return; // a body is only handed back once
    this.game.scene.remove(this.model.root);
    // pooled, not disposed — see Grunt.dispose
    releaseFlyerModel(this.model);
    this.model = null;
  }
}
