import * as THREE from 'three';
import { createKatana } from '../player/katanaModel.js';
import { SPELLS } from '../config/spellConfig.js';
import { makeRadialGlowTexture } from '../fx/textures.js';
import { randRange } from '../core/mathUtils.js';

let shaftTex = null;

// The blade in the stone. Unlike essence, it does not come to the mage and it
// does not rot on a timer: it stands where it landed for the whole wave, lit by
// a shaft the player can navigate by, and the walk over to claim it — through
// whatever is between — is the price of carrying it.
export class BladePickup {
  constructor(game, pos) {
    this.game = game;
    this.isBlade = true;
    this.alive = true;
    this.pos = pos.clone();
    this._phase = 0;
    this._takeT = 0;

    const cfg = SPELLS.katana;
    if (!shaftTex) shaftTex = makeRadialGlowTexture('rgba(255,215,190,0.95)', 'rgba(200,60,40,0)');

    this.group = new THREE.Group();
    this.group.position.copy(pos);

    // point-down, hovering a hand's breadth over the stone it came out of
    this.blade = createKatana({ edgeColor: cfg.edgeColor });
    this.blade.group.rotation.z = Math.PI;
    this.blade.group.position.y = this.blade.length * 1.3 + 0.12;
    this.blade.group.scale.setScalar(1.3);   // a relic, and readable from across the hall
    this.group.add(this.blade.group);

    // Beacon: a column of light to navigate by from the far side of the hall.
    // It starts *above* the hilt rather than around it — additive geometry runs
    // through the bloom pass, and a column drawn over the blade turns the sword
    // into a silhouette inside its own glow.
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.34, 10, 9, 1, true),
      new THREE.MeshBasicMaterial({
        color: cfg.edgeColor, blending: THREE.AdditiveBlending, transparent: true,
        opacity: 0.09, depthWrite: false, side: THREE.BackSide,
      })
    );
    shaft.position.y = 7.0;
    this.group.add(shaft);
    this.shaft = shaft;

    const pool = new THREE.Sprite(new THREE.SpriteMaterial({
      map: shaftTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7,
    }));
    pool.scale.setScalar(2.6);
    pool.position.y = 0.1;
    this.group.add(pool);
    this.pool = pool;

    // A dedicated light rather than the flash pool: this one has to burn for a
    // whole wave, and the pool's six slots are spoken for by explosions.
    this.light = new THREE.PointLight(cfg.edgeColor, 16, 10, 2);
    this.light.position.y = 1.0;
    this.group.add(this.light);

    game.scene.add(this.group);
  }

  update(dt) {
    if (!this.alive) return;
    const game = this.game;
    const player = game.player;
    this._phase += dt;

    // claimed: the blade snaps to the hand, and the caster is handed the binding
    if (this._takeT > 0) {
      this._takeT -= dt;
      const t = 1 - Math.max(0, this._takeT) / 0.18;
      this.group.position.lerpVectors(this.pos, player.center, t * t);
      this.group.scale.setScalar(1 - t * 0.85);
      if (this._takeT <= 0) this.dispose();
      return;
    }

    const pulse = 0.5 + 0.5 * Math.sin(this._phase * 2.1);
    this.blade.group.rotation.y += dt * 0.85;
    this.blade.group.position.y = this.blade.length * 1.3 + 0.12 + Math.sin(this._phase * 1.6) * 0.07;
    this.blade.edgeMat.emissiveIntensity = 1.0 + pulse * 1.9;
    this.shaft.material.opacity = 0.06 + pulse * 0.07;
    this.pool.material.opacity = 0.3 + pulse * 0.25;
    this.light.intensity = 13 + pulse * 16;

    if (Math.random() < dt * 8) {
      game.particles.burst(this.pos, 1, () => ({
        pos: new THREE.Vector3(this.pos.x + randRange(-0.4, 0.4), this.pos.y + 0.1, this.pos.z + randRange(-0.4, 0.4)),
        life: randRange(0.7, 1.5),
        vel: new THREE.Vector3(randRange(-0.2, 0.2), randRange(0.7, 1.8), randRange(-0.2, 0.2)),
        size: randRange(0.07, 0.15), sizeEnd: 0.02,
        color: 0xffcaa8, colorEnd: 0x8a1a10, drag: 0.7,
      }));
    }

    if (player.alive && player.center.distanceTo(this.group.position) < 2.1) this.claim();
  }

  claim() {
    if (this._takeT > 0) return;
    this._takeT = 0.18;
    this.game.caster.takeBlade();
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
