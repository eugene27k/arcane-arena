// Mega Blast is the only spell with a gap between the button and the effect,
// and the only one that picks its own target. Both halves are checkable without
// a renderer: the charge maths is pure config, and the auto-aim only needs
// enemies, a crosshair direction, and a line-of-sight predicate.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SPELLS, createSpellState, effectiveStats } from '../src/config/spellConfig.js';
import { SpellCaster } from '../src/spells/spellCaster.js';

const MIN_CHARGE_TIME = 1.5; // mirrors the module-private constant

test('mega blast starts locked, and is the slow, expensive one', () => {
  const s = createSpellState();
  assert.equal(s.megablast.unlocked, false);
  const mb = effectiveStats('megablast', s);
  assert.equal(mb.chargeTime, SPELLS.megablast.chargeTime);
  assert.ok(mb.chargeTime >= 5, 'the five-second gather is the spell');
  // it hits harder and wider than the workhorse, and costs accordingly
  const fb = effectiveStats('fireball', s);
  assert.ok(mb.damage > fb.damage * 3, 'mega blast should hurt a lot');
  assert.ok(mb.aoeRadius > fb.aoeRadius * 2, 'mega blast should catch a crowd');
  assert.ok(mb.manaCost > fb.manaCost * 4, 'mega blast should cost a lot');
});

test('charge discounts stack down to a floor, never to an instant cast', () => {
  const s = createSpellState();
  s.megablast.chargeTimeMult *= 0.75;
  assert.ok(Math.abs(effectiveStats('megablast', s).chargeTime - SPELLS.megablast.chargeTime * 0.75) < 1e-9);
  for (let i = 0; i < 40; i++) s.megablast.chargeTimeMult *= 0.75;
  const floored = effectiveStats('megablast', s);
  assert.equal(floored.chargeTime, MIN_CHARGE_TIME);
  assert.ok(floored.chargeTime > 0, 'a charged spell must always have a charge');
});

test('radius and speed upgrades reach the fields the blast actually flies on', () => {
  const s = createSpellState();
  s.megablast.radiusMult = 1.2;
  s.megablast.speedMult = 1.4;
  const mb = effectiveStats('megablast', s);
  assert.equal(mb.aoeRadius, SPELLS.megablast.aoeRadius * 1.2);
  assert.equal(mb.projectileSpeed, SPELLS.megablast.projectileSpeed * 1.4);
});

// --- auto-aim ---------------------------------------------------------------
// A stub arena: enemies are bare positions, the crosshair is a fixed direction,
// and stone is whatever the lineOfSight predicate refuses.
function stubGame({ enemies, aimDir = new THREE.Vector3(0, 0, 1), blocked = () => false }) {
  return {
    enemies: enemies.map((e) => ({
      alive: true,
      name: e.name,
      cfg: { radius: 0.55 },
      get center() { return new THREE.Vector3(e.x, e.y ?? 0, e.z); },
    })),
    cameraRig: { getAimPoint: () => ({ dir: aimDir.clone().normalize() }) },
    world: { lineOfSight: (a, b) => !blocked(a, b) },
  };
}

const ORIGIN = new THREE.Vector3(0, 0, 0);

test('the auto-aim takes the pack over the closer straggler', () => {
  const game = stubGame({
    enemies: [
      { name: 'straggler', x: 0, z: 6 },      // dead ahead, alone
      { name: 'pack', x: 0, z: 20 },          // further out, but in a crowd
      { name: 'p2', x: 2, z: 21 },
      { name: 'p3', x: -2, z: 21 },
      { name: 'p4', x: 1, z: 22 },
    ],
  });
  const caster = new SpellCaster(game);
  const stats = caster.stats('megablast');
  const target = caster._pickMegaTarget(stats, ORIGIN);
  assert.ok(target, 'expected a lock');
  assert.notEqual(target.name, 'straggler');
  assert.ok(['pack', 'p2', 'p3', 'p4'].includes(target.name));
});

test('between equal targets, the one on the crosshair wins', () => {
  const game = stubGame({
    enemies: [
      { name: 'ahead', x: 0, z: 12 },
      { name: 'behind', x: 0, z: -12 },
    ],
    aimDir: new THREE.Vector3(0, 0, 1),
  });
  const caster = new SpellCaster(game);
  const target = caster._pickMegaTarget(caster.stats('megablast'), ORIGIN);
  assert.equal(target.name, 'ahead');
});

test('stone blocks a lock: the blast is never thrown into the pillar in front of it', () => {
  const game = stubGame({
    enemies: [{ name: 'hidden', x: 0, z: 10 }],
    blocked: () => true,
  });
  const caster = new SpellCaster(game);
  assert.equal(caster._pickMegaTarget(caster.stats('megablast'), ORIGIN), null);
});

test('nothing in range means no lock — the blast flies down the crosshair instead', () => {
  const far = SPELLS.megablast.autoAimRange + 20;
  const game = stubGame({ enemies: [{ name: 'miles away', x: 0, z: far }] });
  const caster = new SpellCaster(game);
  assert.equal(caster._pickMegaTarget(caster.stats('megablast'), ORIGIN), null);

  const empty = new SpellCaster(stubGame({ enemies: [] }));
  assert.equal(empty._pickMegaTarget(empty.stats('megablast'), ORIGIN), null);
});

test('corpses are never locked on to', () => {
  const game = stubGame({
    enemies: [{ name: 'dead', x: 0, z: 8 }, { name: 'live', x: 0, z: 14 }],
  });
  game.enemies[0].alive = false;
  const caster = new SpellCaster(game);
  assert.equal(caster._pickMegaTarget(caster.stats('megablast'), ORIGIN).name, 'live');
});
