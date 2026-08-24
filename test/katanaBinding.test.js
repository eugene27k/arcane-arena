// Onikiri is the one weapon in the game that is meant to be taken away again,
// so the rules worth pinning down are the ones that keep it from becoming a
// permanent upgrade: it shares the staff's slot, it runs on a clock, kills feed
// that clock but only up to a ceiling, and a new wave always ends it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpellCaster } from '../src/spells/spellCaster.js';
import { SPELLS } from '../src/config/spellConfig.js';

const K = SPELLS.katana;

// Enough of a game for the caster to talk to: nothing here has behaviour, it
// just has to not throw when the blade is claimed, warned about, or lost.
function harness() {
  const toasts = [];
  const game = {
    enemies: [],
    player: { alive: true, mana: 100, center: { x: 0, y: 0, z: 0 }, setMelee(id) { game.heldWeapon = id; } },
    hud: { toast: (t) => toasts.push(t), banner: () => {}, hitmarker: () => {} },
    audio: { play: () => {} },
    fx: { bladeClaim: () => {}, bladeLapse: () => {} },
    cameraRig: { addTrauma: () => {} },
    heldWeapon: 'staff',
  };
  return { caster: new SpellCaster(game), game, toasts };
}

test('the mage starts with the staff; the katana is not in the book', () => {
  const { caster } = harness();
  assert.equal(caster.meleeId, 'staff');
  assert.equal(caster.isUnlocked('katana'), false);
  assert.equal(caster.inBook(SPELLS.staff), true);
  assert.equal(caster.inBook(SPELLS.katana), false);
});

test('the two melee weapons share one slot, and only one of them is ever in it', () => {
  assert.equal(SPELLS.katana.slot, SPELLS.staff.slot);
  const { caster } = harness();
  caster.selectSlot(SPELLS.staff.slot);
  assert.equal(caster.selected, 'staff');

  caster.takeBlade();
  assert.equal(caster.meleeId, 'katana');
  assert.equal(caster.inBook(SPELLS.staff), false);
  caster.selectSlot(SPELLS.katana.slot);
  assert.equal(caster.selected, 'katana', 'slot 4 must reach the blade in hand');
});

test('claiming the blade puts it in the model hand, losing it puts the staff back', () => {
  const { caster, game } = harness();
  caster.takeBlade();
  assert.equal(game.heldWeapon, 'katana');
  caster.dropBlade();
  assert.equal(game.heldWeapon, 'staff');
});

test('the binding runs down in real seconds and hands the staff back when it lapses', () => {
  const { caster } = harness();
  caster.takeBlade();
  caster.select('katana');
  assert.equal(caster.bladeT, K.bindTime);

  caster.update(K.bindTime - 1);
  assert.ok(Math.abs(caster.bladeT - 1) < 1e-9, 'a second of steel left');
  assert.equal(caster.meleeId, 'katana');

  caster.update(1.01);
  assert.equal(caster.bladeT, 0);
  assert.equal(caster.meleeId, 'staff');
  assert.equal(caster.isUnlocked('katana'), false);
  assert.equal(caster.selected, 'staff', 'selection cannot be left on a weapon that is gone');
});

test('kills feed the binding, but never past its ceiling', () => {
  const { caster } = harness();
  caster.takeBlade();
  caster.update(5);
  const before = caster.bladeT;
  caster.feedBlade(2);
  assert.ok(Math.abs(caster.bladeT - (before + K.killBind * 2)) < 1e-9);

  caster.feedBlade(500);
  assert.equal(caster.bladeT, K.maxBindTime, 'a good wave must not buy a permanent sword');
});

test('feeding a blade that is already gone does not resurrect it', () => {
  const { caster } = harness();
  caster.feedBlade(10);
  assert.equal(caster.bladeT, 0);
  assert.equal(caster.meleeId, 'staff');
});

test('a second blade extends the binding, it never shortens it', () => {
  const { caster } = harness();
  caster.takeBlade();
  caster.feedBlade(4);
  const long = caster.bladeT;
  assert.ok(long > K.bindTime);
  caster.takeBlade();
  assert.equal(caster.bladeT, long);
});

test('the blade never survives a wave boundary or a run reset', () => {
  const { caster } = harness();
  caster.takeBlade();
  caster.dropBlade(true);
  assert.equal(caster.meleeId, 'staff');
  assert.equal(caster.bladeT, 0);

  caster.takeBlade();
  caster.reset();
  assert.equal(caster.meleeId, 'staff');
  assert.equal(caster.bladeT, 0);
});

test('god mode holds an endless binding that no wave and no second blade can end', () => {
  const { caster } = harness();
  caster.applyGodMode();
  assert.equal(caster.meleeId, 'katana');
  assert.equal(caster.bladeT, Infinity);

  caster.update(9999);
  assert.equal(caster.bladeT, Infinity);
  caster.dropBlade();
  assert.equal(caster.meleeId, 'katana', 'god mode never has a weapon taken away');
  caster.takeBlade();
  assert.equal(caster.bladeT, Infinity);
});

test('the wheel offers one melee weapon, whichever is in hand', () => {
  const { caster } = harness();
  const inBook = () => Object.values(SPELLS)
    .filter((s) => caster.isUnlocked(s.id) && caster.inBook(s))
    .map((s) => s.id);
  assert.deepEqual(inBook().filter((id) => SPELLS[id].type === 'melee'), ['staff']);
  caster.takeBlade();
  assert.deepEqual(inBook().filter((id) => SPELLS[id].type === 'melee'), ['katana']);
});

test('the blade is not on the upgrade table — no card can hand it out or scale it', async () => {
  const { UPGRADES } = await import('../src/config/upgradeConfig.js');
  const src = UPGRADES.map((u) => `${u.id} ${u.name} ${u.desc} ${u.apply}`).join('\n');
  assert.ok(!/katana|Onikiri/i.test(src), 'the katana must stay out of the upgrade pool');
});
