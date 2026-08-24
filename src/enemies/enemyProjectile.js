import * as THREE from 'three';
import { segmentHitsSphere } from '../core/mathUtils.js';
import { makeRadialGlowTexture } from '../fx/textures.js';

let sharedGlowTex = null;

// Shadow bolt fired by Flying Demons.
export class EnemyProjectile {
  constructor(game, pos, vel, radius, damage) {
    this.game = game;
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.radius = radius;
    this.damage = damage;
    this.life = 5;
    this.alive = true;

    if (!sharedGlowTex) sharedGlowTex = makeRadialGlowTexture('rgba(230,140,255,1)', 'rgba(120,20,180,0)');
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xe090ff })
    );
    this.mesh.position.copy(pos);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: sharedGlowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    glow.scale.setScalar(1.1);
    this.mesh.add(glow);
    game.scene.add(this.mesh);
    this._trailAcc = 0;
  }

  update(dt) {
    if (!this.alive) return;
    this.life -= dt;
    if (this.life <= 0) { this.dispose(); return; }

    const from = this.pos.clone();
    const move = this.vel.clone().multiplyScalar(dt);
    const to = from.clone().add(move);
    const dist = move.length();
    const dir = move.clone().divideScalar(dist || 1);

    // player hit (generous chest sphere; dash i-frames apply inside takeDamage)
    const player = this.game.player;
    if (player.alive) {
      const t = segmentHitsSphere(from, to, player.center, 0.75 + this.radius);
      if (t >= 0) {
        player.takeDamage(this.damage, this.pos);
        this.game.fx.impactPuff(player.center, 0xc060ff);
        this.dispose();
        return;
      }
    }

    // world hit
    const hit = dist > 0 ? this.game.world.raycast(from, dir, dist + this.radius) : null;
    if (hit) {
      this.game.fx.impactPuff(hit.point, 0xa050e0);
      this.dispose();
      return;
    }

    this.pos.copy(to);
    this.mesh.position.copy(this.pos);

    this._trailAcc += dt;
    while (this._trailAcc > 0.03) {
      this._trailAcc -= 0.03;
      this.game.fx.particles.spawn({
        pos: this.pos, life: 0.3,
        vel: new THREE.Vector3(0, 0, 0),
        size: 0.28, sizeEnd: 0.04,
        color: 0xc070ff, colorEnd: 0x300a50, drag: 1,
      });
    }
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    this.game.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
