import * as THREE from 'three';

// Tiny billboard HP bar above a damaged enemy. Canvas-textured sprite;
// redrawn only when the fraction changes (damage events), not per frame.
const W = 64, H = 8;

export class EnemyHealthBar {
  constructor(scene) {
    this.scene = scene;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.SpriteMaterial({
      map: this.texture, transparent: true, depthWrite: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.set(1.0, H / W, 1);
    this.frac = -1;
    this.set(1);
    scene.add(this.sprite);
  }

  set(frac) {
    frac = Math.max(0, Math.min(1, frac));
    if (frac === this.frac) return;
    this.frac = frac;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(8, 5, 8, 0.8)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = frac > 0.5 ? '#d84a30' : '#e02818';
    ctx.fillRect(1, 1, (W - 2) * frac, H - 2);
    ctx.strokeStyle = 'rgba(255, 214, 170, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
    this.texture.needsUpdate = true;
  }

  follow(pos, height) {
    this.sprite.position.set(pos.x, pos.y + height, pos.z);
  }

  dispose() {
    this.scene.remove(this.sprite);
    this.material.dispose();
    this.texture.dispose();
  }
}
