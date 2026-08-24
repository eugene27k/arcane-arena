// Life relics — the cathedral's answer to a bleeding mage (PRD §17, extended).
//
// Essence orbs are the mana economy and the little health orbs are its small
// change: both fall where a demon died, which is to say they arrive as a reward
// for winning. A relic is the opposite. It is offered *because* the fight is
// going badly, it is planted across the hall rather than dropped at your feet,
// and the walk to it through whatever stands in the way is the entire cost.
//
// Nothing is ever offered to a mage at full health. A full restore standing in
// the corner of a wave you are already winning is not a pickup, it is scenery —
// and scenery is what teaches players to stop looking around the arena.

export const LIFE_RELICS = {
  // The common one: a guttering crimson ember. A bite out of the wound, not a
  // reset — you are meant to still be in trouble after taking it.
  ember: {
    id: 'ember',
    name: 'Vital Ember',
    icon: '❤️',
    heal: 40,
    full: false,
    maxHpFrac: 0.8,       // not offered for a scratch
    // Per check — see RELIC_RULES.checkInterval. Tuned against a ~60 s wave
    // spent below the threshold: a bit under half of those waves produce one,
    // so an ember is a break rather than a supply line.
    chance: 0.07,
    minWave: 1,
    minSpawnDist: 9,      // metres from the mage: a walk, not a trek
    maxSpawnDist: 30,
    // Below this the ember will let itself be spent. Essentially any real
    // wound: the ember is cheap enough that hoarding it isn't the point.
    claimAtHpFrac: 0.97,
    color: 0xff4058,
    coreColor: 0xffc0b0,
  },

  // The rare one: a full restore, and the only thing in the game that hands the
  // whole bar back. Gated behind *being about to die* rather than behind a
  // wave number alone — a font is a rescue, and a rescue you didn't need is
  // just a wasted roll.
  font: {
    id: 'font',
    name: 'Sanguine Font',
    icon: '\u{1F496}',
    heal: null,           // null = restore to full
    full: true,
    maxHpFrac: 0.4,
    // A dying mage is below this threshold for maybe twenty seconds of a bad
    // wave, so this reads out at roughly one font every dozen-odd waves —
    // rare enough to be remembered, common enough to be learned.
    chance: 0.05,
    minWave: 4,
    minSpawnDist: 14,     // it costs more to reach, because it gives more
    maxSpawnDist: 40,
    // A font refuses to be spent by a mage who is merely scuffed. Brushing past
    // one at 90 HP and vaporising a full restore is the worst thing this pickup
    // could do to a run, so it simply doesn't happen — the relic goes dormant
    // instead, and lights back up the moment it would actually be worth taking.
    claimAtHpFrac: 0.7,
    color: 0xff5a70,
    coreColor: 0xffe8ec,
    haloColor: 0xffd0a0,
  },
};

// Rarest first: the roll walks these in order and hands out cumulative bands
// off a single draw, so the font always gets first refusal on a dying mage and
// the ember picks up whatever it leaves behind.
export const RELIC_TIERS = ['font', 'ember'];

export const RELIC_RULES = {
  checkInterval: 5,   // seconds of combat between rolls
  minGap: 30,         // seconds between two relics appearing
  maxPerWave: 2,      // a bad wave can be answered twice, never more
};

// The whole spawn decision, kept pure so it can be reasoned about (and tested)
// without a renderer. Returns a tier id or null.
//
// `standing` is "there is already an unclaimed relic in the arena" — one at a
// time, always. A second beacon while the first is still lit reads as noise,
// and lets a player bank heals instead of spending the walk.
export function rollLifeRelic({
  wave,
  hpFrac,
  standing = false,
  spawnedThisWave = 0,
  sinceLastSpawn = Infinity,
  rng = Math.random,
}) {
  if (standing) return null;
  if (spawnedThisWave >= RELIC_RULES.maxPerWave) return null;
  if (sinceLastSpawn < RELIC_RULES.minGap) return null;

  const r = rng();
  let acc = 0;
  for (const id of RELIC_TIERS) {
    const tier = LIFE_RELICS[id];
    // An ineligible tier claims no band at all, which is what makes the ember
    // take its full chance on a lightly-wounded mage instead of forever losing
    // the front of the range to a font that was never going to be offered.
    if (wave < tier.minWave || hpFrac > tier.maxHpFrac) continue;
    acc += tier.chance;
    if (r < acc) return id;
  }
  return null;
}
