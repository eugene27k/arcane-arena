import { SETTINGS, saveSettings } from '../core/settings.js';
import { MusicPanel } from './musicPanel.js';

// Menu / pause / upgrade / death screen controllers (PRD §14, §18, §36-§37).
export class Menus {
  constructor(callbacks) {
    this.cb = callbacks;
    this.menuScreen = document.getElementById('menu-screen');
    this.upgradeScreen = document.getElementById('upgrade-screen');
    this.pauseScreen = document.getElementById('pause-screen');
    this.deathScreen = document.getElementById('death-screen');
    this.settingsScreen = document.getElementById('settings-screen');
    this.upgradeTitle = document.getElementById('upgrade-title');
    this.upgradeCards = document.getElementById('upgrade-cards');
    this.deathStats = document.getElementById('death-stats');
    this.bestWaveEl = document.getElementById('best-wave');

    document.getElementById('btn-start').addEventListener('click', () => this.cb.onStart());
    document.getElementById('btn-quit').addEventListener('click', () => {
      window.close();
      this.cb.onQuitBlocked?.();
    });
    document.getElementById('btn-resume').addEventListener('click', () => this.cb.onResume());
    document.getElementById('btn-abandon').addEventListener('click', () => this.cb.onAbandon());
    document.getElementById('btn-restart').addEventListener('click', () => this.cb.onRestart());
    document.getElementById('btn-tomenu').addEventListener('click', () => this.cb.onToMenu());

    // settings: reachable from the main menu and pause; Back returns to caller
    this._settingsReturn = null;
    document.getElementById('btn-settings').addEventListener('click', () => this.showSettings('menu'));
    document.getElementById('btn-settings-pause').addEventListener('click', () => this.showSettings('pause'));
    document.getElementById('btn-settings-back').addEventListener('click', () => {
      if (this._settingsReturn === 'pause') this.showPause();
      else this.cb.onShowMenu?.();
    });
    this._bindSettingControls();
    this.music = new MusicPanel(callbacks.music, {
      onSettingsChanged: () => this.cb.onSettingsChanged?.(),
    });

    this._upgradeKeyHandler = null;
  }

  hideAll() {
    for (const s of [this.menuScreen, this.upgradeScreen, this.pauseScreen, this.deathScreen, this.settingsScreen]) {
      s.classList.add('hidden');
    }
    this._unbindUpgradeKeys();
  }

  _bindSettingControls() {
    const sens = document.getElementById('set-sens');
    const sensVal = document.getElementById('set-sens-val');
    const inv = document.getElementById('set-inverty');
    const fov = document.getElementById('set-fov');
    const fovVal = document.getElementById('set-fov-val');
    const vol = document.getElementById('set-volume');
    const volVal = document.getElementById('set-volume-val');
    const qual = document.getElementById('set-quality');
    const qualVal = document.getElementById('set-quality-val');
    const auto = document.getElementById('set-auto-weapon');

    this._syncSettingControls = () => {
      sens.value = SETTINGS.sensMult;
      sensVal.textContent = `×${SETTINGS.sensMult.toFixed(2)}`;
      inv.checked = SETTINGS.invertY;
      fov.value = SETTINGS.fov;
      fovVal.textContent = `${SETTINGS.fov}°`;
      vol.value = SETTINGS.volume;
      volVal.textContent = `${Math.round(SETTINGS.volume * 100)}%`;
      qual.value = SETTINGS.quality;
      qualVal.textContent = { low: 'fastest', medium: 'balanced', high: 'heaviest' }[SETTINGS.quality] ?? '';
      auto.checked = SETTINGS.autoWeapon;
    };

    const changed = () => {
      SETTINGS.sensMult = parseFloat(sens.value);
      SETTINGS.invertY = inv.checked;
      SETTINGS.fov = parseInt(fov.value, 10);
      SETTINGS.volume = parseFloat(vol.value);
      SETTINGS.quality = qual.value;
      SETTINGS.autoWeapon = auto.checked;
      if (SETTINGS.volume > 0) SETTINGS.muted = false;
      saveSettings();
      this._syncSettingControls();
      this.cb.onSettingsChanged?.();
    };
    for (const el of [sens, inv, fov, vol, qual, auto]) el.addEventListener('input', changed);
  }

  showSettings(returnTo) {
    this.hideAll();
    this._settingsReturn = returnTo;
    this._syncSettingControls();
    this.music.render();
    this.settingsScreen.querySelector('.settings-inner').scrollTop = 0;
    this.settingsScreen.classList.remove('hidden');
  }

  showMenu(bestWave) {
    this.hideAll();
    if (bestWave > 0) {
      this.bestWaveEl.textContent = `Best: Wave ${bestWave}`;
      this.bestWaveEl.classList.remove('hidden');
    } else {
      this.bestWaveEl.classList.add('hidden');
    }
    this.menuScreen.classList.remove('hidden');
  }

  showPause() {
    this.hideAll();
    this.pauseScreen.classList.remove('hidden');
  }

  showUpgrade(wave, options, onPick) {
    this.hideAll();
    this.upgradeTitle.textContent = `WAVE ${wave} CLEARED`;
    this.upgradeCards.innerHTML = '';
    options.forEach((u, i) => {
      const card = document.createElement('div');
      card.className = 'upgrade-card' + (u.newSpell ? ' new-spell' : '');
      card.innerHTML = `
        <div class="u-icon">${u.icon}</div>
        <div class="u-cat">${u.category}</div>
        <div class="u-name">${u.name}</div>
        <div class="u-desc">${u.desc}</div>
      `;
      card.addEventListener('click', () => onPick(u.id));
      this.upgradeCards.appendChild(card);
    });
    this.upgradeScreen.classList.remove('hidden');

    // keyboard 1..3 selection
    this._upgradeKeyHandler = (e) => {
      const idx = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
      if (idx >= 0 && idx < options.length) onPick(options[idx].id);
    };
    window.addEventListener('keydown', this._upgradeKeyHandler);
  }

  _unbindUpgradeKeys() {
    if (this._upgradeKeyHandler) {
      window.removeEventListener('keydown', this._upgradeKeyHandler);
      this._upgradeKeyHandler = null;
    }
  }

  showDeath(stats, cause) {
    this.hideAll();
    const causeLine = cause === 'abyss'
      ? 'The abyss claimed you.'
      : 'Slain by the demonic horde.';
    this.deathStats.innerHTML = `
      <div style="color:#8a7f95;font-size:16px;margin-bottom:10px">${causeLine}</div>
      Wave Reached: <b>${stats.wave}</b><br/>
      Enemies Killed: <b>${stats.kills}</b><br/>
      ${stats.newBest ? '<span style="color:#d8b46a">New Best!</span>' : `Best: Wave ${stats.bestWave}`}
    `;
    this.deathScreen.classList.remove('hidden');
  }
}
