import { waveComposition } from '../config/waveConfig.js';

// WaveManager (PRD §23): composition, kill tracking, completion detection.
export class WaveManager {
  constructor(game, spawner) {
    this.game = game;
    this.spawner = spawner;
    this.wave = 0;
    this.totalToKill = 0;
    this.killed = 0;
    this.active = false;
  }

  reset() {
    this.wave = 0;
    this.totalToKill = 0;
    this.killed = 0;
    this.active = false;
    this.spawner.reset();
  }

  startWave(n) {
    this.wave = n;
    const comp = waveComposition(n);
    this.totalToKill = (comp.grunt ?? 0) + (comp.flyer ?? 0);
    this.killed = 0;
    this.active = true;
    this._comp = comp;
  }

  // called when the PREP phase ends and combat actually begins
  releaseEnemies() {
    this.spawner.beginWave(this._comp, this.wave);
  }

  get remaining() {
    return Math.max(0, this.totalToKill - this.killed);
  }

  onEnemyKilled() {
    if (!this.active) return;
    this.killed++;
    if (this.killed >= this.totalToKill) {
      this.active = false;
      this.game.onWaveComplete();
    }
  }
}
