import { SPELLS, CAST_MANA_SCALE } from './spellConfig.js';

// What one Fireball cast actually deducts — the unit air jumps are priced in.
const FIREBALL_CAST = Math.round(SPELLS.fireball.manaCost * CAST_MANA_SCALE);

// All player tunables (PRD §41: data-driven values).
export const PLAYER = {
  maxHP: 100,
  maxMana: 100,
  startMana: 100,

  radius: 0.45,
  height: 1.8,
  eyeHeight: 1.62,
  handHeight: 1.35,

  walkSpeed: 6.4,
  sprintSpeed: 9.6,
  groundAccel: 46,
  airAccel: 14,
  groundFriction: 11,
  airDrag: 0.6,

  jumpSpeed: 8.8,
  // Mid-air jumps, tapped with a second and third Space and paid for in mana:
  // one Fireball cast for the double, two for the triple. Speeds are set
  // absolutely (not added), so an air jump also rescues a fall. The triple
  // launches at exactly twice the double's speed — and since height goes with
  // the square of it, that is four times the lift.
  airJumps: 2,
  airJumpSpeeds: [8.2, 16.4],
  airJumpCosts: [FIREBALL_CAST, FIREBALL_CAST * 2],
  airJumpDelay: 0.12,     // lockout after each launch, so a fast
  jumpBufferTime: 0.22,   // multi-tap is buffered instead of wasted
  gravity: 24,
  terminalFall: 34,
  stepHeight: 0.48,

  dashSpeed: 17,
  dashDuration: 0.22,
  dashCooldown: 1.5,
  dashInvulnTime: 0.25,

  // Emergency mana attunement: a slow trickle only while below the reserve,
  // so the run can never soft-lock with zero mana and no essence on the ground.
  // The same trickle is what pays off arcane debt, which is why the debt is
  // measured in seconds of helplessness rather than in mana.
  manaReserve: 16,
  manaReserveRegen: 2.5,

  // How far below empty the well may be overdrawn, as a fraction of the pool
  // (Meteor Storm is the only spell allowed to do it). A cast that would sink
  // past this floor is refused outright, so debt is bounded and always payable.
  manaFloorFrac: 0.5,

  killPlaneY: -12,
  spawnPos: { x: 0, y: 1.4, z: 0 },
};

export const CONTROLS = {
  // Hold-to-cast keyboard alternatives to LMB, for trackpad play where holding
  // a click to fire is uncomfortable. LMB keeps working regardless.
  castKeys: ['KeyE', 'KeyF'],
  // Staff Strike. Always live, whatever spell is selected — the fallback has to
  // be there the instant the pool runs dry, not one slot-switch away.
  meleeKeys: ['KeyV'],
  // Mana Shield. Tapped, never held: the ward is billed by the second whether
  // or not anything walks into it, so it stays up until it is switched off.
  shieldKeys: ['KeyR'],
  // Auto Weapon. Tapped: it flips the reel on and off, and reaching for a slot
  // by hand flips it off too (see AUTO in spellConfig.js for what it draws).
  autoKeys: ['KeyX'],
  // Sense. Tapped, like the ward it is billed beside — it charges by the second
  // whether or not there is anything out there to find, so it stays open until
  // it is closed. C because the bottom row under the WASD hand is where a
  // stance toggle belongs, and X and V already own the keys either side of it:
  // the index finger drops off D and comes back, so the sense opens mid-strafe
  // without the hand leaving the keys or the pinky leaving Shift — which is
  // exactly when you want to know what is behind you.
  senseKeys: ['KeyC'],
};

// Mana Shield — a ward of raw mana held around the mage, toggled with R. It
// does not soak damage: it burns whatever closes to claw range, which makes it
// the answer to grunts specifically (flyers hover far outside it, and pay it no
// rent). Billed one second at a time, so holding it through a long wave is a
// real trade against casting, and an empty well drops it on its own.
export const WARD = {
  radius: 2.8,          // metres from the mage's centre; a demon's own girth counts
  dps: 22,              // damage per second to everything inside the bubble
  pulseInterval: 0.4,   // the ward bites in beats — per-frame ticks are unreadable
  manaPerSecond: 5,     // charged up front, then once every second it stays up
  color: 0xa080ff,
  coreColor: 0xe6dcff,
};

// Sense — the mage stops looking and listens. One needle on a ring inside the
// crosshair, pointing at the nearest living demon, through whatever stone is in
// the way. It does not wound, slow, or name anything: it will not say what the
// demon is, how many there are, or how far — only which way, which is the
// question you actually ask when something you cannot see is closing. The
// cheapest thing in the book that still bills by the second, because it is the
// only one you pay for knowing rather than for killing.
export const SENSE = {
  // 3, not the prettier 2, and the reason is PLAYER.manaReserveRegen. The
  // emergency trickle pays 2.5/s below the reserve, so a sense priced at 2
  // would pay for itself forever at the floor and could never run dry — and
  // running dry is the one behaviour every billed toggle in this game has. 3 is
  // the smallest whole number the trickle cannot cover: a full well is 33
  // seconds, and a wave held with the sense open is a wave you cast less in.
  manaPerSecond: 3,

  // ---------- how the needle moves ----------
  // Exponential chase on the WORLD bearing, fed to damp(). At 12 the needle
  // closes 70% of the gap in a tenth of a second and trails a grunt circling at
  // claw range by about three degrees — following, not lagging. The camera's
  // yaw is subtracted raw at draw time and never smoothed, so turning the mouse
  // slides the needle round the ring the same frame: it is bolted to the arena,
  // not dragged behind the crosshair. Smoothing the *screen* angle instead
  // makes the needle swim on every turn, and that is how this gets built wrong.
  turnRate: 12,
  // Ceiling on the swing, rad/s. Two jobs, and the second is not optional: it
  // stretches a hand-off across the ring into a sweep the eye can follow (half
  // a turn takes about a third of a second) rather than a whip that reads as a
  // teleport — and it is the only thing between the needle and a full spin when
  // a grunt walks through the mage and the true bearing rate goes to infinity.
  maxTurnRate: 9,
  // Inside this many metres a bearing is noise, not information: atan2(0, 0) is
  // zero, which points at world +z with total confidence and is a lie. The
  // needle holds its last heading rather than animate a demon orbiting the
  // mage's own boots. Reachable in play — a flyer drifts directly overhead.
  nullRadius: 0.9,

  // ---------- which demon holds the mark ----------
  // How much nearer a challenger must be, in SQUARED distance, before it can
  // take the mark at all: 0.8 squared is about 11% nearer in metres. Two grunts
  // walking abreast would otherwise trade the needle every frame, and an arrow
  // that twitches is read as broken rather than as precise.
  switchMargin: 0.8,
  // …and how long it must hold that advantage, unbroken, before the hand-off
  // commits. The margin alone only moves the flicker out to the edge of the
  // margin; the dwell is what stops it. Kept short on purpose — every
  // millisecond here is latency on the one question the sense answers. Never
  // applied when the held demon dies: that is not a choice between two live
  // options, and hesitating there would point at a corpse.
  switchDelay: 0.12,

  // ---------- brightness ----------
  // Distance ramp: full inside nearDist, the dim floor past farDist, damped at
  // proxRate so a demon stepping behind a pillar cannot make the needle flinch.
  // Never invisible, only quiet — a straggler across the hall is still a fact,
  // it is just not the fact that is about to hit you.
  nearDist: 4,
  farDist: 30,
  dimFloor: 0.45,
  proxRate: 6,
  // The flare when the mark changes hands. Mid-sweep the needle is pointing at
  // nothing, and without a tell that sweep reads as "my demon ran around me"
  // instead of "a different demon is nearer now".
  swapFlash: 0.35,
  swapDecay: 3,
  // The needle dissolves rather than cuts, so the toggle reads as something
  // opening. Asymmetric the way the vignettes are: a mark appearing is news and
  // lands in about a fifth of a second; a mark leaving is a fact settling, and
  // gets twice that. Closing the sense therefore leaves the last bearing you
  // paid for hanging for a beat, going cold, instead of blinking out.
  fadeInRate: 14,
  fadeOutRate: 7,
};

// GODMODE — the cheat code, typed anywhere (menu, prep, or mid-fight). One-way
// by design: nothing switches it back off, so the only exit is reloading the page.
export const GOD = {
  // Matched on `event.code`, so the sequence is layout-independent. Pick an
  // opening key nothing else is bound to — Input lets the first keystroke
  // through, and swallows the rest of the word so spelling it out doesn't also
  // strafe, mute, and cast on the way past.
  code: ['KeyG', 'KeyO', 'KeyD', 'KeyM', 'KeyO', 'KeyD', 'KeyE'],
  codeTimeout: 1.6,   // seconds of silence before a half-typed code lapses

  // Casts stay paced. Mana is free and every spell is unlocked, but each
  // fireball in flight carries its own point light — an unthrottled hose of
  // them is a slideshow, not a power fantasy. Halved, with a hard floor.
  cooldownMult: 0.5,
  minCooldown: 0.1,
};

export const CAMERA = {
  fov: 74,
  sprintFov: 81,
  armLength: 5.4,
  shoulderX: 0.85,
  pivotHeight: 1.7,
  minPitch: -1.32, // radians (looking up limit)
  maxPitch: 1.42,  // radians (looking down limit)
  sensitivity: 0.0024,
  collisionPad: 0.32,
  aimMaxDist: 200,
};
