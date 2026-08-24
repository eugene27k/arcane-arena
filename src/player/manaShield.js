import * as THREE from 'three';
import { WARD } from '../config/playerConfig.js';
import { clamp } from '../core/mathUtils.js';

// Mana Shield (PRD §40 sibling of SpellCaster: a held ability rather than a
// cast one). A bubble of spent mana around the mage that sears anything close
// enough to claw — so it answers grunts, which have to reach the wizard to do
// anything, and is wasted on flyers, which never come inside it.
//
// It is toggled, not held, and billed one second at a time: the first second is
// charged the instant it goes up, so flicking the key can never buy free beats
// of damage, and the well running dry drops the ward by itself.
export class ManaShield {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.billT = 0;   // seconds until the next mana charge
    this.pulseT = 0;  // seconds until the next damage beat
    this.flashT = 0;  // visual kick, decays after every beat that landed
    this._t = 0;

    // Two shells: a soft membrane and a runic lattice just outside it, both
    // additive and depth-write-free so the wizard reads *through* the ward
    // instead of being sealed inside an opaque ball.
    // Front faces only on the membrane: it halves the additive overdraw, and a
    // camera that ends up inside the bubble sees no shell at all. That alone
    // isn't enough to keep a close camera clear — see the proximity fade in
    // update(), which is what actually carries it.
    this.group = new THREE.Group();
    this.group.visible = false;
    this.skinMat = new THREE.MeshBasicMaterial({
      color: WARD.color, transparent: true, opacity: 0.1,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide,
    });
    this.skin = new THREE.Mesh(new THREE.SphereGeometry(WARD.radius, 24, 16), this.skinMat);
    this.latticeMat = new THREE.MeshBasicMaterial({
      color: WARD.coreColor, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true,
    }); // no `side` here: wireframe draws lines, and lines are never face-culled
    this.lattice = new THREE.Mesh(new THREE.IcosahedronGeometry(WARD.radius * 1.01, 1), this.latticeMat);
    this.group.add(this.skin, this.lattice);
    game.scene.add(this.group);
  }

  // The bind. Raising charges the first second up front — if the pool can't
  // cover it the ward simply doesn't come up (trySpendMana raises the usual
  // insufficient-mana tell on the way past).
  toggle() {
    if (this.active) {
      this.lower('🛡️ Mana Shield down');
      return false;
    }
    const game = this.game;
    if (!game.player.alive) return false;
    if (!game.player.trySpendMana(WARD.manaPerSecond)) {
      game.hud.toast(`🛡️ Not enough mana to raise the shield (${WARD.manaPerSecond}/s)`);
      return false;
    }
    this.active = true;
    this.billT = 1;
    this.pulseT = 0; // bite at once: raising it in a grunt's face has to mean something
    this.flashT = 1;
    this.group.visible = true;
    game.audio.play('shieldUp');
    game.hud.toast(`🛡️ Mana Shield up — ${WARD.manaPerSecond} mana/s, R to drop`);
    return true;
  }

  lower(message = null) {
    if (!this.active) return;
    this.active = false;
    this.group.visible = false;
    this.game.audio.play('shieldDown');
    if (message) this.game.hud.toast(message);
  }

  // Run boundaries (new run, back to the menu, death): torn down without the
  // sound or the toast, since nothing the player did dropped it.
  reset() {
    this.active = false;
    this.billT = 0;
    this.pulseT = 0;
    this.flashT = 0;
    this.group.visible = false;
  }

  update(dt) {
    this._t += dt;
    this.flashT = Math.max(0, this.flashT - dt * 4);
    if (!this.active) return;
    const player = this.game.player;
    if (!player.alive) { this.reset(); return; }

    // ---------- rent ----------
    this.billT -= dt;
    if (this.billT <= 0) {
      if (!player.trySpendMana(WARD.manaPerSecond)) {
        this.lower('🛡️ The well runs dry — the shield fails');
        return;
      }
      this.billT = 1;
    }

    // ---------- the beat ----------
    this.pulseT -= dt;
    if (this.pulseT <= 0) {
      this.pulseT = WARD.pulseInterval;
      this._bite(WARD.dps * WARD.pulseInterval);
    }

    // ---------- visuals ----------
    const c = player.center;
    this.group.position.copy(c);
    this.lattice.rotation.y = this._t * 0.5;
    this.lattice.rotation.x = Math.sin(this._t * 0.4) * 0.3;
    const breathe = 0.5 + 0.5 * Math.sin(this._t * 2.4);
    const kick = this.flashT * this.flashT;
    // Proximity fade, and the reason the ward stays readable: the camera arm
    // collapses to 0.4 m against a wall — deep inside a 2.8 m bubble — and a
    // shell hanging a handspan in front of the lens is violet fog, not a
    // shield. Face culling alone doesn't cover it (the lattice is lines, which
    // are never culled), so the whole ward dissolves as the camera closes on
    // it and is simply gone once the camera is inside. Backing into a corner
    // is exactly when the fight most needs to be visible.
    const near = clamp((this.game.camera.position.distanceTo(c) - WARD.radius) / 1.2, 0, 1);
    this.group.visible = near > 0.01;
    this.skinMat.opacity = (0.07 + 0.03 * breathe + 0.16 * kick) * near;
    this.latticeMat.opacity = (0.12 + 0.05 * breathe + 0.3 * kick) * near;
    this.group.scale.setScalar(1 + 0.02 * breathe + 0.05 * kick);
  }

  // One beat of the ward. Reach is measured the way every other radial effect
  // in the game measures it — centre distance against the radius plus the
  // demon's own girth — so a body leaning into the bubble counts as inside it.
  _bite(damage) {
    const game = this.game;
    const c = game.player.center;
    let hits = 0;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      if (e.center.distanceTo(c) > WARD.radius + e.cfg.radius) continue;
      // silent: four beats a second across a swarm would be a wall of hit
      // stings, so the ward speaks once per beat instead of once per demon
      e.takeDamage(damage, c, 'shield', true);
      game.fx.wardBite(e.center, WARD.coreColor);
      hits++;
    }
    if (hits === 0) return;
    this.flashT = 1;
    game.fx.wardPulse(c, WARD.radius, WARD.color);
    game.audio.play('shieldZap');
  }
}
