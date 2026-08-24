import { SETTINGS, saveSettings } from '../core/settings.js';
import { formatBytes, formatDuration } from '../audio/musicLibrary.js';

// Settings-screen controls for the uploaded background-music library:
// the toggle/volume/order rows, the transport bar, and the track list.
// Owns no playback state — everything routes through the MusicPlayer.
export class MusicPanel {
  constructor(player, { onSettingsChanged } = {}) {
    this.player = player;
    this.onSettingsChanged = onSettingsChanged || (() => {});

    this.onEl = document.getElementById('set-music-on');
    this.volEl = document.getElementById('set-music-vol');
    this.volVal = document.getElementById('set-music-vol-val');
    this.orderEl = document.getElementById('set-music-order');
    this.nowEl = document.getElementById('music-now');
    this.prevBtn = document.getElementById('music-prev');
    this.toggleBtn = document.getElementById('music-toggle');
    this.nextBtn = document.getElementById('music-next');
    this.listEl = document.getElementById('music-list');
    this.addBtn = document.getElementById('music-add');
    this.fileEl = document.getElementById('music-file');
    this.statusEl = document.getElementById('music-status');

    this._status = '';
    this._statusWarn = false;

    this.onEl.addEventListener('change', () => {
      SETTINGS.musicEnabled = this.onEl.checked;
      saveSettings();
      this.player.applySettings();
      if (SETTINGS.musicEnabled) this.player.resume();
      this.onSettingsChanged();
      this.render();
    });

    this.volEl.addEventListener('input', () => {
      SETTINGS.musicVolume = parseFloat(this.volEl.value);
      saveSettings();
      this.player.applySettings();
      this.render();
    });

    this.orderEl.addEventListener('change', () => {
      this.player.setOrder(this.orderEl.value);
      this._setStatus(this.orderEl.value === 'random'
        ? 'Tracks will play in a shuffled order.'
        : 'Tracks will play in order, sorted by file name.');
      this.render();
    });

    this.prevBtn.addEventListener('click', () => this.player.prev());
    this.nextBtn.addEventListener('click', () => this.player.next());
    this.toggleBtn.addEventListener('click', () => this.player.toggle());

    this.addBtn.addEventListener('click', () => this.fileEl.click());
    this.fileEl.addEventListener('change', () => this._onFilesPicked());

    // Drag a folder of tracks straight onto the panel.
    const panel = this.listEl.parentElement;
    for (const ev of ['dragenter', 'dragover']) {
      panel.addEventListener(ev, (e) => { e.preventDefault(); panel.classList.add('drop-target'); });
    }
    for (const ev of ['dragleave', 'drop']) {
      panel.addEventListener(ev, (e) => { e.preventDefault(); panel.classList.remove('drop-target'); });
    }
    panel.addEventListener('drop', (e) => {
      const files = e.dataTransfer?.files;
      if (files && files.length) this._ingest(files);
    });
  }

  async _onFilesPicked() {
    const files = this.fileEl.files;
    if (files && files.length) await this._ingest(files);
    this.fileEl.value = ''; // re-picking the same file must fire `change` again
  }

  async _ingest(files) {
    this._setStatus(`Adding ${files.length} file${files.length === 1 ? '' : 's'}…`);
    const { added, rejected } = await this.player.addFiles(files);
    const parts = [];
    if (added.length) parts.push(`Added ${added.length} track${added.length === 1 ? '' : 's'}.`);
    if (rejected.length) {
      const shown = rejected.slice(0, 2).map((r) => `${r.name} — ${r.reason}`).join('; ');
      parts.push(`Skipped ${rejected.length}: ${shown}${rejected.length > 2 ? '…' : ''}`);
    }
    if (added.length && !this.player.library.persistent) {
      parts.push('Storage unavailable — tracks last only until you reload.');
    }
    this._setStatus(parts.join(' ') || 'Nothing to add.', rejected.length > 0);
    this.render();
  }

  _setStatus(text, warn = false) {
    this._status = text;
    this._statusWarn = warn;
    if (this.statusEl) {
      this.statusEl.textContent = text;
      this.statusEl.classList.toggle('warn', warn);
    }
  }

  // Full redraw — the list is short and only ever visible while paused.
  render() {
    this.onEl.checked = SETTINGS.musicEnabled;
    this.volEl.value = SETTINGS.musicVolume;
    this.volVal.textContent = `${Math.round(SETTINGS.musicVolume * 100)}%`;
    this.orderEl.value = SETTINGS.musicOrder;

    const p = this.player;
    const tracks = p.tracks;
    const cur = p.current;

    if (p.error) {
      this.nowEl.textContent = `⚠ ${p.error}`;
      this.nowEl.classList.remove('playing');
    } else if (cur) {
      this.nowEl.textContent = `${p.playing ? '♪ Now playing' : '❚❚ Paused'} — ${cur.name}`;
      this.nowEl.classList.toggle('playing', p.playing);
    } else {
      this.nowEl.textContent = tracks.length
        ? `${tracks.length} track${tracks.length === 1 ? '' : 's'} ready${SETTINGS.musicEnabled ? '' : ' — music is off'}`
        : 'No music loaded — upload MP3 or WAV files below';
      this.nowEl.classList.remove('playing');
    }

    this.toggleBtn.textContent = p.playing ? '❚❚' : '▶';
    const none = tracks.length === 0;
    this.prevBtn.disabled = none;
    this.nextBtn.disabled = none;
    this.toggleBtn.disabled = none || !SETTINGS.musicEnabled;

    this.listEl.innerHTML = '';
    if (none) {
      const empty = document.createElement('div');
      empty.className = 'music-empty';
      empty.textContent = 'No tracks found. Uploaded music is stored in this browser and survives reloads.';
      this.listEl.appendChild(empty);
      return;
    }

    tracks.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'music-item' + (t.id === p.currentId ? ' current' : '');
      row.title = `Play ${t.name}`;

      const num = document.createElement('div');
      num.className = 'm-num';
      num.textContent = t.id === p.currentId && p.playing ? '♪' : String(i + 1);

      const name = document.createElement('div');
      name.className = 'm-name';
      name.textContent = t.name;

      const meta = document.createElement('div');
      meta.className = 'm-meta';
      const d = formatDuration(t.duration);
      meta.textContent = t.source === 'bundled'
        ? (d ? `${d} · built-in` : 'built-in')
        : (d ? `${d} · ${formatBytes(t.size)}` : formatBytes(t.size));

      // Built-ins ship with the game and have no delete button — removing one
      // means deleting the file from music/, not clearing browser storage.
      let last;
      if (t.source === 'bundled') {
        last = document.createElement('div');
        last.className = 'm-del m-fixed';
        last.textContent = '♦';
        last.title = 'Built in — lives in the game\'s music folder';
      } else {
        last = document.createElement('button');
        last.className = 'm-del';
        last.textContent = '✕';
        last.title = 'Remove from library';
        last.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.player.remove(t.id);
          this._setStatus(`Removed ${t.name}.`);
          this.render();
        });
      }

      row.addEventListener('click', () => this.player.play(t.id));
      row.append(num, name, meta, last);
      this.listEl.appendChild(row);
    });
  }
}
