// A life relic is the one pickup in the game that exists to rescue a losing
// run, which makes its spawn gate the difference between "the cathedral answers
// when you're dying" and "free health, sometimes, whatever". rollLifeRelic is
// pure and takes an injectable rng, so all of it is checkable without a
// renderer — and heartbeat() is just a function, so its shape is too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIFE_RELICS, RELIC_TIERS, RELIC_RULES, rollLifeRelic } from '../src/config/pickupConfig.js';
import { heartbeat } from '../src/pickups/lifeRelic.js';

const always = () => 0;      // draws the front of the band: whatever is eligible
const never = () => 0.999;   // draws past every band: nothing is eligible

function ctx(over = {}) {
  return { wave: 10, hpFrac: 0.2, rng: always, ...over };
}

test('every tier is well-formed, and the tier order runs rarest first', () => {
  for (const id of RELIC_TIERS) {
    const t = LIFE_RELICS[id];
    assert.ok(t, `${id} is listed in RELIC_TIERS but not defined`);
    assert.equal(t.id, id);
    assert.ok(t.name && t.icon, `${id} is missing display copy`);
    assert.ok(t.chance > 0 && t.chance < 1, `${id}.chance`);
    assert.ok(t.maxHpFrac > 0 && t.maxHpFrac <= 1, `${id}.maxHpFrac`);
    assert.ok(t.minSpawnDist > 0 && t.maxSpawnDist > t.minSpawnDist, `${id} spawn band`);
    assert.ok(t.full ? t.heal === null : t.heal > 0, `${id}.heal`);
  }
  assert.deepEqual(Object.keys(LIFE_RELICS).sort(), [...RELIC_TIERS].sort());
  const chances = RELIC_TIERS.map((id) => LIFE_RELICS[id].chance);
  assert.ok(chances.reduce((a, b) => a + b, 0) <= 1, 'cumulative bands must fit in one draw');
  // Rarest first is what gives the font first refusal on a dying mage.
  const full = RELIC_TIERS.findIndex((id) => LIFE_RELICS[id].full);
  assert.equal(full, 0, 'the full-restore tier must be first in RELIC_TIERS');
});

test('nothing is ever offered to a mage at full health', () => {
  assert.equal(rollLifeRelic(ctx({ hpFrac: 1 })), null);
  for (const id of RELIC_TIERS) {
    const t = LIFE_RELICS[id];
    assert.ok(t.maxHpFrac < 1, `${id} would be offered at full HP`);
  }
});

test('the full restore is gated behind being about to die, and behind a wave floor', () => {
  const font = LIFE_RELICS.font;
  // hurt, but not hurt enough: the ember takes the draw instead
  assert.equal(rollLifeRelic(ctx({ hpFrac: font.maxHpFrac + 0.05 })), 'ember');
  // dying, late enough in the run
  assert.equal(rollLifeRelic(ctx({ hpFrac: font.maxHpFrac - 0.05 })), 'font');
  // dying, but too early for a font — still answered, just not with one
  assert.equal(rollLifeRelic(ctx({ wave: font.minWave - 1, hpFrac: 0.05 })), 'ember');
});

test('a lightly wounded mage still gets the ember at its full advertised rate', () => {
  // With the font ineligible its band vanishes rather than eating the front of
  // the range, so the ember's own chance is what actually decides.
  const ember = LIFE_RELICS.ember;
  const justInside = { rng: () => ember.chance - 1e-6 };
  const justOutside = { rng: () => ember.chance + 1e-6 };
  const hp = { hpFrac: LIFE_RELICS.font.maxHpFrac + 0.2 };
  assert.equal(rollLifeRelic(ctx({ ...hp, ...justInside })), 'ember');
  assert.equal(rollLifeRelic(ctx({ ...hp, ...justOutside })), null);
});

test('a dying mage splits the draw between the tiers without losing the ember', () => {
  const { font, ember } = LIFE_RELICS;
  const at = (r) => rollLifeRelic(ctx({ hpFrac: 0.05, rng: () => r }));
  assert.equal(at(font.chance - 1e-6), 'font');
  assert.equal(at(font.chance + 1e-6), 'ember');
  assert.equal(at(font.chance + ember.chance - 1e-6), 'ember');
  assert.equal(at(font.chance + ember.chance + 1e-6), null);
});

test('only one relic stands at a time', () => {
  assert.equal(rollLifeRelic(ctx({ standing: true })), null);
  assert.equal(rollLifeRelic(ctx({ standing: false })), 'font');
});

test('a wave can be answered at most maxPerWave times, and never in a burst', () => {
  assert.ok(rollLifeRelic(ctx({ spawnedThisWave: RELIC_RULES.maxPerWave - 1 })));
  assert.equal(rollLifeRelic(ctx({ spawnedThisWave: RELIC_RULES.maxPerWave })), null);
  assert.equal(rollLifeRelic(ctx({ sinceLastSpawn: RELIC_RULES.minGap - 0.01 })), null);
  assert.ok(rollLifeRelic(ctx({ sinceLastSpawn: RELIC_RULES.minGap })));
  // A fresh wave has no previous relic; Infinity must not trip the gap check.
  assert.ok(rollLifeRelic(ctx({ sinceLastSpawn: Infinity })));
});

test('an unlucky draw simply offers nothing', () => {
  assert.equal(rollLifeRelic(ctx({ rng: never })), null);
});

test('the roll is rare enough to stay occasional over a wave-length fight', () => {
  // ~60 s of combat spent below the ember threshold, checked on the real clock.
  const checks = Math.floor(60 / RELIC_RULES.checkInterval);
  const pNone = (1 - LIFE_RELICS.ember.chance) ** checks;
  assert.ok(pNone > 0.15, 'an ember every wave is not "occasional"');
  assert.ok(pNone < 0.85, 'a mage who spends a whole wave hurt should usually see one');
});

test('heartbeat is a two-lobe beat that stays positive and repeats', () => {
  const lub = heartbeat(0);
  const rest = heartbeat(0.24);
  const dub = heartbeat(0.27);
  assert.ok(lub > dub && dub > rest, 'lub-dub-rest, in that order');
  for (let i = 0; i <= 100; i++) {
    const v = heartbeat(i / 100);
    assert.ok(v >= 0 && v <= 1.2, `heartbeat out of range at ${i / 100}: ${v}`);
  }
  // Periodic, including for the negative phases a float clock can produce.
  assert.equal(heartbeat(3.4).toFixed(9), heartbeat(0.4).toFixed(9));
  assert.equal(heartbeat(-0.6).toFixed(9), heartbeat(0.4).toFixed(9));
});
