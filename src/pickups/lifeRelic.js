import * as THREE from 'three';
import { makeRadialGlowTexture } from '../fx/textures.js';
import { randRange } from '../core/mathUtils.js';
import { LIFE_RELICS } from '../config/pickupConfig.js';

let poolTex = null;

// A heart, not a lamp. Two swells and a rest — so a relic standing across the
// hall reads as *alive* at a distance, and so a player who has learned the
// rhythm can spot one by the way the light moves on the stone without ever
// seeing the crystal that is throwing it.
export function heartbeat(phase) {
  const p = phase - Math.floor(phase);
  const lub = Math.exp(-p * 11);
  const dub = p >= 0.26 ? 0.62 * Math.exp(-(p - 0.26) * 13) : 0;
  return lub + dub;
}

// A life relic planted in the arena. Like the blade in the stone it does not
// come to the mage and it does not rot on a timer — it stands where it was put
// for the rest of the wave, and the walk over is what it costs. Unlike the
// blade it can refuse to be taken: a relic will not spend itself on a mage who
// is not hurt enough to need it, and it says so by going dark rather than by
// putting words on the screen.
export class LifeRelic {
  constructor(game, tierId, pos) {
    this.game = game;
    this.isRelic = true;
    this.tierId = tierId;
    this.tier = LIFE_RELICS[tierId];
    this.alive = true;
    this.pos = pos.clone();
    this._phase = Math.random();
    this._takeT = 0;
    this._wake = 0;        // 0 dormant, 1 awake; eased so the change is felt
    this._refused = false; // the one-time nudge when a font turns you away

    const tier = this.tier;
    const full = tier.full;
    if (!poolTex) poolTex = makeRadialGlowTexture('rgba(255,200,205,0.95)', 'rgba(190,20,50,0)');

    this.group = new THREE.Group();
    this.group.position.copy(pos);

    // The relic proper: a cut stone, taller than it is wide, hanging a little
    // above the floor it was set into.
    const gemGeo = new THREE.OctahedronGeometry(full ? 0.42 : 0.32, 0);
    gemGeo.scale(1, 1.35, 1);
    this.gemMat = new THREE.MeshStandardMaterial({
      color: tier.color, emissive: tier.color, emissiveIntensity: 2.0,
      roughness: 0.18, metalness: 0.1,
    });
    this.gem = new THREE.Mesh(gemGeo, this.gemMat);
    this.gem.position.y = full ? 1.15 : 0.95;
    this.group.add(this.gem);

    // Inner light, so the gem blooms instead of merely being lit.
    this.core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: poolTex, color: tier.coreColor, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0.8,
    }));
    this.core.scale.setScalar(full ? 2.2 : 1.5);
    this.core.position.y = this.gem.position.y;
    this.group.add(this.core);

    // The pool it throws on the stone underneath — the part that is visible
    // from the far side of a pillar.
    this.pool = new THREE.Sprite(new THREE.SpriteMaterial({
      map: poolTex, color: tier.color, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0.55,
    }));
    this.pool.scale.setScalar(full ? 3.4 : 2.3);
    this.pool.position.y = 0.08;
    this.group.add(this.pool);

    this.light = new THREE.PointLight(tier.color, full ? 16 : 9, full ? 12 : 8, 2);
    this.light.position.y = this.gem.position.y;
    this.group.add(this.light);

    // A font announces itself the way the blade does: a column to navigate by
    // from anywhere in the hall, plus a ring turning around the stone. The
    // ember gets neither — it is meant to be found, not handed over.
    if (full) {
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.42, 11, 9, 1, true),
        new THREE.MeshBasicMaterial({
          color: tier.color, blending: THREE.AdditiveBlending, transparent: true,
          opacity: 0.09, depthWrite: false, side: THREE.BackSide,
        })
      );
      shaft.position.y = 7.4;
      this.group.add(shaft);
      this.shaft = shaft;

      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.62, 0.028, 8, 44),
        new THREE.MeshBasicMaterial({
          color: tier.haloColor, blending: THREE.AdditiveBlending,
          transparent: true, opacity: 0.85, depthWrite: false,
        })
      );
      halo.rotation.x = 1.15;
      halo.position.y = this.gem.position.y;
      this.group.add(halo);
      this.halo = halo;
    }

    game.scene.add(this.group);
  }

  // Would taking it right now actually do something? A relic that answers a
  // mage who does not need it has spent a rare roll on nothing.
  get claimable() {
    const p = this.game.player;
    return p.alive && p.hp < p.maxHP * this.tier.claimAtHpFrac;
  }

  update(dt) {
    if (!this.alive) return;
    const game = this.game;
    const player = game.player;
    this._phase += dt * 1.15;   // ~69 bpm awake, and slower while dormant

    // claimed: the stone comes to the hand and burns out getting there
    if (this._takeT > 0) {
      this._takeT -= dt;
      const t = 1 - Math.max(0, this._takeT) / 0.22;
      this.group.position.lerpVectors(this.pos, player.center, t * t);
      this.group.scale.setScalar(1 - t * 0.85);
      if (this._takeT <= 0) { this.spend(); this.dispose(); }
      return;
    }

    // Dormant relics keep a pilot light: enough to be found, not enough to be
    // mistaken for something you can walk into and use.
    const want = this.claimable ? 1 : 0;
    this._wake += (want - this._wake) * Math.min(1, dt * 3.2);
    const lit = 0.22 + 0.78 * this._wake;
    // A dormant relic beats slowly, like something asleep; waking speeds it up.
    const beat = heartbeat(this._phase * (0.5 + 0.5 * this._wake));

    this.gem.rotation.y += dt * (0.5 + 0.9 * this._wake);
    this.gem.position.y = (this.tier.full ? 1.15 : 0.95) + Math.sin(this._phase * 3.1) * 0.06;
    this.gemMat.emissiveIntensity = (0.5 + beat * 2.2) * lit;
    this.core.position.y = this.gem.position.y;
    this.core.material.opacity = (0.2 + beat * 0.6) * lit;
    this.core.scale.setScalar((this.tier.full ? 2.2 : 1.5) * (0.86 + beat * 0.24));
    this.pool.material.opacity = (0.14 + beat * 0.4) * lit;
    this.light.intensity = (this.tier.full ? 6 + beat * 22 : 3 + beat * 12) * lit;

    if (this.shaft) this.shaft.material.opacity = (0.04 + beat * 0.075) * lit;
    if (this.halo) {
      this.halo.position.y = this.gem.position.y;
      this.halo.rotation.z += dt * (0.6 + 1.1 * this._wake);
      this.halo.rotation.x = 1.15 + Math.sin(this._phase * 1.7) * 0.22;
      this.halo.material.opacity = (0.25 + beat * 0.6) * lit;
    }

    // Motes drifting *up* off the stone — the one cue in the arena that reads
    // as restoration rather than as another thing about to hurt you.
    if (this._wake > 0.35 && Math.random() < dt * (this.tier.full ? 14 : 7)) {
      const r = this.tier.full ? 0.55 : 0.4;
      game.particles.burst(this.pos, 1, () => ({
        pos: new THREE.Vector3(this.pos.x + randRange(-r, r), this.pos.y + 0.1, this.pos.z + randRange(-r, r)),
        life: randRange(0.8, 1.7),
        vel: new THREE.Vector3(randRange(-0.15, 0.15), randRange(0.6, 1.5), randRange(-0.15, 0.15)),
        size: randRange(0.07, 0.16), sizeEnd: 0.02,
        color: this.tier.coreColor, colorEnd: this.tier.color, drag: 0.8,
      }));
    }

    if (!player.alive) return;
    if (player.center.distanceTo(this.group.position) > 2.0) return;
    if (this.claimable) { this.claim(); return; }
    // Standing inside a font you are too healthy to spend is confusing exactly
    // once — after that the dark crystal is explanation enough.
    if (this.tier.full && !this._refused) {
      this._refused = true;
      game.hud.toast(`${this.tier.icon} The font will not answer a mage this whole — come back wounded`);
    }
  }

  claim() {
    if (this._takeT > 0) return;
    this._takeT = 0.22;
    this.game.audio.play(this.tier.full ? 'relicFull' : 'relicHeal');
  }

  // The heal itself, paid at the end of the flight so the number lands with the
  // bloom rather than a fifth of a second before it.
  spend() {
    const game = this.game;
    const player = game.player;
    const amount = this.tier.full ? player.maxHP : this.tier.heal;
    player.heal(amount);
    game.fx.lifeBloom(player.center, this.tier.color, this.tier.full);
    game.hud.healFlash(this.tier.full ? 1 : 0.55);
    game.hud.toast(this.tier.full
      ? `${this.tier.icon} ${this.tier.name} — whole again`
      : `${this.tier.icon} ${this.tier.name} — +${this.tier.heal} HP`);
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    this.game.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.isMesh || o.isSprite) {
        o.geometry?.dispose();
        o.material?.dispose();
      }
    });
  }
}
