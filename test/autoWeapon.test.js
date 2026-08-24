// Auto Weapon — the reel. Two halves, both checkable without a renderer: the
// ranking is pure arithmetic over the authored book, and the draw is a weighted
// pick with an injectable rng, so a seeded run is deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPELLS, AUTO, autoHeft, autoDrawable, isChannelled, effectiveStats, createSpellState } from '../src/config/spellConfig.js';
import { SpellCaster } from '../src/spells/spellCaster.js';
import { PLAYER, CONTROLS } from '../src/config/playerConfig.js';

// deterministic rng, so "200 draws" means the same 200 draws every run
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A caster on a stub game: the reel only ever asks about mana, cooldowns and
// unlocks, so nothing else has to exist.
function stubCaster({ mana = PLAYER.maxMana, unlocked = [], only = null, cooldowns = {}, auto = true } = {}) {
  const game = {
    player: { mana, maxMana: PLAYER.maxMana, get manaFloor() { return -PLAYER.maxMana * PLAYER.manaFloorFrac; }, alive: true },
    audio: { play() {}, stopBeamLoop() {}, stopLanceLoop() {} },
    hud: { toast() {} },
    fx: { beamStop() {}, lanceStop() {} },
  };
  const caster = new SpellCaster(game);
  // `only` is the exact book; `unlocked` adds to the two a fresh mage starts with
  if (only) for (const id of Object.keys(SPELLS)) caster.spellState[id].unlocked = only.includes(id);
  for (const id of unlocked) caster.spellState[id].unlocked = true;
  caster.cooldowns = { ...cooldowns };
  caster.setAuto(auto);
  return caster;
}

const EVERY_SPELL = Object.keys(SPELLS);

test('the reel is off until it is asked for, and toggling is idempotent', () => {
  const c = stubCaster({ auto: false });
  assert.equal(c.auto, false);
  assert.equal(c.toggleAuto(), true);
  assert.equal(c.setAuto(true), true, 'setting it on twice is not a flip');
  assert.equal(c.toggleAuto(), false);
});

test('the reel has its own bind, and it is not one already spoken for', () => {
  assert.ok(CONTROLS.autoKeys.length > 0);
  const taken = new Set([...CONTROLS.castKeys, ...CONTROLS.meleeKeys, ...CONTROLS.shieldKeys,
    ...CONTROLS.senseKeys, 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyM', 'Space']);
  for (const k of CONTROLS.autoKeys) assert.ok(!taken.has(k), `${k} is already bound`);
});

// --- the ranking -----------------------------------------------------------

test('heft ranks the book by what a shot of it costs, heaviest first', () => {
  assert.deepEqual(autoDrawable(), ['meteor', 'megablast', 'wyrmlance', 'lightning', 'frostnova', 'fireball']);
  const heft = autoDrawable().map(autoHeft);
  for (let i = 1; i < heft.length; i++) assert.ok(heft[i - 1] > heft[i], 'strictly ordered');
});

test('a channelled weapon is ranked by a burst of it, not by one tick', () => {
  for (const sp of Object.values(SPELLS)) {
    if (!isChannelled(sp.type)) continue;
    assert.equal(autoHeft(sp.id), sp.manaCost * AUTO.channelBurst);
  }
});

test('melee is not in the book the reel draws from, at any weight', () => {
  const drawable = new Set(autoDrawable());
  for (const sp of Object.values(SPELLS)) {
    if (sp.type !== 'melee') continue;
    assert.ok(!drawable.has(sp.id), `${sp.id} must never be drawn`);
    assert.equal(autoHeft(sp.id), 0);
  }
});

test('a discount makes a storm cheaper, not lighter — the ranking is authored', () => {
  const s = createSpellState();
  for (let i = 0; i < 10; i++) s.meteor.manaCostMult *= 0.8;
  assert.ok(effectiveStats('meteor', s).manaCost < effectiveStats('fireball', createSpellState()).manaCost);
  assert.ok(autoHeft('meteor') > autoHeft('fireball'), 'it is still the biggest thing in the book');
});

// --- the draw --------------------------------------------------------------

test('a fresh mage draws the only spell they own', () => {
  const c = stubCaster();
  assert.equal(c.autoDraw(mulberry32(1)), 'fireball');
});

test('nothing ready draws nothing — the reel never invents a shot', () => {
  const c = stubCaster({ cooldowns: { fireball: 0.4 } });
  assert.equal(c.autoDraw(mulberry32(1)), null);
  const dry = stubCaster({ mana: 1 });
  assert.equal(dry.autoDraw(mulberry32(1)), null);
});

test('the reel never draws melee, however long it spins', () => {
  const c = stubCaster({ unlocked: EVERY_SPELL });
  const rand = mulberry32(7);
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    // vary the pool so every branch of the draw is exercised
    c.game.player.mana = (i % 21) * 5;
    const id = c.autoDraw(rand);
    if (id) { seen.add(id); c._autoLast = id; }
  }
  assert.ok(!seen.has('staff') && !seen.has('katana'), [...seen].join());
  assert.ok(seen.size >= 4, `expected variety, got ${[...seen].join()}`);
});

test('a cooled-down weapon is out of the hat until its recovery ends', () => {
  const c = stubCaster({ unlocked: ['fireball', 'frostnova'], cooldowns: { frostnova: 2 } });
  const rand = mulberry32(3);
  for (let i = 0; i < 60; i++) assert.equal(c.autoDraw(rand), 'fireball');
  c.cooldowns.frostnova = 0;
  const seen = new Set();
  for (let i = 0; i < 60; i++) { const id = c.autoDraw(rand); seen.add(id); c._autoLast = id; }
  assert.deepEqual([...seen].sort(), ['fireball', 'frostnova']);
});

// A channel opens for a third of a second's drain — cheaper than a fireball —
// and then spends twenty mana a second. Priced at that opening the reel would
// re-draw the beam, and only the beam, for the rest of a run.
test('a channel draw is priced by the burst it commits to, not by one tick', () => {
  const c = stubCaster({ unlocked: EVERY_SPELL });
  for (const sp of Object.values(SPELLS)) {
    if (!isChannelled(sp.type)) continue;
    const st = c.stats(sp.id);
    assert.equal(c._autoShotCost(st), st.manaPerSecond * AUTO.channelBurst);
    assert.ok(c._autoShotCost(st) > st.castThreshold, 'a burst costs more than opening one');
    // and it must not be the cheapest thing in the book to draw, or it starves
    // every discrete weapon out of the rotation
    assert.ok(c._autoShotCost(st) > c._autoShotCost(c.stats('fireball')), sp.id);
  }
});

test('the reel keeps headroom back and never draws a cast on credit', () => {
  const storm = effectiveStats('meteor', createSpellState()).manaCost;
  const floor = storm * (1 + AUTO.costHeadroom);

  // Meteor Storm is the one spell that may be cast into debt. The player may;
  // the reel may not — a well overdrawn on the reel's initiative would lock the
  // whole book out for something nobody chose.
  const thin = stubCaster({ only: ['meteor'], mana: 10 });
  assert.ok(thin.canAfford(thin.stats('meteor')), 'by hand it still goes off, on credit');
  assert.equal(thin.autoDraw(mulberry32(2)), null, 'the reel refuses to overdraw');

  const justShort = stubCaster({ only: ['meteor'], mana: floor - 0.01 });
  assert.equal(justShort.autoDraw(mulberry32(2)), null);
  const justEnough = stubCaster({ only: ['meteor'], mana: floor });
  assert.equal(justEnough.autoDraw(mulberry32(2)), 'meteor');
});

// A flat reserve measured against the whole pool sits ABOVE the emergency
// attunement's ceiling, so a run that goes dry with no essence on the ground can
// never climb back to a drawable level and the mode silently stops being one.
// The draw floor has to stay under what the trickle alone can restore.
test('the emergency trickle can always restart the reel on its own', () => {
  const c = stubCaster({ unlocked: EVERY_SPELL });
  const floors = autoDrawable().map((id) => c._autoShotCost(c.stats(id)) * (1 + AUTO.costHeadroom));
  assert.ok(Math.min(...floors) < PLAYER.manaReserve,
    `the cheapest draw floor (${Math.min(...floors).toFixed(1)}) must sit under the trickle ceiling (${PLAYER.manaReserve})`);

  // and in practice: a pool sitting exactly at the trickle ceiling still draws
  const dry = stubCaster({ unlocked: EVERY_SPELL, mana: PLAYER.manaReserve });
  assert.ok(dry.autoDraw(mulberry32(4)), 'a run that went dry is not stuck there');
});

// The reel must never leave the one overdraft spell sitting in the slot: the
// trigger's own canAfford() would happily fire a storm on credit, so a stranded
// pick turns into an auto-overdraw the instant the recovery clears.
test('with nothing ready the reel parks on the lightest weapon, never on the storm', () => {
  const c = stubCaster({ only: ['fireball', 'meteor', 'staff'], mana: 16 });
  c.selected = 'meteor';
  c.cooldowns.meteor = 9;               // as a storm it just cast would leave it
  c.cooldowns.fireball = 4;             // and nothing else is ready either
  assert.equal(c.autoDraw(mulberry32(6)), null, 'the book has nothing to draw');
  c._updateAuto(1 / 60);
  assert.equal(c.selected, 'fireball', 'so it falls back to the weapon that cannot borrow');

  // parked, a dry pool reaches the melee handover the way it always has
  c.game.player.mana = 1;
  assert.ok(c.meleeFallbackActive, 'the staff is what the cast button swings');
});

test('a live channel is never taken away just because nothing else is ready', () => {
  const c = stubCaster({ only: ['lightning'], mana: 3 });
  c.selected = 'lightning';
  c.beam = { id: 'lightning', t: AUTO.channelBurst * 2 };
  c._updateAuto(1 / 60);
  assert.equal(c.selected, 'lightning', 'the parking rule does not outrank a burning beam');
  assert.ok(c.beam);
});

test('a full well draws the heavy end; a thin one falls back to what it can pay for', () => {
  const rand = mulberry32(11);
  const rich = stubCaster({ unlocked: EVERY_SPELL, mana: PLAYER.maxMana });
  const richDraws = new Set();
  for (let i = 0; i < 200; i++) { const id = rich.autoDraw(rand); richDraws.add(id); rich._autoLast = id; }
  assert.deepEqual([...richDraws].sort(), ['megablast', 'meteor'],
    'above the splurge mark only the toughest weapons come out');

  const thin = stubCaster({ unlocked: EVERY_SPELL, mana: 40 });
  const thinDraws = new Set();
  for (let i = 0; i < 200; i++) { const id = thin.autoDraw(rand); thinDraws.add(id); thin._autoLast = id; }
  assert.ok(!thinDraws.has('meteor') && !thinDraws.has('megablast'), 'nothing it cannot pay for');
  assert.ok(thinDraws.has('fireball'), 'the cheap end is back in the hat');
});

test('the splurge mark is a mana level, not a spell list', () => {
  // three weapons of clearly different weight, all affordable at every level tested
  const at = (mana) => {
    const c = stubCaster({ unlocked: ['fireball', 'frostnova', 'wyrmlance'], mana });
    const rand = mulberry32(5);
    const seen = new Set();
    for (let i = 0; i < 200; i++) { const id = c.autoDraw(rand); seen.add(id); c._autoLast = id; }
    return [...seen].sort();
  };
  assert.deepEqual(at(PLAYER.maxMana), ['frostnova', 'wyrmlance'],
    'a full well leaves the cheapest weapon out of the hat');
  assert.deepEqual(at(PLAYER.maxMana * AUTO.splurgeFrac - 1), ['fireball', 'frostnova', 'wyrmlance'],
    'below the mark the whole affordable book is back');
});

test('the heavy end never narrows to one weapon — the reel still has to rotate', () => {
  // Lightning outweighs Fireball by more than the splurge band, so trimming
  // alone would leave a single candidate and turn the mode into a slot lock.
  const c = stubCaster({ unlocked: ['fireball', 'lightning'], mana: PLAYER.maxMana });
  const rand = mulberry32(17);
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const id = c.autoDraw(rand); seen.add(id); c._autoLast = id; }
  assert.deepEqual([...seen].sort(), ['fireball', 'lightning']);
});

test('the weapon that just fired is markedly less likely to fire next', () => {
  // Measured against the same seeded draw with nothing remembered: the penalty
  // has to bend the sequence towards variety, not merely exist in the code.
  const run = (remember) => {
    const c = stubCaster({ unlocked: ['fireball', 'frostnova'], mana: 50 });
    const rand = mulberry32(13);
    let repeats = 0, prev = null;
    const N = 800;
    for (let i = 0; i < N; i++) {
      c._autoLast = remember ? prev : null;
      const id = c.autoDraw(rand);
      if (prev && id === prev) repeats++;
      prev = id;
    }
    return repeats / N;
  };
  const penalised = run(true);
  const blind = run(false);
  assert.ok(penalised < blind * 0.6, `expected far fewer repeats than ${blind.toFixed(2)}, got ${penalised.toFixed(2)}`);
  assert.ok(penalised < 0.4, `a repeat should be the exception, got ${penalised.toFixed(2)}`);
});

// main.js only disengages the reel when the pick actually lands, so both of
// these have to report failure rather than quietly doing nothing.
test('a refused pick reports that it was refused', () => {
  const c = stubCaster({ only: ['fireball'] });
  assert.equal(c.selectSlot(2), false, 'a locked slot is not a pick');
  assert.equal(c.cycle(1), false, 'nor is a wheel turn with only one weapon in the book');

  const gathering = stubCaster({ unlocked: ['megablast', 'frostnova'] });
  gathering.selected = 'megablast';
  gathering.charge = { stats: gathering.stats('megablast'), t: 1, total: 5 };
  assert.equal(gathering.selectSlot(3), false, 'the gather refuses the slot');
  assert.equal(gathering.cycle(1), false, 'and refuses the wheel');
  assert.equal(gathering.selected, 'megablast');
});

test('a pick that lands reports that it landed', () => {
  const c = stubCaster({ unlocked: ['frostnova'] });
  assert.equal(c.selectSlot(3), true);
  assert.equal(c.selected, 'frostnova');
  assert.equal(c.cycle(1), true, 'two weapons in the book, so the wheel moves');
  assert.notEqual(c.selected, 'frostnova');
});

test('one ready weapon is drawn even when it just fired', () => {
  const c = stubCaster({ unlocked: ['fireball'] });
  c._autoLast = 'fireball';
  assert.equal(c.autoDraw(mulberry32(1)), 'fireball');
});

// --- the turn of the reel --------------------------------------------------

test('a loaded weapon is left alone; a spent one is replaced', () => {
  const c = stubCaster({ unlocked: ['fireball', 'frostnova'], mana: 50 });
  c.selected = 'fireball';
  c._updateAuto(1 / 60);
  assert.equal(c.selected, 'fireball', 'still ready, so it is still the next shot');

  c.cooldowns.fireball = 0.5;           // as a cast would leave it
  c._updateAuto(1 / 60);
  assert.equal(c.selected, 'frostnova', 'the reel moves on the moment it fires');
  assert.equal(c._autoLast, 'frostnova');
});

// Rotating weapons steps around every weapon's own recovery at once. Without a
// cadence of its own the reel fires a different spell on every frame and empties
// a full well in about three of them.
test('the reel keeps a cadence — rotating is not a way around every cooldown', () => {
  const c = stubCaster({ unlocked: EVERY_SPELL, mana: PLAYER.maxMana });
  const rand = mulberry32(41);
  const dt = 1 / 60;
  const window = 2;
  let draws = 0, last = c.selected;
  c.cooldowns[last] = 9;   // the loaded weapon is spent, so the reel has to move
  for (let i = 0; i < Math.round(window / dt); i++) {
    // every weapon it lands on is treated as fired: straight onto its recovery
    c._updateAuto(dt, rand);
    if (c.selected !== last) { draws++; last = c.selected; c.cooldowns[last] = 9; }
  }
  const ceiling = Math.ceil(window / AUTO.shotDelay) + 1;
  assert.ok(draws <= ceiling, `${window}s should be at most ${ceiling} shots, got ${draws}`);
  assert.ok(draws >= 3, `and it must not stall either, got ${draws}`);
});

test('the cadence never outpaces a spell that is slower than it', () => {
  assert.ok(AUTO.shotDelay <= SPELLS.fireball.cooldown,
    'a mage who only owns Fireball should be paced by Fireball, not by the mode');
});

test('the reel does not touch the slot while a Mega Blast is gathering', () => {
  const c = stubCaster({ unlocked: ['megablast', 'fireball'], mana: PLAYER.maxMana });
  c.selected = 'megablast';
  c.charge = { stats: c.stats('megablast'), t: 1, total: 5 };
  c.cooldowns.megablast = 14;           // as tryCast() stamps it at the button
  c._updateAuto(1 / 60);
  assert.equal(c.selected, 'megablast', 'the gather owns the slot until it throws');
});

test('a held channel is one shot: kept for its burst, then spun on', () => {
  const c = stubCaster({ only: ['lightning', 'fireball'], mana: PLAYER.maxMana });
  const rand = mulberry32(23);
  c.selected = 'lightning';
  c.beam = { id: 'lightning', target: null, tickAcc: 0, hitFxT: 0, arcFxT: 0, t: 0 };

  // mid-burst the beam owns the trigger, however many frames go by
  for (c.beam.t = 0; c.beam.t < AUTO.channelBurst; c.beam.t += 1 / 60) {
    c._updateAuto(1 / 60, rand);
    assert.equal(c.selected, 'lightning');
    assert.ok(c.beam, 'and it is never cut short');
  }

  // past it the reel spins on — the draw is weighted and paced, so it takes a
  // few of its own cadences to land on the other weapon
  let turns = 0;
  while (c.selected === 'lightning' && turns++ < 900) c._updateAuto(1 / 60, rand);
  assert.equal(c.selected, 'fireball', 'the burst is over, so the reel moves on');
  assert.equal(c.beam, null, 'and the beam is dropped with the slot it belonged to');
  assert.ok((c.cooldowns.lightning ?? 0) > 0, 'dropping it stamps the usual recovery');
});

test('a lone channel keeps burning past its burst rather than dropping to silence', () => {
  const c = stubCaster({ only: ['lightning'], mana: PLAYER.maxMana });
  c.selected = 'lightning';
  c.beam = { id: 'lightning', t: AUTO.channelBurst * 3 };
  for (let i = 0; i < 40; i++) c._updateAuto(1 / 60, mulberry32(31));
  assert.equal(c.selected, 'lightning');
  assert.ok(c.beam, 'nothing else was ready, so nothing was taken away');
});

test('the reel is a preference: a run reset keeps it, and forgets only the last draw', () => {
  const c = stubCaster({ unlocked: EVERY_SPELL });
  c.game.player.setMelee = () => {};
  c._autoLast = 'meteor';
  c.reset();
  assert.equal(c.auto, true, 'how you play outlives the run');
  assert.equal(c._autoLast, null, 'but the draw starts clean');
});

test('the reel only ever changes the slot — it never spends a drop on its own', () => {
  const c = stubCaster({ unlocked: EVERY_SPELL, mana: PLAYER.maxMana });
  c.selected = 'fireball';
  c.cooldowns.fireball = 0.5;
  for (let i = 0; i < 50; i++) c._updateAuto(1 / 60);
  assert.equal(c.game.player.mana, PLAYER.maxMana);
});
