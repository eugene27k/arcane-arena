import * as THREE from 'three';
import { EnemyBase } from './enemyBase.js';
import { createGruntModel, releaseGruntModel, animateGrunt } from './enemyModels.js';
import { horizontalDist } from '../core/mathUtils.js';

// Demon Grunt (PRD §20): melee pressure. Navigates the waypoint graph
// (stairs, drop-ledges), then swarms directly when it has line of sight.
export class Grunt extends EnemyBase {
  constructor(game, cfg, scaling, pos) {
    super(game, cfg, scaling, pos);
    this.model = createGruntModel();
    this.model.root.position.copy(pos);
    game.scene.add(this.model.root);

    this.path = null;
    this.pathIdx = 0;
    this.repathT = Math.random() * cfg.repathInterval;
    this.grounded = false;
    this.windup = 0;
    this.strike = 0;
    this.attackCd = 0;
    this.stuckT = 0;
    this.facing = Math.random() * Math.PI * 2;
  }

  // Is the mage actually within claw reach? Horizontal range, a vertical band
  // tied to the grunt's own footing (so a mage a ledge above is genuinely out
  // of reach, not merely far), and clear stone between the two bodies — claws
  // do not pass through a stair riser or a floor.
  _canClaw(hRange, vSlack = 0) {
    const player = this.game.player;
    if (horizontalDist(this.pos, player.pos) >= hRange) return false;
    if (Math.abs(player.pos.y - this.pos.y) >= this.cfg.attackVerticalReach + vSlack) return false;
    return this.game.world.lineOfSight(this.center, player.center);
  }

  updateAI(dt) {
    const game = this.game;
    const player = game.player;
    const cfg = this.cfg;

    this.attackCd = Math.max(0, this.attackCd - dt);
    this.strike = Math.max(0, this.strike - dt);

    const toPlayerH = horizontalDist(this.pos, player.pos);
    const dy = player.pos.y - this.pos.y;

    // ---------- attacking ----------
    if (this.windup > 0) {
      this.windup -= dt;
      this.vel.x *= 0.8; this.vel.z *= 0.8;
      if (this.windup <= 0) {
        this.strike = 0.15;
        this.attackCd = this.attackCooldownTime;
        if (player.alive && this._canClaw(cfg.attackHitRange, cfg.attackReachSlack)) {
          player.takeDamage(this.damage, this.pos);
        }
        this.game.audio.play('gruntAttack');
      }
    } else if (this.attackCd <= 0 && player.alive && this._canClaw(cfg.attackRange)) {
      this.windup = cfg.attackWindup;
    } else {
      // ---------- navigation ----------
      this.repathT -= dt;
      const canDirect = Math.abs(dy) < 1.6 && game.world.lineOfSight(
        this.center, player.center
      );
      let target = null;
      if (canDirect && player.alive) {
        target = player.pos;
        this.path = null;
      } else {
        if (this.repathT <= 0 || !this.path || this.pathIdx >= this.path.length) {
          this.repathT = cfg.repathInterval;
          const from = game.nav.nearest(this.pos);
          const to = game.nav.nearest(player.pos);
          const path = game.nav.findPath(from.id, to.id);
          this.path = path;
          this.pathIdx = 0;
          // shortcut: skip the entry node when the next one is already closer
          // than reaching it via the entry node (avoids backtracking)
          if (path && path.length > 1) {
            const d01 = horizontalDist(path[0], path[1]);
            if (horizontalDist(this.pos, path[1]) < d01 + 0.5) this.pathIdx = 1;
          }
        }
        if (this.path && this.pathIdx < this.path.length) {
          const wp = this.path[this.pathIdx];
          if (horizontalDist(this.pos, wp) < 1.0) {
            this.pathIdx++;
          }
          target = this.pathIdx < this.path.length ? this.path[this.pathIdx] : player.pos;
        } else {
          target = player.pos;
        }
      }

      // hold position at claw range while the attack recharges
      const holdOff = canDirect && toPlayerH < cfg.attackRange * 0.85;
      // steer toward target (horizontal)
      const dir = new THREE.Vector3(target.x - this.pos.x, 0, target.z - this.pos.z);
      const dLen = dir.length();
      if (holdOff) {
        this.vel.x *= 0.72; this.vel.z *= 0.72;
      } else if (dLen > 0.05) {
        dir.divideScalar(dLen);
        // separation from other grunts
        for (const e of game.enemies) {
          if (e === this || !e.alive || e.cfg.id !== 'grunt') continue;
          const d = horizontalDist(this.pos, e.pos);
          if (d < cfg.separationRadius && d > 0.01) {
            dir.x += (this.pos.x - e.pos.x) / d * 0.5;
            dir.z += (this.pos.z - e.pos.z) / d * 0.5;
          }
        }
        dir.normalize();
        this.vel.x = dir.x * this.effSpeed;
        this.vel.z = dir.z * this.effSpeed;
        this.facing = Math.atan2(dir.x, dir.z);
      } else {
        this.vel.x *= 0.7; this.vel.z *= 0.7;
      }
    }

    // face the player when close / attacking
    if (toPlayerH < cfg.attackRange * 2.2) {
      this.facing = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    }

    // ---------- physics ----------
    this.vel.y -= cfg.gravity * dt;
    this.vel.y = Math.max(this.vel.y, -cfg.terminalFall);
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    const res = game.world.moveEntity(
      this.pos, this.vel, dt,
      { radius: cfg.radius, height: cfg.height, stepHeight: cfg.stepHeight },
      this.grounded
    );
    this.grounded = res.grounded;
    if (this.grounded) this.lastGroundedPos.copy(this.pos);

    // stuck detection: wants to move but isn't
    const actualSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 1 && actualSpeed < 0.4 && this.windup <= 0) {
      this.stuckT += dt;
      if (this.stuckT > 1.2) {
        this.stuckT = 0;
        this.repathT = 0;
        this.path = null;
        this.vel.y = 6; // small hop to break out of geometry snags
      }
    } else {
      this.stuckT = Math.max(0, this.stuckT - dt);
    }

    // ---------- visuals ----------
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.facing;
    animateGrunt(this.model, {
      speed: actualSpeed,
      windup: this.windup,
      strike: this.strike,
      dying: false,
    }, dt, this._time);
  }

  updateDeath(dt) {
    this.model.root.position.copy(this.pos);
    animateGrunt(this.model, { dying: true, deathT: this.deathT }, dt, this._time);
  }

  dispose() {
    this.hpBar?.dispose();
    this.hpBar = null;
    if (!this.model) return; // a body is only handed back once
    this.game.scene.remove(this.model.root);
    // back to the pool intact — disposing the materials would evict their
    // compiled shaders and stall the next demon that spawns
    releaseGruntModel(this.model);
    this.model = null;
  }
}
