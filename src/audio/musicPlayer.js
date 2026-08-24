import { SETTINGS, saveSettings } from '../core/settings.js';
import { MusicLibrary } from './musicLibrary.js';
import { BUNDLED_TRACKS } from './bundledMusic.js';

// Background-music playback over the uploaded library.
//
// One <audio> element for the whole session, routed into the AudioEngine's
// dedicated music bus (a MediaElementSourceNode can only be created once per
// element, and the music bus sits beside the SFX compressor so explosions
// don't pump the soundtrack). Streaming the element beats decoding to an
// AudioBuffer: a four-minute track would otherwise sit in memory as ~40 MB of
// float samples.
//
// The playlist merges two sources: the tracks bundled in music/ and whatever
// the player has uploaded. Both are addressed by opaque string ids, so the
// rest of this class never has to care which is which.
//
// Two play orders, chosen in Settings:
//   'name'   — the library sorted by file name, advancing in order, looping
//   'random' — a shuffled bag; every track plays once before any repeats, and
//              a reshuffle never opens with the track that just finished

const ORDERS = ['name', 'random'];

function isValidOrder(o) {
  return ORDERS.includes(o);
}

// Sorted on the file name, not the display title: bundled tracks carry a
// numeric prefix that decides their order but never reaches the screen.
function byName(a, b) {
  return a.sortKey.localeCompare(b.sortKey, undefined, { numeric: true, sensitivity: 'base' });
}

export class MusicPlayer {
  constructor(audio, { onChange } = {}) {
    this.audio = audio;
    this.onChange = onChange || (() => {});
    this.library = new MusicLibrary();
    this.tracks = [];          // metadata, always sorted by name
    this.currentId = null;
    this.loading = false;
    this.error = '';

    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.loop = false;
    this.el.addEventListener('ended', () => this.next());
    this.el.addEventListener('error', () => this._onTrackError());
    // Bundled tracks ship without a duration; the first play reveals it.
    this.el.addEventListener('loadedmetadata', () => {
      const t = this.current;
      if (t && !t.duration && Number.isFinite(this.el.duration)) {
        t.duration = this.el.duration;
        this.onChange();
      }
    });
    this.el.addEventListener('play', () => this.onChange());
    this.el.addEventListener('pause', () => this.onChange());

    this._srcNode = null;
    this._url = null;
    this._bag = [];            // remaining ids this shuffle round
    this._history = [];        // for prev() in random order
    this._failures = 0;        // consecutive load failures, to stop skip-loops
  }

  get playing() {
    return !this.el.paused && !this.el.ended && !!this.currentId;
  }

  get current() {
    return this.tracks.find((t) => t.id === this.currentId) || null;
  }

  async load() {
    this.loading = true;
    const uploaded = await this.library.list();
    this.tracks = [...BUNDLED_TRACKS, ...uploaded].sort(byName);
    this.loading = false;
    this._bag = [];
    this.onChange();
    return this.tracks;
  }

  // Called once the AudioContext exists (first user gesture). Until then the
  // element plays at its own volume; after it, the music bus owns the level.
  attach() {
    if (this._srcNode || !this.audio.ctx) return;
    try {
      this._srcNode = this.audio.ctx.createMediaElementSource(this.el);
      this._srcNode.connect(this.audio.musicGain);
      this.el.volume = 1; // level now lives on the bus
    } catch {
      this._srcNode = null; // stay on element volume
    }
    this.applySettings();
  }

  applySettings() {
    const level = (SETTINGS.muted || !SETTINGS.musicEnabled) ? 0 : SETTINGS.musicVolume ** 2;
    if (this._srcNode) this.audio.setMusicGain(level);
    else this.el.volume = Math.min(1, level);
    // Disabling music stops the stream outright rather than muting it, so a
    // paused-out soundtrack isn't quietly burning decode work every frame.
    if (!SETTINGS.musicEnabled && !this.el.paused) this.el.pause();
  }

  // Start playing if music is on, tracks exist, and nothing is playing yet.
  // Safe to call on every user gesture — it no-ops once music is under way.
  autoStart() {
    this.attach();
    if (!SETTINGS.musicEnabled || this.playing || this.tracks.length === 0) return;
    const remembered = this.tracks.find((t) => t.id === SETTINGS.musicTrackId);
    this.play(remembered ? remembered.id : this._firstId());
  }

  _firstId() {
    if (this.tracks.length === 0) return null;
    if (SETTINGS.musicOrder === 'random') return this._drawFromBag(null);
    return this.tracks[0].id;
  }

  async play(id) {
    if (id == null) return;
    const track = this.tracks.find((t) => t.id === id);
    if (!track) return;

    this.attach();
    if (this.audio.ctx && this.audio.ctx.state === 'suspended') this.audio.ctx.resume();

    let src;
    if (track.source === 'bundled') {
      src = track.url;
    } else {
      const blob = await this.library.getBlob(id);
      if (!blob) {
        this._onTrackError(`${track.name} could not be read`);
        return;
      }
      src = URL.createObjectURL(blob);
    }

    if (this.currentId !== id) this._history.push(this.currentId);
    this._releaseUrl();
    if (track.source !== 'bundled') this._url = src;
    this.currentId = id;
    this.error = '';
    SETTINGS.musicTrackId = id;
    saveSettings();

    this.el.src = src;
    this.applySettings();
    try {
      await this.el.play();
      this._failures = 0;
    } catch {
      // Autoplay refused (no gesture yet) — leave it cued; the next click starts it.
    }
    this.onChange();
  }

  resume() {
    if (!SETTINGS.musicEnabled || this.tracks.length === 0) return;
    this.attach();
    if (this.audio.ctx && this.audio.ctx.state === 'suspended') this.audio.ctx.resume();
    if (!this.currentId) { this.autoStart(); return; }
    this.el.play().catch(() => {});
  }

  pause() {
    this.el.pause();
    this.onChange();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.resume();
  }

  stop() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this._releaseUrl();
    this.currentId = null;
    this.onChange();
  }

  // Only uploads get an object URL; a bundled track's src is a plain asset
  // path that must outlive the track being switched away from.
  _releaseUrl() {
    if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
  }

  next() {
    const id = this._pickNext();
    if (id == null) this.stop();
    else this.play(id);
  }

  prev() {
    if (this.tracks.length === 0) return;
    if (SETTINGS.musicOrder === 'random') {
      let id = this._history.pop();
      while (id != null && !this.tracks.some((t) => t.id === id)) id = this._history.pop();
      this.play(id ?? this._pickNext());
      return;
    }
    const i = this.tracks.findIndex((t) => t.id === this.currentId);
    const n = this.tracks.length;
    this.play(this.tracks[(((i < 0 ? 0 : i) - 1) % n + n) % n].id);
  }

  _pickNext() {
    const n = this.tracks.length;
    if (n === 0) return null;
    if (n === 1) return this.tracks[0].id;
    if (SETTINGS.musicOrder === 'random') return this._drawFromBag(this.currentId);
    const i = this.tracks.findIndex((t) => t.id === this.currentId);
    return this.tracks[(i + 1) % n].id;
  }

  // Shuffle bag: refilled with every track when empty, reordered so the round
  // never opens on the track that just played.
  _drawFromBag(avoidId) {
    const valid = new Set(this.tracks.map((t) => t.id));
    this._bag = this._bag.filter((id) => valid.has(id) && id !== avoidId);
    if (this._bag.length === 0) {
      this._bag = this.tracks.map((t) => t.id);
      for (let i = this._bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this._bag[i], this._bag[j]] = [this._bag[j], this._bag[i]];
      }
      if (this._bag.length > 1 && this._bag[0] === avoidId) {
        [this._bag[0], this._bag[1]] = [this._bag[1], this._bag[0]];
      }
    }
    return this._bag.shift();
  }

  setOrder(order) {
    if (!isValidOrder(order)) return;
    SETTINGS.musicOrder = order;
    saveSettings();
    this._bag = [];
    this.onChange();
  }

  async addFiles(files) {
    const result = await this.library.add([...files]);
    if (result.added.length) {
      this.tracks = this.tracks.concat(result.added).sort(byName);
      this._bag = [];
      // Uploading is itself the user gesture autoplay wants — if nothing is
      // playing, the first new track starts right away.
      if (SETTINGS.musicEnabled && !this.playing) this.play(result.added[0].id);
    }
    this.onChange();
    return result;
  }

  async remove(id) {
    const track = this.tracks.find((t) => t.id === id);
    if (!track || track.source === 'bundled') return; // built-ins aren't the player's to delete
    const wasCurrent = this.currentId === id;
    const wasPlaying = this.playing;
    const at = this.tracks.findIndex((t) => t.id === id);
    await this.library.remove(id);
    this.tracks = this.tracks.filter((t) => t.id !== id);
    this._bag = this._bag.filter((b) => b !== id);
    this._history = this._history.filter((h) => h !== id);
    if (wasCurrent) {
      const nextId = this.tracks.length ? this._pickNextAfterRemoval(at) : null;
      if (nextId != null && wasPlaying) this.play(nextId);
      else this.stop();
    }
    this.onChange();
  }

  // Hand off to whatever slid into the deleted track's slot, so removing one
  // song mid-list carries on from there instead of jumping back to the top.
  _pickNextAfterRemoval(at) {
    if (SETTINGS.musicOrder === 'random') return this._drawFromBag(null);
    const i = Math.min(Math.max(at, 0), this.tracks.length - 1);
    return this.tracks[i].id;
  }

  _onTrackError(message) {
    this.error = message || (this.current ? `${this.current.name} could not be played` : 'Track could not be played');
    this.onChange();
    this._failures++;
    // Give up once every track in the library has failed in a row, so a
    // library of broken files can't spin forever.
    if (this._failures >= Math.max(1, this.tracks.length)) {
      this._failures = 0;
      this.stop();
      return;
    }
    if (this.tracks.length > 1) this.next();
  }
}
