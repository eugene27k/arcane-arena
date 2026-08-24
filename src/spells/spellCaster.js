import * as THREE from 'three';
import { SPELLS, AUTO, autoDrawable, autoHeft, createSpellState, effectiveStats, isChannelled } from '../config/spellConfig.js';
import { GOD } from '../config/playerConfig.js';
import { clamp, randRange, pick } from '../core/mathUtils.js';
import { Projectile } from './projectile.js';
import { HelixBolt } from './helixBolt.js';

const DOWN = new THREE.Vector3(0, -1, 0); // meteors fall straight, so impacts are predictable

// Scratch for the Wyrmlance throw. One cast a second at most, but the aim is
// taken from a two-hand midpoint and normalised in place either way.
const _helixDir = new THREE.Vector3();
const _helixOrigin = new THREE.Vector3();

// SpellCaster (PRD §40): owns spell state, cooldowns, selection, and cast
// dispatch. Data-driven — spells resolve behaviour by `type`.
export class SpellCaster {
  constructor(game) {
    this.game = game;
    this.spellState = createSpellState();
    this.cooldowns = {};      // id -> remaining seconds
    this.selected = 'fireball';
    this.swingT = 0;          // remaining windup of a staff swing in flight
    this.swingStats = null;
    this.pendingMeteors = []; // rocks of a storm still queued in the sky
    this.firing = false;      // cast button held this frame (set by the game loop)
    this.beam = null;         // live beam state while a beam spell is firing
    this.overchargeT = 0;     // Arc Battery: seconds of boosted beam damage left
    this.charge = null;       // Mega Blast gathering in the hands (see _updateCharge)
    this._staffHinted = false;
    this.bladeT = 0;          // seconds left on Onikiri's binding (0 = the staff is in hand)
    this._bladeWarned = false;
    this.godMode = false;     // GODMODE cheat: whole book unlocked, cast for free
    this.auto = false;        // Auto Weapon: the reel draws the next spell itself
    this._autoLast = null;    // what it drew last, so the next draw can avoid it
    this._autoGapT = 0;       // seconds until the reel may draw again (its cadence)
  }

  reset() {
    this.spellState = createSpellState();
    this.cooldowns = {};
    this.selected = 'fireball';
    this.swingT = 0;
    this.swingStats = null;
    this.clearPending();
    this.firing = false;
    this.stopBeam();
    this.cancelCharge();
    this._staffHinted = false;
    this.bladeT = 0;
    this._bladeWarned = false;
    // `auto` deliberately survives: the reel is a play-style preference, not run
    // state — only its memory of the last draw is wiped with everything else.
    this._autoLast = null;
    this._autoGapT = 0;
    if (this.godMode) this.applyGodMode(); // survives the wipe: it's irreversible
    this._syncMelee();
  }

  // GODMODE: the whole book, no mana, shorter recovery. One-way — there is no
  // counterpart that puts the spells back behind their unlocks.
  applyGodMode() {
    this.godMode = true;
    for (const id of Object.keys(SPELLS)) this.spellState[id].unlocked = true;
    this.cooldowns = {};
    this.bladeT = Infinity;   // "infinite weapons" includes the one that runs out
    this._syncMelee();
  }

  get selectedSpell() { return SPELLS[this.selected]; }

  // ---------- Onikiri: which blade is in the hand ----------
  // Slot 4 holds exactly one melee weapon: the staff by default, the katana
  // while its binding lasts. Everything that walks the book — slot select,
  // wheel cycling, the HUD — asks here instead of assuming the staff.
  get meleeId() { return this.spellState.katana.unlocked ? 'katana' : 'staff'; }

  // Is this spell the one its slot is currently showing? Only ever false for
  // the melee weapon that isn't in hand.
  inBook(spell) { return spell.type !== 'melee' || spell.id === this.meleeId; }

  // Put the right weapon in the model's hand. Pushed on change rather than
  // polled per frame, so the mesh can never disagree with `meleeId`.
  _syncMelee() { this.game.player.setMelee(this.meleeId); }

  // Claimed from the stone. Refreshes rather than stacks, and can only ever be
  // extended — a second blade found under god mode can't shorten an endless one.
  takeBlade() {
    const cfg = SPELLS.katana;
    const first = !this.spellState.katana.unlocked;
    this.spellState.katana.unlocked = true;
    this.bladeT = Math.max(this.bladeT, cfg.bindTime);
    this._bladeWarned = false;
    if (first && this.selected === 'staff') this.selected = 'katana';
    const game = this.game;
    game.fx.bladeClaim(game.player.center, cfg.edgeColor);
    game.audio.play('bladeClaim');
    game.hud.banner('ONIKIRI');
    game.hud.toast(`${cfg.icon} Onikiri answers — ${Math.round(cfg.bindTime)}s of steel (RMB / V)`);
    game.cameraRig.addTrauma(0.2);
    this._syncMelee();
  }

  // Every demon the steel fells feeds the binding, so wading in keeps the blade
  // alive and whiffing starves it. The ceiling is what stops a good wave from
  // compounding into a permanent sword — it always goes out eventually.
  feedBlade(kills) {
    if (kills <= 0 || this.bladeT <= 0) return;
    const cfg = SPELLS.katana;
    this.bladeT = Math.min(cfg.maxBindTime, this.bladeT + cfg.killBind * kills);
    if (this.bladeT > cfg.warnTime) this._bladeWarned = false;
  }

  // The binding lapses — on its own clock, or because a new wave began. God
  // mode is the one hand it is never taken out of.
  dropBlade(quiet = false) {
    if (this.godMode || !this.spellState.katana.unlocked) return;
    this.spellState.katana.unlocked = false;
    this.bladeT = 0;
    this._bladeWarned = false;
    this.cooldowns.katana = 0;
    if (this.selected === 'katana') this.selected = 'staff';
    this._syncMelee();
    if (quiet) return;
    const game = this.game;
    game.fx.bladeLapse(game.player.center, SPELLS.katana.edgeColor);
    game.audio.play('bladeLapse');
    game.hud.toast(`${SPELLS.staff.icon} The binding fails — Onikiri is gone`);
  }

  _updateBlade(dt) {
    const cfg = SPELLS.katana;
    this.bladeT -= dt;
    if (this.bladeT <= 0) { this.dropBlade(); return; }
    if (!this._bladeWarned && this.bladeT <= cfg.warnTime) {
      this._bladeWarned = true;
      this.game.hud.toast(`${cfg.icon} Onikiri is failing — ${Math.round(cfg.warnTime)}s`);
      this.game.audio.play('bladeLapse');
    }
  }

  // Can the pool pay for this cast at all? An overdraft spell is affordable
  // down to the debt floor, everything else only down to empty. The measure is
  // castThreshold, not manaCost: for a discrete spell those are the same
  // number, but a beam that can only pay for two more of its 50 ms ticks is
  // dry, not affordable — and the staff has to be what the trigger does next.
  canAfford(stats) {
    if (this.godMode) return true;
    const player = this.game.player;
    const floor = stats.overdraft ? player.manaFloor : 0;
    return player.mana - stats.castThreshold >= floor;
  }

  // True while the selected spell is unaffordable and the staff is what the
  // cast button will actually swing. The HUD reads this to show the handover.
  get meleeFallbackActive() {
    const spell = SPELLS[this.selected];
    if (!spell || spell.type === 'melee') return false;
    if (!this.isUnlocked(this.meleeId)) return false;
    // already channelling: nothing to hand over
    if (this.beamActive) return false;
    return !this.canAfford(this.stats(this.selected));
  }

  // Rocks queued but not yet summoned. Dropped when a run resets or a new wave
  // begins, so a storm cast on the last demon can't rain into the next wave.
  clearPending() {
    this.pendingMeteors.length = 0;
  }

  isUnlocked(id) { return this.spellState[id]?.unlocked; }

  stats(id) {
    const s = effectiveStats(id, this.spellState);
    if (this.godMode) {
      s.manaCost = 0;
      s.manaPerSecond = 0;
      s.castThreshold = 0;
      // A channelled spell has no cast rhythm to shorten — its tick rate *is*
      // the weapon, and the god-mode floor is slower than the stock cadence.
      if (isChannelled(s.type)) s.refireDelay = 0;
      else s.cooldown = Math.max(GOD.minCooldown, s.cooldown * GOD.cooldownMult);
    }
    return s;
  }

  // `silent` is for the Auto Weapon reel, which changes the slot several times a
  // wave: the switch blip is a player-action sound, and firing it on every draw
  // would turn the mode into a metronome.
  select(id, silent = false) {
    if (!SPELLS[id] || !this.isUnlocked(id)) return false;
    if (this.selected === id) return true;
    // A gather in progress owns the slot: the mana is already spent, so letting
    // a stray scroll of the wheel throw it away would be a pure loss.
    if (this.charging) {
      if (!silent) this.game.hud.toast(`${SPELLS.megablast.icon} The blast is already gathering`);
      return false;
    }
    this.stopBeam(); // a beam can't outlive the slot it belongs to
    this.selected = id;
    if (!silent) this.game.audio.play('spellSwitch');
    return true;
  }

  selectSlot(slotNum) {
    const spell = Object.values(SPELLS).find((s) => s.slot === slotNum && this.inBook(s));
    if (spell) return this.select(spell.id);
    return false;
  }

  // Returns whether the wheel actually moved the slot, the way select() does —
  // Auto Weapon reads it to tell a real manual pick from a refused one.
  cycle(dirSign) {
    const unlocked = Object.values(SPELLS)
      .filter((s) => this.isUnlocked(s.id) && this.inBook(s))
      .sort((a, b) => a.slot - b.slot);
    if (unlocked.length < 2) return false;
    const idx = unlocked.findIndex((s) => s.id === this.selected);
    const next = unlocked[(idx + dirSign + unlocked.length) % unlocked.length];
    return this.select(next.id);
  }

  update(dt) {
    for (const id of Object.keys(this.cooldowns)) {
      this.cooldowns[id] = Math.max(0, this.cooldowns[id] - dt);
    }
    // The reel runs after recovery ticks down, so a weapon that came off
    // cooldown this frame is drawable this frame, and before the channels below
    // read `selected`, so a draw takes effect on the frame it happened.
    if (this.auto) this._updateAuto(dt);
    if (this.pendingMeteors.length > 0) this._updateStorm(dt);
    if (this.bladeT > 0) this._updateBlade(dt);
    if (this.charge) this._updateCharge(dt);
    this._updateBeam(dt);
    // a staff swing lands partway through its animation, like the grunt's claw
    if (this.swingT > 0) {
      this.swingT -= dt;
      if (this.swingT <= 0) {
        const stats = this.swingStats;
        this.swingStats = null;
        this._resolveSwing(stats);
      }
    }
  }

  cooldownFrac(id) {
    const cd = this.cooldowns[id] ?? 0;
    const stats = this.stats(id);
    // A beam's `cooldown` is its 50 ms tick; what the slot should be sweeping
    // out is the recovery after the beam drops.
    const total = isChannelled(stats.type) ? stats.refireDelay : stats.cooldown;
    return total > 0 ? Math.min(1, cd / total) : 0;
  }

  // ---------- Auto Weapon (the reel) ----------
  // With the reel on, the cast button stops meaning "fire the slot I picked" and
  // starts meaning "fire whatever the book has ready". Every shot is drawn
  // afresh, weighted hard toward the heaviest weapon the well can pay for, so a
  // full pool spends itself on storms and blasts and a thin one falls back to
  // fireballs — without the player ever touching a number key.
  //
  // Melee is never drawn. The staff and Onikiri already have their own bind and
  // their own job: RMB / V swings them whatever the reel is holding, and the
  // dry-pool handover in tryCast() still puts them in the cast button's hands
  // the moment nothing in the book can be paid for. See AUTO in spellConfig.js.

  setAuto(on) {
    const next = !!on;
    if (next === this.auto) return this.auto;
    this.auto = next;
    this._autoLast = null;
    this._autoGapT = 0;   // flipping it on shouldn't cost the mage half a second
    return this.auto;
  }

  toggleAuto() { return this.setAuto(!this.auto); }

  // Whichever channel is live right now, if any. They are mutually exclusive —
  // both read `selected`, and only one spell is selected — so this is the one
  // "am I mid-channel, and for how long" question the reel has to ask.
  get activeChannel() { return this.beam; }

  // Can the reel fire this weapon *right now*? Unlocked, not melee, off
  // cooldown, and payable without dipping into the reserve.
  _autoReady(id) {
    const spell = SPELLS[id];
    if (!spell || spell.type === 'melee') return false;
    if (!this.isUnlocked(id)) return false;
    if ((this.cooldowns[id] ?? 0) > 0) return false;
    return this._autoAffordable(this.stats(id));
  }

  // What one auto shot of a weapon actually costs the well. A discrete spell
  // costs its cast; a channel costs the burst the reel is committing to, which
  // is the same measure autoHeft() ranks it by.
  //
  // Pricing a channel at its castThreshold instead — a third of a second of
  // fire, cheaper than a fireball — is the trap: the reel would open a beam on
  // almost nothing, the beam would drain the pool straight back under every
  // discrete weapon's floor, and the only thing affordable at the bottom would
  // be the beam again. One weapon for the rest of the run, which is the one
  // thing this mode promises never to do.
  _autoShotCost(stats) {
    return isChannelled(stats.type) ? stats.manaPerSecond * AUTO.channelBurst : stats.castThreshold;
  }

  // Stricter than canAfford(). The reel never casts on credit — the overdraft is
  // the player's call, not the mode's — and it leaves headroom behind, scaled to
  // what the shot itself costs. See AUTO.costHeadroom for why that scales rather
  // than sitting flat against the pool. Neither rule touches the trigger: they
  // gate the draw, not the cast, so a channel already burning stays lit on its
  // own hysteresis long after the reel would refuse to re-open it.
  _autoAffordable(stats) {
    if (this.godMode) return true;
    return this.game.player.mana >= this._autoShotCost(stats) * (1 + AUTO.costHeadroom);
  }

  // Where the reel rests when the book has nothing ready: the lightest weapon
  // the mage owns that cannot cast on credit. Leaving the last draw loaded
  // instead would strand the slot — and Meteor Storm, the one spell that answers
  // an empty well by borrowing against it, would eventually go off on the reel's
  // initiative rather than the player's, with the melee handover never reached
  // because canAfford() says a storm on credit is affordable. Parked on the
  // lightest, a dry trigger either fires the first thing the well can pay for or
  // hands over to the staff, exactly as it does without the mode.
  _autoPark() {
    const held = SPELLS[this.selected];
    if (held && held.type !== 'melee' && !held.overdraft && this.isUnlocked(this.selected)) return;
    const book = autoDrawable().filter((id) => this.isUnlocked(id) && !SPELLS[id].overdraft);
    const lightest = book[book.length - 1];   // autoDrawable() runs heaviest first
    if (lightest) this.select(lightest, true);
  }

  // Draw the next weapon, or null when the book has nothing ready. Every ready
  // weapon goes in the hat; the heavy ones fill more of it, the one that just
  // fired fills almost none, and at a full well the cheap end is left out
  // altogether. `rand` is injectable so the draw can be tested.
  autoDraw(rand = Math.random) {
    const ready = autoDrawable().filter((id) => this._autoReady(id));
    if (ready.length === 0) return null;
    if (ready.length === 1) return ready[0];

    // A full well spends like one. This is the half of the mode that says "if
    // there is enough mana, the toughest weapon you own comes out": above the
    // splurge mark the reel simply stops looking at the cheap end.
    const player = this.game.player;
    const rich = player.maxMana > 0 && player.mana / player.maxMana >= AUTO.splurgeFrac;
    const top = autoHeft(ready[0]); // autoDrawable() is sorted heaviest first
    let pool = ready;
    if (rich) {
      pool = ready.filter((id) => autoHeft(id) >= top * AUTO.splurgeBand);
      // The reel is a rotation as much as a ranking. Trimming the hat down to a
      // single weapon would just be a slot lock with extra steps, so the heavy
      // end never narrows past the two heaviest things the mage can pay for.
      if (pool.length < 2) pool = ready.slice(0, 2);
    }

    let total = 0;
    const weights = pool.map((id) => {
      let w = Math.pow(autoHeft(id), AUTO.heftPower);
      if (id === this._autoLast) w *= AUTO.repeatPenalty;
      total += w;
      return w;
    });
    if (!(total > 0)) return pool[0];
    let roll = rand() * total;
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  // One turn of the reel, called every frame while the mode is on. It only
  // *changes* the slot — firing it is still the cast button's job, so the reel
  // spinning on its own never costs a mage a drop of mana.
  _updateAuto(dt, rand = Math.random) {
    // The cadence runs down first, and unconditionally: it measures real time
    // since the last draw, not time the reel spent looking for one.
    this._autoGapT = Math.max(0, this._autoGapT - dt);

    // A gather owns the slot until it throws: the mana is already spent, and
    // select() refuses mid-charge anyway.
    if (this.charging) return;

    const channel = this.activeChannel;
    if (channel) {
      // A held channel has no cast rhythm to count shots with, so the reel gives
      // it a burst instead and spins on when that runs out. Without this the
      // beam would simply never let go of the trigger.
      if (channel.t < AUTO.channelBurst) return;
    } else if (this._autoReady(this.selected)) {
      // What is loaded can still fire: this *is* the next shot, leave it alone.
      // (A discrete spell fails this the instant it goes on cooldown, which is
      // what makes every shot a fresh draw.)
      return;
    }

    // Every weapon still respects its own recovery, but rotating between them
    // steps around all of them at once — so the reel keeps a cadence of its own.
    // Without it the mage fires a different spell on every single frame.
    if (this._autoGapT > 0) return;

    const next = this.autoDraw(rand);
    if (!next) {
      // Nothing is ready. A channel that has outlived its burst keeps burning
      // rather than dropping into silence — spinning onto nothing would only
      // cost the mage damage. Otherwise the reel falls back to its resting slot.
      if (!channel) this._autoPark();
      return;
    }
    this.select(next, true);
    this._autoLast = next;
    this._autoGapT = AUTO.shotDelay;
  }

  tryCast() {
    const game = this.game;
    const player = game.player;
    if (!player.alive) return false;
    // Already gathering: the cast button can't start a second one, but it is
    // never dead weight either — it swings the staff, same as a dry pool does.
    if (this.charging) return this.tryMelee();
    const id = this.selected;
    if (!this.isUnlocked(id)) return false;

    const stats = this.stats(id);
    if (stats.type === 'melee') return this.tryMelee();

    // A live beam owns the trigger. It sustains below the level a fresh strike
    // needs (see the hysteresis in _updateBeam), so the dry-pool handover below
    // must not swing the melee weapon underneath a beam that is still burning.
    if (stats.type === 'beam' && this.beamActive) return true;

    // Dry pool: the staff comes out on its own, so the cast button is never
    // dead weight. Checked ahead of the cooldown — with no mana, the gaps
    // between recharging casts are exactly when the staff has to cover.
    if (!this.canAfford(stats)) {
      if (this.tryMelee()) {
        if (!this._staffHinted) {
          this._staffHinted = true;
          const melee = SPELLS[this.meleeId];
          game.hud.toast(`${melee.icon} Out of mana — ${melee.name} (RMB / V)`);
        }
        return true;
      }
      player.trySpendMana(stats.castThreshold); // no staff either: the usual refusal
      return false;
    }

    // A beam has no per-cast rhythm: it lives in _updateBeam(), driven by the
    // held button. Everything above still applies — the staff still covers a
    // dry pool — there is simply nothing to fire here.
    if (stats.type === 'beam') return this.beamActive;

    if ((this.cooldowns[id] ?? 0) > 0) return false;
    const wasInDebt = player.inManaDebt;
    if (!player.trySpendMana(stats.manaCost, !!stats.overdraft)) return false;
    if (player.inManaDebt && !wasInDebt) this._onOverdrawn();
    this.cooldowns[id] = stats.cooldown;

    game.cameraRig.fovKick = 2.2;

    // A nova is self-centered: skip the aim ray entirely, cast level.
    if (stats.type === 'nova') {
      player.triggerCastAnim(0);
      this._castNova(stats);
      return true;
    }

    // A storm is called down on the ground around the mage — also unaimed,
    // but with the arms thrown up at the sky rather than out at the crosshair.
    if (stats.type === 'meteor') {
      player.triggerCastAnim(-1.15);
      this._castMeteorStorm(stats);
      return true;
    }

    // Wyrmlance is thrown like a fireball and aimed like one — the difference
    // is all downstream, in what the thing it launches does on the way.
    if (stats.type === 'helix') {
      const aim = game.cameraRig.getAimPoint();
      player.triggerCastAnim(Math.asin(-aim.dir.y));
      this._castHelix(stats, aim);
      return true;
    }

    // Mega Blast doesn't fire from here — it starts gathering, and
    // _updateCharge() throws it five seconds later.
    if (stats.type === 'megablast') {
      // Recovery is measured from the boom, not from the button: the charge is
      // already five seconds of casting nothing else.
      this.cooldowns[id] = stats.chargeTime + stats.cooldown;
      this._beginCharge(stats);
      return true;
    }

    const aim = game.cameraRig.getAimPoint();
    player.triggerCastAnim(Math.asin(-aim.dir.y));
    this._castProjectile(stats, aim);
    return true;
  }

  // ---------- Melee: Staff Strike, or Onikiri while its binding holds ----------
  // Always available, whatever slot is selected: RMB / V, or automatically
  // when a cast is refused for mana. Which weapon answers is `meleeId`.
  tryMelee() {
    const game = this.game;
    if (!game.player.alive) return false;
    const id = this.meleeId;
    if (!this.isUnlocked(id)) return false;
    if ((this.cooldowns[id] ?? 0) > 0 || this.swingT > 0) return false;

    const stats = this.stats(id);
    this.cooldowns[id] = stats.cooldown;
    this.swingStats = stats;
    this.swingT = stats.windup;
    game.player.triggerSwingAnim(stats.swingTime);
    game.audio.play(id === 'katana' ? 'bladeSwing' : 'staffSwing');
    return true;
  }

  // The sweep itself, resolved at the end of the windup. Reach is measured the
  // way the grunt measures its claw — horizontal distance, a vertical band tied
  // to footing, and clear stone between the bodies — so neither side can hit
  // through a stair riser or up onto a ledge it hasn't climbed.
  _resolveSwing(stats) {
    const game = this.game;
    const player = game.player;
    const yaw = game.cameraRig.yaw;
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
    const origin = player.center;
    const halfArc = stats.arc * 0.5;

    let hits = 0, kills = 0;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
      const dh = Math.hypot(dx, dz);
      if (dh > stats.range + e.cfg.radius) continue;
      if (Math.abs(e.pos.y - player.pos.y) > stats.verticalReach) continue;
      // inside the cone — widened by the demon's own girth, so a body clipping
      // the edge of the arc still eats it (same allowance as lightning's assist)
      if (dh > 0.15) {
        const angle = Math.acos(Math.min(1, Math.max(-1, (dx * fwdX + dz * fwdZ) / dh)));
        if (angle - Math.atan2(e.cfg.radius, dh) > halfArc) continue;
      }
      if (!game.world.lineOfSight(origin, e.center)) continue;
      e.takeDamage(stats.damage, player.pos, stats.id);
      hits++;
      if (!e.alive) kills++;
    }

    const blade = stats.id === 'katana';
    if (blade) game.fx.bladeSweep(origin, yaw, stats.range, stats.arc, stats.color, stats.edgeColor);
    else game.fx.staffSweep(origin, yaw, stats.range, stats.arc, stats.color);
    if (hits > 0) {
      game.hud.hitmarker(kills > 0);
      game.audio.play(blade ? 'bladeHit' : 'staffHit');
      game.cameraRig.addTrauma(blade ? 0.14 : 0.09);
    }
    // the steel drinks: kills push the binding back out, up to its ceiling
    if (blade) this.feedBlade(kills);
  }

  _castProjectile(stats, aim) {
    const game = this.game;
    const origin = game.player.handWorldPos(1);
    const count = stats.projectileCount;
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3().subVectors(aim.point, origin).normalize();
      if (count > 1) {
        // horizontal fan spread
        const off = (i - (count - 1) / 2) * stats.spreadAngle;
        const cos = Math.cos(off), sin = Math.sin(off);
        const nx = dir.x * cos - dir.z * sin;
        const nz = dir.x * sin + dir.z * cos;
        dir.x = nx; dir.z = nz;
      }
      game.projectiles.push(new Projectile(game, {
        pos: origin.clone().addScaledVector(dir, 0.4),
        dir,
        speed: stats.projectileSpeed,
        radius: stats.projectileRadius,
        damage: stats.damage,
        aoeRadius: stats.aoeRadius,
        life: stats.lifeTime,
        color: stats.color,
        coreColor: stats.coreColor,
      }));
    }
    game.fx.muzzleFlash(origin, stats.color);
    game.audio.play('fireballCast');
  }

  // Frost Nova: instant burst around the player. Damage is the small half — the
  // slow it leaves on everything it touches is the point.
  _castNova(stats) {
    const game = this.game;
    const center = game.player.center;
    let hits = 0, kills = 0;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      if (e.center.distanceTo(center) > stats.novaRadius + e.cfg.radius) continue;
      e.takeDamage(stats.damage, center, 'frostnova');
      hits++;
      // chill survivors only — and after the hit, so the nova never Shatters itself
      if (e.alive) e.applySlow(stats.slowFactor, stats.slowDuration);
      else kills++;
    }
    if (hits > 0) game.hud.hitmarker(kills > 0);

    game.fx.frostNova(center, stats.novaRadius);
    game.audio.play('frostCast');
    game.cameraRig.addTrauma(0.15);
  }

  // ---------- Meteor Storm ----------
  // The overdraft tell. Cheap to miss in the middle of a barrage, so it says so
  // out loud: nothing else in the book casts until the well is back above zero.
  _onOverdrawn() {
    const game = this.game;
    game.hud.toast('\u{1F311} Arcane debt — no spell but the staff until the well refills');
    game.audio.play('manaDebt');
  }

  // A ring of sky torn open around the mage: rocks are scheduled now, one by
  // one, and summoned over the next couple of seconds by _updateStorm().
  // The circle is pinned where it was cast — walk out of it and it stays put.
  _castMeteorStorm(stats) {
    const game = this.game;
    const center = game.player.pos.clone();
    const count = Math.max(1, Math.round(stats.meteorCount));
    const bigs = Math.max(1, Math.round(count * stats.bigFraction));

    for (let i = 0; i < count; i++) {
      // bigs spread evenly through the barrage rather than arriving in a lump
      const big = Math.floor((i * bigs) / count) < Math.floor(((i + 1) * bigs) / count);
      const impact = this._pickImpact(stats, center);
      if (!impact) continue; // nothing but abyss under that column — skip the rock
      this.pendingMeteors.push({
        t: (i / count) * stats.duration + randRange(0, (stats.duration / count) * 0.7),
        big,
        pos: impact,
        stats,
      });
    }

    game.fx.meteorSummon(center, stats.stormRadius);
    game.audio.play('meteorCast');
    game.cameraRig.addTrauma(0.28);
  }

  // Where one rock lands: mostly steered onto a demon standing in the circle,
  // otherwise anywhere in it. Returns the point on the stone, or null if the
  // column is open air (the pit breaches, a ledge overhanging the abyss).
  //
  // A rock falls straight down, so whatever roofs the column catches it. The
  // storm re-aims away from those columns — a bridge or the top of the outer
  // wall shouldn't eat half a barrage — but if every attempt comes back roofed
  // the last one is used anyway: casting from under the bridge hits the bridge,
  // which is honest, rather than costing 60 mana for no rocks at all.
  _pickImpact(stats, center) {
    const game = this.game;
    const inner = stats.stormInnerRadius;
    const outer = stats.stormRadius;
    const targets = game.enemies.filter((e) => {
      if (!e.alive) return false;
      const d = Math.hypot(e.pos.x - center.x, e.pos.z - center.z);
      return d <= outer;
    });

    let roofed = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      let x, z;
      if (targets.length > 0 && Math.random() < stats.enemyBias) {
        const e = pick(targets);
        x = e.pos.x + randRange(-stats.scatter, stats.scatter);
        z = e.pos.z + randRange(-stats.scatter, stats.scatter);
      } else {
        // uniform over the annulus: sqrt keeps the rain even, not centre-heavy
        const a = randRange(0, Math.PI * 2);
        const r = Math.sqrt(randRange(inner * inner, outer * outer));
        x = center.x + Math.cos(a) * r;
        z = center.z + Math.sin(a) * r;
      }
      // never on the mage's own boots, however the point was chosen
      const dx = x - center.x, dz = z - center.z;
      const d = Math.hypot(dx, dz) || 1;
      if (d < inner) { x = center.x + (dx / d) * inner; z = center.z + (dz / d) * inner; }

      // straight down, so the first surface under the column is the impact point
      const from = new THREE.Vector3(x, center.y + stats.spawnHeight, z);
      const hit = game.world.raycast(from, DOWN, stats.spawnHeight + 40);
      if (!hit) continue;
      if (hit.point.y - center.y <= stats.skyClearance) return hit.point;
      roofed = hit.point;
    }
    return roofed;
  }

  _updateStorm(dt) {
    let due = false;
    for (const m of this.pendingMeteors) {
      m.t -= dt;
      if (m.t <= 0) due = true;
    }
    if (!due) return;
    const waiting = [];
    for (const m of this.pendingMeteors) {
      if (m.t <= 0) this._spawnMeteor(m);
      else waiting.push(m);
    }
    this.pendingMeteors = waiting;
  }

  _spawnMeteor({ big, pos, stats }) {
    const game = this.game;
    const speed = big ? stats.bigSpeed : stats.smallSpeed;
    const aoe = big ? stats.bigAoe : stats.smallAoe;
    const damage = stats.damage * (big ? 1 : stats.smallDamageMult);
    const fall = stats.spawnHeight / speed;

    game.fx.meteorWarning(pos, aoe, fall);
    game.projectiles.push(new Projectile(game, {
      pos: new THREE.Vector3(pos.x, pos.y + stats.spawnHeight, pos.z),
      dir: DOWN.clone(),
      speed,
      radius: big ? stats.bigRadius : stats.smallRadius,
      damage,
      aoeRadius: aoe,
      life: fall + 1.5,          // it has already found its ground; this is the backstop
      color: stats.color,
      coreColor: stats.coreColor,
      source: 'meteor',
      light: big,                // a lit sky-full of small rocks is a slideshow
      traumaMult: big ? stats.bigTrauma : stats.smallTrauma,
      trailInterval: big ? 0.016 : 0.03,
      trailFn: (p) => game.fx.meteorTrail(p, big),
      onExplode: (p) => {
        game.fx.meteorImpact(p, aoe, big);
        game.audio.play(big ? 'meteorImpact' : 'meteorHit');
      },
    }));
  }

  // ---------- Mega Blast (charged) ----------
  // The only spell with a gap between the button and the effect. Pressing cast
  // spends the mana and starts a five-second gather; _updateCharge() drives the
  // orb, the sound and the pose, and throws it at the end. Nothing here is a
  // one-shot, so every path out of a run has to be able to tear it down —
  // reset(), death, and the game abandoning a run all land on cancelCharge().

  get charging() { return this.charge !== null; }

  // 0 -> 1 across the gather. The HUD reads this for its charge bar.
  get chargeFrac() {
    return this.charge ? Math.min(1, this.charge.t / this.charge.total) : 0;
  }

  get chargeRemaining() {
    return this.charge ? Math.max(0, this.charge.total - this.charge.t) : 0;
  }

  _beginCharge(stats) {
    const game = this.game;
    this.charge = { stats, t: 0, total: Math.max(0.01, stats.chargeTime) };
    game.fx.chargeStart(stats.color, stats.coreColor);
    game.audio.startChargeLoop();
    game.player.setChargeAnim(0);
    game.hud.toast(`${SPELLS.megablast.icon} Mega Blast gathering — stay alive`);
  }

  _updateCharge(dt) {
    const game = this.game;
    const c = this.charge;
    // Dying drops it. The mana is already gone, which is exactly the risk the
    // spell is: five seconds of standing in a fight holding a lit fuse.
    if (!game.player.alive) { this.cancelCharge(); return; }

    c.t = Math.min(c.total, c.t + dt);
    const t01 = c.t / c.total;
    game.fx.chargeUpdate(this._chargeOrbPos(), game.player.pos, t01, dt);
    game.audio.updateChargeLoop(t01);
    game.player.setChargeAnim(t01);
    // The stone starts moving under the last of it — trauma bleeds off at 1.6/s,
    // so feeding it t01^2 per second builds a rumble that only ever grows.
    game.cameraRig.addTrauma(c.stats.chargeTrauma * t01 * t01 * dt);

    if (c.t >= c.total) this._releaseMegaBlast(c.stats);
  }

  // Where the sun hangs: on the mage's centreline, between both raised hands
  // and pushed clear of the chest so the orb never eats the model.
  _chargeOrbPos() {
    const p = this.game.player;
    const yaw = this.game.cameraRig.yaw;
    const mid = p.handWorldPos(1).add(p.handWorldPos(-1)).multiplyScalar(0.5);
    return mid.add(new THREE.Vector3(Math.sin(yaw) * 0.62, 0.24, Math.cos(yaw) * 0.62));
  }

  // Boom. The lock is taken *here*, not when the button went down: after five
  // seconds the pack the player was aiming at has moved, died, or been replaced.
  _releaseMegaBlast(stats) {
    const game = this.game;
    const origin = this._chargeOrbPos();
    this.cancelCharge(); // the held orb becomes the thrown one

    const target = this._pickMegaTarget(stats, origin);
    const dir = new THREE.Vector3();
    if (target) dir.subVectors(target.center, origin).normalize();
    else dir.subVectors(game.cameraRig.getAimPoint().point, origin).normalize();

    game.player.triggerCastAnim(Math.asin(clamp(-dir.y, -1, 1)));
    game.projectiles.push(new Projectile(game, {
      pos: origin.clone().addScaledVector(dir, 0.5),
      dir,
      speed: stats.projectileSpeed,
      radius: stats.projectileRadius,
      damage: stats.damage,
      aoeRadius: stats.aoeRadius,
      life: stats.lifeTime,
      color: stats.color,
      coreColor: stats.coreColor,
      source: 'megablast',
      traumaMult: stats.blastTrauma,
      lightIntensity: 220,
      lightRange: 20,
      trailFn: (p) => game.fx.megaBlastTrail(p),
      trailInterval: 0.012,
      onExplode: (p) => {
        game.fx.megaBlastImpact(p, stats.aoeRadius);
        game.audio.play('megaImpact');
      },
      // Guidance, not a guarantee: the orb bends after its mark, and a demon
      // that sidesteps far enough still watches it sail past.
      homing: target ? { target, turnRate: stats.homingTurnRate } : null,
    }));

    game.fx.megaBlastLaunch(origin, stats.color, stats.coreColor);
    game.audio.play('megaLaunch');
    game.cameraRig.addTrauma(0.4);
    game.cameraRig.fovKick = 8;
  }

  // Auto-aim. Scores every demon the orb could actually reach and picks the one
  // worth the most: the pack beats the straggler, what the player is looking at
  // beats what is behind them, and near beats far. Stone blocks a lock outright,
  // so the blast is never thrown into the pillar the mage is hiding behind.
  _pickMegaTarget(stats, origin) {
    const game = this.game;
    const aimDir = game.cameraRig.getAimPoint().dir;
    const to = new THREE.Vector3();
    let best = null, bestScore = -Infinity;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const center = e.center;
      to.subVectors(center, origin);
      const dist = to.length();
      if (dist > stats.autoAimRange || dist < 0.001) continue;
      if (!game.world.lineOfSight(origin, center)) continue;

      let cluster = 0;
      for (const other of game.enemies) {
        if (other === e || !other.alive) continue;
        if (other.center.distanceTo(center) <= stats.aoeRadius) cluster++;
      }
      // squared so the bonus falls away fast off-crosshair: the auto-aim should
      // pick the pack, not quietly overrule a player who is clearly aiming
      const facing = Math.max(0, to.divideScalar(dist).dot(aimDir));
      const score = cluster * stats.clusterWeight
        + facing * facing * stats.facingWeight
        - dist * 0.12;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  // Tear the gather down. Safe with nothing charging, which is why reset() and
  // every abandon path call it unconditionally.
  cancelCharge() {
    if (!this.charge) return;
    this.charge = null;
    this.game.fx.chargeStop();
    this.game.audio.stopChargeLoop();
    this.game.player.endChargeAnim();
  }

  // ---------- Lightning (continuous beam) ----------
  // Modelled on the Quake 3 lightning gun: no cast rhythm, no travel time, no
  // projectile — a held shaft of electricity that ticks 20 times a second for
  // as long as the button, the mana and the leash all hold. Everything about it
  // lives here rather than in tryCast(), because a beam is a *state*, not an
  // event: it has to be advanced on dt so its damage rate is the same at 30 fps
  // and 144, and it has to be able to drop itself mid-frame.

  get beamActive() { return this.beam !== null; }

  // The game loop reports the cast button every frame; the beam reads it here.
  setFiring(held) { this.firing = !!held; }

  _updateBeam(dt) {
    const game = this.game;
    if (this.overchargeT > 0) this.overchargeT = Math.max(0, this.overchargeT - dt);

    const id = this.selected;
    const spell = SPELLS[id];
    const isBeam = spell?.type === 'beam' && this.isUnlocked(id);
    const stats = isBeam ? this.stats(id) : null;

    // Mana gate with hysteresis: striking the beam up costs a real beat of
    // drain, but once it is lit it burns down to the last tick. Without the gap
    // between those two numbers the trickle of reserve regen would relight the
    // beam for one 50 ms tick every third of a second — a machine-gun stutter
    // instead of the clean handover to the melee weapon a dry pool should get.
    const manaGate = !stats ? 0 : (this.beam ? stats.manaCost : stats.castThreshold);
    const wants = isBeam && this.firing && game.player.alive
      && (this.godMode || game.player.mana >= manaGate)
      && (this.cooldowns[id] ?? 0) <= 0;
    if (!wants) { this.stopBeam(); return; }

    if (!this.beam) {
      this.beam = { id, target: null, tickAcc: 0, hitFxT: 0, arcFxT: 0, t: 0 };
      game.fx.beamStart(stats.color, stats.coreColor);
      game.audio.startBeamLoop();
    }
    const beam = this.beam;
    beam.t += dt;

    const shot = this._aimBeam(stats);
    beam.target = shot.target;

    // Damage on a fixed tick clock, independent of frame rate. The catch-up is
    // capped so a long hitch can't dump half a second of damage in one frame.
    beam.tickAcc += dt;
    let ticks = 0;
    while (beam.tickAcc >= stats.tickInterval && ticks < 4) {
      beam.tickAcc -= stats.tickInterval;
      ticks++;
      if (!game.player.trySpendMana(stats.manaCost)) { this.stopBeam(); return; }
      if (shot.target) this._beamTick(stats, shot.target, shot.origin);
    }
    if (beam.tickAcc >= stats.tickInterval) beam.tickAcc = 0; // drop the backlog

    // Feedback: the arm stays up, the view sits pushed in, and the shake is a
    // constant low hum rather than the per-cast punch a discrete spell gets.
    game.player.triggerCastAnim(Math.asin(-shot.dir.y));
    game.cameraRig.fovKick = 1.6;
    game.cameraRig.addTrauma(1.1 * dt); // per second, so the hum is frame-rate honest
    beam.hitFxT -= dt;
    beam.arcFxT -= dt;
    game.fx.beamUpdate(shot.origin, shot.end, !!shot.target, dt, game.camera);
  }

  // Auto-aim. The crosshair proposes and the beam disposes: it latches onto the
  // demon nearest the aim ray inside a narrow acquisition cone, then *keeps*
  // that demon through a much wider one, so a target strafing across the view
  // stays lit without the player tracking it. A rival has to beat the held
  // target by the switch margin to steal the beam, which stops the lock
  // flickering between two demons standing shoulder to shoulder. Range and
  // line of sight are measured from the hand — the beam is drawn from there,
  // and an arc through a pillar reads as a bug however the camera saw it.
  _aimBeam(stats) {
    const game = this.game;
    const aim = game.cameraRig.getAimPoint();
    const origin = game.player.handWorldPos(1);
    const toEnemy = new THREE.Vector3();

    // How far off the crosshair a demon sits, generously counting its own girth
    // as part of the cone. null = out of the leash entirely.
    const offAxis = (e) => {
      if (e.center.distanceTo(origin) > stats.range + e.cfg.radius) return null;
      toEnemy.subVectors(e.center, aim.origin);
      const dist = toEnemy.length();
      if (dist < 0.4) return 0;
      toEnemy.divideScalar(dist);
      const angle = Math.acos(Math.min(1, Math.max(-1, toEnemy.dot(aim.dir))));
      return Math.max(0, angle - Math.atan2(e.cfg.radius * 0.9, dist));
    };
    const visible = (e) => game.world.lineOfSight(origin, e.center);

    // 1. hold what we already have, while it stays inside the wide cone
    let target = null;
    let targetAngle = Infinity;
    const held = this.beam?.target;
    if (held?.alive) {
      const a = offAxis(held);
      if (a !== null && a <= stats.lockAngle && visible(held)) { target = held; targetAngle = a; }
    }
    // 2. acquire whatever sits nearest the crosshair inside the narrow cone
    let best = null;
    let bestAngle = stats.aimAssistAngle;
    for (const e of game.enemies) {
      if (!e.alive || e === target) continue;
      const a = offAxis(e);
      if (a === null || a >= bestAngle) continue;
      if (!visible(e)) continue;
      best = e; bestAngle = a;
    }
    if (best && (!target || bestAngle < targetAngle - stats.lockSwitchMargin)) target = best;

    let end;
    if (target) {
      end = target.center.clone();
    } else {
      // Nothing locked: the beam runs down the crosshair ray and earths on the
      // first stone, or simply stops dead at the end of the leash.
      const ray = new THREE.Vector3().subVectors(aim.point, origin);
      const len = ray.length();
      end = len > stats.range
        ? origin.clone().addScaledVector(ray.divideScalar(len), stats.range)
        : aim.point.clone();
    }
    return { origin, end, target, dir: aim.dir };
  }

  // One tick of the beam. The demon under it takes the full bite; the ones
  // packed around it take a lick of the same discharge, because the arc earths
  // itself through the nearest bodies — standing shoulder to shoulder in front
  // of a lightning gun is its own punishment. Chain Lightning pushes that
  // spread one demon deeper per stack.
  _beamTick(stats, target, origin) {
    const game = this.game;
    const beam = this.beam;
    const mult = this.overchargeT > 0 ? stats.overchargeMult : 1;
    const showArcs = beam.arcFxT <= 0;
    let kills = 0;

    const bite = (e, dmg, from) => {
      // silent, like the Mana Shield's beat: the per-hit thud fired 20 times a
      // second is a wall of noise, and the beam's own loop already sells contact
      e.takeDamage(dmg, from, 'lightning', true);
      if (!e.alive) kills++;
    };
    bite(target, stats.damage * mult, origin);

    // Spread outward one layer at a time: the struck demon's neighbours first,
    // then (only with Chain Lightning) their neighbours, each layer weaker.
    const struck = new Set([target]);
    let layer = [target];
    let frac = stats.splashFrac;
    const layers = 1 + stats.chains;
    for (let l = 0; l < layers && layer.length > 0; l++) {
      const radius = l === 0 ? stats.splashRadius : stats.chainRadius;
      const next = [];
      for (const src of layer) {
        for (const e of game.enemies) {
          if (!e.alive || struck.has(e)) continue;
          const gap = e.center.distanceTo(src.center) - e.cfg.radius;
          if (gap > radius) continue;
          if (!game.world.lineOfSight(src.center, e.center)) continue;
          struck.add(e);
          next.push(e);
          // shoulder to shoulder eats nearly the whole share; the far edge of
          // the radius keeps only the floor
          const fall = 1 - Math.max(0, gap) / radius;
          const share = frac * (stats.splashFloor + (1 - stats.splashFloor) * fall);
          bite(e, stats.damage * mult * share, src.center);
          if (showArcs) game.fx.lightningArc(src.center, e.center, true);
        }
      }
      layer = next;
      frac *= stats.chainDamageMult;
    }
    if (showArcs && struck.size > 1) beam.arcFxT = 0.1;

    // A hitmarker at the tick rate would strobe, so it beats at a readable
    // pace — except on a kill, which always lands on the frame it happened.
    if (kills > 0) {
      game.hud.hitmarker(true);
      beam.hitFxT = 0.12;
      const mod = this.spellState[beam.id];
      if (mod.siphon) {
        game.player.addMana(stats.siphonMana * kills);
        game.fx.pickupSparkle(game.player.center, stats.color);
      }
      // Arc Battery: every kill dumps the stored charge back into the beam
      if (mod.battery) this.overchargeT = stats.overchargeTime;
    } else if (beam.hitFxT <= 0) {
      game.hud.hitmarker(false);
      beam.hitFxT = 0.12;
    }
  }

  // Drop the beam: the button, the mana, the run state or a spell switch. Safe
  // to call when there is no beam, which is why every one of those paths does.
  stopBeam() {
    const beam = this.beam;
    if (!beam) return;
    this.beam = null;
    this.overchargeT = 0;
    this.game.fx.beamStop();
    this.game.audio.stopBeamLoop();
    const { refireDelay } = this.stats(beam.id);
    this.cooldowns[beam.id] = Math.max(this.cooldowns[beam.id] ?? 0, refireDelay);
  }

  // ---------- Wyrmlance: throwing the braid ----------
  // Everything that decides where this shot goes happens right here, once. The
  // axis is frozen at the muzzle: no homing, no aim assist, no acquisition
  // cone, no re-aim in flight. A weapon that pierces an entire line without
  // falloff cannot also be allowed to find the line for you.
  _castHelix(stats, aim) {
    const game = this.game;
    // Both hands throw, and the braid is born between them. The two muzzle
    // flashes 0.7 m apart are the cheapest, most legible "this is a PAIR" tell
    // in the whole design, and they land at the one moment the camera is
    // guaranteed to be pointed at the mage's hands.
    const right = game.player.handWorldPos(1);
    const left = game.player.handWorldPos(-1);
    const hands = _helixOrigin.copy(right).add(left).multiplyScalar(0.5);

    // THE AXIS IS THE CROSSHAIR RAY — and getting that literally right matters
    // more here than anywhere else in the book.
    //
    // `cameraRig.forward` is NOT the camera's optical axis. The rig parks the
    // camera at a shoulder offset (cameraRig.js: `shoulderPivot`) but then
    // lookAt()s the *un-shouldered* pivot, so the two diverge by a real angle.
    // A line built from `forward` therefore misses what the reticle covers by a
    // margin that grows with distance: measured against a demon solved to exact
    // screen centre, 0.85 m at 8 m and 2.62 m at 36 m. Every other spell
    // inherits the same error and hides it — Fireball inside a 3.4 m blast,
    // Lightning inside a 14-degree acquisition cone — but a 0.56 m core band
    // with no assist of any kind would simply whiff past ten metres.
    //
    // So the direction is taken from the camera itself, and the hands are
    // projected onto that ray. What the crosshair covers is what the braid runs
    // through, at every distance. The strands are still *drawn* leaving the two
    // palms and winding onto the axis, which is what openDistance is for.
    const dir = game.camera.getWorldDirection(_helixDir);
    const cam = game.camera.position;
    const t = (hands.x - cam.x) * dir.x + (hands.y - cam.y) * dir.y + (hands.z - cam.z) * dir.z;
    const origin = new THREE.Vector3(cam.x + dir.x * t, cam.y + dir.y * t, cam.z + dir.z * t);

    // One raycast, now, for the whole flight. The arena's collision boxes are
    // built once and never move, and the axis is frozen — so a per-frame cast
    // would return the same answer sixty times a second for nothing. It also
    // means the scan needs no line-of-sight test at all: every metre inside
    // maxRange is clear air by construction.
    const hit = game.world.raycast(origin, dir, stats.range);
    const maxRange = hit ? Math.min(hit.t, stats.range) : stats.range;

    // Whether it ends on stone or simply runs out of reach are different events
    // and must sound different: a braid that fades in open air is a clean miss,
    // and a clean miss reports nothing at all.
    game.projectiles.push(new HelixBolt(game, stats, origin, dir, maxRange, !!hit, [right, left]));

    game.fx.muzzleFlash(right, stats.color);
    game.fx.muzzleFlash(left, stats.color);
    game.audio.play('wyrmCast');
    game.cameraRig.fovKick = stats.fovKick;
    game.cameraRig.addTrauma(stats.castTrauma);
  }

}
