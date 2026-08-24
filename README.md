# Arcane Arena — MVP

Third-person magical arena roguelite (vertical slice, per PRD v0.1). A dark-fantasy
wizard fights endless waves of demons in a ruined demonic cathedral: fireballs,
lightning, mana essence economy, vertical traversal, portals, upgrades.

Built with **Three.js** (browser, PC, keyboard + mouse). The PRD recommends UE5;
this slice implements the full MVP feature set on the web stack so it runs and
iterates instantly — module boundaries mirror the PRD's proposed architecture
(SpellCaster, WaveManager, SpawnManager, UpgradeManager, …) so a UE5 port maps 1:1.

## Download & Install

No Node, no terminal, no build step — grab a file from the
[**Releases**](../../releases) page and open it.

| You have | Download | Then |
|---|---|---|
| **macOS** (Apple Silicon or Intel) | `ArcaneArena-0.1.0-mac-universal.dmg` | Open it, drag **Arcane Arena** onto **Applications** |
| **Windows 10 / 11** | `ArcaneArena-Setup-0.1.0.exe` | Run it — it installs and makes a Start-menu shortcut |
| **Windows, no install** | `ArcaneArena-0.1.0-portable.exe` | Just run it; nothing is written to Program Files |

### First launch

The app is **not code-signed** — a signing certificate is a paid, per-year
subscription from Apple and from a Windows CA, and this is a free game. Both
systems therefore stop the first launch and ask you to confirm. This is the
"we don't know who wrote this" warning, not a virus warning, and it happens
once.

**macOS** — the first double-click shows *Apple could not verify "Arcane Arena"
is free of malware*, with only **Done** and **Move to Trash**. Nothing is wrong;
click **Done**, then:

1. **System Settings → Privacy & Security**
2. Scroll down to **Security** — *"Arcane Arena" was blocked to protect your Mac*
3. Click **Open Anyway**, authenticate, and confirm **Open**

That is the whole ritual, once, forever. (On macOS 14 and earlier the older
right-click → **Open** shortcut still works and is quicker.)

**Windows** — SmartScreen shows *Windows protected your PC*. Click
**More info**, then **Run anyway**.

### Playing

The game **captures your mouse** when you press Start — that is how you aim.
Press **Esc** to release the cursor and pause; press Start again to go back in.
Full screen is **F11** on Windows, **Control-Command-F** on macOS. Everything
else is in [Controls](#controls) below.

## Run from source

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run build` produces a static build in `dist/` (serve with any web server).

Requires a desktop browser with pointer-lock support (Chrome/Edge/Firefox/Safari).
Click **Start Game** — the game captures the mouse; **Esc** releases it and pauses.

### Desktop builds

```bash
npm run electron    # build, then run the desktop shell locally
npm run dist:mac    # -> release/ArcaneArena-<version>-mac-universal.dmg
npm run dist:win    # -> release/ArcaneArena-Setup-<version>.exe (+ portable)
npm run dist        # both
```

The shell is [electron/main.cjs](electron/main.cjs) and holds no game logic — it
serves `dist/` over a private `arena://` scheme and grants pointer lock. The
custom scheme rather than `file://` is load-bearing: the bundle is an ES module,
and modules are blocked on `file://`'s opaque origin, which would also leave
`localStorage` shared with every other local page instead of being the game's own.

The app icon is generated too — `npm run icon` renders
[tools/generateIcon.mjs](tools/generateIcon.mjs) into `build/icon.{png,ico,icns}`,
each size drawn natively rather than downsampled. Like the soundtrack, the
generator is the source and the artefact is build output.

## Controls

| Action | Input |
|---|---|
| Move | WASD |
| Camera / Aim | Mouse |
| Cast | Left Mouse, or E / F (hold to auto-cast) |
| Melee — Staff Strike, or Onikiri while carried | Right Mouse, or V (hold to keep swinging) |
| Mana Shield (toggle) | R (on/off — costs mana every second it is up) |
| Auto Weapon (toggle) | X (the book draws each shot; picking a slot by hand turns it off) |
| Sense (toggle) | C (a needle to the nearest demon, through stone — costs mana every second) |
| Jump / Double / Triple jump | Space (tap again in mid-air — air jumps cost mana) |
| Sprint | Shift |
| Dash (i-frames) | Ctrl or Q |
| Spell 1 – 7 | 1 / 2 / 3 / 4 / 5 / 6 / 7 (or mouse wheel) |
| Mute | M |
| Pause | Esc |

Mouse sensitivity, invert-Y, FOV, and volume live in **Settings** (main menu
or pause screen), persisted in localStorage.

## Soundtrack

Three tracks ship with the game, in `music/`:

| | | |
|---|---|---|
| **Cathedral of Ash** | 2:16 | organ, bell and harp in an empty nave — the menu and the lull between waves |
| **Demonfall** | 2:30 | war drum and an ostinato that refuses to leave D; brass only once the wave is on top of you |
| **The Abyss Waits** | 2:40 | a tritone opening under the tonic, and never resolving |

They are synthesized, not recorded — `npm run music` re-renders them from
[tools/generateMusic.mjs](tools/generateMusic.mjs), the same procedural approach
the SFX take, just offline. All three are D Phrygian: the flat second is what
makes the mode read as dread rather than plain minor, and every track leans on
it. The generator is seeded and deterministic, so editing an instrument there
and re-running produces an audible diff rather than a new roll of the dice.

**Music is off by default** — turn it on in Settings.

### Your own tracks

**Settings → Background Music** also takes MP3 and WAV files — the *Upload
MP3 / WAV…* button, or drag them onto the panel. Uploads go into IndexedDB
(localStorage is a 5 MB string store; songs are megabytes of binary), so a
library survives reloads and is ready the next time the game opens. 100 MB per
file; anything that isn't an MP3 or WAV is skipped by name, with a reason.

Anything dropped into `music/` itself joins the list as a built-in on the next
build — the folder is globbed, not registered. Built-ins are marked with a
diamond and have no delete button; removing one means deleting the file.

Both sources share one playlist, in two play orders:

- **In order, by file name** — the list top to bottom, looping. Names sort
  naturally, so `Track 2` comes before `Track 10`, and the built-ins' numeric
  prefixes decide where they sit.
- **Random (shuffled)** — a shuffle bag: every track plays once before any
  repeats, and a reshuffle never opens on the song that just ended.

Click any row to jump to it; the transport buttons drive it by hand. *Music
Volume* rides its own bus beside the SFX chain, so explosions never duck the
soundtrack, and **M** still silences everything at once. Playback carries across
pauses, upgrade screens, and death — new tracks announce themselves in the HUD
as they start.

Nothing plays until you click something: browsers block audio until a gesture,
and the game resumes whichever track was playing when you last quit.

## The loop

Cast → kill → demons drop glowing **Mana Essence** → move to collect → keep casting.
Clear the wave → pick 1 of 3 upgrades → next, harder wave. Waves 1–5 are
authored, then composition and stat multipliers scale algorithmically forever.
Death shows your run stats; best wave persists in localStorage.

The book fills as the run goes: **Fireball** (slot 1), unlockable **Lightning**
(slot 2), **Frost Nova** (slot 3, offered from wave 4) — an instant, self-centered burst
that barely scratches but chills every demon in 6 m to half speed for 3 seconds.
It's the panic button when the swarm closes in; no aiming, 5 s cooldown.
**Wyrmlance** (slot 7, offered from wave 5) rounds the book out: a thrown pair
of braided bolts that pierce a line and spread nowhere at all.

**Lightning** (slot 2) is a Quake 3 lightning gun. There is no cast rhythm and
no projectile: hold the button and a continuous shaft of electricity connects
you to a demon, ticking 20 times a second for 6 damage a tick (120 dps) at
18 mana per second. It aims itself — the beam latches onto whoever sits nearest
the crosshair inside a ~14° cone, then *keeps* that demon out to ~29°, so a
target strafing across your view stays lit without you tracking it. What you
pay for that is reach: the leash is 25 m, roughly half the arena, and stone
breaks it like anything else. The arc also earths itself through whoever is
packed around the demon it's burning — neighbours inside 3 m take up to a third
of every tick, falling off with distance, so a tight knot of grunts cooks
together. Striking the beam up needs a real beat of mana in the pool, but once
lit it burns down to the last tick, then hands the trigger cleanly to the staff
rather than sputtering.

**Staff Strike** (slot 4) is the melee weapon, and the only attack that costs
nothing: a wide sweep of the staff for 14 damage on a 0.5 s recovery, hitting
every demon in a ~115° arc within 2.7 m. Reach is measured exactly the way a
grunt measures its claw — horizontal distance, a vertical band tied to footing,
and clear stone between the bodies — so neither side can swing through a stair
riser or up onto a ledge it hasn't climbed. It is never taken away and never
scales, which is the point: it keeps a dry run alive without ever winning one.
It swings on **RMB / V** whatever slot is selected, and the cast button falls
back to it on its own the moment the pool can't pay for the selected spell —
the staff slot pulses while it's standing in.

**Onikiri** — the demon-cutter — is the staff's opposite, and the only weapon in
the game that is meant to be taken away again. It is a katana that appears
standing in the cathedral floor under a thin column of red light: at most once a
wave, never before wave 3, never two waves running, and always a long way from
where the mage is standing. Nothing brings it to you. You walk over and take it,
through whatever is in between, and that walk is what it costs.

Once claimed it *replaces* the staff in slot 4 — same key, same **RMB / V** —
for **18 seconds**: 52 damage a cut on a 0.26 s recovery, 3.5 m of reach, an ~89°
arc that has to be aimed rather than swept. Roughly four times the staff's bite
at twice its speed, for free, in claw range of everything trying to kill you.
Every demon the steel fells feeds the binding another 1.2 s, to a hard ceiling of
26 s, so wading in keeps it alive and whiffing starves it. The slot counts the
seconds down where a spell shows its price and goes red for the last five.

No upgrade card offers it, scales it, or makes it permanent, and it never
survives into the next wave — a blade still standing in the stone when the wave
ends sinks back into it. When the binding lapses the staff is simply back in
hand, which is the whole design: a burst of real power you have to go and get,
that is always about to end, on top of a floor that never changes.

**Mana Shield** (toggled with **R**) is the one ability that is neither cast nor
swung: a ward of raw mana held around the mage that sears anything close enough
to claw. It answers grunts specifically — they have to reach you to do anything,
and the ward is waiting where they have to stand. Flyers hover far outside it and
pay it no rent at all.

It costs 5 mana the instant it goes up and 5 more every second it stays up,
whether or not a demon walks into it, which makes holding it a standing trade
against casting rather than a free stance. There is no timer and no cooldown: it
stays up until you press R again, or until the well can't cover the next second
and the ward fails on its own. Inside, it bites four times a second for 22
damage per second — enough to kill a wave-1 grunt that stands in your face for
under three seconds, never enough to clear a wave on its own. It goes down with
you when you die, and a fresh run starts unwarded.

**Sense** (toggled with **C**) is the ward's opposite number: it wounds nothing,
slows nothing and names nothing. It puts a single cyan needle on a ring around
the crosshair — set outside the damage arcs, because the mage's own back stands
where a tighter ring would draw "something is behind you" — pointing at the
nearest living demon, and it does not check line of sight, which is the point. What the crosshair cannot tell
you is what is behind you and what is on the far side of a pillar, and that is
exactly what the needle answers.

It is a world bearing, not a screen one: turning the mouse slides the needle
round the ring the same frame, while the mark itself only ever eases. When a
closer demon takes the mark the needle sweeps across in about a third of a
second and flares as it lands, so a hand-off never reads as one demon running
around you; it brightens as its mark closes and goes quiet as it retreats, so a
straggler across the hall does not shout as loudly as a grunt at your heels.

It costs **3 mana** the instant it opens and **3 more every second** it stays
open, whether or not anything is alive to find — the same rule the ward states
for itself, because two toggles sitting in one HUD column must not have two
billing models. A full well is **33 seconds**. The price is deliberately above
the emergency trickle (2.5/s): a cheaper sense would pay its own rent forever at
the floor and could never run dry, and running dry — with a toast, and no other
way — is the only thing that closes it besides pressing C again. Closing it
leaves the last bearing you paid for hanging for a beat, going cold, rather than
blinking out.

**Mega Blast** (slot 6, offered from wave 6) is the slow ultimate: a sun of cold
blue fire the mage builds by hand for **five full seconds** before throwing it.
Pressing cast spends the mana immediately and starts the gather — both arms come
up, the orb grows between the hands while motes of mana are dragged in and
swallowed, a ring tightens on the stone underfoot, and the floor starts to shake
as the last second runs out. A meter under the crosshair counts it down. Then it
goes: 180 damage inside a 7.5 m blast, which is most of a crowd.

It **aims itself**. The lock is taken at the boom rather than at the button —
five seconds is long enough for the arena to rearrange itself completely — and
it scores every demon it can actually see, preferring the middle of a pack to a
closer straggler and the crosshair to your back. The orb then steers after that
demon in flight, so the five seconds are spent surviving rather than lining up a
shot. With nothing in sight it simply flies down the crosshair.

You are committed once it starts: the mana is gone, the slot is locked, and
dying loses it. You can still move, sprint, jump, and dash the whole time, and
the cast button falls back to your melee weapon so it is never dead weight.
Upgrades sharpen it (**Deeper Well**, **Wider Sun**) or shorten the ritual
(**Focused Ritual**, −25% charge, floored at 1.5 s — the wait is the spell).

**Meteor Storm** (slot 5, offered from wave 6) tears the sky open in a wide
circle around the mage and rains rock into it for two and a half seconds — five
big meteors and nine small ones, mixed rather than uniform, each one a falling
fireball that explodes where it lands. There is no aiming: the circle is pinned
to the ground you were standing on when you cast it, 11 m out, and most rocks are
steered onto whatever demons are inside it. They fall straight down, so the storm
looks for open sky: a rock whose column is roofed by the bridge, a balcony, or the
top of the outer wall is re-aimed, and only lands up there if the whole circle is
covered — which is also how a demon standing on the bridge gets rained on. Eight
grunts caught in one storm eat roughly 110 damage each; the mage takes none of it.

It is the most expensive thing in the book at **60 mana**, and the only spell in
it that can be cast on a pool that cannot pay. Instead of refusing, the well goes
**negative** — arcane debt, shown as the mana bar refilling backwards in ember
red. The debt is bounded: it may never sink past −50, so a storm that would take
you deeper is refused like any other unaffordable cast. Everything else about it
is punishment. While the pool is under zero *nothing* casts — no fireball, no
beam, no nova, no air jumps — and the staff is the whole arsenal until you climb
out, at 2.5 mana a second on the emergency trickle (a full −50 debt is 20 seconds
of melee) or faster if you can walk over the essence your storm just dropped.
Casting it twice from a full pool is exactly the trade it is built around: one
wave cleared, then twenty seconds with a stick.

**Wyrmlance** (slot 7, offered from wave 5) is the book's only line weapon, and
the only one you *throw* rather than aim-and-hold. One press launches a heavy
**pair** of emerald bolts that braid around each other in a double helix as they
fly — 50 m/s, seven metres of braid in the air at once, 45 m of reach, 17 mana a
throw on a 0.85 s rhythm. They drill through every demon on the line and weaken
for nothing: the tenth takes exactly what the first took.

Two bands decide what a throw is worth. A demon the line runs **through** is in
the core, and every strand sinks into it as its own separate hit — two fangs,
two flashes, two markers a frame apart, 96 damage in one press. One the braid
only **brushes** takes a single thin graze worth a third of that. Anything
further out takes nothing whatsoever, at full price. Nothing else in the book
can spend a whole cast and deal literally zero, and that risk is what buys it
the heaviest single chunk in the game outside the two ultimates.

"Zero area of effect" is a measured promise rather than a flavour note: the
outermost point the spell can touch sits at 1.17 m, which is narrower than the
1.35 m the grunts keep between each other. A dead-centre hit provably cannot
spill onto the demon standing beside it, no upgrade widens that corridor, and a
unit test asserts the inequality still holds after every card in the family is
stacked to its cap. What Widening Coil grows is the *full-damage* band inside
that fixed corridor — forgiveness without area.

The aim is honest, which for this weapon is a mechanic and not a detail. Every
other spell here fires from the mage's hands toward whatever the crosshair
covers; because the hands sit below and beside the camera, that line runs about
0.4 m off the crosshair at mid range. Fireball hides it inside a 3.4 m blast. A
0.56 m core band cannot, so Wyrmlance's axis *is* the crosshair ray, and the
strands are drawn winding out of the two palms onto it over the first couple of
metres. What the crosshair covers is what the braid runs through, at every
distance — the only thing between you and a centred hit is your own aim and the
0.3 s of travel time a moving demon can step out of.

Upgrades: stat boosts (damage/radius/cost/speed, dash, HP, mana), behaviors
(Twin Fireball, Chain Lightning), and synergies — **Burning Touch** (fireball
ignites), **Demonfall Detonation** (fire kills explode, cascading), **Static
Siphon** (lightning kills restore mana), **Arc Battery** (lightning kills
overcharge the beam for +35% damage), **Chain Lightning** (the beam's splash
spreads a demon deeper into the pack), **Tempest Step** (dash discharges a nova), **Deep Freeze**
(the chill bites harder), **Shatter** (chilled demons take +25% damage from
everything), **Focused Ritual** (a shorter Mega Blast gather), **Endless Barrage**
(five more meteors a storm), **Arcane Overdraft** (debt repays twice as fast),
**Serpent's Bite** / **Ophidian Thrift** / **Widening Coil** / **Rifling** (Wyrmlance damage, cost, full-damage band, launch speed), **Third Serpent** (a third head winds into the braid — each fang bites for 78%, but three land where two did), **Essence Overflow** (full-mana essence heals). Damaged enemies show
HP bars; hits flash a directional damage arc around the crosshair.

## Life relics

Health has two sources and they pull in opposite directions. Demons drop small
**health orbs** on death — an 8–10 % roll, 20 HP, collected like essence: a
reward for winning a fight you were already winning.

**Life relics** are the other half, and they only appear *because* the fight is
going badly. Every 5 s of combat the cathedral rolls one, and the roll can only
succeed on a mage who is actually hurt — nothing is ever offered at full health,
because a heal standing unused in a corner is scenery, and scenery is what
teaches players to stop looking around the arena. Whatever is planted stands
across the hall like the Onikiri blade: it does not come to you, it does not rot
on a timer, and the walk over through whatever is in the way is the whole price.
One at a time, at most two a wave, never inside 30 s of each other, and nothing
is banked — anything left standing sinks back into the stone when the wave turns.

- **❤️ Vital Ember** — **+40 HP**, offered below 80 % health, from wave 1, planted
  9–30 m out. Roughly every other wave you spend wounded. A break, not a supply
  line: you are meant to still be in trouble after taking one.
- **💖 Sanguine Font** — **a full restore**, the only thing in the game that hands
  the whole bar back. Offered only below **40 %** health, only from wave 4, and
  planted 14–40 m out behind its own beacon shaft. Roughly one every dozen-odd
  waves — rare enough to be remembered, common enough to be learned.

Both beat like a heart rather than glowing like a lamp, which is how you find one
by the light moving on the stone before you ever see the crystal throwing it. A
relic also *refuses to be wasted*: walk into a font at 90 % health and it stays
dark and stays put (it will not spend a full restore on a scratch), waking up the
moment you are hurt enough for it to be worth taking. The ember is cheaper about
it and answers any real wound.

The arena has 5 elevation bands (pit −3 m, floor 0, platforms 3.5, balconies 7,
bridge 11 + floating stones ~13.4) connected by stairs and drop ledges. Grunts
navigate all of it via a waypoint graph; flying demons deny high-ground camping.
Glowing red rims mark **lethal abyss** breaches — falling in ends the run.

## Graphics

Everything is generated at runtime — there are still no image files in the repo.

**Surfaces** (`src/fx/surfaces.js`) build a height field per material, then derive
albedo, normal, roughness and AO from that one field, so a mortar joint is dark,
dented, rough and occluded *consistently*. Four stone types (ashlar blockwork,
floor flagstone, veined marble, broken rock) plus woven cloth and demon hide.
Noise primitives — tileable value/ridged/Worley, blur, cavity AO, Sobel normals —
live in `src/fx/noise.js`.

**Geometry** (`src/world/stoneGeometry.js`) turns each layout AABB into a
chamfered box with triplanar UVs taken from *world* position, so a 55 m wall and
a 0.4 m trim piece share texel density and the masonry runs continuously between
neighbouring blocks. Per-vertex ambient occlusion is baked at load against a
grid of the collider boxes, so inside corners and stair undersides stay dark
even with screen-space AO off.

**Post** (`src/fx/postfx.js`): render → [GTAO] → bloom → ACES tonemap →
grade (vignette, radial chromatic aberration, film grain, split-toning).
Emissives use channel values above 1.0 so they cross the bloom threshold as real
light rather than bright paint; explosions kick `post.punch()` for an extra beat.

This stage is entirely fill-rate bound, so the presets are budgeted in *pixels*
rather than in features — each caps device pixel ratio and carries a `maxPixels`
backstop so a large window or a 4K display can't quietly triple the cost. Two
things dominate and are switched off by default: **MSAA on a half-float target
costs ~70%**, and bloom does not need native resolution to look like bloom (it
renders at half). Measured at a 1440×900 window on an M4 Air:

| preset | | frame | |
|---|---|---|---|
| `low` | DPR 1, bloom only, no atmosphere | 2.5 ms | 393 fps |
| `medium` *(default)* | DPR 1.25, ½-res bloom, full atmosphere | 4.6 ms | 215 fps |
| `high` | DPR 1.5, adds GTAO | 14.2 ms | 71 fps |

For reference: no post at all is 2.4 ms, and geometry + materials are close to
free — the arena is ~55k triangles in four draw calls.

**Atmosphere** (`src/fx/atmosphere.js`): moonlight shafts through every window,
a volumetric cone under the oculus, GPU-animated dust motes and brazier embers,
and scrolling ground fog. Characters get a Fresnel rim light
(`src/fx/charMaterials.js`) so silhouettes hold against a dark wall.

**Quality** (Settings → Graphics) switches live, no reload — pixel ratio, bloom
resolution, shadow map size, GTAO and atmosphere visibility all rebind on the
spot.

## Tuning (data-driven, PRD §41)

All balance lives in `src/config/`:

- `playerConfig.js` — HP/mana (incl. the overdraft floor), speeds, jump/air
  jumps/dash, camera, `WARD`
  (Mana Shield radius, dps, beat, per-second price), and `SENSE`
  (the needle's chase and slew, the mark's hysteresis, the distance ramp,
  per-second price)
- `spellConfig.js` — spell stats + upgrade-modifier math, plus `AUTO` (the Auto
  Weapon reel: cadence, channel burst, how hard the draw leans on the heavy end,
  the repeat penalty, the splurge mark and the headroom a draw leaves behind),
  including Onikiri's
  binding (how long, what a kill is worth, the ceiling) and how often a blade is
  offered at all (`minWave`, `waveChance`, `minWaveGap`, `minSpawnDist`)
- `enemyConfig.js` — enemy stats + per-wave scaling multipliers
- `waveConfig.js` — authored waves 1-5, endless formula, spawn pacing
- `upgradeConfig.js` — the upgrade pool (weights, stacks, effects)

Arena geometry + nav graph + spawn points: `src/world/arenaLayout.js` (authored
together so navigation always matches architecture). The soundtrack's own
tuning — tempo, harmony, arrangement — lives in `tools/generateMusic.mjs`.

## GODMODE

Type **`GODMODE`** — at the menu, between waves, or mid-fight. There is no
prompt and no menu entry; the letters just have to land in order, at typing
speed. The word is spelled over bound keys (D strafes, M mutes, E casts), so
every keystroke after the opening `G` is swallowed before it reaches the game —
spelling the code out never also strafes, mutes, or fires a spell.

Once it takes:

- **Nothing wounds you.** Every damage source is refused outright, so the run
  cannot end — the abyss included: falling past the kill plane sets you back on
  the cathedral floor instead of killing you.
- **Infinite weapons.** Every spell unlocks at once, every cast is free, the
  mana bar stays full, and cooldowns are halved (floored at 0.1 s — each
  fireball in flight carries its own point light, and an unthrottled hose of
  them is a slideshow, not a power fantasy).
- **Your damage is untouched.** Demons still die at the usual rate; god mode
  only takes the risk away, not the fight.

A gold **⚜ GOD MODE** badge sits under the kill counter, and the HP / mana
readouts change to ∞ for as long as it is on.

**It is irreversible.** Typing the code again does nothing, no upgrade or menu
switches it off, and it carries across `Restart Run` and `Abandon Run` alike.
Reloading the page is the only way back to a mortal wizard. Deaths after
activation are impossible, so a god-mode run never writes a new best wave.

Tunables (cooldown scaling, the sequence itself, the typing timeout) live in
`GOD` in `src/config/playerConfig.js`.

## Debug console (DevTools)

`__ARENA.step(sec)` simulate • `.setWave(n)` jump • `.skipWave()` clear •
`.giveMana()` • `.god()` (same one-way GODMODE) • `.look(yaw,pitch)` •
`.aimAt(v3)` • `.cast()` • `.melee()` • `.shield(on?)` toggle the ward •
`.drainMana()` • `.setMana(v)` (accepts a negative balance) •
`.charging()` read the Mega Blast gather • `.cancelCharge()` •
`.helix()` list the Wyrmlance braids in flight (head / range / struck) •
`.blade()` plant an Onikiri • `.takeBlade()` / `.dropBlade()` bind it, end it •
`.auto(on?)` read or flip the Auto Weapon reel • `.autoDraw()` roll one draw •
`.sense(on?)` open or close the sense • `.senseArrow()` read the bearing
(on / billT / heading / dist / vis / target)

## Structure

```
src/
  config/   all balance data
  core/     input, math
  world/    layout, collision (AABB + step-up), nav graph (A*), scene builder
  player/   controller, wizard model, katana model, third-person camera,
            mana ward, sense bearing
  spells/   caster, projectile (Fireball & meteors), held auto-aimed beam
            (Lightning), thrown piercing braid (Wyrmlance), self-nova (Frost Nova),
            scheduled rain (Meteor Storm),
            arc sweep (Staff Strike / Onikiri)
  enemies/  base, grunt (melee/nav), flyer (aerial/ranged), bolts, models
  pickups/  mana essence & health orbs, life relics (partial/full heals),
            the Onikiri blade in the stone
  flow/     portals, spawn/wave/upgrade managers
  fx/       procedural PBR surfaces, post stack, atmosphere, particles, VFX
  audio/    procedural WebAudio SFX + music library (bundled + uploaded)
  ui/       HUD, menus/upgrade/death screens
electron/ desktop shell (window, arena:// protocol, menu) — no game logic
tools/    offline generators: soundtrack (generateMusic), app icon (generateIcon)
```
