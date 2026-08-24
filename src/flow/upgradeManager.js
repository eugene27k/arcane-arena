import { UPGRADES, UPGRADE_RULES } from '../config/upgradeConfig.js';

// UpgradeManager (PRD §13-§14): rolls ~3 weighted options per cleared wave,
// applies picks, tracks stacks.
export class UpgradeManager {
  constructor(game) {
    this.game = game;
    this.stacks = new Map();
  }

  reset() {
    this.stacks.clear();
  }

  _ctx() {
    return {
      spellState: this.game.caster.spellState,
      player: this.game.player,
      stacks: this.stacks,
      wave: this.game.waves.wave,
    };
  }

  roll() {
    const ctx = this._ctx();
    const pool = UPGRADES.filter((u) => {
      const s = this.stacks.get(u.id) ?? 0;
      if (u.maxStacks && s >= u.maxStacks) return false;
      if (u.id === 'unlock_lightning' && !u.available(ctx)) return false;
      return u.available(ctx);
    });

    const options = [];
    // Guarantee the Lightning unlock shows up while it's locked.
    if (UPGRADE_RULES.forceLightningOfferWhileLocked) {
      const unlock = pool.find((u) => u.id === 'unlock_lightning');
      if (unlock) options.push(unlock);
    }

    const rest = pool.filter((u) => !options.includes(u));
    while (options.length < UPGRADE_RULES.optionsPerScreen && rest.length > 0) {
      const totalW = rest.reduce((s, u) => s + u.weight, 0);
      let r = Math.random() * totalW;
      let idx = 0;
      for (; idx < rest.length; idx++) {
        r -= rest[idx].weight;
        if (r <= 0) break;
      }
      options.push(rest.splice(Math.min(idx, rest.length - 1), 1)[0]);
    }
    return options;
  }

  apply(id) {
    const u = UPGRADES.find((x) => x.id === id);
    if (!u) return;
    u.apply(this._ctx());
    this.stacks.set(id, (this.stacks.get(id) ?? 0) + 1);
  }
}
