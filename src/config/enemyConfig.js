// Enemy archetype tunables (PRD §19-§21).
export const ENEMIES = {
  grunt: {
    id: 'grunt',
    name: 'Demon Grunt',
    hp: 60,
    speed: 5.1,
    attackDamage: 12,
    attackRange: 2.0,
    attackHitRange: 2.6,   // still-hits range checked at the end of the windup
    // How far the player's feet may sit above or below the grunt's own and
    // still be clawed. Kept just under two authored stair steps (2 x 0.36) so
    // melee works along a staircase, while a real ledge — a column stub, a
    // platform, the tier of the dais the grunt has not climbed — puts the mage
    // out of reach instead of letting claws pass through the stone.
    attackVerticalReach: 0.9,
    attackReachSlack: 0.35, // follow-through allowance re-checked at strike time
    attackCooldown: 1.2,
    attackWindup: 0.45,
    radius: 0.55,
    height: 1.9,
    stepHeight: 0.5,
    gravity: 24,
    terminalFall: 30,
    manaDropChance: 0.9,
    manaReward: [16, 24],
    healthDropChance: 0.08,
    healthReward: 20,
    repathInterval: 0.55,
    separationRadius: 1.35,
  },
  flyer: {
    id: 'flyer',
    name: 'Flying Demon',
    hp: 35,
    speed: 7.0,
    accel: 9,
    attackDamage: 9,
    projectileSpeed: 17,
    projectileRadius: 0.28,
    attackCooldown: 2.3,
    attackWindup: 0.4,
    preferredRangeMin: 9,
    preferredRangeMax: 17,
    altitudeAbovePlayer: [2.5, 6.5],
    strafeFlipInterval: [2.2, 4.5],
    radius: 0.55,
    height: 1.2,
    wallPadding: 1.5,   // steer-away margin from the arena bounds
    manaDropChance: 0.78,
    manaReward: [20, 30],
    healthDropChance: 0.1,
    healthReward: 20,
  },
};

// Per-wave scaling multipliers (PRD §24: moderate scaling, prefer count/composition).
export function waveScaling(wave) {
  return {
    hpMult: 1 + 0.10 * (wave - 1),
    damageMult: 1 + 0.06 * (wave - 1),
    aggroMult: Math.max(0.55, 1 - 0.035 * (wave - 1)), // multiplies attack cooldowns
    speedMult: Math.min(1.25, 1 + 0.012 * (wave - 1)),
  };
}
