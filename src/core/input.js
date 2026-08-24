// Keyboard/mouse state. Pointer-lock request/exit is orchestrated by main.js;
// this module only tracks raw state and per-frame deltas.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();   // keydown edges, consumed each frame
    this.mouseDown = false;
    this.rightMouseDown = false;
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.pointerLocked = false;
    this._cheats = [];          // typed key-code sequences (see addCheatCode)

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // Keep the browser from stealing gameplay keys.
      if (['Space', 'ControlLeft', 'ControlRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (this._matchCheat(e.code)) return; // eaten mid-sequence, never reaches play
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = false; this.rightMouseDown = false; });

    window.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) this.rightMouseDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.rightMouseDown = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (this.onLockChange) this.onLockChange(this.pointerLocked);
    });
  }

  requestLock() {
    if (this.pointerLocked) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* pointer lock unavailable (embedded browsers) */ }
  }
  exitLock() {
    if (this.pointerLocked) document.exitPointerLock();
  }

  // Register a literal key-code sequence that calls `onComplete` once it is
  // typed in order. Every keystroke that *continues* a match in progress is
  // swallowed — the letters of a cheat word land on bound keys, and typing one
  // out shouldn't also strafe, mute, and fire a spell along the way. The
  // opening keystroke passes through untouched, so pick an unbound key for it:
  // that way a stray press costs at most the one key that follows it.
  addCheatCode(sequence, onComplete, timeoutSec = 1.6) {
    this._cheats.push({ seq: sequence, onComplete, timeout: timeoutSec * 1000, idx: 0, lastT: 0 });
  }

  // True when this keystroke belongs to a sequence already under way.
  _matchCheat(code) {
    let swallow = false;
    const now = performance.now();
    for (const c of this._cheats) {
      if (c.idx > 0 && now - c.lastT > c.timeout) c.idx = 0; // typed too slowly
      c.lastT = now;
      if (code === c.seq[c.idx]) {
        swallow = swallow || c.idx > 0;
        c.idx++;
        if (c.idx >= c.seq.length) { c.idx = 0; c.onComplete(); }
      } else {
        // A wrong key ends the run — but it may be a fresh opening in its own right.
        c.idx = code === c.seq[0] ? 1 : 0;
      }
    }
    return swallow;
  }

  isDown(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }

  // Read accumulated mouse deltas (start of frame).
  consumeDeltas() {
    const out = { dx: this.dx, dy: this.dy, wheel: this.wheel };
    this.dx = 0; this.dy = 0; this.wheel = 0;
    return out;
  }

  // Clear keydown edges (end of frame, after all wasPressed checks ran).
  endFrame() {
    this.pressed.clear();
  }
}
