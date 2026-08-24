import * as THREE from 'three';
import { makeRadialGlowTexture } from '../fx/textures.js';
import { randRange } from '../core/mathUtils.js';

let manaGlowTex = null;
let healthGlowTex = null;

// ManaEssence & HealthPickup (PRD §16-§17): glowing orbs dropped by enemies;
// the player must physically approach; orb flies to the player on collect.
export class Pickup {
  constructor(game, kind, pos, amount) {
    this.game = game;
    this.kind = kind; // 'mana' | 'health'
    this.amount = amount;
    this.pos = pos.clone();
    this.basePos = pos.clone();
    this.alive = true;
    this.life = 30;
    this.collecting = false;
    this.collectT = 0;
    this._phase = Math.random() * 10;

    if (!manaGlowTex) {
      manaGlowTex = makeRadialGlowTexture('rgba(120,220,255,1)', 'rgba(20,80,220,0)');
      healthGlowTex = makeRadialGlowTexture('rgba(255,120,120,1)', 'rgba(180,20,40,0)');
    }
    const isMana = kind === 'mana';
    const color = isMana ? 0x50c8ff : 0xff5060;

    this.group = new THREE.Group();
    this.crystal = new THREE.Mesh(
      new THREE.IcosahedronGeometry(isMana ? 0.26 : 0.24, 0),
      new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: 1.6, roughness: 0.3,
      })
    );
    this.group.add(this.crystal);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: isMana ? manaGlowTex : healthGlowTex,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85,
    }));
    glow.scale.setScalar(1.5);
    this.group.add(glow);
    this.glowSprite = glow;
    this.group.position.copy(pos);
    game.scene.add(this.group);
  }

  update(dt) {
    if (!this.alive) return;
    const game = this.game;
    const player = game.player;

    if (this.collecting) {
      this.collectT += dt * 6;
      const t = Math.min(1, this.collectT);
      this.pos.lerpVectors(this.basePos, player.center, t * t);
      this.group.position.copy(this.pos);
      this.group.scale.setScalar(1 - t * 0.7);
      if (t >= 1) {
        if (this.kind === 'mana') {
          // Essence Overflow: essence collected at (near-)full mana heals instead
          if (player.essenceOverflow && player.mana >= player.maxMana - 1) {
            player.heal(5);
            game.fx.pickupSparkle(player.center, 0xff6070);
          }
          player.addMana(this.amount);
          game.audio.play('manaPickup');
          game.fx.pickupSparkle(player.center, 0x50c8ff);
        } else {
          player.heal(this.amount);
          game.audio.play('healthPickup');
          game.fx.pickupSparkle(player.center, 0xff6070);
        }
        this.dispose();
      }
      return;
    }

    this.life -= dt;
    if (this.life <= 0) { this.dispose(); return; }

    // bob + spin, blink when expiring
    this._phase += dt;
    this.crystal.rotation.y += dt * 2.2;
    this.crystal.rotation.x += dt * 0.9;
    this.group.position.y = this.basePos.y + Math.sin(this._phase * 2.4) * 0.12;
    if (this.life < 5) {
      const blink = Math.sin(this.life * 12) > 0 ? 1 : 0.25;
      this.glowSprite.material.opacity = 0.85 * blink;
      this.crystal.material.emissiveIntensity = 1.6 * blink;
    }

    // collect when the player is close (magnet radius slightly larger on the ground plane)
    if (player.alive && player.center.distanceTo(this.group.position) < 1.9) {
      this.collecting = true;
      this.basePos.copy(this.group.position);
    }
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    this.game.scene.remove(this.group);
    this.crystal.geometry.dispose();
    this.crystal.material.dispose();
  }
}

// Roll drops for a killed enemy (PRD §16: reward depends on enemy type).
export function rollDrops(game, enemy) {
  const cfg = enemy.cfg;
  const at = enemy.lastGroundedPos.clone();
  at.y += 0.7;
  // keep drops out of the void: snap to a real surface
  const ground = game.world.groundHeight(at.x, at.z, at.y + 2);
  if (ground === null) {
    at.set(enemy.lastGroundedPos.x, enemy.lastGroundedPos.y + 0.7, enemy.lastGroundedPos.z);
  } else {
    at.y = ground + 0.7;
  }
  if (Math.random() < cfg.manaDropChance) {
    const amount = Math.round(randRange(cfg.manaReward[0], cfg.manaReward[1]));
    game.pickups.push(new Pickup(game, 'mana', at, amount));
  }
  if (Math.random() < cfg.healthDropChance) {
    const off = new THREE.Vector3(randRange(-0.5, 0.5), 0, randRange(-0.5, 0.5));
    game.pickups.push(new Pickup(game, 'health', at.clone().add(off), cfg.healthReward));
  }
}
