// Wave composition and enemy scaling are the two knobs that decide whether a
// run ramps or spikes. Both are pure functions of the wave number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waveComposition, WAVE_RULES } from '../src/config/waveConfig.js';
import { waveScaling } from '../src/config/enemyConfig.js';

const total = (c) => (c.grunt ?? 0) + (c.flyer ?? 0);

test('the five authored waves are the authored numbers', () => {
  assert.deepEqual(waveComposition(1), { grunt: 3, flyer: 0 });
  assert.deepEqual(waveComposition(2), { grunt: 5, flyer: 0 });
  assert.deepEqual(waveComposition(3), { grunt: 5, flyer: 1 });
  assert.deepEqual(waveComposition(4), { grunt: 7, flyer: 2 });
  assert.deepEqual(waveComposition(5), { grunt: 8, flyer: 3 });
});

test('flyers are introduced on wave 3, not before', () => {
  assert.equal(waveComposition(1).flyer, 0);
  assert.equal(waveComposition(2).flyer, 0);
  assert.ok(waveComposition(3).flyer > 0);
});

test('the algorithmic tail picks up where the authored waves stop', () => {
  // wave 6 must not be easier than the wave 5 it follows
  assert.ok(total(waveComposition(6)) >= total(waveComposition(5)));
});

test('counts never decrease as waves go up', () => {
  let prevG = 0, prevF = 0;
  for (let w = 1; w <= 60; w++) {
    const c = waveComposition(w);
    assert.ok(c.grunt >= prevG, `grunt count dropped at wave ${w}`);
    assert.ok(c.flyer >= prevF, `flyer count dropped at wave ${w}`);
    prevG = c.grunt; prevF = c.flyer;
  }
});

test('counts plateau at the authored caps instead of growing forever', () => {
  const late = waveComposition(500);
  assert.equal(late.grunt, 16);
  assert.equal(late.flyer, 9);
});

test('a wave always has something to kill', () => {
  for (let w = 1; w <= 60; w++) {
    assert.ok(total(waveComposition(w)) > 0, `wave ${w} spawns nothing`);
  }
});

test('the returned composition is a copy — mutating it cannot poison later waves', () => {
  const a = waveComposition(1);
  a.grunt = 999;
  assert.equal(waveComposition(1).grunt, 3);
});

test('concurrency cap stays below the total, so late waves have to trickle', () => {
  assert.ok(WAVE_RULES.maxConcurrentEnemies < total(waveComposition(500)));
  assert.ok(WAVE_RULES.trickleBatchSize > 0);
});

test('scaling starts neutral on wave 1', () => {
  const s = waveScaling(1);
  assert.equal(s.hpMult, 1);
  assert.equal(s.damageMult, 1);
  assert.equal(s.aggroMult, 1);
  assert.equal(s.speedMult, 1);
});

test('hp and damage scale up, attack cooldown scales down', () => {
  const a = waveScaling(5), b = waveScaling(15);
  assert.ok(b.hpMult > a.hpMult);
  assert.ok(b.damageMult > a.damageMult);
  assert.ok(b.aggroMult < a.aggroMult, 'aggroMult multiplies cooldowns — lower is faster');
});

test('speed and aggro stay inside their clamps at absurd waves', () => {
  const s = waveScaling(1000);
  assert.equal(s.speedMult, 1.25);
  assert.equal(s.aggroMult, 0.55);
  assert.ok(s.aggroMult > 0, 'a zero cooldown multiplier would mean infinite attack rate');
});
