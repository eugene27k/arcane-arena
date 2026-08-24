// The upgrade roll decides what a player is even allowed to build towards.
// UpgradeManager only reads spellState / player / wave off the game, so a stub
// game is enough to exercise the whole pool without a renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UPGRADES, UPGRADE_RULES } from '../src/config/upgradeConfig.js';
import { UpgradeManager } from '../src/flow/upgradeManager.js';
import { createSpellState } from '../src/config/spellConfig.js';

function stubGame(wave = 1) {
  return {
    caster: { spellState: createSpellState() },
    waves: { wave },
    player: {
      maxHP: 100, maxMana: 100, dashCooldownMult: 1, essenceOverflow: false,
      heal() {}, addMana() {},
    },
  };
}

// Rolls are weighted-random; anything about "can this ever appear" needs a few.
function rollIds(mgr, times = 200) {
  const seen = new Set();
  for (let i = 0; i < times; i++) for (const u of mgr.roll()) seen.add(u.id);
  return seen;
}

test('every upgrade entry is well-formed and uniquely identified', () => {
  const ids = new Set();
  for (const u of UPGRADES) {
    assert.ok(u.id && !ids.has(u.id), `duplicate or missing id: ${u.id}`);
    ids.add(u.id);
    assert.equal(typeof u.available, 'function', `${u.id}.available`);
    assert.equal(typeof u.apply, 'function', `${u.id}.apply`);
    assert.ok(u.weight > 0, `${u.id}.weight must be positive`);
    assert.ok(u.name && u.desc && u.icon, `${u.id} is missing display copy`);
  }
});

test('a roll offers the configured number of distinct options', () => {
  const mgr = new UpgradeManager(stubGame(1));
  for (let i = 0; i < 50; i++) {
    const opts = mgr.roll();
    assert.equal(opts.length, UPGRADE_RULES.optionsPerScreen);
    assert.equal(new Set(opts.map((o) => o.id)).size, opts.length, 'duplicate option in one roll');
  }
});

test('the lightning unlock is guaranteed on screen while it is locked', () => {
  const mgr = new UpgradeManager(stubGame(1));
  for (let i = 0; i < 50; i++) {
    assert.ok(mgr.roll().some((o) => o.id === 'unlock_lightning'), 'unlock missing from a roll');
  }
});

test('the lightning unlock never reappears once taken', () => {
  const game = stubGame(1);
  const mgr = new UpgradeManager(game);
  mgr.apply('unlock_lightning');
  assert.ok(game.caster.spellState.lightning.unlocked);
  assert.ok(!rollIds(mgr).has('unlock_lightning'));
});

test('lightning upgrades are gated behind the unlock', () => {
  const game = stubGame(6);
  const mgr = new UpgradeManager(game);
  const lightningIds = UPGRADES
    .filter((u) => u.category === 'Lightning' && u.id !== 'unlock_lightning')
    .map((u) => u.id);
  assert.ok(lightningIds.length > 0, 'no lightning upgrades to check');

  const before = rollIds(mgr);
  for (const id of lightningIds) assert.ok(!before.has(id), `${id} offered while locked`);

  mgr.apply('unlock_lightning');
  const after = rollIds(mgr);
  assert.ok(lightningIds.some((id) => after.has(id)), 'no lightning upgrade appeared after unlock');
});

test('wave-gated upgrades stay out of the pool until their wave', () => {
  const gated = UPGRADES.filter((u) => u.id !== 'unlock_lightning' && !u.available({
    spellState: createSpellState(), wave: 1, stacks: new Map(),
  }));
  assert.ok(gated.length > 0, 'expected some gated upgrades');

  const early = new UpgradeManager(stubGame(1));
  const earlyIds = rollIds(early);
  for (const u of gated) assert.ok(!earlyIds.has(u.id), `${u.id} offered on wave 1`);
});

test('maxStacks is respected — a capped upgrade stops being offered', () => {
  const capped = UPGRADES.find((u) => u.maxStacks && u.available({
    spellState: createSpellState(), wave: 1, stacks: new Map(),
  }));
  assert.ok(capped, 'expected a capped, wave-1-available upgrade');

  const mgr = new UpgradeManager(stubGame(1));
  for (let i = 0; i < capped.maxStacks; i++) mgr.apply(capped.id);
  assert.equal(mgr.stacks.get(capped.id), capped.maxStacks);
  assert.ok(!rollIds(mgr).has(capped.id), `${capped.id} offered past its cap`);
});

test('apply mutates run state and counts the stack', () => {
  const game = stubGame(1);
  const mgr = new UpgradeManager(game);
  const before = game.caster.spellState.fireball.damageMult;
  mgr.apply('fireball_damage');
  mgr.apply('fireball_damage');
  assert.ok(game.caster.spellState.fireball.damageMult > before);
  assert.equal(mgr.stacks.get('fireball_damage'), 2);
});

test('applying an unknown id is a no-op, not a crash', () => {
  const mgr = new UpgradeManager(stubGame(1));
  mgr.apply('no_such_upgrade');
  assert.equal(mgr.stacks.size, 0);
});

test('reset clears stacks so a new run starts from the full pool', () => {
  const mgr = new UpgradeManager(stubGame(1));
  mgr.apply('fireball_damage');
  mgr.reset();
  assert.equal(mgr.stacks.size, 0);
});

test('an exhausted pool returns fewer options instead of looping forever', () => {
  const game = stubGame(1);
  const mgr = new UpgradeManager(game);
  // cap out everything wave 1 can offer
  for (const u of UPGRADES) {
    if (u.maxStacks) mgr.stacks.set(u.id, u.maxStacks);
    else mgr.stacks.set(u.id, 1);
  }
  game.caster.spellState.lightning.unlocked = true;
  const opts = mgr.roll();
  assert.ok(opts.length < UPGRADE_RULES.optionsPerScreen);
  assert.ok(opts.every((o) => !o.maxStacks || (mgr.stacks.get(o.id) ?? 0) < o.maxStacks));
});

test('every upgrade in the pool applies cleanly against a fresh run', () => {
  for (const u of UPGRADES) {
    const game = stubGame(10);
    game.caster.spellState.lightning.unlocked = true;
    game.caster.spellState.frostnova.unlocked = true;
    const mgr = new UpgradeManager(game);
    assert.doesNotThrow(() => mgr.apply(u.id), `${u.id} threw on apply`);
  }
});
