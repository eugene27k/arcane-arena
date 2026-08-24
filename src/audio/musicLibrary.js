// Persistent store for player-uploaded background music.
//
// IndexedDB rather than localStorage: tracks are megabytes of binary, and
// localStorage is a ~5 MB string store. Each record keeps the original File
// blob alongside the metadata the settings list needs, so a track survives
// reloads exactly as uploaded — no re-encoding, no base64 bloat.
//
// If IndexedDB is unavailable (private windows, hardened profiles) the library
// degrades to an in-memory map: uploads still play, they just don't persist.

const DB_NAME = 'arcane_music';
const DB_VERSION = 1;
const STORE = 'tracks';

// Browsers disagree about WAV's MIME type (and some report none at all for
// files dragged from odd sources), so the extension is the primary check.
const EXT_RE = /\.(mp3|wav)$/i;
const MIME_OK = /^audio\/(mpeg|mp3|wav|wave|x-wav|vnd\.wave)$/i;

export const MAX_TRACK_BYTES = 100 * 1024 * 1024; // ~9 min of stereo 44.1k WAV

export function isSupportedAudioFile(file) {
  return EXT_RE.test(file.name) || MIME_OK.test(file.type || '');
}

export function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Read a blob's duration without keeping it decoded — a throwaway element and
// its metadata event. Resolves to 0 rather than rejecting: a missing duration
// is a cosmetic gap in the track list, never a reason to refuse an upload.
function probeDuration(blob) {
  return new Promise((resolve) => {
    let url = null;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) && v > 0 ? v : 0);
    };
    const timer = setTimeout(() => finish(0), 5000);
    try {
      url = URL.createObjectURL(blob);
      const el = new Audio();
      el.preload = 'metadata';
      el.addEventListener('loadedmetadata', () => finish(el.duration));
      el.addEventListener('error', () => finish(0));
      el.src = url;
    } catch {
      finish(0);
    }
  });
}

export class MusicLibrary {
  constructor() {
    this.persistent = true;
    this._db = null;
    this._mem = new Map();   // fallback store, and blob cache for the session
    this._nextMemId = -1;    // negative ids never collide with IndexedDB keys
  }

  async _open() {
    if (this._db) return this._db;
    if (!this.persistent || typeof indexedDB === 'undefined') {
      this.persistent = false;
      return null;
    }
    try {
      this._db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      });
      return this._db;
    } catch {
      this.persistent = false;
      return null;
    }
  }

  _tx(db, mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Metadata only — the blob stays in the record until something asks to play
  // it, so listing a large library never materializes its bytes.
  async list() {
    const db = await this._open();
    let rows = [];
    if (db) {
      try {
        rows = await this._req(this._tx(db, 'readonly').getAll());
      } catch {
        rows = [];
      }
    } else {
      rows = [...this._mem.values()];
    }
    return rows.map((r) => this._meta(r));
  }

  // Uploaded tracks are addressed as `u:<key>` so they can share one playlist
  // with the bundled `b:<file>` tracks without the two id spaces colliding.
  _meta(r) {
    return {
      id: `u:${r.id}`, name: r.name, sortKey: r.name, type: r.type, size: r.size,
      duration: r.duration || 0, addedAt: r.addedAt || 0, source: 'upload',
    };
  }

  _key(id) {
    return Number(String(id).slice(2));
  }

  async getBlob(id) {
    const cached = this._mem.get(id);
    if (cached) return cached.blob;
    const db = await this._open();
    if (!db) return null;
    try {
      const row = await this._req(this._tx(db, 'readonly').get(this._key(id)));
      return row ? row.blob : null;
    } catch {
      return null;
    }
  }

  // Returns { added: [meta], rejected: [{name, reason}] } — partial success is
  // the norm when someone shift-selects a folder, so nothing throws on a bad
  // file; the caller reports what landed and what didn't.
  async add(files) {
    const added = [];
    const rejected = [];
    for (const file of files) {
      if (!isSupportedAudioFile(file)) {
        rejected.push({ name: file.name, reason: 'not an MP3 or WAV' });
        continue;
      }
      if (file.size > MAX_TRACK_BYTES) {
        rejected.push({ name: file.name, reason: `too large (${formatBytes(file.size)})` });
        continue;
      }
      const duration = await probeDuration(file);
      const rec = {
        name: file.name,
        type: file.type || (/\.wav$/i.test(file.name) ? 'audio/wav' : 'audio/mpeg'),
        size: file.size,
        duration,
        addedAt: Date.now(),
        blob: file,
      };
      try {
        rec.id = await this._put(rec);
        const meta = this._meta(rec);
        this._mem.set(meta.id, rec); // keep the blob hot for immediate playback
        added.push(meta);
      } catch (err) {
        const quota = err && (err.name === 'QuotaExceededError' || err.name === 'NotAllowedError');
        rejected.push({ name: file.name, reason: quota ? 'not enough browser storage' : 'could not be saved' });
      }
    }
    return { added, rejected };
  }

  async _put(rec) {
    const db = await this._open();
    if (!db) {
      const id = this._nextMemId--;
      this._mem.set(`u:${id}`, { ...rec, id });
      return id;
    }
    const store = this._tx(db, 'readwrite');
    return this._req(store.add(rec));
  }

  async remove(id) {
    this._mem.delete(id);
    const db = await this._open();
    if (!db) return;
    try {
      await this._req(this._tx(db, 'readwrite').delete(this._key(id)));
    } catch { /* already gone */ }
  }

  async clear() {
    this._mem.clear();
    const db = await this._open();
    if (!db) return;
    try {
      await this._req(this._tx(db, 'readwrite').clear());
    } catch { /* nothing to clear */ }
  }
}
