// Spell definitions (PRD §10-§12). Data-driven: adding a spell = adding an entry.
// type: 'projectile' | 'beam' | 'nova' | 'meteor' | 'helix' | 'melee'

// Global cast-cost scale: every spell fires for this fraction of its listed
// manaCost, so the same pool buys twice as many casts at 0.5.
export const CAST_MANA_SCALE = 0.5;
const MANA_COST_FLOOR = 2; // scaled down alongside the costs (was 3 at full price)
// However much a charge is shortened, it stays long enough to read as a ritual.
const MIN_CHARGE_TIME = 1.5;

// Spells that are *held* rather than cast. They have no per-cast rhythm: their
// `cooldown` is a tick interval, they are priced per second and drained per
// tick, and their slot sweeps `refireDelay` instead. Everything that reasons
// about cast cadence branches on this rather than on one type name, so adding
// the next channelled spell doesn't mean hunting down the string 'beam'.
// The most the renderer ever fattens a strand by, at full Serpent's Bite (see
// effects.js helixStart). Config and renderer must agree on this or the drawn
// braid can spill outside the volume it damages.
export const STRAND_WIDTH_PEAK = 1.22;

const CHANNELLED_TYPES = new Set(['beam']);
export function isChannelled(type) { return CHANNELLED_TYPES.has(type); }

export const SPELLS = {
  fireball: {
    id: 'fireball',
    name: 'Fireball',
    icon: '🔥',
    type: 'projectile',
    slot: 1,
    unlockedAtStart: true,
    damage: 40,
    manaCost: 15,
    cooldown: 0.5,
    projectileSpeed: 30,
    projectileRadius: 0.32,
    aoeRadius: 3.4,
    projectileCount: 1,
    spreadAngle: 0.07,     // used when projectileCount > 1
    twinDamageMult: 0.7,   // per-bolt damage multiplier once Twin Fireball is taken
    lifeTime: 4,
    color: 0xff7a30,
    coreColor: 0xffd9a0,
    // synergy upgrade tunables
    igniteDpsFrac: 0.22,    // burn dps as a fraction of hit damage
    igniteDuration: 3,
    detonationFrac: 0.45,   // corpse-explosion damage as a fraction of fireball damage
    detonationRadius: 2.6,
  },
  // Lightning — the Quake 3 lightning gun, not a bolt you throw. Hold the cast
  // button and a continuous shaft of electricity connects you to a demon,
  // ticking 20 times a second on a short leash. It auto-latches onto whatever
  // sits nearest the crosshair and stays latched while that demon strafes, so
  // the skill is in keeping the leash — not in tracking heads.
  lightning: {
    id: 'lightning',
    name: 'Lightning',
    icon: '\u26a1',
    type: 'beam',
    slot: 2,
    unlockedAtStart: false,
    damage: 6,             // per tick — 120 dps at the stock 20 Hz cadence
    manaCost: 36,          // per SECOND of fire (scaled like every cast by CAST_MANA_SCALE)
    cooldown: 0.05,        // tick interval: Quake 3's 50 ms lightning cadence
    refireDelay: 0.16,     // recovery once the beam drops, before it can re-strike
    range: 25,             // Q3's 768-unit leash, converted to this arena's scale
    // Auto-aim. The narrow cone is what it takes to *acquire* a demon; the wide
    // one is what it takes to *keep* it. A rival has to beat the held target by
    // the switch margin to steal the beam, so the lock doesn't flicker between
    // two demons standing side by side.
    aimAssistAngle: 0.24,  // radians (~14 deg) acquisition cone
    lockAngle: 0.5,        // radians (~29 deg) hold cone
    lockSwitchMargin: 0.07,
    // Arc splash: the beam earths itself through whoever is packed around the
    // demon it's burning. Close neighbours eat most of the fraction, ones at the
    // edge of the radius barely feel it.
    splashRadius: 3,
    splashFrac: 0.35,
    splashFloor: 0.4,      // share of the splash a neighbour keeps at the far edge
    chains: 0,             // extra spread layers (upgradeable)
    chainRadius: 5.5,
    chainDamageMult: 0.6,
    color: 0x86d4ff,
    coreColor: 0xeaf8ff,
    // synergy upgrade tunables
    siphonMana: 8,          // mana refunded per Lightning kill
    overchargeMult: 1.35,   // Arc Battery: beam damage while overcharged
    overchargeTime: 2,      // seconds, refreshed by every further kill
    tempestDamage: 20,      // dash-nova hit (scales with Lightning damage upgrades)
    tempestRadius: 3.2,
  },
  frostnova: {
    id: 'frostnova',
    name: 'Frost Nova',
    icon: '❄️',
    type: 'nova',
    slot: 3,
    unlockedAtStart: false,
    // Panic button, not a damage tool: the slow is the payload.
    damage: 30,
    manaCost: 30,
    cooldown: 5,
    novaRadius: 6,
    slowFactor: 0.5,        // slowed demons move at 50% speed
    slowDuration: 3,
    slowFactorFloor: 0.15,  // Deep Freeze stacks multiply down — never to a full stop
    color: 0x9fd8ff,
    coreColor: 0xeaf6ff,
    // synergy upgrade tunables
    shatterDamageMult: 1.25, // Shatter: bonus damage all sources deal to a slowed demon
  },
  // The ultimate (PRD §12 "high-cost spell"): a circle of sky torn open around
  // the mage, raining rock for a few seconds. The only spell that may be cast
  // with an empty pool — it overdraws the well into arcane debt instead of
  // refusing, and everything else in the book stays dead until the debt clears.
  meteor: {
    id: 'meteor',
    name: 'Meteor Storm',
    icon: '\u2604\uFE0F',
    type: 'meteor',
    slot: 5,
    unlockedAtStart: false,
    damage: 55,             // one big rock; the small ones scale off it
    manaCost: 120,          // over half the well per cast, before any discount
    cooldown: 9,
    overdraft: true,        // castable into a negative balance (see PLAYER.manaFloorFrac)
    stormRadius: 11,        // the circle of ground the rain covers, centred on the mage
    stormInnerRadius: 1.6,  // nothing lands on the mage's own boots
    duration: 2.4,          // seconds of falling rock per cast
    meteorCount: 14,
    bigFraction: 0.35,      // the rest fall small — a mix, not a uniform barrage
    smallDamageMult: 0.5,
    bigAoe: 4.4, smallAoe: 2.5,
    bigRadius: 0.6, smallRadius: 0.28,
    bigSpeed: 25, smallSpeed: 33,
    spawnHeight: 26,        // where the rocks are summoned above the impact point
    enemyBias: 0.6,         // share of rocks steered onto a demon instead of open stone
    scatter: 1.5,           // metres of slop on a steered rock, so aimed still misses
    skyClearance: 6,        // a rock re-aims if the stone under that column stands
                            // this far above the mage — the storm looks for open sky
    // Every rock is its own explosion; full per-hit shake would be unplayable.
    bigTrauma: 0.5, smallTrauma: 0.22,
    color: 0xff5a1e,
    coreColor: 0xffd08a,
  },
  // The slow ultimate: a sun of cold blue fire the mage builds by hand over a
  // full five seconds, then throws. Nothing else in the book asks the player to
  // stand in a fight and *wait* — the charge is the cost the mana price only
  // half pays for. It aims itself (see pickMegaTarget) and steers in flight, so
  // the five seconds are spent surviving rather than lining a shot up.
  megablast: {
    id: 'megablast',
    name: 'Mega Blast',
    icon: '\u{1F535}',
    type: 'megablast',
    slot: 6,
    unlockedAtStart: false,
    damage: 180,            // a grunt dies to this well past wave 20
    manaCost: 90,           // ~half the well once CAST_MANA_SCALE applies
    cooldown: 10,           // starts at the boom, not at the start of the charge
    chargeTime: 5,          // the whole point: five seconds of gathering
    projectileSpeed: 24,
    projectileRadius: 0.8,
    aoeRadius: 7.5,         // the "multiple grunts" half of the promise
    lifeTime: 6,
    // Auto-aim. The lock is taken at the *boom*, not at the start of the charge:
    // five seconds is long enough for the arena to rearrange itself completely.
    autoAimRange: 60,
    // Target scoring — the pack beats the straggler, and a demon the mage is
    // already looking at beats one behind them.
    clusterWeight: 12,      // score per extra demon inside the blast radius
    facingWeight: 9,        // score for sitting on the crosshair, scaled by aim
    homingTurnRate: 3.2,    // rad/s the orb may bend toward its mark
    // Charge tells. The orb grows in the hands, the ground ring tightens, and
    // the last second rumbles so the boom is never a surprise.
    chargeTrauma: 0.5,      // trauma fed per second at full ramp (decay is 1.6/s)
    blastTrauma: 2.4,       // multiplier on the impact shake
    color: 0x2f7bff,
    coreColor: 0xbfe4ff,
  },
  // Wyrmlance — the twin-serpent cast. One press *throws* a heavy pair of
  // emerald bolts that braid around one another in a tight double helix as they
  // fly. It is not a beam and has no trigger to hold: it is a discrete, aimed,
  // launched thing with travel time, and the whole weapon is decided in the
  // instant the button goes down.
  //
  // It drills through every demon on the line without weakening — the tenth
  // takes what the first took — and it has no sideways reach at all. That second
  // clause is the one number to defend: the outermost thing the spell can touch
  // sits at sleeveRadius + a grunt's own girth = 1.17 m, which is measurably
  // NARROWER than the 1.35 m the grunts keep between each other (ENEMIES.grunt
  // .separationRadius). A dead-centre hit therefore *provably cannot* spill onto
  // the demon standing beside it. That inequality is what "zero area of effect"
  // means here, it is asserted in the tests, and no upgrade is allowed to touch
  // it — which is why sleeveRadius is the one radius radiusMult never scales.
  //
  // Two bands, and the pair is the readout. The braid is what you see; the axis
  // is what bites. A demon the axis runs through is in the core and every strand
  // sinks into it as its own separate hit — two fangs, two thuds, two markers a
  // frame apart — so a centred kill *sounds* different from a clipped one. A
  // demon the braid only brushes takes a single thin graze. Miss by more than a
  // body's width past that and it takes nothing whatsoever, at full price.
  // Nothing else in the book can spend a whole cast and deal literally zero;
  // that risk is what buys it the heaviest single chunk of damage in the book
  // outside the two ultimates.
  wyrmlance: {
    id: 'wyrmlance',
    name: 'Wyrmlance',
    icon: '\u{1F9EC}',        // the double helix itself
    type: 'helix',
    slot: 7,
    unlockedAtStart: false,

    damage: 48,               // PER STRAND. A centred pair lands 96 in one press.
    strandCount: 2,           // the pair *is* the spell
    strandDamageMult: 0.78,   // each fang thins as a strand is added to the braid
    grazeFrac: 0.34,          // a brush, as a share of the full pair's bite

    // 17 effective (CAST_MANA_SCALE halves it): five throws to a full well, and
    // 96/17 = 5.6 damage a point, which sits deliberately between Fireball's 5.0
    // and Lightning's 6.7. Careful with this number: once the spell stopped
    // being channelled its Auto-Weapon heft became the raw cost, and the reel's
    // ordering test wants it strictly between Lightning's 32.4 and Mega Blast's
    // 90, with half of it above Frost Nova's 30 and below Fireball's 15.
    manaCost: 34,
    cooldown: 0.85,           // 113 dps on a centred target; a deliberate rhythm

    boltSpeed: 50,            // 0.9 s to cross the arena — fast, but you must lead
    range: 45,                // reaches the far wall. No card ever extends it.
    lifeTime: 1.2,            // backstop only; the full run takes 0.9 s

    // The pair is a *rod*, not a point — this is how much of the braid is in
    // the air behind the head at once. At 50 m/s a 7 m rod persists for 0.14 s,
    // about eight frames, which is what stops the throw reading as a stub. It
    // costs nothing in damage terms: a demon inside the rod is already in the
    // `struck` set from the frame the head reached them.
    braidLength: 7,
    // Metres over which the two strands wind out of the palms and onto the
    // axis. Purely visual: the damage axis is the crosshair ray, which runs
    // near the mage's eyes rather than their hands, and this is what hides the
    // gap. Nothing is exempt from damage inside it.
    openDistance: 2.2,

    // The two damage bands. Resolved against the axis, never against the drawn
    // strands — see the geometry note in helixBolt.js for why an emergent
    // strand-hit would be phase-dependent and therefore unlearnable.
    coreRadius: 0.42,
    coreGirthFrac: 0.25,      // 0.42 + 0.55*0.25 = 0.5575 m: "if the line runs
                              // through the body, every fang lands"
    sleeveRadius: 0.62,       // NEVER scaled. 0.62 + 0.55 = 1.17 m < 1.35 m.

    // The braid as drawn. Its envelope (coilRadius + strandRadius = 0.52 m) sits
    // inside the core band, so a strand is never painted outside the volume that
    // deals full damage — the weapon cannot look wider than it hits.
    coilRadius: 0.34,
    strandRadius: 0.18,
    // REVOLUTIONS per metre — note the unit; the old channel's constant was
    // radians and the two are a silent 6.28x apart. A turn every 2.86 m puts
    // ~2.4 turns on the rod at once, and subtends about 47 px at the far wall;
    // tighten the pitch much past this and the spiral is mush at range however
    // "fast-oscillating" the brief says. The floor underneath it is
    // coilRadius x twist(rad) = 0.75, which must stay well above 0.4 or the
    // camera-facing ribbon collapses when the bolt flies away from you.
    twistTurns: 0.35,
    twistSpin: 8,             // rad/s of roll. The phase is rod-local (see
                              // effects.js), so this is the only rotation the eye
                              // sees and it cannot alias against the frame clock.

    castTrauma: 0.26,
    fovKick: 3.4,
    wallTrauma: 0.05,
    trailStep: 0.9,           // metres of travel per trail mote — distance-based,
                              // so the braid's density is the same at 30 and 144 fps
    color: 0x2fe08a,
    coreColor: 0xdcffe9,
  },
  // The mage's last resort. No mana, no ammo, no aiming — a wide, cheap sweep
  // of the staff that mirrors the grunt claw (short windup, one arc, a beat of
  // recovery). Deliberately feeble: it keeps a dry run alive, it never wins one.
  staff: {
    id: 'staff',
    name: 'Staff Strike',
    icon: '\u{1FA84}',
    type: 'melee',
    slot: 4,
    unlockedAtStart: true,
    damage: 14,
    manaCost: 0,          // the whole point — infinite
    cooldown: 0.5,
    windup: 0.11,         // damage lands mid-sweep, not on the button
    swingTime: 0.34,      // arm animation length
    range: 2.7,           // horizontal reach, measured like the grunt's claw
    arc: 2.0,             // radians of the sweep cone (~115 deg), centred on aim
    verticalReach: 1.2,   // a demon a real ledge below/above is out of reach
    color: 0xc9a6ff,
    coreColor: 0xf0e4ff,
  },
  // Onikiri, the demon-cutter. A katana left standing in the cathedral floor,
  // claimed by walking to it through the wave and carried on a clock. It shares
  // the staff's slot rather than taking one of its own — only one thing is ever
  // in the mage's hand — and while its binding holds it simply *is* the melee
  // weapon, on the same bind, at four times the bite. No upgrade card touches
  // it and it never survives into the next wave, so the mage's floor stays the
  // staff and a good run is never handed a permanent sword.
  katana: {
    id: 'katana',
    name: 'Onikiri',
    icon: '\u{1F5E1}\uFE0F',
    type: 'melee',
    slot: 4,              // the staff's slot: the blade replaces it, never joins it
    unlockedAtStart: false,
    damage: 52,
    manaCost: 0,
    cooldown: 0.26,       // roughly twice the staff's rhythm
    windup: 0.07,
    swingTime: 0.24,
    range: 3.5,
    arc: 1.55,            // ~89 deg: a cut that has to be aimed, not the staff's broom
    verticalReach: 1.4,
    // The binding. It starts short, every demon the steel fells feeds it, and
    // the ceiling means a perfect wave still ends with the blade going out.
    bindTime: 18,
    killBind: 1.2,
    maxBindTime: 26,
    warnTime: 5,          // the slot starts counting down out loud here
    // When a blade is offered at all (rolled once per wave, in main.js).
    minWave: 3,
    waveChance: 0.45,
    minWaveGap: 2,        // never two waves running
    minSpawnDist: 16,     // metres from the mage: claiming it is a trek
    color: 0xffe0c0,
    coreColor: 0xfff6ec,
    edgeColor: 0xff4a3a,  // the crimson the hamon throws on a cut
  },
};

// ---------- Auto Weapon ----------
// The reel. With it on, the mage stops choosing a slot and the book chooses for
// them: every shot is drawn afresh from whatever is unlocked, off cooldown, and
// payable, weighted hard toward the heaviest thing they own. Melee is never in
// the draw — the staff and Onikiri live on their own bind, and the dry-pool
// handover already covers the case where nothing else can be paid for.
export const AUTO = {
  // The floor between one auto shot and the next. A weapon's own cooldown is
  // what paces a mage who stays on one slot; rotating weapons steps around
  // every one of them at once, and without this the reel empties a full well in
  // three frames. Deliberately just under Fireball's own 0.5 s recovery, so a
  // mage who only owns Fireball is paced by the spell rather than by the mode.
  shotDelay: 0.45,
  // One "shot" of a held channel. A beam has no cast rhythm to count, so the
  // reel gives it a burst instead: long enough to read as its own turn, short
  // enough that Lightning doesn't quietly become the whole mode.
  channelBurst: 0.9,
  // How hard the draw leans on the heavy end. 1 would be strictly proportional
  // to price; above that the big spells crowd the small ones out of the hat
  // whenever they are affordable at all.
  heftPower: 1.8,
  // The weapon that just fired is not forbidden, only heavily out-weighted, so
  // "a different weapon every shot" is the rule and a repeat is what happens
  // when nothing else is ready.
  repeatPenalty: 0.15,
  // A full well spends like one. Above this share of the pool the reel stops
  // considering anything below `splurgeBand` of the heaviest weapon it could
  // actually pay for — this is what makes "enough mana" mean "the toughest
  // thing you own comes out".
  splurgeFrac: 0.7,
  splurgeBand: 0.5,
  // Headroom a draw has to leave behind, as a share of the cast's own price: a
  // storm must leave a real cushion, a fireball barely any. Scaled to the cast
  // rather than flat against the pool on purpose — a flat floor big enough to
  // matter for a storm would sit above the emergency trickle's ceiling
  // (PLAYER.manaReserve) and stall the reel outright the first time a run went
  // dry. The reel also never casts on credit, however deep the overdraft goes:
  // spending the well into arcane debt is the player's call, not the mode's.
  // Neither rule touches the trigger — they gate the draw, not the cast.
  costHeadroom: 0.25,
};

// How *heavy* a weapon reads to the reel. Every spell in this book states its
// own weight in the one unit they all share — what a cast costs — and the
// damage tracks the price by design: nothing here asks 120 mana without being
// the biggest thing in the book. A channelled spell is priced per second, so
// one shot of it is `channelBurst` seconds of channel.
//
// Measured off the *authored* price, never the upgraded one. A mage who takes a
// Meteor Storm discount has made the storm cheaper, not smaller, and the reel
// should still treat it as the heaviest thing they own.
export function autoHeft(id) {
  const base = SPELLS[id];
  if (!base || base.type === 'melee') return 0;
  return isChannelled(base.type) ? base.manaCost * AUTO.channelBurst : base.manaCost;
}

// Every weapon the reel is allowed to draw, heaviest first. Melee is excluded
// here rather than at each call site, so "the reel never swings the staff" is
// one rule in one place.
export function autoDrawable() {
  return Object.values(SPELLS)
    .filter((s) => s.type !== 'melee')
    .map((s) => s.id)
    .sort((a, b) => autoHeft(b) - autoHeft(a));
}

// Fresh runtime modifier state for one run.
export function createSpellState() {
  const state = {};
  for (const id of Object.keys(SPELLS)) {
    state[id] = {
      unlocked: SPELLS[id].unlockedAtStart,
      level: 0,
      damageMult: 1,
      manaCostMult: 1,
      radiusMult: 1,
      speedMult: 1,
      cooldownMult: 1,
      extraProjectiles: 0,
      extraChains: 0,
      extraMeteors: 0,
      slowFactorMult: 1,
      chargeTimeMult: 1,
      // synergy flags (set by upgrades)
      ignite: false,
      detonation: false,
      siphon: false,
      battery: false,
      tempest: false,
      shatter: false,
    };
  }
  return state;
}

// Effective, upgrade-adjusted stats for a spell.
export function effectiveStats(spellId, spellState) {
  const base = SPELLS[spellId];
  const mod = spellState[spellId];
  const stats = {
    ...base,
    damage: base.damage * mod.damageMult,
    // a free spell stays free: the floor only applies to spells that cost at all
    manaCost: base.manaCost === 0
      ? 0
      : Math.max(MANA_COST_FLOOR, Math.round(base.manaCost * mod.manaCostMult * CAST_MANA_SCALE)),
    cooldown: base.cooldown * mod.cooldownMult,
  };
  // Pool level below which the spell counts as unaffordable and the staff takes
  // over. One cast for everything discrete; see the beam branch for why a beam
  // needs more than one tick's worth.
  stats.castThreshold = stats.manaCost;
  if (base.type === 'projectile') {
    stats.projectileSpeed = base.projectileSpeed * mod.speedMult;
    stats.aoeRadius = base.aoeRadius * mod.radiusMult;
    stats.projectileCount = base.projectileCount + mod.extraProjectiles;
    if (stats.projectileCount > 1) stats.damage *= base.twinDamageMult;
  }
  if (isChannelled(base.type)) {
    // A channelled spell is *priced* per second and *spends* per tick. The flat
    // mana floor that keeps discrete casts honest would be absurd 20 times a
    // second, so these skip it and stay fractional.
    stats.tickInterval = stats.cooldown;
    stats.manaPerSecond = base.manaCost * mod.manaCostMult * CAST_MANA_SCALE;
    stats.manaCost = stats.manaPerSecond * stats.tickInterval;
    // A third of a second of fire: below that it would sputter one tick at a
    // time, which reads as a bug. It hands over to the staff instead.
    stats.castThreshold = stats.manaPerSecond / 3;
  }
  if (base.type === 'beam') {
    stats.chains = base.chains + mod.extraChains;
    // The leash is the weapon's identity, so radius upgrades widen the arc
    // splash rather than letting Lightning reach across the arena again.
    stats.splashRadius = base.splashRadius * mod.radiusMult;
    stats.chainRadius = base.chainRadius * mod.radiusMult;
    stats.tempestDamage = base.tempestDamage * mod.damageMult;
  }
  if (base.type === 'helix') {
    stats.boltSpeed = base.boltSpeed * mod.speedMult;
    // Widening Coil converts sleeve into core: the full-damage band and the
    // drawn braid grow together, and the corridor does not move a centimetre.
    // Capping the core at the sleeve is what stops a stacked run from inverting
    // the two bands.
    // Both radii are capped at the sleeve, and the drawn one is capped a strand's
    // thickness inside it — so however many Widening Coils a run stacks, the
    // braid is never painted outside the volume that actually deals damage. The
    // card caps at 2 stacks, so this only bites in theory; it is the invariant
    // the tests assert, and it should hold structurally rather than by luck.
    stats.coilRadius = Math.min(base.coilRadius * mod.radiusMult,
                                base.sleeveRadius - base.strandRadius * STRAND_WIDTH_PEAK);
    stats.coreRadius = Math.min(base.coreRadius * mod.radiusMult, base.sleeveRadius);
    stats.sleeveRadius = base.sleeveRadius; // never scaled — this IS "zero AoE"
    stats.strandCount = base.strandCount + mod.extraProjectiles;
    // Every extra fang thins all of them, so a third serpent is a real gain and
    // not a free 50%.
    stats.damage *= Math.pow(base.strandDamageMult, mod.extraProjectiles);
    stats.coreDamage = stats.damage * stats.strandCount;
    // A third of the pair's bite — but never more than one fang is worth. Without
    // the cap, Third Serpent's thinner-but-more-numerous fangs push the graze
    // (3 x 37.44 x 0.34 = 38.2) past a single strand (37.44), so brushing a
    // demon would beat clipping it with one strand of the braid.
    stats.grazeDamage = Math.min(stats.coreDamage * base.grazeFrac, stats.damage * 0.9);
    // The one scalar the FX reads, so "powered up" is a single dial: the braid
    // widens, thickens and brightens off the same card that raises the damage.
    stats.power01 = Math.min(1, Math.max(0, (mod.damageMult - 1) / 1.5));
  }
  if (base.type === 'melee') {
    stats.range = base.range * mod.radiusMult;
  }
  if (base.type === 'meteor') {
    // the circle and the rocks in it grow together: a wider storm with the same
    // blast size would spread the same damage thinner, which is a trap upgrade
    stats.stormRadius = base.stormRadius * mod.radiusMult;
    stats.bigAoe = base.bigAoe * mod.radiusMult;
    stats.smallAoe = base.smallAoe * mod.radiusMult;
    stats.meteorCount = base.meteorCount + mod.extraMeteors;
  }
  if (base.type === 'megablast') {
    stats.projectileSpeed = base.projectileSpeed * mod.speedMult;
    stats.aoeRadius = base.aoeRadius * mod.radiusMult;
    // A charge that could be shortened without limit would stop being the
    // spell's identity, so discounts converge on a floor instead of vanishing.
    stats.chargeTime = Math.max(MIN_CHARGE_TIME, base.chargeTime * mod.chargeTimeMult);
  }
  if (base.type === 'nova') {
    stats.novaRadius = base.novaRadius * mod.radiusMult;
    stats.slowFactor = Math.max(base.slowFactorFloor, base.slowFactor * mod.slowFactorMult);
    stats.slowDuration = base.slowDuration;
  }
  return stats;
}
