// Player-facing settings, persisted to localStorage. Gameplay code reads the
// live SETTINGS object every frame, so changes apply instantly.
const KEY = 'arcane_settings';

const DEFAULTS = {
  sensMult: 1,     // multiplier on CAMERA.sensitivity
  invertY: false,
  fov: 74,         // base FOV in degrees (sprint widening stays relative)
  volume: 1,       // 0..1 multiplier on the master gain
  muted: false,
  quality: 'medium',     // 'low' | 'medium' | 'high' — post stack, AO, atmosphere
  gfxRev: 2,             // bumped when preset costs change; forces a re-pick below
  // Auto Weapon: the cast button draws its own spell every shot. A play-style
  // preference rather than a run state, so it outlives a death like the rest.
  autoWeapon: false,
  // Background music (uploaded MP3/WAV — see src/audio/musicLibrary.js)
  musicEnabled: false,   // off until the player asks for it — see music/
  musicVolume: 0.6,      // 0..1 on the music bus, independent of SFX
  musicOrder: 'name',    // 'name' = library order by file name, 'random' = shuffled
  musicTrackId: '',      // last track played, resumed on the next launch
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      out[k] = typeof raw[k] === typeof DEFAULTS[k] ? raw[k] : DEFAULTS[k];
    }
    // typeof alone would wave through any string here
    if (out.musicOrder !== 'name' && out.musicOrder !== 'random') out.musicOrder = DEFAULTS.musicOrder;
    if (!['low', 'medium', 'high'].includes(out.quality)) out.quality = DEFAULTS.quality;

    // gfxRev 1 shipped a far more expensive 'high' (4x MSAA at 2x device pixel
    // ratio — ~22 fps on an M4 Air) and defaulted to it. Anyone carrying that
    // saved choice is moved to the new default once. Read the revision off
    // `raw`, not `out`: the loop above has already filled a missing gfxRev in
    // with the current value, which would hide the very case this detects. And
    // persist immediately, so a later deliberate pick of 'high' sticks.
    if ((typeof raw.gfxRev === 'number' ? raw.gfxRev : 0) < DEFAULTS.gfxRev) {
      out.quality = DEFAULTS.quality;
      out.gfxRev = DEFAULTS.gfxRev;
      try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* private mode */ }
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export const SETTINGS = load();

export function saveSettings() {
  localStorage.setItem(KEY, JSON.stringify(SETTINGS));
}

export const SETTINGS_DEFAULTS = DEFAULTS;
