import * as THREE from 'three';
import { EnemyHealthBar } from '../fx/healthBar.js';
import { SPELLS } from '../config/spellConfig.js';

// EnemyBase (PRD §19): shared HP / hit-flash / death lifecycle. Subclasses
// implement movement + attacks in updateAI().
export class EnemyBase {
  constructor(game, cfg, scaling, pos) {
    this.game = game;
    this.cfg = cfg;
    this.scaling = scaling;
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.maxHP = cfg.hp * scaling.hpMult;
    this.hp = this.maxHP;
    this.damage = cfg.attackDamage * scaling.damageMult;
    this.attackCooldownTime = cfg.attackCooldown * scaling.aggroMult;
    this.speed = cfg.speed * scaling.speedMult;
    this.alive = true;
    this.dying = false;
    this.deathT = 0;
    this.removeMe = false;
    this.hitFlashT = 0;
    this.lastGroundedPos = pos.clone();
    this._time = Math.random() * 10;

    this.lastHitSource = 'generic'; // what landed the killing blow (detonation checks fire)
    this.burnDps = 0;
    this.burnT = 0;
    this._burnFxAcc = 0;
    this.slowT = 0;
    this.slowFactor = 1;
    this._slowFxAcc = 0;
  }

  get center() {
    return new THREE.Vector3(this.pos.x, this.pos.y + this.cfg.height * 0.55, this.pos.z);
  }

  // Movement speed after the Frost Nova chill. Attack rate and projectile speed
  // are deliberately untouched — the debuff is kiting help, not a stun.
  get effSpeed() {
    return this.speed * (this.slowT > 0 ? this.slowFactor : 1);
  }

  // `silent` suppresses the hit sting only — everything else (flash, HP bar,
  // Shatter, death) is unchanged. Used by damage that lands on a repeating beat
  // rather than on a swing: the Mana Shield bites four times a second, and one
  // cue per demon per beat is a wall of noise instead of feedback.
  takeDamage(amount, fromPos = null, source = 'generic', silent = false) {
    if (!this.alive) return;
    // Shatter: chilled demons are brittle to every source, not just frost
    if (this.slowT > 0 && this.game.caster.spellState.frostnova.shatter) {
      amount *= SPELLS.frostnova.shatterDamageMult;
    }
    this.hp -= amount;
    this.lastHitSource = source;
    this.hitFlashT = 0.12;
    if (!silent) this.game.audio.play('enemyHit');
    if (this.hp > 0) {
      // HP bar appears once the enemy has actually been hurt
      if (!this.hpBar) this.hpBar = new EnemyHealthBar(this.game.scene);
      this.hpBar.set(this.hp / this.maxHP);
    }
    if (this.hp <= 0) this.die();
  }

  die(silent = false) {
    if (!this.alive) return;
    this.alive = false;
    this.dying = true;
    this.deathT = 0;
    this.hpBar?.dispose();
    this.hpBar = null;
    if (!silent) {
      this.game.audio.play(this.cfg.id === 'flyer' ? 'flyerDeath' : 'gruntDeath');
      this.game.fx.deathBurst(this.center, this.cfg.id === 'flyer' ? 0x6a1040 : 0x8a1a10);
      this.game.onEnemyKilled(this);
    }
  }

  applyHitFlash(dt) {
    if (this.hitFlashT > 0) {
      this.hitFlashT -= dt;
      const on = this.hitFlashT > 0;
      for (const m of this.model.mats) {
        if (!m.emissive) continue; // sprite/basic materials don't flash
        if (on) {
          m.emissive.setHex(0xffffff);
          m.emissiveIntensity = 0.55;
        } else {
          // restore the material's own glow, not black
          m.emissive.setHex(m.userData.baseEmissive ?? 0x000000);
          m.emissiveIntensity = m.userData.baseEmissiveIntensity ?? 0;
        }
      }
    }
  }

  update(dt) {
    this._time += dt;
    if (this.dying) {
      this.deathT += dt * 1.6;
      this.updateDeath(dt);
      if (this.deathT >= 1) this.removeMe = true;
      return;
    }
    this.updateAI(dt);
    this.applyHitFlash(dt);
    this.updateBurn(dt);
    this.updateSlow(dt);
    this.hpBar?.follow(this.pos, this.cfg.height + 0.45);
    // fell into the abyss: dies silently but still counts for the wave
    if (this.pos.y < -11) {
      this.game.onEnemyKilled(this, true);
      this.alive = false;
      this.removeMe = true;
      this.hpBar?.dispose();
      this.hpBar = null;
    }
  }

  // Ignite DoT. Refreshes rather than stacks: keeps the strongest dps and the
  // longest remaining duration.
  applyBurn(dps, duration) {
    this.burnDps = Math.max(this.burnDps, dps);
    this.burnT = Math.max(this.burnT, duration);
  }

  updateBurn(dt) {
    if (this.burnT <= 0 || !this.alive) return;
    this.burnT -= dt;
    // continuous damage — no takeDamage() to avoid per-frame hit audio/flash
    this.hp -= this.burnDps * dt;
    this.hpBar?.set(this.hp / this.maxHP);
    this._burnFxAcc += dt;
    if (this._burnFxAcc > 0.12) {
      this._burnFxAcc = 0;
      this.game.fx.burnFlame(this.center, this.cfg.radius);
    }
    if (this.hp <= 0) {
      this.lastHitSource = 'burn';
      this.die();
    }
  }

  // Frost chill. Refreshes like ignite: keeps the strongest slow and the longest
  // remaining duration.
  applySlow(factor, duration) {
    this.slowFactor = Math.min(this.slowFactor, factor);
    this.slowT = Math.max(this.slowT, duration);
  }

  updateSlow(dt) {
    if (this.slowT <= 0 || !this.alive) return;
    this.slowT -= dt;
    if (this.slowT <= 0) {
      this.slowFactor = 1;
      return;
    }
    this._slowFxAcc += dt;
    if (this._slowFxAcc > 0.12) {
      this._slowFxAcc = 0;
      this.game.fx.frostMist(this.center, this.cfg.radius);
    }
  }

  updateDeath(dt) {}
  updateAI(dt) {}
  dispose() {}
}
