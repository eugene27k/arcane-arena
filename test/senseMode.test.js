// Sense Mode is the one ability whose whole product is a number — a bearing —
// so almost all of it is checkable without a renderer: the class imports only
// playerConfig and mathUtils, touches no DOM, no AudioContext and no THREE
// object, and every clock in it is dt-driven. The two things worth guarding
// hardest are the price (it has to sit above the emergency trickle or the mode
// can never run dry) and the ±π seam (a demon behind you is precisely the case
// the sense exists for, and it is the case a naive lerp spins the long way on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SenseMode } from '../src/player/senseMode.js';
import { CONTROLS, GOD, PLAYER, SENSE } from '../src/config/playerConfig.js';
import { wrapAngle, angleDelta } from '../src/core/mathUtils.js';

const stub = ({ enemies = [], mana = 100, alive = true, god = false } = {}) => {
  const player = {
    alive, mana, maxMana: 100, godMode: god,
    pos: { x: 0, y: 0, z: 0 },
    trySpendMana(amount) {
      if (god) return true;
      if (this.mana - amount < 0) return false;
      this.mana -= amount;
      return true;
    },
  };
  const toasts = [], sounds = [];
  return {
    player, enemies, toasts, sounds,
    audio: { play: (n) => sounds.push(n) },
    hud: { toast: (m) => toasts.push(m) },
  };
};

const demon = (x, z, aliveFlag = true) => ({ alive: aliveFlag, pos: { x, y: 0, z }, cfg: { id: `d${x}_${z}` } });
const step = (s, seconds, dt = 1 / 60) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) s.update(dt);
};

// --- the price -------------------------------------------------------------

test('the price sits above the emergency trickle, which is what makes running dry reachable', () => {
  // PLAYER.manaReserveRegen refills the well below the reserve for free. A
  // sense priced at or under that rate would pay its own rent forever at the
  // floor, and "the well runs dry closes it" would be unreachable code.
  assert.ok(SENSE.manaPerSecond > PLAYER.manaReserveRegen,
    `sense at ${SENSE.manaPerSecond}/s vs a trickle of ${PLAYER.manaReserveRegen}/s: `
    + 'a sense the trickle can cover can never run dry, and running dry is the only '
    + 'thing that closes it on its own');
  assert.ok(SENSE.manaPerSecond < 5, 'the user asked for a small charge; the ward is 5/s');
});

test('the sense has its own bind, and it is not one already spoken for', () => {
  assert.ok(CONTROLS.senseKeys.length > 0);
  const taken = new Set([...CONTROLS.castKeys, ...CONTROLS.meleeKeys, ...CONTROLS.shieldKeys,
    ...CONTROLS.autoKeys, ...GOD.code, 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyM', 'Space']);
  for (const k of CONTROLS.senseKeys) assert.ok(!taken.has(k), `${k} is already bound`);
});

// --- billing ---------------------------------------------------------------

test('opening charges the first second up front, before a single frame runs', () => {
  const g = stub();
  const s = new SenseMode(g);
  assert.equal(s.toggle(), true);
  assert.equal(g.player.mana, 100 - SENSE.manaPerSecond);
  assert.equal(s.active, true);
  assert.deepEqual(g.sounds, ['senseOn']);
});

test('a second of uptime is a second of rent, and no more', () => {
  const g = stub();
  const s = new SenseMode(g);
  s.toggle();
  step(s, 1);                       // exactly one billing boundary crossed
  assert.equal(g.player.mana, 100 - SENSE.manaPerSecond * 2);
  step(s, 0.9);                     // still inside the second already paid for
  assert.equal(g.player.mana, 100 - SENSE.manaPerSecond * 2);
});

test('billT is set, never accumulated: a long frame hitch owes no back-rent', () => {
  const g = stub();
  const s = new SenseMode(g);
  s.toggle();
  s.update(1.9);                    // one stalled frame spanning two seconds
  assert.equal(g.player.mana, 100 - SENSE.manaPerSecond * 2, 'charged once, not twice');
  assert.equal(s.billT, 1, 'the clock restarts whole rather than carrying a deficit');
});

test('it bills with an empty arena — the same rule the ward states for itself', () => {
  const g = stub({ enemies: [] });
  const s = new SenseMode(g);
  s.toggle();
  step(s, 3);
  assert.equal(g.player.mana, 100 - SENSE.manaPerSecond * 4);
  assert.equal(s.active, true, 'and it never closes itself just because nothing is out there');
});

test('a well that cannot cover a second does not open the sense at all', () => {
  const g = stub({ mana: SENSE.manaPerSecond - 1 });
  const s = new SenseMode(g);
  assert.equal(s.toggle(), false);
  assert.equal(s.active, false);
  assert.equal(g.player.mana, SENSE.manaPerSecond - 1, 'nothing was taken');
  assert.equal(g.toasts.length, 1);
  assert.match(g.toasts[0], /Not enough mana/);
  assert.deepEqual(g.sounds, [], 'and it does not sound like it opened');
});

test('the well running dry closes it exactly once, with the same exit a manual close takes', () => {
  const g = stub({ mana: SENSE.manaPerSecond * 2 });   // opens, buys one more second
  const s = new SenseMode(g);
  s.toggle();
  step(s, 1);
  assert.equal(s.active, true);
  step(s, 1);
  assert.equal(s.active, false, 'the second tick could not be paid');
  assert.equal(g.sounds.filter((n) => n === 'senseOff').length, 1);
  assert.ok(g.toasts.some((t) => /runs dry/.test(t)));
  // Re-entered directly: update()'s rent block is behind `if (this.active)`, so
  // stepping again can never reach close() a second time and would prove only
  // that guard. This calls the exit itself.
  s.close('a second close');
  s.close();
  assert.equal(g.sounds.filter((n) => n === 'senseOff').length, 1, 'close() is idempotent');
  assert.ok(!g.toasts.includes('a second close'), 'and it stays silent the second time');
});

test('an overdrawn well neither opens the sense nor sustains it', () => {
  const g = stub({ mana: -10 });     // arcane debt, after a Meteor Storm
  const s = new SenseMode(g);
  assert.equal(s.toggle(), false, 'no overdraft: sense is rent, not a bounded debt');
  assert.equal(s.active, false);
});

test('god mode never deducts and never closes it', () => {
  const g = stub({ god: true });
  const s = new SenseMode(g);
  s.toggle();
  step(s, 30);
  assert.equal(s.active, true);
  assert.equal(g.player.mana, 100);
});

test('toggling closes it, and every re-open charges a fresh second up front', () => {
  const g = stub();
  const s = new SenseMode(g);
  s.toggle(); s.toggle(); s.toggle();
  assert.equal(s.active, true);
  assert.equal(g.player.mana, 100 - SENSE.manaPerSecond * 2, 'two opens, two up-front charges');
  assert.equal(g.sounds.filter((n) => n === 'senseOff').length, 1);
});

// --- which demon holds the mark --------------------------------------------

test('the nearest LIVING demon takes the mark; a nearer corpse is invisible to it', () => {
  const corpse = demon(1, 0, false);
  const live = demon(9, 0);
  const g = stub({ enemies: [corpse, live] });
  const s = new SenseMode(g);
  s.toggle();
  s.update(1 / 60);
  assert.equal(s.target, live, 'bodies linger in the array for half a second of death animation');
  assert.ok(Math.abs(s.dist - 9) < 1e-9);
});

test('a challenger inside the margin is refused however long it holds it', () => {
  // The mark has to be held before hysteresis means anything: on the opening
  // frame there is nothing to arbitrate against, so the nearest simply takes it.
  const held = demon(0, 10);
  const g = stub({ enemies: [held] });
  const s = new SenseMode(g);
  s.toggle();
  s.update(1 / 60);
  assert.equal(s.target, held);
  // squared margin 0.8 -> a challenger must get under sqrt(0.8) x the distance
  g.enemies.push(demon(0, 10 * Math.sqrt(SENSE.switchMargin) + 1e-3));
  step(s, 2);
  assert.equal(s.target, held, 'two grunts walking abreast must not trade the needle');
  assert.equal(s.swapT, 0, 'and nothing flared, because nothing changed hands');
});

test('a challenger past the margin takes the mark only after the dwell, not before', () => {
  const held = demon(0, 10);
  const g = stub({ enemies: [held] });
  const s = new SenseMode(g);
  s.toggle();
  s.update(1 / 60);
  assert.equal(s.target, held);
  const challenger = demon(0, 10 * Math.sqrt(SENSE.switchMargin) - 1e-3);
  g.enemies.push(challenger);
  // Frame-exact: the dwell is credited from the first frame the advantage
  // exists, so it commits on the frame where frames x dt first reaches it.
  const need = Math.ceil(SENSE.switchDelay * 60);
  for (let i = 0; i < need - 1; i++) s.update(1 / 60);
  assert.equal(s.target, held, 'the dwell has not been served');
  // Sampled on the frame BEFORE the swap: the opening acquisition already set
  // swapT = 1, and at swapDecay 3/s it has only fallen to ~0.6 by now, so
  // "swapT > 0" after the swap would be true whether or not the hand-off
  // flared at all.
  const flareBefore = s.swapT;
  s.update(1 / 60);
  assert.equal(s.target, challenger);
  // Re-lit to 1 by _mark, then decayed by one frame (dt * swapDecay) inside the
  // same update, so the ceiling to check against is just under 1.
  assert.ok(s.swapT > 0.9,
    `the hand-off must re-light the flare, not ride the opening one; got ${s.swapT.toFixed(3)}`);
  assert.ok(s.swapT > flareBefore, `flare rose from ${flareBefore.toFixed(2)} to ${s.swapT.toFixed(2)}`);
});

test('a mark that dies is dropped the same frame — no margin, no dwell, never a corpse', () => {
  const held = demon(0, 2);
  const far = demon(0, 25);
  const g = stub({ enemies: [held, far] });
  const s = new SenseMode(g);
  s.toggle();
  s.update(1 / 60);
  assert.equal(s.target, held);
  held.alive = false;
  s.update(1 / 60);
  assert.equal(s.target, far, 'hesitating here would point confidently at a body');
});

test('an empty arena drops the mark and the heading with it', () => {
  const e = demon(0, 6);
  const g = stub({ enemies: [e] });
  const s = new SenseMode(g);
  s.toggle();
  step(s, 0.2);
  assert.equal(s.hasHeading, true);
  e.alive = false;
  s.update(1 / 60);
  assert.equal(s.target, null);
  assert.equal(s.hasHeading, false, 'the next demon is snapped to, not swept to from a stale bearing');
  step(s, 1.5);
  assert.ok(s.vis < 0.01, 'and the needle fades out rather than cutting');
});

// --- the bearing -----------------------------------------------------------

test('the bearing uses the damage arcs’ argument order: atan2(dx, dz)', () => {
  const g = stub({ enemies: [demon(0, 5)] });
  const s = new SenseMode(g);
  s.toggle();
  s.update(1 / 60);
  assert.ok(Math.abs(s.heading - 0) < 1e-9, 'a demon at +z is bearing 0');

  const g2 = stub({ enemies: [demon(5, 0)] });
  const s2 = new SenseMode(g2);
  s2.toggle();
  s2.update(1 / 60);
  assert.ok(Math.abs(s2.heading - Math.PI / 2) < 1e-9,
    'a demon at +x is bearing +pi/2 — the same convention main.js uses for damageFrom');
});

test('a fresh open snaps to the bearing rather than sweeping in from last wave’s', () => {
  const g = stub({ enemies: [demon(0, -5)] });   // directly behind
  const s = new SenseMode(g);
  s.toggle();
  s.update(1 / 60);
  assert.ok(Math.abs(Math.abs(s.heading) - Math.PI) < 1e-9, 'arrived pointing the right way');
});

test('wrapAngle and angleDelta take the short way round the seam', () => {
  assert.ok(Math.abs(angleDelta(3.0, -3.0) - 0.2831853071795862) < 1e-9,
    'crossing due south is a few degrees, not nearly a full turn');
  assert.ok(Math.abs(angleDelta(-3.0, 3.0) + 0.2831853071795862) < 1e-9);
  assert.ok(Math.abs(wrapAngle(7 * Math.PI) - -Math.PI) < 1e-9);
  assert.ok(Math.abs(wrapAngle(0.5) - 0.5) < 1e-12, 'an angle already home is untouched');
  for (const a of [-100, -6.3, -Math.PI, 0, Math.PI, 6.3, 100, 1e4]) {
    const w = wrapAngle(a);
    assert.ok(w >= -Math.PI && w < Math.PI + 1e-12, `${a} wrapped out of range: ${w}`);
    assert.ok(Math.abs(Math.sin(w) - Math.sin(a)) < 1e-9, 'and it is the same angle');
  }
});

test('a demon crossing behind the mage sweeps a few degrees, never three hundred and fifty', () => {
  const e = demon(-0.5, -8);           // just left of due south
  const g = stub({ enemies: [e] });
  const s = new SenseMode(g);
  s.toggle();
  s.update(1 / 60);
  const before = s.heading;
  e.pos.x = 0.5;                       // steps across the seam to just right of it
  // Measured over a full second of CUMULATIVE travel, not one frame. One frame
  // proves nothing here: the slew clamp caps any single step at maxTurnRate*dt
  // = 0.15 rad whichever way the needle is going, so a one-frame magnitude
  // assertion is satisfied by the clamp and passes even for a naive
  // (goal - heading) lerp that then spins the long way round over the next
  // second. Summing the absolute steps is what actually distinguishes them.
  let travel = 0, prev = before;
  for (let i = 0; i < 60; i++) {
    s.update(1 / 60);
    travel += Math.abs(angleDelta(prev, s.heading));
    prev = s.heading;
  }
  assert.ok(travel < 0.5,
    `the needle travelled ${travel.toFixed(2)} rad to cross the seam; the short way is `
    + 'about 0.13 rad and the long way about 6.15 — anything near the latter means the '
    + 'error stopped being the wrapped delta');
  assert.ok(Math.abs(angleDelta(s.heading, Math.atan2(0.5, -8))) < 0.02, 'and it arrives');
});

test('the slew clamp holds at every frame rate, so a hand-off is a sweep and not a whip', () => {
  for (const dt of [1 / 240, 1 / 60, 1 / 30]) {
    const near = demon(0, 3);
    const g = stub({ enemies: [near] });
    const s = new SenseMode(g);
    s.toggle();
    s.update(dt);
    // teleport the mark to the antipode: the worst case the clamp exists for
    near.pos.z = -3;
    let prev = s.heading;
    for (let i = 0; i < 200; i++) {
      s.update(dt);
      const moved = Math.abs(angleDelta(prev, s.heading));
      assert.ok(moved <= SENSE.maxTurnRate * dt + 1e-9,
        `dt=${dt}: one frame moved ${moved} rad, over the ${SENSE.maxTurnRate} rad/s ceiling`);
      prev = s.heading;
    }
    assert.ok(Math.abs(Math.abs(s.heading) - Math.PI) < 0.05, 'and it does arrive');
  }
});

test('the chase is frame-rate independent — the same half second lands in the same place', () => {
  const run = (dt) => {
    const e = demon(0, 8);
    const g = stub({ enemies: [e] });
    const s = new SenseMode(g);
    s.toggle();
    s.update(dt);
    e.pos.x = 8; e.pos.z = 0;      // a quarter turn to chase
    step(s, 0.5, dt);
    return s.heading;
  };
  // damp() is exact; the slew clamp quantizes by a hair, hence the loose bound
  assert.ok(Math.abs(run(1 / 240) - run(1 / 30)) < 2e-2,
    'a 240 Hz machine and a 30 Hz one must see the same needle');
});

test('a mark that walks inside the null radius holds the bearing it already had', () => {
  const e = demon(0, 12);              // acquired well outside, so a heading exists
  const g = stub({ enemies: [e] });
  const s = new SenseMode(g);
  s.toggle();
  step(s, 0.6);
  const held = s.heading;
  assert.equal(s.hasHeading, true);
  e.pos.x = -SENSE.nullRadius * 0.4;   // now orbiting the mage's own boots
  e.pos.z = 0;
  step(s, 0.5);
  assert.equal(s.heading, held, 'atan2(0,0) is a confident lie; the needle refuses to tell it');
  assert.ok(s.vis > 0.9, 'and it keeps showing the bearing it does have');
  e.pos.x = 0; e.pos.z = 12;           // steps back out
  step(s, 0.5);
  assert.ok(Math.abs(s.heading) < 0.05, 'tracking resumes');
});

test('a mark acquired INSIDE the null radius draws nothing rather than inventing a bearing', () => {
  // The regression this exists for: the null-radius guard returns before the
  // first-bearing snap, so a mark taken at point-blank range never gets a
  // heading — and if presence were keyed on the mark alone, the needle would
  // light to full brightness over whatever `heading` happened to hold. On a
  // fresh instance that is 0, i.e. it would point at world +z, confidently,
  // regardless of where the demon actually is.
  const e = demon(0.2, 0.2);           // 0.28 m, inside nullRadius 0.9
  const g = stub({ enemies: [e] });
  const s = new SenseMode(g);
  s.toggle();
  step(s, 1);
  assert.equal(s.target, e, 'the mark is held — there is something there');
  assert.equal(s.hasHeading, false, 'but no bearing was ever computed for it');
  assert.equal(s.vis, 0, 'so nothing is drawn: absent says "no direction", bright says a lie');
  e.pos.x = 0; e.pos.z = 14;           // steps out to due north
  step(s, 0.5);
  assert.equal(s.hasHeading, true);
  assert.ok(Math.abs(s.heading) < 0.05, 'and it snaps to the real bearing, not sweeps from a fiction');
  assert.ok(s.vis > 0.9, 'lighting only once it has something true to say');
});

test('a stale bearing from a previous open is never shown on the next one', () => {
  const far = demon(0, -10);           // due south
  const g = stub({ enemies: [far] });
  const s = new SenseMode(g);
  s.toggle();
  step(s, 1);
  assert.ok(Math.abs(Math.abs(s.heading) - Math.PI) < 0.05, 'settled on due south');
  s.toggle();                          // closed
  step(s, 1);
  far.pos.x = 0.2; far.pos.z = 0.2;    // a flyer drifts overhead, point blank
  s.toggle();                          // reopened
  step(s, 1);
  // hud.js draws the needle only above this threshold; vis decays exponentially
  // and never reaches a literal zero once it has been raised.
  assert.ok(s.vis <= 0.002,
    `the last open ended pointing due south; that bearing is not evidence about this one `
    + `(vis ${s.vis.toExponential(2)} must stay under the HUD's 0.002 draw threshold)`);
});

// --- envelopes and lifecycle ------------------------------------------------

test('brightness rides distance: near is loud, across the hall is quiet but never gone', () => {
  const near = stub({ enemies: [demon(0, SENSE.nearDist * 0.5)] });
  const sn = new SenseMode(near); sn.toggle(); step(sn, 1.5);
  const far = stub({ enemies: [demon(0, SENSE.farDist * 2)] });
  const sf = new SenseMode(far); sf.toggle(); step(sf, 1.5);
  assert.ok(sn.near01 > 0.98, 'inside nearDist it is full');
  assert.ok(sf.near01 < 0.02, 'past farDist it is at the floor');
  assert.ok(sn.vis > 0.99 && sf.vis > 0.99, 'presence is not brightness: both are present');
});

test('reset() zeroes everything and says nothing — nothing the player did closed it', () => {
  const g = stub({ enemies: [demon(0, 4)] });
  const s = new SenseMode(g);
  s.toggle();
  step(s, 0.5);
  const soundsBefore = g.sounds.length, toastsBefore = g.toasts.length;
  s.reset();
  assert.equal(s.active, false);
  assert.equal(s.billT, 0);
  assert.equal(s.target, null);
  assert.equal(s.hasHeading, false);
  assert.equal(s.vis, 0, 'zeroed, not left to decay: DEATH never ticks this class again');
  assert.equal(s.near01, 0);
  assert.equal(s.swapT, 0);
  assert.equal(g.sounds.length, soundsBefore);
  assert.equal(g.toasts.length, toastsBefore);
});

test('a dead mage closes the sense on the frame they fall, before any rent is charged', () => {
  const g = stub({ enemies: [demon(0, 4)] });
  const s = new SenseMode(g);
  s.toggle();
  const manaAtOpen = g.player.mana;
  g.player.alive = false;             // player.update() ran first and died
  step(s, 2);
  assert.equal(s.active, false);
  assert.equal(s.vis, 0);
  assert.equal(g.player.mana, manaAtOpen, 'a corpse pays no rent');
});

test('forget() drops a dangling mark without touching the billing', () => {
  const g = stub({ enemies: [demon(0, 4)] });
  const s = new SenseMode(g);
  s.toggle();
  step(s, 0.3);
  const billT = s.billT;
  s.forget();                          // clearEntities() disposes without clearing `alive`
  assert.equal(s.target, null);
  assert.equal(s.hasHeading, false);
  assert.equal(s.active, true, 'the mode is still open, it just has nothing in hand');
  assert.equal(s.billT, billT);
});

// --- the hot path ----------------------------------------------------------

test('the scan touches the enemy array by index only — no filter, no map, no copy', () => {
  // Object.keys() alone proves almost nothing here: it sees a new own property
  // on the instance and is blind to an array, closure or Vector3 minted inside
  // the loop, which is what actually costs frames. A Proxy records every
  // property name the scan reads off game.enemies, so `filter`/`map`/`slice`
  // cannot be reached without this failing.
  const enemies = [];
  for (let i = 0; i < 11; i++) enemies.push(demon(Math.cos(i) * 12, Math.sin(i) * 12));
  const seen = new Set();
  const watched = new Proxy(enemies, {
    get(t, k) { if (typeof k === 'string') seen.add(k); return t[k]; },
  });
  const g = stub({ enemies: watched });
  const s = new SenseMode(g);
  s.toggle();
  const shape = Object.keys(s).sort().join(',');
  step(s, 100 / 60);

  const nonIndex = [...seen].filter((k) => k !== 'length' && !/^\d+$/.test(k));
  assert.deepEqual(nonIndex, [],
    `the scan reached for ${nonIndex.join(', ')} on the enemy array; it must walk it by index`);
  assert.equal(Object.keys(s).sort().join(','), shape, 'the class grew a field in its hot loop');
  assert.ok(enemies.includes(s.target), 'the mark is the demon itself, not a copy of it');
});

test('the scan never reads e.center, which would mint a Vector3 per demon per frame', () => {
  let centerReads = 0;
  const mk = (x, z) => {
    const e = { alive: true, pos: { x, y: 0, z }, cfg: { id: `c${x}` } };
    Object.defineProperty(e, 'center', { get() { centerReads++; return { x, y: 0, z }; } });
    return e;
  };
  const enemies = [];
  for (let i = 0; i < 11; i++) enemies.push(mk(Math.cos(i) * 9, Math.sin(i) * 9));
  const s = new SenseMode(stub({ enemies }));
  s.toggle();
  step(s, 100 / 60);
  assert.equal(centerReads, 0,
    `e.center was read ${centerReads} times: it allocates, and its per-type height offset `
    + 'would make a flyer overhead read as further off than a grunt on the same spot');
});

test('the needle keeps fading after the sense is closed, rather than freezing lit', () => {
  // _envelopes() sits OUTSIDE the `if (this.active)` guard on purpose: that is
  // what leaves the last bearing you paid for hanging for a beat, going cold.
  // hud.js gates drawing on vis, not on active, so a frozen vis is a needle
  // that never leaves the screen.
  const g = stub({ enemies: [demon(0, 6)] });
  const s = new SenseMode(g);
  s.toggle();
  step(s, 1);
  assert.ok(s.vis > 0.99, 'lit while open');
  s.close();
  assert.equal(s.active, false);
  const rightAfter = s.vis;
  step(s, 0.25);
  assert.ok(s.vis < rightAfter, 'it is still being ticked with the mode shut');
  step(s, 1.5);
  assert.ok(s.vis <= 0.002, `it goes all the way cold, not frozen at ${s.vis.toFixed(3)}`);
});

test('the dwell has to be held unbroken — a challenger that lapses starts over', () => {
  const held = demon(0, 10);
  const g = stub({ enemies: [held] });
  const s = new SenseMode(g);
  s.toggle();
  s.update(1 / 60);
  assert.equal(s.target, held);
  const near = 10 * Math.sqrt(SENSE.switchMargin) - 0.05;   // inside the margin
  const far = 10 * Math.sqrt(SENSE.switchMargin) + 0.05;    // outside it
  const challenger = demon(0, near);
  g.enemies.push(challenger);
  // Jostle either side of the boundary for well over the dwell. Without the
  // else-branch reset, _candT banks the frames it spent ahead and commits.
  for (let i = 0; i < 40; i++) {
    challenger.pos.z = (i % 2 === 0) ? near : far;
    s.update(1 / 60);
  }
  assert.equal(s.target, held,
    'two grunts trading the lead must not bank dwell across the frames they are behind');
});

test('re-opening snaps to the current bearing instead of sweeping in from the last one', () => {
  // close() deliberately does not clear hasHeading, so toggle()'s reset is the
  // only thing making a close/re-open cycle arrive pointing the right way.
  const e = demon(0, -10);              // due south, bearing ~ +/-pi
  const g = stub({ enemies: [e] });
  const s = new SenseMode(g);
  s.toggle();
  step(s, 1);
  assert.ok(Math.abs(Math.abs(s.heading) - Math.PI) < 0.05);
  s.toggle();                           // closed, heading left at due south
  e.pos.x = 0; e.pos.z = 10;            // the demon is now due north
  s.toggle();                           // re-opened
  s.update(1 / 60);                     // ONE frame: a snap, not a sweep
  assert.ok(Math.abs(s.heading) < 0.02,
    `a fresh open must arrive on the real bearing; got ${s.heading.toFixed(3)} rad after one frame`);
});
