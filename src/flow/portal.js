import * as THREE from 'three';

// Demonic spawn portal (PRD §22): visible ring that opens, disgorges an enemy,
// then collapses.
export class Portal {
  constructor(game, pos, aerial = false) {
    this.game = game;
    this.pos = pos.clone();
    this.aerial = aerial;
    this.age = 0;
    this.state = 'opening'; // opening -> open -> closing -> done
    this.done = false;

    this.group = new THREE.Group();
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.15, 0.09, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xff3a20 })
    );
    this.inner = new THREE.Mesh(
      new THREE.CircleGeometry(1.05, 24),
      new THREE.MeshBasicMaterial({
        color: 0x40060a, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      })
    );
    this.group.add(this.ring, this.inner);
    this.group.position.set(pos.x, pos.y + (aerial ? 0 : 1.25), pos.z);
    this.group.scale.setScalar(0.01);
    game.scene.add(this.group);

    this.light = new THREE.PointLight(0xff3a20, 0, 12, 2);
    this.light.position.copy(this.group.position);
    game.scene.add(this.light);

    game.audio.play('portalOpen');
  }

  close() {
    if (this.state !== 'closing' && this.state !== 'done') {
      this.state = 'closing';
      this.closeAge = 0;
    }
  }

  update(dt) {
    if (this.done) return;
    this.age += dt;
    this.ring.rotation.z += dt * 1.8;
    // face the player for readability
    const p = this.game.player.pos;
    this.group.lookAt(p.x, this.group.position.y, p.z);

    if (this.state === 'opening') {
      const t = Math.min(1, this.age / 0.55);
      const s = t * t * (3 - 2 * t);
      this.group.scale.setScalar(Math.max(0.01, s));
      this.light.intensity = 60 * s;
      if (t >= 1) this.state = 'open';
    } else if (this.state === 'open') {
      const pulse = 1 + Math.sin(this.age * 7) * 0.05;
      this.group.scale.setScalar(pulse);
      this.light.intensity = 55 + Math.sin(this.age * 9) * 12;
      this.game.fx.portalSwirl(this.pos, this.age);
    } else if (this.state === 'closing') {
      this.closeAge += dt;
      const t = Math.min(1, this.closeAge / 0.45);
      this.group.scale.setScalar(Math.max(0.01, 1 - t));
      this.light.intensity = 60 * (1 - t);
      if (t >= 1) {
        this.done = true;
        this.dispose();
      }
    }
  }

  dispose() {
    this.game.scene.remove(this.group);
    this.game.scene.remove(this.light);
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.inner.geometry.dispose();
    this.inner.material.dispose();
  }
}
