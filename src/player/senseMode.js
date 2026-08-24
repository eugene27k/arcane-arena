import { SENSE } from '../config/playerConfig.js';
import { clamp, damp, wrapAngle, angleDelta } from '../core/mathUtils.js';

// Sense Mode (PRD §40 sibling of ManaShield: a toggled ability rather than a
// cast one). It changes nothing about the world, it only measures it — one
// bearing to the nearest living demon, handed to the HUD. Nothing here is drawn
// in the scene: the indicator is DOM, because the cathedral is fill-rate bound
// and a wall-hack that costs frames is not help. There is no line-of-sight
// check either, and that is not an oversight — sensing through the stone is the
// entire ability.
//
// Toggled, not held, and billed one second at a time exactly like the ward: the
// first second is charged the instant it opens, so flicking the key can never
// buy free beats of knowing, and a well that cannot pay the rent closes it.
export class SenseMode {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.billT = 0;        // seconds until the next mana charge

    this.target = null;    // the demon holding the mark
    this.dist = 0;         // metres to it, horizontal
    this.heading = 0;      // smoothed WORLD bearing in radians — what is drawn
    this.hasHeading = false;
    this._cand = null;     // challenger serving out its dwell
    this._candT = 0;

    this.vis = 0;          // 0..1 presence; outlives `active` by the fade
    this.near01 = 0;       // 1 = on top of you, 0 = across the hall
    this.swapT = 0;        // hand-off flare, decays to 0
  }

  // The bind. Opening charges the first second up front — if the pool can't
  // cover it the sense simply doesn't open (trySpendMana raises the usual
  // insufficient-mana tell on the way past).
  toggle() {
    if (this.active) { this.close('👁 Sense closed'); return false; }
    const game = this.game;
    if (!game.player.alive) return false;
    if (!game.player.trySpendMana(SENSE.manaPerSecond)) {
      game.hud.toast(`👁 Not enough mana to open the sense (${SENSE.manaPerSecond}/s)`);
      return false;
    }
    this.active = true;
    this.billT = 1;
    this.target = null;
    this._cand = null;
    this._candT = 0;
    // A fresh open arrives already pointing the right way. Sweeping in from
    // last wave's heading would be an animation of information the mage never
    // paid for.
    this.hasHeading = false;
    game.audio.play('senseOn');
    game.hud.toast(`👁 Sense open — ${SENSE.manaPerSecond} mana/s, C to close`);
    return true;
  }

  // Idempotent, and the same exit the rent failure takes: a sense that lapses
  // and a sense you closed have to be the same event to the player, or the
  // ability looks like it broke.
  close(message = null) {
    if (!this.active) return;
    this.active = false;
    this.target = null;
    this._cand = null;
    this._candT = 0;
    this.game.audio.play('senseOff');
    if (message) this.game.hud.toast(message);
  }

  // Run boundaries (new run, back to the menu, death): closed without the sound
  // or the toast, since nothing the player did closed it. `vis` is zeroed here
  // rather than left to decay, because DEATH runs its own update path that
  // never ticks this class — a fading needle would freeze at whatever it was
  // and hang over the corpse for the whole death orbit.
  reset() {
    this.active = false;
    this.billT = 0;
    this.target = null;
    this._cand = null;
    this._candT = 0;
    this.hasHeading = false;
    this.vis = 0;
    this.near01 = 0;
    this.swapT = 0;
  }

  // clearEntities() disposes every demon and empties the array without ever
  // setting alive = false, so a held mark would survive as a dangling reference
  // still reporting alive === true — one frame of pointing at a disposed ghost,
  // with its meshes pinned out of the collector's reach. The ward has no
  // equivalent hazard because it holds no references; this one is ours.
  forget() {
    this.target = null;
    this._cand = null;
    this._candT = 0;
    this.hasHeading = false;
  }

  update(dt) {
    if (this.active) {
      const player = this.game.player;
      // Death can land inside this same frame: player.update() runs first and
      // can call die('abyss'). This is the ordinary path on the frame you fall
      // off the world, not belt-and-braces.
      if (!player.alive) { this.reset(); return; }

      // ---------- rent ----------
      this.billT -= dt;
      if (this.billT <= 0) {
        if (!player.trySpendMana(SENSE.manaPerSecond)) {
          this.close('👁 The well runs dry — the sense closes');
        } else {
          this.billT = 1;   // a literal second, never += : a long frame hitch
        }                   // must not accrue back-rent
      }
    }
    if (this.active) { this._acquire(dt); this._steer(dt); }
    this._envelopes(dt);
  }

  // The scan. WAVE_RULES.maxConcurrentEnemies caps the living at 11 and corpses
  // linger about half a second, so this walks at most ~14 entries: an index loop
  // over raw components, no filter, no map, no closure, and above all no
  // e.center, which mints a Vector3 on every read and carries a per-type height
  // offset that would make a flyer overhead read as further off than a grunt
  // standing on the same spot. The needle lives in the plan view, so the
  // measurement does too: squared, horizontal, off the stored pos.
  _acquire(dt) {
    const p = this.game.player.pos;
    const px = p.x, pz = p.z;
    const list = this.game.enemies;
    let best = null, bestD2 = Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      // updateGameplay filters on removeMe, not alive: a corpse sits in the
      // array for another half-second of death animation, and a needle locked
      // onto one points confidently at nothing for all of it.
      if (!e.alive) continue;
      const dx = e.pos.x - px, dz = e.pos.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }

    const held = this.target;
    if (!best) {
      // Nothing alive. Drop the mark and the heading with it, so the next demon
      // to appear is snapped to rather than swept to from a bearing that went
      // stale while the arena was empty.
      this.target = null; this._cand = null; this._candT = 0; this.hasHeading = false;
      return;
    }
    // A mark that has stopped existing is not a choice, so there is nothing to
    // hesitate about: no margin, no dwell, swap now.
    if (!held || !held.alive) { this._mark(best, bestD2); return; }

    const hx = held.pos.x - px, hz = held.pos.z - pz;
    const heldD2 = hx * hx + hz * hz;
    if (best !== held && bestD2 < heldD2 * SENSE.switchMargin) {
      // Credited from the first frame the advantage existed, not the second,
      // so switchDelay is the dwell it says it is rather than one frame more.
      if (best === this._cand) this._candT += dt;
      else { this._cand = best; this._candT = dt; }
      if (this._candT >= SENSE.switchDelay) { this._mark(best, bestD2); return; }
    } else {
      this._cand = null;
      this._candT = 0;
    }
    this.dist = Math.sqrt(heldD2);
  }

  _mark(e, d2) {
    const handOff = this.target !== null && this.hasHeading;
    this.target = e;
    this.dist = Math.sqrt(d2);
    this._cand = null;
    this._candT = 0;
    if (handOff) this.swapT = 1;
  }

  _steer(dt) {
    const t = this.target;
    if (!t) return;
    const p = this.game.player.pos;
    const dx = t.pos.x - p.x, dz = t.pos.z - p.z;
    // Inside the null radius the bearing is undefined, not merely fast. Hold
    // the last heading and let the brightness carry the message instead.
    if (dx * dx + dz * dz < SENSE.nullRadius * SENSE.nullRadius) return;
    // Same argument order as the damage arcs' call site in main.js — x first,
    // z second — so the needle and the arcs agree about which way is right.
    const goal = Math.atan2(dx, dz);
    if (!this.hasHeading) {
      this.heading = goal;
      this.hasHeading = true;
      this.swapT = 1;
      return;
    }
    // The error is the WRAPPED delta: a demon crossing due south behind the
    // mage moves the needle four degrees, not three hundred and fifty-six.
    let step = angleDelta(this.heading, goal) * damp(SENSE.turnRate, dt);
    const maxStep = SENSE.maxTurnRate * dt;
    if (step > maxStep) step = maxStep;
    else if (step < -maxStep) step = -maxStep;
    this.heading = wrapAngle(this.heading + step);
  }

  _envelopes(dt) {
    // `hasHeading`, not just `target`, and that is the whole guard: a mark can
    // be held with no bearing ever computed for it — acquired inside the null
    // radius, where atan2 has nothing to say. Presence keyed on the mark alone
    // would raise `vis` to 1 over a heading nobody set, which is the previous
    // open's bearing, or world +z on the first open of the page. A needle that
    // is merely absent says "nothing worth pointing at"; a needle at full
    // brightness pointing the wrong way is a lie, and this ability is only
    // worth having if it is never that.
    const want = this.active && this.target && this.hasHeading ? 1 : 0;
    this.vis += (want - this.vis)
      * damp(want > this.vis ? SENSE.fadeInRate : SENSE.fadeOutRate, dt);
    if (this.target) {
      const n = clamp(1 - (this.dist - SENSE.nearDist)
        / (SENSE.farDist - SENSE.nearDist), 0, 1);
      this.near01 += (n - this.near01) * damp(SENSE.proxRate, dt);
    }
    this.swapT = Math.max(0, this.swapT - dt * SENSE.swapDecay);
  }
}
