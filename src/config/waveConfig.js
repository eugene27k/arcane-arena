// Wave composition (PRD §23). Waves 1-5 authored, then algorithmic scaling.
const AUTHORED_WAVES = [
  { grunt: 3, flyer: 0 },
  { grunt: 5, flyer: 0 },
  { grunt: 5, flyer: 1 },
  { grunt: 7, flyer: 2 },
  { grunt: 8, flyer: 3 },
];

export const WAVE_RULES = {
  maxConcurrentEnemies: 11,
  trickleBatchSize: 3,
  trickleInterval: 3.5,
  prepTime: 3.0,          // seconds of "Prepare" phase before spawning starts
  portalEmergeDelay: 0.85, // portal opens -> enemy appears
  portalLingerTime: 1.1,   // after emergence before the portal closes
  minSpawnDistFromPlayer: 9,
};

export function waveComposition(wave) {
  if (wave <= AUTHORED_WAVES.length) return { ...AUTHORED_WAVES[wave - 1] };
  const over = wave - AUTHORED_WAVES.length;
  return {
    grunt: Math.min(16, 8 + Math.round(over * 1.5)),
    flyer: Math.min(9, 3 + Math.round(over * 0.8)),
  };
}
