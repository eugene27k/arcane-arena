// Wyrmlance is the only spell that spends its damage *along* a line rather than
// around a point, and the only one that bites a target more than once per cast.
// Every one of those properties is checkable without a renderer: the bolt owns
// no scene objects at all (they live behind an Effects handle), so a stub game
// with bare positions drives the whole weapon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { SPELLS, createSpellState, effectiveStats, isChannelled, autoDrawable, autoHeft } from '../src/config/spellConfig.js';
import { ENEMIES } from '../src/config/enemyConfig.js';
import { UPGRADES } from '../src/config/upgradeConfig.js';
import { HelixBolt } from '../src/spells/helixBolt.js';
import { SpellCaster } from '../src/spells/spellCaster.js';

const GRUNT = ENEMIES.grunt;

// ---------------------------------------------------------------- pricing ---

test('the braid is thrown, not channelled — priced per cast like a fireball', () => {
  assert.equal(isChannelled('helix'), false);
  const st = effectiveStats('wyrmlance', createSpellState());
  assert.equal(st.castThreshold, st.manaCost, 'a discrete cast hands over at exactly one cast');
  assert.equal(st.manaCost, 17);
  assert.equal(st.manaPerSecond, undefined, 'nothing here is priced per second any more');
  assert.equal(st.tickInterval, undefined);
});

test('the pair is the spell: two fangs, and the core is their sum', () => {
  const st = effectiveStats('wyrmlance', createSpellState());
  assert.equal(st.strandCount, 2);
  assert.equal(st.coreDamage, st.damage * 2);
  assert.ok(st.grazeDamage < st.damage, 'a brush is worth less than a single fang');
});

// ------------------------------------------------------- the corridor -------
// The one promise the spec is emphatic about: zero spread to the sides. Made
// concrete as an inequality against the gap the demons keep between themselves.

test('the corridor is narrower than the demons stand apart — at every upgrade stack', () => {
  const s = createSpellState();
  const reach = () => effectiveStats('wyrmlance', s).sleeveRadius + GRUNT.radius;
  assert.ok(reach() < GRUNT.separationRadius,
    `outer reach ${reach()} must stay under separation ${GRUNT.separationRadius}`);

  // apply every stack of every Wyrmlance card and re-check
  const cards = UPGRADES.filter((u) => u.category === 'Wyrmlance');
  assert.ok(cards.length >= 5, 'expected the Wyrmlance family');
  for (const card of cards) {
    for (let i = 0; i < (card.maxStacks ?? 1); i++) card.apply({ spellState: s });
  }
  assert.ok(reach() < GRUNT.separationRadius,
    'a fully upgraded Wyrmlance still cannot touch the demon beside the one it hit');
});

test('the braid is never drawn wider than the volume it damages', () => {
  const s = createSpellState();
  const check = (label) => {
    const st = effectiveStats('wyrmlance', s);
    const envelope = st.coilRadius + SPELLS.wyrmlance.strandRadius;
    assert.ok(envelope <= st.coreRadius + GRUNT.radius * st.coreGirthFrac,
      `${label}: drawn ${envelope} must stay inside the core band`);
    assert.ok(st.coreRadius <= st.sleeveRadius, `${label}: core must stay inside the sleeve`);
  };
  check('base');
  s.wyrmlance.radiusMult *= 1.18; check('1 coil');
  s.wyrmlance.radiusMult *= 1.18; check('2 coils');
  for (let i = 0; i < 20; i++) s.wyrmlance.radiusMult *= 1.18;
  check('absurd');
});

// ------------------------------------------------------------ the flight ----

function stubGame(enemies, { stoneAt = null } = {}) {
  const fxCalls = [];
  return {
    enemies: enemies.map((e) => ({
      alive: true,
      name: e.name,
      hits: [],
      hp: e.hp ?? 1e9,
      cfg: { radius: GRUNT.radius, height: GRUNT.height },
      pos: new THREE.Vector3(e.x, e.y ?? 0, e.z),
      takeDamage(amount) {
        if (!this.alive) return;
        this.hits.push(amount);
        this.hp -= amount;
        if (this.hp <= 0) this.alive = false;
      },
    })),
    projectiles: [],
    // The axis is taken from the camera's OPTICAL direction, not from the rig's
    // `forward` — see the note in _castHelix. The stub has to model that.
    camera: {
      position: new THREE.Vector3(0, 1.4, -4),
      getWorldDirection: (v) => v.set(0, 0, 1),
    },
    player: {
      alive: true,
      center: new THREE.Vector3(0, 1.7, 0),
      handWorldPos: (side) => new THREE.Vector3(0.36 * side, 1.4, 0),
    },
    cameraRig: {
      fovKick: 0,
      addTrauma() {},
      getAimPoint: () => ({
        origin: new THREE.Vector3(0, 1.4, -3),          // the camera, behind the mage
        dir: new THREE.Vector3(0, 0, 1),
        point: new THREE.Vector3(0, 1.4, 40),
      }),
    },
    world: { raycast: () => (stoneAt === null ? null : { t: stoneAt }) },
    hud: { hitmarker() {} },
    audio: { play(n) { fxCalls.push(n); } },
    fx: {
      muzzleFlash() {},
      helixStart: () => ({}),
      helixUpdate() {}, helixPierce() {}, helixScorch() {}, helixStop() {},
    },
    sounds: fxCalls,
  };
}

// Throw a bolt down +Z from the origin and run it to expiry.
function throwBolt(game, { state = createSpellState(), dt = 1 / 60, frames = 400, perp = 0 } = {}) {
  const stats = effectiveStats('wyrmlance', state);
  // level with the demons' centres, as an aimed shot is
  const origin = new THREE.Vector3(perp, GRUNT.height * 0.55, 0);
  const dir = new THREE.Vector3(0, 0, 1);
  const hit = game.world.raycast(origin, dir, stats.range);
  const maxRange = hit ? Math.min(hit.t, stats.range) : stats.range;
  const bolt = new HelixBolt(game, stats, origin, dir, maxRange, !!hit, [
    game.player.handWorldPos(1), game.player.handWorldPos(-1),
  ]);
  let n = 0;
  while (bolt.alive && n++ < frames) bolt.update(dt);
  const by = {};
  for (const e of game.enemies) by[e.name] = e;
  return { bolt, stats, by, frames: n };
}

test('it pierces: every demon on the line is struck, and depth costs nothing', () => {
  const game = stubGame([
    { name: 'near', x: 0, z: 6 },
    { name: 'mid', x: 0, z: 16 },
    { name: 'far', x: 0, z: 30 },
  ]);
  const { by, stats } = throwBolt(game);
  for (const n of ['near', 'mid', 'far']) {
    assert.equal(by[n].hits.length, stats.strandCount, `${n} takes both fangs`);
    assert.equal(by[n].hits.reduce((a, b) => a + b, 0), stats.coreDamage);
  }
  // the one at 30 m takes exactly what the one at 6 m does
  assert.deepEqual(by.near.hits, by.far.hits);
});

test('the pair bites twice on the line, once on a brush', () => {
  const game = stubGame([
    { name: 'centred', x: 0, z: 14 },
    { name: 'brushed', x: 1.0, z: 20 },   // outside the core, inside the sleeve
  ]);
  const { by, stats } = throwBolt(game);
  assert.equal(by.centred.hits.length, 2, 'two fangs');
  assert.deepEqual(by.centred.hits, [stats.damage, stats.damage]);
  assert.equal(by.brushed.hits.length, 1, 'a brush is a single thin hit');
  assert.ok(Math.abs(by.brushed.hits[0] - stats.grazeDamage) < 1e-9);
  assert.ok(by.brushed.hits[0] < stats.coreDamage);
});

test('Third Serpent adds a real fang, and thins all of them', () => {
  const s = createSpellState();
  UPGRADES.find((u) => u.id === 'lance_strand').apply({ spellState: s });
  const game = stubGame([{ name: 'centred', x: 0, z: 14 }]);
  const { by, stats } = throwBolt(game, { state: s });
  assert.equal(stats.strandCount, 3);
  assert.equal(by.centred.hits.length, 3, 'three separate bites');
  const per = SPELLS.wyrmlance.damage * SPELLS.wyrmlance.strandDamageMult;
  for (const h of by.centred.hits) assert.ok(Math.abs(h - per) < 1e-9);
  // three thinner fangs still beat two fat ones
  assert.ok(stats.coreDamage > SPELLS.wyrmlance.damage * 2);
});

test('nothing spreads sideways — the corridor is exact', () => {
  const st = effectiveStats('wyrmlance', createSpellState());
  const outer = st.sleeveRadius + GRUNT.radius;    // 1.17
  const at = (perp) => {
    const game = stubGame([{ name: 'e', x: perp, z: 18 }]);
    return throwBolt(game).by.e.hits.length;
  };
  assert.equal(at(outer - 0.01), 1, 'just inside the sleeve: a graze');
  assert.equal(at(outer + 0.01), 0, 'just outside: nothing at all');
  assert.equal(at(GRUNT.separationRadius), 0,
    'a demon one full separation away is untouched — this is the zero-AoE promise');
});

test('stone bounds the run, and the line goes one way only', () => {
  const sheltered = stubGame([{ name: 'behindWall', x: 0, z: 20 }], { stoneAt: 8 });
  assert.equal(throwBolt(sheltered).by.behindWall.hits.length, 0);

  const behind = stubGame([{ name: 'behind', x: 0, z: -10 }]);
  assert.equal(throwBolt(behind).by.behind.hits.length, 0);

  const beyond = stubGame([{ name: 'distant', x: 0, z: 200 }]);
  const r = throwBolt(beyond);
  assert.equal(r.by.distant.hits.length, 0);
  assert.equal(r.bolt.head, SPELLS.wyrmlance.range, 'the run stops at its own range');
});

test('a demon inside the rod for many frames is struck exactly once', () => {
  for (const dt of [1 / 144, 1 / 60, 1 / 30]) {
    const game = stubGame([{ name: 'e', x: 0, z: 12 }]);
    const { by, stats } = throwBolt(game, { dt });
    assert.equal(by.e.hits.length, stats.strandCount,
      `dt=${dt}: exactly one strike, ${stats.strandCount} fangs — never spread over frames`);
  }
});

test('nothing tunnels, even at Rifling speed on a terrible frame', () => {
  const s = createSpellState();
  const rifling = UPGRADES.find((u) => u.id === 'lance_speed');
  rifling.apply({ spellState: s });
  rifling.apply({ spellState: s });
  const stats = effectiveStats('wyrmlance', s);
  assert.ok(stats.boltSpeed > 80, 'expected the fast build');
  // The frame's travel MUST exceed braidLength or the max() term this test
  // exists to cover is inert: at 84.5 m/s a 1/10 s frame moves 8.45 m against a
  // 7 m rod, so the rod alone would leave a 1.45 m gap between frames.
  const dt = 1 / 10;
  assert.ok(stats.boltSpeed * dt > SPELLS.wyrmlance.braidLength,
    'this test is worthless unless the frame outruns the rod');
  const game = stubGame([5, 12, 19, 26, 33].map((z, i) => ({ name: `e${i}`, x: 0, z })));
  const { by } = throwBolt(game, { state: s, dt });
  for (let i = 0; i < 5; i++) {
    assert.equal(by[`e${i}`].hits.length, stats.strandCount, `e${i} must not be stepped over`);
  }
});

test('a fang is never wasted on a corpse, and the line carries on behind it', () => {
  const st = effectiveStats('wyrmlance', createSpellState());
  const game = stubGame([
    { name: 'frail', x: 0, z: 10, hp: st.damage - 1 },  // dies to the first fang
    { name: 'behind', x: 0, z: 18 },
  ]);
  const { by } = throwBolt(game);
  assert.equal(by.frail.hits.length, 1, 'the second fang is not spent on a body already down');
  assert.equal(by.frail.alive, false);
  assert.equal(by.behind.hits.length, 2, 'the braid drills on through');
});

// ------------------------------------------------------------- upgrades -----

test('radius upgrades widen the full-damage band and nothing else', () => {
  const s = createSpellState();
  const base = effectiveStats('wyrmlance', s);
  s.wyrmlance.radiusMult *= 1.18;
  const up = effectiveStats('wyrmlance', s);
  assert.ok(up.coreRadius > base.coreRadius, 'the core band widens');
  assert.ok(up.coilRadius > base.coilRadius, 'the drawn braid widens with it');
  assert.equal(up.sleeveRadius, base.sleeveRadius, 'the corridor never moves');
  assert.equal(up.range, base.range, 'a longer braid would just be a better one');
  assert.equal(up.lifeTime, base.lifeTime);
});

test('speed upgrades move the bolt and nothing else', () => {
  const s = createSpellState();
  const base = effectiveStats('wyrmlance', s);
  s.wyrmlance.speedMult *= 1.3;
  const up = effectiveStats('wyrmlance', s);
  assert.ok(Math.abs(up.boltSpeed - base.boltSpeed * 1.3) < 1e-9);
  assert.equal(up.damage, base.damage);
  assert.equal(up.coreRadius, base.coreRadius);
});

test('the power dial that drives the visual is the damage card', () => {
  const s = createSpellState();
  assert.equal(effectiveStats('wyrmlance', s).power01, 0);
  const bite = UPGRADES.find((u) => u.id === 'lance_damage');
  const seen = [];
  for (let i = 0; i < 5; i++) { bite.apply({ spellState: s }); seen.push(effectiveStats('wyrmlance', s).power01); }
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'monotonic');
  assert.equal(seen[seen.length - 1], 1, 'a fully stacked braid is at full intensity');
});

test('the cost ladder', () => {
  const s = createSpellState();
  const seen = [effectiveStats('wyrmlance', s).manaCost];
  const thrift = UPGRADES.find((u) => u.id === 'lance_cost');
  for (let i = 0; i < 3; i++) { thrift.apply({ spellState: s }); seen.push(effectiveStats('wyrmlance', s).manaCost); }
  assert.deepEqual(seen, [17, 14, 11, 9]);
});

test('the unlock is a wave-5 card, offered once', () => {
  const unlock = UPGRADES.find((u) => u.id === 'unlock_wyrmlance');
  const s = createSpellState();
  assert.equal(unlock.available({ spellState: s, wave: 4 }), false);
  assert.equal(unlock.available({ spellState: s, wave: 5 }), true);
  unlock.apply({ spellState: s });
  assert.equal(s.wyrmlance.unlocked, true);
  assert.equal(unlock.available({ spellState: s, wave: 9 }), false);
});

// ------------------------------------------------- contracts with the rest --

test('the Auto Weapon reel is undisturbed by the rewrite', () => {
  // Once it stopped being channelled its heft became its raw cost, so it has to
  // stay clear of Lightning below it and Mega Blast above it.
  assert.equal(autoHeft('wyrmlance'), SPELLS.wyrmlance.manaCost);
  const order = autoDrawable();
  assert.deepEqual(order, ['meteor', 'megablast', 'wyrmlance', 'lightning', 'frostnova', 'fireball']);
  for (let i = 1; i < order.length; i++) {
    assert.ok(autoHeft(order[i - 1]) > autoHeft(order[i]), 'hefts must stay strictly descending');
  }
});

test('the hot path allocates nothing and rolls no dice', () => {
  // comments stripped: the file explains why it avoids these, and saying so
  // must not read as doing so
  const src = readFileSync(new URL('../src/spells/helixBolt.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Math\.random/.test(src), 'damage must be deterministic');
  assert.ok(!/\.center\b/.test(src), 'e.center allocates a Vector3 on every read');
  assert.ok(!/segmentHitsSphere|pointSegmentDist/.test(src), 'those helpers allocate three vectors a call');
  assert.ok(!/new THREE\.|new Set\(|\.clone\(/.test(src.slice(src.indexOf('_scan('))),
    'the per-frame scan must allocate nothing at all');

  // and the scan really does reuse one Set for the whole flight
  const game = stubGame([{ name: 'e', x: 0, z: 20 }]);
  const stats = effectiveStats('wyrmlance', createSpellState());
  const bolt = new HelixBolt(game, stats, new THREE.Vector3(), new THREE.Vector3(0, 0, 1), 45, false,
    [new THREE.Vector3(0.36, 1.4, 0), new THREE.Vector3(-0.36, 1.4, 0)]);
  const set = bolt.struck;
  for (let i = 0; i < 40 && bolt.alive; i++) bolt.update(1 / 60);
  assert.equal(bolt.struck, set, 'the struck set is allocated once and never replaced');
});

test('the same shot deals the same damage at any frame rate', () => {
  // Comparing two runs at the SAME dt only proves the code is not random.
  // Varying dt proves damage does not depend on how the flight was sampled —
  // which is the property that a phase-dependent or per-frame-accumulating
  // implementation would fail.
  const run = (dt) => {
    const game = stubGame([
      { name: 'a', x: 0, z: 9 }, { name: 'b', x: 0.9, z: 17 }, { name: 'c', x: 0, z: 26 },
    ]);
    const { by } = throwBolt(game, { dt });
    return ['a', 'b', 'c'].map((n) => by[n].hits.slice());
  };
  const ref = run(1 / 60);
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 1 / 20]) {
    assert.deepEqual(run(dt), ref, `dt=${dt} must deal exactly what 1/60 dealt`);
  }
  assert.ok(ref[0].length === 2 && ref[2].length === 2, 'and it must actually be hitting things');
});

test('the caster throws exactly one bolt and pays exactly once', () => {
  const game = stubGame([{ name: 'e', x: 0, z: 14 }]);
  let spent = 0;
  game.player.mana = 100;
  game.player.trySpendMana = (n) => { spent += n; return true; };
  game.player.triggerCastAnim = () => {};
  game.player.inManaDebt = false;
  const caster = new SpellCaster(game);
  game.caster = caster;
  caster.spellState.wyrmlance.unlocked = true;
  caster.selected = 'wyrmlance';
  assert.equal(caster.tryCast(), true);
  assert.equal(game.projectiles.length, 1);
  assert.ok(game.projectiles[0] instanceof HelixBolt);
  assert.equal(spent, 17);
  assert.ok(game.sounds.includes('wyrmCast'));
  // and the slot is on a real cooldown, not a channel's refire
  assert.ok(caster.cooldowns.wyrmlance > 0);
  assert.equal(caster.tryCast(), false, 'the second press inside the cooldown does nothing');
});

test('a brush is never worth more than a single fang, at any strand count', () => {
  const s = createSpellState();
  const check = (label) => {
    const st = effectiveStats('wyrmlance', s);
    assert.ok(st.grazeDamage < st.damage,
      `${label}: graze ${st.grazeDamage} must stay under one fang ${st.damage}`);
  };
  check('base');
  UPGRADES.find((u) => u.id === 'lance_strand').apply({ spellState: s });
  check('third serpent');
  for (let i = 0; i < 5; i++) { UPGRADES.find((u) => u.id === 'lance_damage').apply({ spellState: s }); check('maxed'); }
});

test('running out of reach in open air reports nothing — silence is the tell', () => {
  const stats = effectiveStats('wyrmlance', createSpellState());
  const openAir = stubGame([]);
  const b1 = new HelixBolt(openAir, stats, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1),
    stats.range, false, [new THREE.Vector3(0.36, 1, 0), new THREE.Vector3(-0.36, 1, 0)]);
  while (b1.alive) b1.update(1 / 60);
  assert.deepEqual(openAir.sounds, [], 'a clean whiff must not play the wall impact');

  const wall = stubGame([], { stoneAt: 12 });
  const b2 = new HelixBolt(wall, stats, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1),
    12, true, [new THREE.Vector3(0.36, 1, 0), new THREE.Vector3(-0.36, 1, 0)]);
  while (b2.alive) b2.update(1 / 60);
  assert.deepEqual(wall.sounds, ['wyrmWall'], 'earthing on stone does');
});

test('every cored demon gets both of its markers, even in a pierce', () => {
  const marks = [];
  const game = stubGame([9, 10, 11, 12].map((z, i) => ({ name: `e${i}`, x: 0, z })));
  game.hud.hitmarker = (kill) => marks.push(!!kill);
  const { by, stats } = throwBolt(game);
  for (let i = 0; i < 4; i++) assert.equal(by[`e${i}`].hits.length, stats.strandCount);
  // one immediate + one deferred per cored demon; consecutive frames must not
  // swallow a pending marker, and the last one must not be lost to expiry
  assert.equal(marks.length, 8, 'four cored demons must produce eight markers');
});

test('the axis follows the camera optical axis, not the rig forward', () => {
  // Regression: cameraRig parks the camera at a shoulder offset but lookAt()s
  // the un-shouldered pivot, so rig.forward and the true optical axis diverge.
  // Building the shot from the wrong one made it whiff past ten metres.
  const game = stubGame([{ name: 'far', x: 0, z: 34 }]);
  let asked = false;
  game.camera.getWorldDirection = (v) => { asked = true; return v.set(0, 0, 1); };
  // a rig `forward` pointing somewhere else entirely: if the cast used it, the
  // demon dead ahead would be missed
  game.cameraRig.getAimPoint = () => ({
    origin: new THREE.Vector3(3, 1.4, -3),
    dir: new THREE.Vector3(0.6, 0, 0.8).normalize(),
    point: new THREE.Vector3(30, 1.4, 40),
  });
  game.player.mana = 100;
  game.player.trySpendMana = () => true;
  game.player.triggerCastAnim = () => {};
  game.player.inManaDebt = false;
  const caster = new SpellCaster(game);
  game.caster = caster;
  caster.spellState.wyrmlance.unlocked = true;
  caster.selected = 'wyrmlance';
  caster.tryCast();
  assert.ok(asked, 'the cast must ask the camera for its real direction');
  const bolt = game.projectiles[0];
  while (bolt.alive) bolt.update(1 / 60);
  assert.equal(game.enemies[0].hits.length, 2, 'the demon under the crosshair takes both fangs');
});
