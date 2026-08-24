import { SPELLS } from '../config/spellConfig.js';
import { CONTROLS, SENSE, WARD } from '../config/playerConfig.js';

// DOM HUD (PRD §30): HP / Mana bars, spell slots, wave + enemy counters,
// crosshair feedback, banners, damage vignettes.
export class Hud {
  constructor() {
    this.root = document.getElementById('hud');
    this.hpFill = document.getElementById('hp-fill');
    this.hpText = document.getElementById('hp-text');
    this.manaFill = document.getElementById('mana-fill');
    this.manaText = document.getElementById('mana-text');
    this.manaBar = document.querySelector('.mana-bar');
    this.dashFill = document.getElementById('dash-fill');
    this.waveLabel = document.getElementById('wave-label');
    this.enemiesLabel = document.getElementById('enemies-label');
    this.killsLabel = document.getElementById('kills-label');
    this.bannerEl = document.getElementById('banner');
    this.toastEl = document.getElementById('toast');
    this.hitmarkerEl = document.getElementById('hitmarker');
    this.vDamage = document.getElementById('vignette-damage');
    this.vLowHP = document.getElementById('vignette-lowhp');
    this.vHeal = document.getElementById('vignette-heal');
    this.godBadge = document.getElementById('godmode-badge');
    this.chargeMeter = document.getElementById('charge-meter');
    this.chargeLabel = document.getElementById('charge-label');
    this.chargeFill = document.getElementById('charge-fill');
    // Mana Shield readout. The key hint is derived from the bind rather than
    // written into the markup, so rebinding the ward can't leave the HUD lying.
    this.wardRow = document.getElementById('ward-row');
    this.wardCost = this.wardRow.querySelector('.ward-cost');
    this.wardRow.querySelector('.ward-key').textContent =
      CONTROLS.shieldKeys[0].replace(/^Key/, '');
    // Auto Weapon readout, keyed off its bind for the same reason.
    this.autoRow = document.getElementById('auto-row');
    this.autoState = this.autoRow.querySelector('.auto-state');
    this.autoRow.querySelector('.auto-key').textContent =
      CONTROLS.autoKeys[0].replace(/^Key/, '');
    // Sense Mode readout, keyed off its bind for the same reason.
    this.senseRow = document.getElementById('sense-row');
    this.senseCost = this.senseRow.querySelector('.sense-cost');
    this.senseRow.querySelector('.sense-key').textContent =
      CONTROLS.senseKeys[0].replace(/^Key/, '');
    this.senseInd = document.getElementById('sense-indicator');
    this.senseArrow = document.getElementById('sense-arrow');
    this._senseShown = false;
    this._senseDeg = NaN;
    this._senseOp = NaN;
    this.slots = {};
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      const el = document.getElementById(`slot-${n}`);
      this.slots[n] = {
        el,
        icon: el.querySelector('.slot-icon'),
        name: el.querySelector('.slot-name'),
        cost: el.querySelector('.slot-cost'),
        cd: el.querySelector('.slot-cd'),
      };
    }
    this._damageT = 0;
    this._healT = 0;
    this._manaFlashT = 0;

    // directional damage indicator pool
    this.dmgContainer = document.getElementById('dmg-indicators');
    this._dmgArcs = [];
    for (let i = 0; i < 6; i++) {
      const el = document.createElement('div');
      el.className = 'dmg-arc';
      this.dmgContainer.appendChild(el);
      this._dmgArcs.push({ el, angle: 0, t: 0, dur: 1.1 });
    }
  }

  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }

  update(game, dt) {
    const p = game.player;
    // GODMODE pins both bars full; counting to a number that never moves reads
    // as a frozen HUD, so the readouts say what is actually true instead.
    const god = game.godMode;
    this.godBadge.classList.toggle('hidden', !god);
    const hpFrac = Math.max(0, p.hp / p.maxHP);
    this.hpFill.style.width = `${hpFrac * 100}%`;
    this.hpText.textContent = god ? '∞' : `${Math.ceil(p.hp)} / ${p.maxHP}`;
    // Arcane debt (Meteor Storm overdraft): the same bar refills backwards in
    // ember red, measured against the floor the well can be overdrawn to.
    const debt = p.inManaDebt;
    this.manaBar.classList.toggle('debt', debt);
    this.manaFill.style.width = debt
      ? `${Math.min(1, p.mana / p.manaFloor) * 100}%`
      : `${Math.max(0, p.mana / p.maxMana) * 100}%`;
    this.manaText.textContent = god
      ? '∞'
      : `${debt ? Math.ceil(p.mana) : Math.floor(p.mana)} / ${p.maxMana}`;

    // Mana Shield: lit while the ward is up, because it is spending mana the
    // whole time it is — an unnoticed shield is a drained well.
    const warded = game.shield.active;
    this.wardRow.classList.toggle('on', warded);
    this.wardRow.classList.toggle('off', !warded);
    this.wardCost.textContent = god ? '∞ free' : `${WARD.manaPerSecond} / s`;

    // Auto Weapon: the slot moving on its own is only legible if the HUD says
    // something is moving it, so the row names the weapon the reel is holding.
    const auto = game.caster.auto;
    this.autoRow.classList.toggle('on', auto);
    this.autoRow.classList.toggle('off', !auto);
    this.autoState.textContent = auto
      ? (SPELLS[game.caster.selected]?.name ?? 'ON').toUpperCase()
      : 'OFF';

    // Sense Mode: lit while it is open, because it is spending the whole time
    // it is — and unlike the ward it gives nothing back if you forget it.
    const sensing = game.sense.active;
    this.senseRow.classList.toggle('on', sensing);
    this.senseRow.classList.toggle('off', !sensing);
    this.senseCost.textContent = god ? '∞ free' : `${SENSE.manaPerSecond} / s`;

    const dashFrac = p.dashCooldownTime > 0 ? 1 - p.dashCooldown / p.dashCooldownTime : 1;
    this.dashFill.style.width = `${dashFrac * 100}%`;
    this.dashFill.style.background = dashFrac >= 1 ? '#d8c890' : '#7a6f58';

    this.waveLabel.textContent = `WAVE ${game.waves.wave}`;
    const rem = game.waves.remaining;
    this.enemiesLabel.textContent = game.state === 'PREP'
      ? 'They are coming…'
      : `Enemies Remaining: ${rem}`;
    this.killsLabel.textContent = `Kills: ${game.stats.kills}`;

    // spell slots
    const fallback = game.caster.meleeFallbackActive;
    for (const spell of Object.values(SPELLS)) {
      const slot = this.slots[spell.slot];
      if (!slot) continue;
      // Slot 4 is shared: only the melee weapon actually in hand paints it.
      if (!game.caster.inBook(spell)) continue;
      const unlocked = game.caster.isUnlocked(spell.id);
      slot.el.classList.toggle('locked', !unlocked);
      const held = game.caster.selected === spell.id && unlocked;
      slot.el.classList.toggle('selected', held);
      // drawn by the reel rather than chosen: same gold ring, dashed and breathing
      slot.el.classList.toggle('reel', held && game.caster.auto);
      // the pool ran dry: show that the cast button is swinging this instead
      slot.el.classList.toggle('standin', spell.type === 'melee' && unlocked && fallback);
      slot.icon.textContent = unlocked ? spell.icon : '🔒';
      slot.name.textContent = unlocked ? spell.name : 'Locked';
      const st = unlocked ? game.caster.stats(spell.id) : null;
      const cost = st ? st.manaCost : 0;
      // a costless spell advertises that it is costless, not "0 mana"
      slot.el.classList.toggle('free', unlocked && cost === 0);
      // A beam is priced per second of fire — its per-tick cost is a fraction
      // of a point, which would read as "0 mana" and look free.
      slot.cost.textContent = !unlocked ? ''
        : cost === 0 ? '∞ free'
        : st.type === 'beam' ? `${Math.round(st.manaPerSecond)} mana/s`
        : `${cost} mana`;
      // Onikiri spends its binding where a spell shows its price: the slot is
      // a clock, and it goes red for the last few seconds so the countdown is
      // felt without reading it.
      const blade = unlocked && spell.id === 'katana';
      slot.el.classList.toggle('blade', blade);
      slot.el.classList.toggle('blade-fading', blade && game.caster.bladeT <= spell.warnTime);
      if (blade) {
        slot.cost.textContent = Number.isFinite(game.caster.bladeT)
          ? `${Math.max(0, game.caster.bladeT).toFixed(1)}s`
          : '∞';
      }
      // Mega Blast mid-gather: the slot's own cooldown shade is already full
      // (the recovery is stamped at the button), so the pulse is what says the
      // sun is being built right now rather than merely recharging.
      slot.el.classList.toggle('charging',
        unlocked && game.caster.charging && game.caster.selected === spell.id);
      const cd = unlocked ? game.caster.cooldownFrac(spell.id) : 0;
      slot.cd.style.height = `${cd * 100}%`;
    }

    // Mega Blast charge meter
    const charging = game.caster.charging;
    this.chargeMeter.classList.toggle('hidden', !charging);
    if (charging) {
      const f = game.caster.chargeFrac;
      this.chargeFill.style.width = `${f * 100}%`;
      this.chargeMeter.classList.toggle('imminent', f > 0.8);
      this.chargeLabel.textContent = `MEGA BLAST  ${(game.caster.chargeRemaining).toFixed(1)}s`;
    }

    // vignettes
    this._damageT = Math.max(0, this._damageT - dt * 2.4);
    this.vDamage.style.opacity = Math.min(1, this._damageT);
    // The heal wash fades slower than the damage one on purpose: a wound is a
    // spike you need to read instantly, a heal is a beat you get to enjoy.
    this._healT = Math.max(0, this._healT - dt * 1.15);
    this.vHeal.style.opacity = Math.min(1, this._healT);
    this.vLowHP.classList.toggle('active', p.alive && hpFrac <= 0.3);

    // directional damage arcs track the camera while fading
    const yaw = game.cameraRig.yaw;
    for (const a of this._dmgArcs) {
      if (a.t <= 0) continue;
      a.t -= dt;
      // screen-right is world −x when facing +z, hence yaw − angle (verified
      // against camera projection: +x probe at yaw 0 lands on the LEFT)
      const deg = (yaw - a.angle) * (180 / Math.PI);
      a.el.style.transform = `rotate(${deg}deg) translateY(-19vh)`;
      a.el.style.opacity = Math.max(0, Math.min(1, a.t / a.dur * 1.8));
    }

    // The sense needle rides its own ring, one radius OUTSIDE the damage arcs
    // above — see the measured argument at the #sense-arrow rule in styles.css
    // before changing 26vh; an inner ring puts "something is behind you" on the
    // wizard's own boots. Everything the needle needs was decided in
    // sense.update(); the HUD only spends it. The yaw is subtracted here and
    // never smoothed — the heading is a world bearing, so turning the camera
    // has to move the needle this frame rather than chase it.
    const sn = game.sense;
    if (sn.vis <= 0.002) {
      // display:none, so a closed sense is not a layer, not a blur pass and not
      // a paint — the same reason #charge-meter hides rather than fades.
      if (this._senseShown) { this.senseInd.classList.add('hidden'); this._senseShown = false; }
    } else {
      if (!this._senseShown) { this.senseInd.classList.remove('hidden'); this._senseShown = true; }
      // Tenths of a degree: at this radius a whole degree is two pixels of
      // travel and a slow sweep would stagger, while a tenth is a fifth of a
      // pixel — invisible, and it elides the write and the template string on
      // every frame the mage and the demon both hold still.
      const sdeg = Math.round((yaw - sn.heading) * (1800 / Math.PI)) / 10;
      if (sdeg !== this._senseDeg) {
        this._senseDeg = sdeg;
        this.senseArrow.style.transform = `rotate(${sdeg}deg) translateY(-26vh)`;
      }
      const lit = Math.min(1, SENSE.dimFloor + (1 - SENSE.dimFloor) * sn.near01
        + sn.swapT * SENSE.swapFlash);
      const op = Math.round(sn.vis * lit * 100) / 100;
      if (op !== this._senseOp) { this._senseOp = op; this.senseArrow.style.opacity = op; }
    }

    if (this._manaFlashT > 0) {
      this._manaFlashT -= dt;
      if (this._manaFlashT <= 0) this.manaBar.classList.remove('insufficient');
    }
  }

  damageFlash(strength = 1) {
    this._damageT = Math.min(1.4, this._damageT + 0.55 * strength + 0.25);
  }

  // A relic spending itself washes the frame warm — the visual opposite of the
  // damage vignette, and the one thing that can overwrite the low-HP pulse.
  healFlash(strength = 1) {
    // Capped well under full opacity on purpose. Relief that blinds you for a
    // second is worse than the wound — demons keep swinging through a heal.
    this._healT = Math.min(0.62, this._healT + 0.34 * strength + 0.17);
  }

  // worldAngle: atan2(dx, dz) from player to the damage source
  damageFrom(worldAngle) {
    let slot = this._dmgArcs.find((a) => a.t <= 0);
    if (!slot) slot = this._dmgArcs.reduce((m, a) => (a.t < m.t ? a : m));
    slot.angle = worldAngle;
    slot.t = slot.dur;
  }

  manaInsufficient() {
    this.manaBar.classList.remove('insufficient');
    void this.manaBar.offsetWidth; // restart the CSS animation
    this.manaBar.classList.add('insufficient');
    this._manaFlashT = 0.7;
  }

  hitmarker(kill = false) {
    const el = this.hitmarkerEl;
    el.classList.remove('show', 'kill');
    void el.offsetWidth;
    if (kill) el.classList.add('kill');
    el.classList.add('show');
  }

  banner(text) {
    const el = this.bannerEl;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  toast(text) {
    const el = this.toastEl;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }
}
