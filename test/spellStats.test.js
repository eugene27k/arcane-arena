// effectiveStats() is where every upgrade a player picks turns into the numbers
// the cast path actually uses. It is pure (config in, stats out), so the whole
// upgrade surface is checkable without a renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPELLS, CAST_MANA_SCALE, createSpellState, effectiveStats, isChannelled } from '../src/config/spellConfig.js';

const MANA_COST_FLOOR = 2; // mirrors the module-private constant

test('fresh state matches the authored spell, at the global cast-cost scale', () => {
  const s = createSpellState();
  const fb = effectiveStats('fireball', s);
  assert.equal(fb.damage, SPELLS.fireball.damage);
  assert.equal(fb.cooldown, SPELLS.fireball.cooldown);
  assert.equal(fb.manaCost, Math.round(SPELLS.fireball.manaCost * CAST_MANA_SCALE));
});

test('only fireball and staff start unlocked', () => {
  const s = createSpellState();
  assert.deepEqual(
    Object.keys(s).filter((id) => s[id].unlocked).sort(),
    ['fireball', 'staff'],
  );
});

test('multiplier upgrades compound onto damage and cooldown', () => {
  const s = createSpellState();
  s.fireball.damageMult *= 1.2;
  s.fireball.damageMult *= 1.2;
  s.fireball.cooldownMult *= 0.85;
  const fb = effectiveStats('fireball', s);
  assert.ok(Math.abs(fb.damage - SPELLS.fireball.damage * 1.44) < 1e-9);
  assert.ok(Math.abs(fb.cooldown - SPELLS.fireball.cooldown * 0.85) < 1e-9);
});

test('discrete casts never fall below the mana floor, however many discounts stack', () => {
  const discrete = Object.values(SPELLS).filter((sp) => sp.manaCost > 0 && !isChannelled(sp.type));
  assert.ok(discrete.length > 0, 'expected some discrete-cast spells');
  for (const sp of discrete) {
    const s = createSpellState();
    for (let i = 0; i < 40; i++) s[sp.id].manaCostMult *= 0.8; // well past any real stack cap
    assert.equal(effectiveStats(sp.id, s).manaCost, MANA_COST_FLOOR, sp.id);
  }
});

// A beam is priced per second and spends per tick, so the flat floor that keeps
// discrete casts honest is deliberately skipped — at 20 ticks a second it would
// price the weapon out of the game.
test('a channelled spell prices per second and spends per tick, below the discrete floor', () => {
  const beams = Object.values(SPELLS).filter((sp) => isChannelled(sp.type));
  assert.ok(beams.length > 0, 'expected a channelled spell');
  for (const sp of beams) {
    const s = createSpellState();
    const st = effectiveStats(sp.id, s);
    assert.equal(st.tickInterval, st.cooldown);
    assert.ok(Math.abs(st.manaCost - st.manaPerSecond * st.tickInterval) < 1e-9, sp.id);
    assert.ok(st.manaCost < MANA_COST_FLOOR, `${sp.id} per-tick cost should sit under the discrete floor`);
    // a full second of fire costs what it says on the tin
    assert.ok(Math.abs(st.manaPerSecond - sp.manaCost * CAST_MANA_SCALE) < 1e-9, sp.id);
  }
});

test('a channelled spell hands over to the staff with more than one tick left in the pool', () => {
  const beams = Object.values(SPELLS).filter((sp) => isChannelled(sp.type));
  for (const sp of beams) {
    const st = effectiveStats(sp.id, createSpellState());
    assert.ok(st.castThreshold > st.manaCost,
      `${sp.id} would sputter one tick at a time at the bottom of the pool`);
  }
});

test('discrete casts hand over to the staff exactly when one cast is unaffordable', () => {
  const s = createSpellState();
  for (const id of Object.keys(SPELLS)) {
    if (isChannelled(SPELLS[id].type)) continue;
    const st = effectiveStats(id, s);
    assert.equal(st.castThreshold, st.manaCost, id);
  }
});

test('a free spell stays free — the floor does not make the staff cost mana', () => {
  const s = createSpellState();
  assert.equal(SPELLS.staff.manaCost, 0);
  assert.equal(effectiveStats('staff', s).manaCost, 0);
  s.staff.manaCostMult *= 2;
  assert.equal(effectiveStats('staff', s).manaCost, 0);
});

test('extra projectiles trade per-bolt damage for count', () => {
  const s = createSpellState();
  const single = effectiveStats('fireball', s);
  s.fireball.extraProjectiles = 1;
  const twin = effectiveStats('fireball', s);
  assert.equal(twin.projectileCount, 2);
  assert.equal(twin.damage, single.damage * SPELLS.fireball.twinDamageMult);
  // the split is a nerf per bolt but a gain in total output
  assert.ok(twin.damage * 2 > single.damage);
});

test('extra chains add to the base jump count', () => {
  const s = createSpellState();
  assert.equal(effectiveStats('lightning', s).chains, SPELLS.lightning.chains);
  s.lightning.extraChains = 3;
  assert.equal(effectiveStats('lightning', s).chains, SPELLS.lightning.chains + 3);
});

test('deep freeze slows harder but never to a full stop', () => {
  const s = createSpellState();
  for (let i = 0; i < 20; i++) s.frostnova.slowFactorMult *= 0.7;
  const nova = effectiveStats('frostnova', s);
  assert.equal(nova.slowFactor, SPELLS.frostnova.slowFactorFloor);
  assert.ok(nova.slowFactor > 0, 'a slowed demon must still be able to move');
});

test('radius upgrades reach the right field for each spell type', () => {
  const s = createSpellState();
  s.fireball.radiusMult = 1.25;
  s.frostnova.radiusMult = 1.25;
  s.staff.radiusMult = 1.25;
  assert.equal(effectiveStats('fireball', s).aoeRadius, SPELLS.fireball.aoeRadius * 1.25);
  assert.equal(effectiveStats('frostnova', s).novaRadius, SPELLS.frostnova.novaRadius * 1.25);
  assert.equal(effectiveStats('staff', s).range, SPELLS.staff.range * 1.25);
});

test('effectiveStats does not mutate the authored config', () => {
  const s = createSpellState();
  s.fireball.damageMult = 3;
  s.fireball.radiusMult = 3;
  effectiveStats('fireball', s);
  assert.equal(SPELLS.fireball.damage, 40);
  assert.equal(SPELLS.fireball.aoeRadius, 3.4);
});

test('every spell resolves without throwing, at base and heavily upgraded', () => {
  for (const id of Object.keys(SPELLS)) {
    const s = createSpellState();
    Object.assign(s[id], {
      damageMult: 2.5, manaCostMult: 0.3, radiusMult: 1.8,
      speedMult: 1.4, cooldownMult: 0.5, extraProjectiles: 2,
      extraChains: 4, slowFactorMult: 0.5,
    });
    const st = effectiveStats(id, s);
    assert.ok(st.damage > 0, `${id} damage`);
    assert.ok(st.cooldown > 0, `${id} cooldown`);
    assert.ok(st.manaCost >= 0, `${id} manaCost`);
  }
});
