import * as THREE from 'three';
import { WAVE_RULES } from '../config/waveConfig.js';
import { waveScaling, ENEMIES } from '../config/enemyConfig.js';
import { Portal } from './portal.js';
import { Grunt } from '../enemies/grunt.js';
import { Flyer } from '../enemies/flyer.js';
import { horizontalDist, pick } from '../core/mathUtils.js';

// SpawnManager (PRD §22): portals at authored spawn points, initial burst up
// to the concurrency cap, then trickle batches until the wave quota is out.
export class SpawnManager {
  constructor(game, spawnPoints) {
    this.game = game;
    this.spawnPoints = spawnPoints;
    this.queue = [];        // enemy types waiting to enter
    this.tasks = [];        // { type, portal, timer, spawned }
    this.trickleT = 0;
    this.scaling = waveScaling(1);
    this.stagger = 0;
  }

  reset() {
    this.queue.length = 0;
    for (const t of this.tasks) {
      if (t.portal && !t.portal.done) t.portal.dispose();
    }
    this.tasks.length = 0;
  }

  beginWave(comp, wave) {
    this.scaling = waveScaling(wave);
    this.queue.length = 0;
    for (let i = 0; i < (comp.grunt ?? 0); i++) this.queue.push('grunt');
    for (let i = 0; i < (comp.flyer ?? 0); i++) this.queue.push('flyer');
    // shuffle so types interleave
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.trickleT = 0;
    this.stagger = 0;
    // initial burst
    const burst = Math.min(WAVE_RULES.maxConcurrentEnemies, this.queue.length);
    for (let i = 0; i < burst; i++) this._openPortal(this.queue.shift(), i * 0.28);
  }

  get pendingCount() {
    return this.queue.length + this.tasks.filter((t) => !t.spawned).length;
  }

  _pickPoint(type) {
    const player = this.game.player;
    const pts = type === 'flyer' ? this.spawnPoints.aerial : this.spawnPoints.ground;
    const usable = pts.filter((p) => {
      const v = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]);
      return horizontalDist(v, player.pos) > WAVE_RULES.minSpawnDistFromPlayer;
    });
    const chosen = usable.length > 0 ? pick(usable) : pts.reduce((a, b) => {
      const da = horizontalDist(new THREE.Vector3(...a.pos), player.pos);
      const db = horizontalDist(new THREE.Vector3(...b.pos), player.pos);
      return da > db ? a : b;
    });
    return new THREE.Vector3(chosen.pos[0], chosen.pos[1], chosen.pos[2]);
  }

  _openPortal(type, delay = 0) {
    const pos = this._pickPoint(type);
    this.tasks.push({
      type,
      pos,
      portal: null,
      timer: -delay,
      spawned: false,
    });
  }

  _spawnEnemy(type, pos) {
    const game = this.game;
    const cfg = ENEMIES[type];
    const spawnPos = pos.clone();
    if (type === 'flyer') spawnPos.y += 0.5;
    const enemy = type === 'flyer'
      ? new Flyer(game, cfg, this.scaling, spawnPos)
      : new Grunt(game, cfg, this.scaling, spawnPos);
    game.enemies.push(enemy);
    // emergence flash
    game.fx.impactPuff(enemy.center, 0xff4020);
  }

  update(dt) {
    const game = this.game;

    // advance portal tasks
    for (const t of this.tasks) {
      t.timer += dt;
      if (t.timer < 0) continue;
      if (!t.portal) t.portal = new Portal(game, t.pos, ENEMIES[t.type].id === 'flyer');
      if (!t.spawned && t.timer >= WAVE_RULES.portalEmergeDelay) {
        t.spawned = true;
        this._spawnEnemy(t.type, t.pos);
      }
      if (t.spawned && t.timer >= WAVE_RULES.portalEmergeDelay + WAVE_RULES.portalLingerTime) {
        t.portal.close();
      }
    }
    this.tasks = this.tasks.filter((t) => !(t.portal && t.portal.done));

    // trickle remaining quota while below the concurrency cap
    if (this.queue.length > 0) {
      this.trickleT += dt;
      const alive = game.enemies.filter((e) => e.alive).length +
        this.tasks.filter((t) => !t.spawned).length;
      if (this.trickleT >= WAVE_RULES.trickleInterval && alive < WAVE_RULES.maxConcurrentEnemies) {
        this.trickleT = 0;
        const n = Math.min(WAVE_RULES.trickleBatchSize, this.queue.length, WAVE_RULES.maxConcurrentEnemies - alive);
        for (let i = 0; i < n; i++) this._openPortal(this.queue.shift(), i * 0.25);
      }
    }
  }
}
