// WaveManager owns "is this wave over yet" — the one piece of run flow that,
// if it miscounts, either hangs the run or ends it early.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveManager } from '../src/flow/waveManager.js';
import { waveComposition } from '../src/config/waveConfig.js';

function harness() {
  const completions = [];
  const spawner = { reset: () => {}, beginWave: (comp, wave) => spawner.calls.push({ comp, wave }), calls: [] };
  const game = { onWaveComplete: () => completions.push(true) };
  return { mgr: new WaveManager(game, spawner), spawner, completions };
}

test('the kill target is the wave composition total', () => {
  const { mgr } = harness();
  for (const w of [1, 3, 5, 9, 40]) {
    mgr.startWave(w);
    const c = waveComposition(w);
    assert.equal(mgr.totalToKill, c.grunt + c.flyer, `wave ${w}`);
    assert.equal(mgr.remaining, mgr.totalToKill);
  }
});

test('a wave completes exactly once, on the last kill', () => {
  const { mgr, completions } = harness();
  mgr.startWave(1);
  const n = mgr.totalToKill;
  for (let i = 0; i < n - 1; i++) mgr.onEnemyKilled();
  assert.equal(completions.length, 0, 'completed early');
  mgr.onEnemyKilled();
  assert.equal(completions.length, 1);
  assert.equal(mgr.active, false);
});

test('stray kills after completion do not fire a second completion', () => {
  const { mgr, completions } = harness();
  mgr.startWave(1);
  for (let i = 0; i < mgr.totalToKill + 5; i++) mgr.onEnemyKilled();
  assert.equal(completions.length, 1);
  assert.equal(mgr.remaining, 0, 'remaining must not go negative');
});

test('remaining counts down and floors at zero', () => {
  const { mgr } = harness();
  mgr.startWave(2);
  const n = mgr.totalToKill;
  mgr.onEnemyKilled();
  assert.equal(mgr.remaining, n - 1);
  for (let i = 0; i < n * 2; i++) mgr.onEnemyKilled();
  assert.equal(mgr.remaining, 0);
});

test('enemies are released with the same composition the wave was sized from', () => {
  const { mgr, spawner } = harness();
  mgr.startWave(4);
  mgr.releaseEnemies();
  assert.equal(spawner.calls.length, 1);
  assert.deepEqual(spawner.calls[0].comp, waveComposition(4));
  assert.equal(spawner.calls[0].wave, 4);
});

test('reset returns to a pre-run state', () => {
  const { mgr } = harness();
  mgr.startWave(7);
  mgr.onEnemyKilled();
  mgr.reset();
  assert.equal(mgr.wave, 0);
  assert.equal(mgr.killed, 0);
  assert.equal(mgr.totalToKill, 0);
  assert.equal(mgr.active, false);
});
