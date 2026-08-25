import * as THREE from 'three';
import { buildLayout } from './world/arenaLayout.js';
import { CollisionWorld } from './world/collisionWorld.js';
import { buildArena } from './world/arenaBuilder.js';
import { NavGraph } from './world/navGraph.js';
import { Input } from './core/input.js';
import { CameraRig } from './player/cameraRig.js';
import { PlayerController } from './player/playerController.js';
import { ManaShield } from './player/manaShield.js';
import { SenseMode } from './player/senseMode.js';
import { SpellCaster } from './spells/spellCaster.js';
import { HelixBolt } from './spells/helixBolt.js';
import { ParticleSystem, LightPool } from './fx/particles.js';
import { Effects } from './fx/effects.js';
import { PostFX } from './fx/postfx.js';
import { AudioEngine } from './audio/audioEngine.js';
import { MusicPlayer } from './audio/musicPlayer.js';
import { Hud } from './ui/hud.js';
import { Menus } from './ui/menus.js';
import { SpawnManager } from './flow/spawnManager.js';
import { Portal } from './flow/portal.js';
import {
  createGruntModel, createFlyerModel, releaseGruntModel, releaseFlyerModel,
} from './enemies/enemyModels.js';
import { WaveManager } from './flow/waveManager.js';
import { UpgradeManager } from './flow/upgradeManager.js';
import { rollDrops, Pickup } from './pickups/pickups.js';
import { BladePickup } from './pickups/bladePickup.js';
import { LifeRelic } from './pickups/lifeRelic.js';
import { WAVE_RULES } from './config/waveConfig.js';
import { SPELLS } from './config/spellConfig.js';
import { LIFE_RELICS, RELIC_RULES, rollLifeRelic } from './config/pickupConfig.js';
import { CONTROLS, GOD } from './config/playerConfig.js';
import { SETTINGS, saveSettings } from './core/settings.js';

const BEST_WAVE_KEY = 'arcane_best_wave';

// Storage can throw outright in private mode and sandboxed frames; a missing
// record is just "no best yet", never a failed boot.
function readBestWave() {
  try {
    const n = Number(localStorage.getItem(BEST_WAVE_KEY));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

// Game states (PRD §36): MENU, PREP, COMBAT, WAVE_COMPLETE, UPGRADE, PAUSE, DEATH.
class Game {
  constructor() {
    const canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.32;

    this.scene = new THREE.Scene();
    // `|| 1`: embedded/backgrounded panes can report a 0×0 window — a 0/0
    // aspect poisons the projection matrix with NaN for the rest of the run.
    this.camera = new THREE.PerspectiveCamera(74, (window.innerWidth / window.innerHeight) || 1, 0.1, 300);

    // world
    this.world = new CollisionWorld();
    this.layout = buildLayout();
    const built = buildArena(this.layout, this.scene, this.world, {
      quality: SETTINGS.quality,
      anisotropy: this.renderer.capabilities.getMaxAnisotropy(),
    });
    this.arenaUpdatables = built.updatables;
    this.setArenaDetail = built.setDetail;
    this.nav = new NavGraph(this.layout.navNodes, this.layout.navEdges);

    // fx
    this.post = new PostFX(this.renderer, this.scene, this.camera, SETTINGS.quality);
    this.particles = new ParticleSystem(this.scene);
    this.lightPool = new LightPool(this.scene, 4);
    this.fx = new Effects(this.scene, this.particles, this.lightPool, this.post);
    this.audio = new AudioEngine();
    // Uploaded background music: library loads from IndexedDB now, playback
    // waits for the first user gesture (autoplay policy).
    this.music = new MusicPlayer(this.audio, { onChange: () => this.onMusicChanged() });
    this.music.load();

    // entities
    this.enemies = [];
    this.projectiles = [];
    this.enemyProjectiles = [];
    this.pickups = [];

    // player & camera
    this.input = new Input(canvas);
    this.cameraRig = new CameraRig(this.camera, this.world);
    this._lastManaFail = -10;
    this.player = new PlayerController(this.scene, this.world, {
      onDamaged: (amount, fromPos) => {
        this.hud.damageFlash(Math.min(1, amount / 25));
        if (fromPos) {
          const p = this.player.pos;
          this.hud.damageFrom(Math.atan2(fromPos.x - p.x, fromPos.z - p.z));
        }
        this.cameraRig.addTrauma(0.3 + Math.min(0.3, amount / 60));
        this.audio.play('playerHit');
      },
      onDeath: (cause) => this.onPlayerDeath(cause),
      onLand: (speed) => { if (speed > 11) { this.audio.play('land'); this.cameraRig.addTrauma(0.12); } },
      onDash: () => {
        this.audio.play('dash');
        // Tempest Step: dashing discharges a static nova
        const L = this.caster.spellState.lightning;
        if (L.unlocked && L.tempest) {
          const stats = this.caster.stats('lightning');
          const c = this.player.center;
          let any = false;
          for (const e of this.enemies) {
            if (!e.alive) continue;
            if (e.center.distanceTo(c) <= stats.tempestRadius + e.cfg.radius) {
              this.fx.lightningArc(c, e.center, true);
              e.takeDamage(stats.tempestDamage, c, 'lightning');
              any = true;
            }
          }
          if (any) this.audio.play('lightningCast');
        }
      },
      onJump: (tier) => this.audio.play(['jump', 'airJump', 'airJump2'][tier]),
      onManaFail: () => {
        if (this.time - this._lastManaFail > 0.5) {
          this._lastManaFail = this.time;
          this.hud.manaInsufficient();
          this.audio.play('manaFail');
        }
      },
    });
    this.caster = new SpellCaster(this);
    this.shield = new ManaShield(this);
    this.sense = new SenseMode(this);

    // flow
    this.spawner = new SpawnManager(this, this.layout.spawnPoints);
    this.waves = new WaveManager(this, this.spawner);
    this.upgrades = new UpgradeManager(this);

    // ui
    this.hud = new Hud();
    this.menus = new Menus({
      onStart: () => this.startRun(),
      onResume: () => this.resumeFromPause(),
      onAbandon: () => this.toMenu(),
      onRestart: () => this.startRun(),
      onToMenu: () => this.toMenu(),
      onQuitBlocked: () => this.hud.toast('Close the browser tab to quit.'),
      onShowMenu: () => this.menus.showMenu(this.stats.bestWave),
      onSettingsChanged: () => {
        this.audio.applySettings();
        this.music.applySettings();
        this.applyGraphicsSettings();
        this.caster.setAuto(SETTINGS.autoWeapon);
      },
      music: this.music,
    });
    // Settings is the one screen where a change can be heard before a run
    // starts, so the first touch there brings the audio graph up — the volume
    // sliders and the music transport are silent without a context.
    document.getElementById('settings-screen').addEventListener('pointerdown', () => {
      this.audio.init();
      this.music.attach();
    }, { capture: true });

    this.state = 'MENU';
    this.stateT = 0;
    this.pausedFrom = 'COMBAT';
    this.stats = { kills: 0, bestWave: readBestWave() };
    // A run stops counting towards the best-wave record the moment a debug hook
    // touches it — setWave teleports past the waves it skips, GODMODE removes
    // the thing being measured. Sticky for the rest of the run.
    this.runTainted = false;
    this._lastBladeWave = -99;   // Onikiri's spacing rule, reset with each run
    this._relicCheckT = 0;       // life-relic roll clock, see maybeOfferRelic
    this._relicsThisWave = 0;
    this._lastRelicAt = -999;
    this.bestWaveAtRunStart = this.stats.bestWave;
    this.time = 0;
    this._emberAcc = 0;
    this._lastToastedTrack = null;
    this._menuAngle = 0;
    this.godMode = false;
    this.input.addCheatCode(GOD.code, () => this.enableGodMode(), GOD.codeTimeout);
    // Auto Weapon is a saved preference, so a run starts however the last one
    // was played. Set straight on the caster: the toast belongs to the toggle.
    this.caster.setAuto(SETTINGS.autoWeapon);

    this.input.onLockChange = (locked) => {
      if (!locked && !this.noAutoPause && (this.state === 'COMBAT' || this.state === 'PREP')) {
        this.pausedFrom = this.state;
        this.setState('PAUSE');
        this.menus.showPause();
      }
      if (locked && this.state === 'PAUSE') {
        this.menus.hideAll();
        this.setState(this.pausedFrom);
      }
    };
    canvas.addEventListener('click', () => {
      if (this.state === 'PAUSE' || this.state === 'COMBAT' || this.state === 'PREP') this.input.requestLock();
    });

    window.addEventListener('resize', () => {
      const w = window.innerWidth, h = window.innerHeight;
      if (w === 0 || h === 0) return; // backgrounded/embedded pane; keep last real size
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.post.setSize(w, h);
    });

    this.menus.showMenu(this.stats.bestWave);
    this._prewarmShaders();
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.frame());

    // debug/verification hooks (harmless in production)
    window.__ARENA = {
      game: this,
      skipWave: () => { for (const e of this.enemies) if (e.alive) e.takeDamage(99999); },
      giveMana: () => this.player.addMana(999),
      setWave: (n) => { if (this.state === 'COMBAT' || this.state === 'PREP') { this.runTainted = true; this.clearEntities(); this.waves.startWave(n); this.setState('PREP'); this.hud.banner(`WAVE ${n}`); } },
      god: () => this.enableGodMode(),
      // Deterministic simulation stepping (testing in throttled/embedded browsers).
      step: (seconds = 1, dt = 1 / 60) => {
        const n = Math.max(1, Math.round(seconds / dt));
        for (let i = 0; i < n; i++) this.frame(dt, i === n - 1);
      },
      look: (yaw, pitch) => { this.cameraRig.yaw = yaw; this.cameraRig.pitch = pitch; },
      key: (code, down = true) => {
        if (down) { this.input.keys.add(code); this.input.pressed.add(code); }
        else this.input.keys.delete(code);
      },
      cast: () => this.caster.tryCast(),
      auto: (on = null) => {
        if (on !== null) this.setAutoWeapon(!!on);
        return { on: this.caster.auto, drawn: this.caster.selected, last: this.caster._autoLast };
      },
      autoDraw: () => this.caster.autoDraw(),
      fire: (on = true) => this.caster.setFiring(on),
      melee: () => this.caster.tryMelee(),
      blade: () => { const at = this.pickPlantSpot(SPELLS.katana.minSpawnDist); if (at) this.pickups.push(new BladePickup(this, at)); },
      relic: (tier = 'ember') => this.spawnRelic(tier),
      takeBlade: () => this.caster.takeBlade(),
      dropBlade: () => this.caster.dropBlade(),
      shield: (on = null) => {
        if (on === null || !!on !== this.shield.active) this.shield.toggle();
        return this.shield.active;
      },
      sense: (on = null) => {
        if (on === null || !!on !== this.sense.active) this.sense.toggle();
        return this.sense.active;
      },
      senseArrow: () => ({
        on: this.sense.active,
        billT: this.sense.billT,
        heading: this.sense.heading,
        dist: this.sense.dist,
        vis: this.sense.vis,
        target: this.sense.target?.cfg?.id ?? null,
      }),
      drainMana: () => { this.player.mana = 0; },
      charging: () => ({ on: this.caster.charging, frac: this.caster.chargeFrac, left: this.caster.chargeRemaining }),
      helix: () => this.projectiles.filter((p) => p instanceof HelixBolt).map((b) => ({
        head: +b.head.toFixed(2), maxRange: +b.maxRange.toFixed(2),
        struck: b.struck.size, strands: b.strandCount,
      })),
      cancelCharge: () => this.caster.cancelCharge(),
      setMana: (v) => { this.player.mana = Math.max(this.player.manaFloor, Math.min(this.player.maxMana, v)); },
      aimAt: (target) => {
        // point the camera so the crosshair ray passes through a world position
        // (iterate: the ray origin is the shoulder camera, which moves with yaw)
        const rig = this.cameraRig;
        let ref = new THREE.Vector3(this.player.pos.x, this.player.pos.y + 1.7, this.player.pos.z);
        for (let i = 0; i < 3; i++) {
          const dx = target.x - ref.x, dz = target.z - ref.z, dy = target.y - ref.y;
          rig.yaw = Math.atan2(dx, dz);
          rig.pitch = -Math.atan2(dy, Math.hypot(dx, dz));
          rig.update(1 / 60, this.player.pos, false);
          ref = rig.getAimPoint().origin;
        }
      },
    };
  }

  // Three compiles a material's shader the first time something is drawn with
  // it, and a demon's hide-plus-rim shader takes a couple of hundred
  // milliseconds to build. Left alone, that bill lands on the frame the first
  // grunt walks out of a portal — mid-fight, once per body type. Pay it here
  // instead, while the menu is still up, by drawing one of everything a wave
  // will show. The bodies go straight into the enemy pool afterwards, so the
  // first two demons of the run reuse them.
  //
  // It has to be a real frame through the post stack, not renderer.compile():
  // the scene is drawn into a linear HDR target rather than onto the canvas,
  // and colour space and tone mapping are both part of a program's cache key,
  // so compiling against the canvas state would warm a set of shaders the game
  // never uses and leave the real ones cold. The bodies sit far below the floor
  // with culling switched off — off screen, but still drawn, which is all a
  // compile needs.
  //
  // This only holds because the rig keeps the scene's light counts fixed: a
  // shader compiled here is keyed to those counts and would be thrown away and
  // rebuilt if a light ever appeared or vanished. See LightPool.
  _prewarmShaders() {
    const below = new THREE.Vector3(0, -60, 0);
    const grunt = createGruntModel();
    const flyer = createFlyerModel();
    const drops = [new Pickup(this, 'mana', below, 1), new Pickup(this, 'health', below, 1)];
    // Kept alive rather than pooled: three throws a compiled program away when
    // the last material using it is disposed, so holding one of each of these
    // forever is what keeps the shader cache warm for the real ones. A portal,
    // one blade in the stone and one font — three objects' worth of memory to
    // never pay for their shaders again.
    const keep = [
      new Portal(this, below, false),
      new BladePickup(this, below),
      new LifeRelic(this, 'font', below),
    ];
    // the mage's own robes, and the katana still sheathed on the rig, are the
    // other cold shaders at run start: the menu camera never has them on screen
    const roots = [
      grunt.root, flyer.root, this.player.modelRoot,
      ...drops.map((d) => d.group), ...keep.map((k) => k.group),
    ];
    const restore = [];
    for (const r of roots) {
      r.traverse((o) => {
        restore.push([o, o.frustumCulled, o.visible]);
        o.frustumCulled = false;
        // Groups too, not just what draws: the sheathed katana hangs off a
        // hidden group until a blade is claimed, and an invisible parent stops
        // the renderer from ever reaching the steel underneath it.
        o.visible = true;
      });
      if (!r.parent) this.scene.add(r);
    }
    grunt.root.position.copy(below);
    flyer.root.position.copy(below);
    try {
      this.post.render(0);
    } catch {
      // a warm-up is an optimisation, never a reason to fail to boot
    }
    for (const [o, culled, visible] of restore) { o.frustumCulled = culled; o.visible = visible; }
    // demons and orbs go to their pools, so the first of each in the run is one
    // of these; the rest are simply parked out of the scene, still referenced
    this.scene.remove(grunt.root);
    this.scene.remove(flyer.root);
    releaseGruntModel(grunt);
    releaseFlyerModel(flyer);
    for (const d of drops) d.dispose();
    for (const k of keep) {
      this.scene.remove(k.group);
      this.lightPool.release(k.lightH);   // a parked object holds no rig slot
      k.lightH = null;
      k.alive = false;                    // and is never updated or claimed
      k.done = true;
    }
    this._warmObjects = keep;
  }

  setState(s) {
    // A held beam can't survive a frozen sim: pause, upgrade, death and the
    // menu all stop calling caster.update(), which would strand the shaft (and
    // its audio loop) in the scene. Wyrmlance needs none of this — a thrown
    // braid lives in `projectiles` and is torn down with everything else.
    if (s !== 'PREP' && s !== 'COMBAT' && s !== 'WAVE_COMPLETE') {
      this.caster?.setFiring(false);
      this.caster?.stopBeam();
    }
    this.state = s;
    this.stateT = 0;
  }

  // MusicPlayer state changed (track, play/pause, library edit). Repaints the
  // settings list when it's on screen, and announces new tracks mid-run.
  onMusicChanged() {
    if (this.menus && !this.menus.settingsScreen.classList.contains('hidden')) {
      this.menus.music.render();
    }
    const t = this.music.current;
    if (!t || !this.music.playing || t.id === this._lastToastedTrack) return;
    this._lastToastedTrack = t.id;
    if (this.hud && ['PREP', 'COMBAT', 'WAVE_COMPLETE'].includes(this.state)) {
      this.hud.toast(`♪ ${t.name}`);
    }
  }

  // Quality changes take effect immediately: the post stack rebuilds its passes
  // and the stone materials swap to a different procedural texture resolution
  // (cached, so flipping back and forth is free after the first generation).
  applyGraphicsSettings() {
    if (this.post.quality === SETTINGS.quality) return;
    this.post.setQuality(SETTINGS.quality);
    this.setArenaDetail?.(SETTINGS.quality);
    this.post.setSize(window.innerWidth, window.innerHeight);
  }

  // ---------- Auto Weapon ----------
  // The reel, bound to X and remembered between runs. main.js owns the tell and
  // the saved preference; the caster owns what the reel actually draws.
  setAutoWeapon(on, reason = 'toggle') {
    const next = !!on;
    if (next === this.caster.auto) return;
    this.caster.setAuto(next);
    SETTINGS.autoWeapon = next;
    saveSettings();
    this.audio.play('spellSwitch');
    if (next) this.hud.toast('\u27f3 Auto Weapon — the book draws, heaviest first (X)');
    else if (reason === 'manual') this.hud.toast('\u27f3 Auto Weapon off — your pick stands (X)');
    else this.hud.toast('\u27f3 Auto Weapon off (X)');
  }

  // ---------- GODMODE ----------
  // Typed anywhere, at any point in a run (or from the menu). One-way on
  // purpose: there is no second sequence that gives the danger back, and it
  // rides through death-less restarts until the page is reloaded.
  enableGodMode() {
    if (this.godMode) return;
    this.godMode = true;
    this.runTainted = true;
    this.applyGodMode();
    this.hud.banner('GOD MODE');
    this.hud.toast('⚜ Ascended — no wound lands, no spell costs. There is no way back.');
    this.audio.play('upgradePick');
  }

  // Re-stamped after every reset(), which wipes HP, mana, and spell unlocks.
  applyGodMode() {
    this.player.godMode = true;
    this.player.hp = this.player.maxHP;
    this.player.mana = this.player.maxMana;
    this.caster.applyGodMode();
  }

  // ---------- run lifecycle ----------
  startRun() {
    this.audio.init();
    this.music.autoStart();
    this.audio.play('uiClick');
    this.clearEntities();
    this.player.reset();
    this.caster.reset();
    this.shield.reset();
    this.sense.reset();
    this.upgrades.reset();
    this.waves.reset();
    this.stats.kills = 0;
    // GODMODE rides through restarts, so a fresh run under it starts tainted.
    this.runTainted = this.godMode;
    this._lastBladeWave = -99;
    this._lastRelicAt = -999;
    this.bestWaveAtRunStart = this.stats.bestWave;
    if (this.godMode) this.applyGodMode();
    this.menus.hideAll();
    this.hud.show();
    this.input.requestLock();
    this.beginWave(1);
  }

  toMenu() {
    this.input.exitLock();
    this.clearEntities();
    this.shield.reset();
    this.sense.reset();         // MENU ticks nothing: a needle left lit would
                                // hang over the flyover for the whole menu
    this.caster.cancelCharge(); // an abandoned run doesn't get to keep its sun
    this.hud.hide();
    this.menus.showMenu(this.stats.bestWave);
    this.setState('MENU');
  }

  beginWave(n) {
    // a storm summoned over the last demon of a wave doesn't rain into the next,
    // and a Mega Blast still gathering when it turns over doesn't cross either
    this.caster.clearPending();
    this.caster.cancelCharge();
    // Onikiri is never banked across a wave: whatever is in hand lapses here,
    // and a blade left standing in the stone sinks back into it.
    this.caster.dropBlade(true);
    for (const p of this.pickups) if (p.isBlade) p.dispose();
    // Relics lapse with the wave too. Left standing they would be banked —
    // walk past three of them, then open wave 12 with a full restore in your
    // pocket — and the whole point of a relic is that you go and get it *now*.
    for (const p of this.pickups) if (p.isRelic) p.dispose();
    this.pickups = this.pickups.filter((p) => p.alive);
    this._relicsThisWave = 0;
    this._relicCheckT = 0;
    this.waves.startWave(n);
    this.recordBestWave();
    this.setState('PREP');
    this.hud.banner(`WAVE ${n}`);
    this.audio.play('waveStart');
    this.maybeOfferBlade(n);
  }

  // ---------- Onikiri ----------
  // One roll per wave, never in the opening waves and never two waves running.
  // The blade is planted, not dropped: it stands across the hall from the mage
  // for the whole wave, and the walk over is what it costs.
  maybeOfferBlade(wave) {
    const cfg = SPELLS.katana;
    if (this.godMode) return;   // the god-mode blade never runs out; a second is noise
    if (wave < cfg.minWave) return;
    if (wave - this._lastBladeWave < cfg.minWaveGap) return;
    if (Math.random() >= cfg.waveChance) return;
    const at = this.pickPlantSpot(cfg.minSpawnDist);
    if (!at) return;
    this._lastBladeWave = wave;
    this.pickups.push(new BladePickup(this, at));
    this.hud.toast(`${cfg.icon} A blade stands in the stone — go and take it`);
    this.audio.play('bladeCall');
  }

  // ---------- life relics ----------
  // Rolled on a clock through the fight rather than once at the wave's start,
  // because the moment a heal matters is the moment the wave is going wrong —
  // and that moment is never the second before the first demon walks out of a
  // portal. The gate itself lives in pickupConfig so it can be reasoned about
  // (and tested) without a renderer.
  maybeOfferRelic(dt) {
    if (this.godMode) return;               // nothing to restore, nothing to offer
    this._relicCheckT += dt;
    if (this._relicCheckT < RELIC_RULES.checkInterval) return;
    this._relicCheckT = 0;

    const tierId = rollLifeRelic({
      wave: this.waves.wave,
      hpFrac: this.player.hp / this.player.maxHP,
      standing: this.pickups.some((p) => p.isRelic && p.alive),
      spawnedThisWave: this._relicsThisWave,
      sinceLastSpawn: this.time - this._lastRelicAt,
    });
    if (!tierId) return;
    this.spawnRelic(tierId);
  }

  spawnRelic(tierId) {
    const tier = LIFE_RELICS[tierId];
    const at = this.pickPlantSpot(tier.minSpawnDist, tier.maxSpawnDist);
    if (!at) return;
    this._relicsThisWave++;
    this._lastRelicAt = this.time;
    this.pickups.push(new LifeRelic(this, tierId, at));
    this.hud.toast(tier.full
      ? `${tier.icon} A ${tier.name} has opened — it will make you whole`
      : `${tier.icon} A ${tier.name} burns somewhere in the hall`);
    this.audio.play('relicCall');
  }

  // Nav nodes are authored standable ground, so anywhere a demon can walk is a
  // fair place to plant something. Anything within `minDist` of the mage is
  // dropped — a gift at your feet is a gift, and these are meant to be a trip.
  // `maxDist` caps the other end: a blade may be all the way across the hall,
  // but a heal offered to a mage at 20 HP should not be a death march.
  pickPlantSpot(minDist, maxDist = Infinity) {
    const from = this.player.pos;
    const far = this.layout.navNodes.filter((n) => {
      const dx = n.pos[0] - from.x, dz = n.pos[2] - from.z;
      const d = Math.hypot(dx, dz);
      return d >= minDist && d <= maxDist;
    });
    const pool = far.length > 0 ? far : this.layout.navNodes;
    if (pool.length === 0) return null;
    const node = pool[Math.floor(Math.random() * pool.length)];
    const [x, y, z] = node.pos;
    const ground = this.world.groundHeight(x, z, y + 2);
    return new THREE.Vector3(x, (ground ?? y) + 0.05, z);
  }

  // Banked on arrival at each wave rather than only on death: a run abandoned
  // from the pause menu, or a tab closed mid-fight, still keeps what it reached.
  // "Reached wave N" is the same number death used to write, just written sooner.
  recordBestWave() {
    if (this.runTainted || this.waves.wave <= this.stats.bestWave) return;
    this.stats.bestWave = this.waves.wave;
    try {
      localStorage.setItem(BEST_WAVE_KEY, String(this.stats.bestWave));
    } catch {
      // private mode / quota: the record still stands for this session
    }
  }

  onWaveComplete() {
    // A gather with nothing left to kill is over: dropping it here also keeps a
    // frozen sun from hanging in the scene behind the upgrade screen.
    this.caster.cancelCharge();
    this.setState('WAVE_COMPLETE');
    this.hud.banner(`WAVE ${this.waves.wave} CLEARED`);
    this.audio.play('waveComplete');
  }

  openUpgradeScreen() {
    this.setState('UPGRADE');
    this.input.exitLock();
    const options = this.upgrades.roll();
    if (options.length === 0) {
      // pool exhausted — just continue
      this.menus.hideAll();
      this.input.requestLock();
      this.beginWave(this.waves.wave + 1);
      return;
    }
    this.menus.showUpgrade(this.waves.wave, options, (id) => {
      const picked = options.find((o) => o.id === id);
      this.upgrades.apply(id);
      this.audio.play('upgradePick');
      this.menus.hideAll();
      if (picked?.id === 'unlock_lightning') this.hud.toast('⚡ Lightning learned — press 2');
      else if (picked?.id === 'unlock_frostnova') this.hud.toast('❄️ Frost Nova learned — press 3');
      else if (picked?.id === 'unlock_meteor') this.hud.toast('☄️ Meteor Storm learned — press 5');
      else if (picked?.id === 'unlock_megablast') this.hud.toast('🔵 Mega Blast learned — press 6, then hold on');
      else if (picked?.id === 'unlock_wyrmlance') this.hud.toast('🧬 Wyrmlance learned — press 7, and line them up');
      else this.hud.toast(`${picked.icon} ${picked.name}`);
      this.input.requestLock();
      this.beginWave(this.waves.wave + 1);
    });
  }

  resumeFromPause() {
    this.input.requestLock(); // onLockChange restores the previous state
  }

  onPlayerDeath(cause) {
    this._deathCause = cause;
    // The ward goes down with the mage. DEATH runs its own update path, which
    // never ticks the shield — without this the bubble hangs over the corpse
    // through the whole death orbit. A Mega Blast mid-gather goes the same way:
    // DEATH never calls caster.update(), so nothing else would ever drop it.
    // The sense is subtler: updateDeath *does* call hud.update but never
    // sense.update, so a needle left with vis > 0 would track the demons
    // circling the corpse. Zeroed here rather than left to fade.
    this.shield.reset();
    this.sense.reset();
    this.caster.cancelCharge();
    this.audio.play('playerDeath');
    this.cameraRig.addTrauma(0.9);
    this.setState('DEATH');
    this.input.exitLock();
    this.recordBestWave(); // normally a no-op: beginWave banked this wave already
    // Which is why "New Best!" compares against where the run started rather
    // than against the record — the record is already this wave.
    const isBest = !this.runTainted && this.waves.wave > this.bestWaveAtRunStart;
    this._deathStats = {
      wave: this.waves.wave,
      kills: this.stats.kills,
      bestWave: this.stats.bestWave,
      newBest: isBest,
    };
    this._deathShown = false;
  }

  onEnemyKilled(enemy, fellInAbyss = false) {
    this.stats.kills++;
    if (!fellInAbyss) {
      rollDrops(this, enemy);
      // Demonfall Detonation: fire kills explode (and can cascade)
      const fire = this.caster.spellState.fireball;
      if (fire.detonation && ['fireball', 'burn', 'detonation'].includes(enemy.lastHitSource)) {
        const stats = this.caster.stats('fireball');
        const at = enemy.center;
        this.fx.explosion(at, stats.detonationRadius);
        this.audio.play('explosion');
        for (const e of this.enemies) {
          if (!e.alive || e === enemy) continue;
          if (e.center.distanceTo(at) <= stats.detonationRadius + e.cfg.radius) {
            e.takeDamage(stats.damage * stats.detonationFrac, at, 'detonation');
          }
        }
      }
    }
    this.waves.onEnemyKilled();
  }

  clearEntities() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    // Demons are disposed here without `alive` ever going false, so a held
    // mark would outlive them as a dangling reference to a disposed body.
    this.sense?.forget();
    for (const p of this.projectiles) if (p.alive) p.dispose();
    this.projectiles.length = 0;
    for (const p of this.enemyProjectiles) p.dispose();
    this.enemyProjectiles.length = 0;
    for (const p of this.pickups) p.dispose();
    this.pickups.length = 0;
    this.spawner.reset();
    this.fx.clear();
    this.particles.clear();
    this.lightPool.clear();
  }

  // ---------- per-frame ----------
  frame(dtOverride = null, render = true) {
    const dt = dtOverride ?? Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    this.stateT += dt;
    const frameInput = this.input.consumeDeltas();

    // atmosphere always alive
    for (const u of this.arenaUpdatables) u(this.time, dt);
    this._emberAcc += dt;
    if (this._emberAcc > 0.08) {
      this._emberAcc = 0;
      for (const rect of this.layout.abyssRects) {
        if (Math.random() < 0.6) this.fx.abyssEmber(rect);
      }
    }

    const s = this.state;
    if (s === 'MENU') {
      this._menuAngle += dt * 0.07;
      const r = 26;
      this.camera.position.set(Math.cos(this._menuAngle) * r, 15, Math.sin(this._menuAngle) * r);
      this.camera.lookAt(0, 2, 0);
    } else if (s === 'PREP' || s === 'COMBAT' || s === 'WAVE_COMPLETE') {
      this.updateGameplay(dt, frameInput);
    } else if (s === 'DEATH') {
      this.updateDeath(dt);
    }
    // PAUSE / UPGRADE: frozen sim, static camera

    this.particles.update(dt);
    this.lightPool.update(dt);
    this.fx.update(dt);
    this.input.endFrame();
    if (render) this.post.render(dt);
  }

  updateGameplay(dt, frameInput) {
    // camera look
    this.cameraRig.applyMouse(frameInput.dx, frameInput.dy);

    // Auto Weapon: X hands the book the trigger, and hands it back.
    if (CONTROLS.autoKeys.some((k) => this.input.wasPressed(k))) {
      this.setAutoWeapon(!this.caster.auto);
    }

    // Spell selection. A pick that lands takes the reel off with it — the very
    // next shot would overwrite it otherwise, and a player reaching for a slot
    // means it. A pick that is *refused* — a locked slot, or a Mega Blast
    // already gathering — changes nothing and must not quietly flip the mode
    // off (and save that as the preference) on the way.
    let picked = 0;
    for (let n = 1; n <= 7; n++) if (this.input.wasPressed(`Digit${n}`)) picked = n;
    if (picked && this.caster.selectSlot(picked)) this.setAutoWeapon(false, 'manual');
    if (frameInput.wheel !== 0 && this.caster.cycle(Math.sign(frameInput.wheel))) {
      this.setAutoWeapon(false, 'manual');
    }

    // Mana Shield: a toggle, not a hold — it bills by the second either way
    if (CONTROLS.shieldKeys.some((k) => this.input.wasPressed(k))) this.shield.toggle();

    // Sense: a toggle like the ward, and billed like it — C opens the sense
    // and C closes it. It kills nothing; it only says which way.
    if (CONTROLS.senseKeys.some((k) => this.input.wasPressed(k))) this.sense.toggle();

    // quick mute
    if (this.input.wasPressed('KeyM')) {
      SETTINGS.muted = !SETTINGS.muted;
      saveSettings();
      this.audio.applySettings();
      this.music.applySettings();
      this.hud.toast(SETTINGS.muted ? '🔇 Muted — M to unmute' : '🔊 Sound on');
    }

    // player + camera
    this.player.update(dt, this.input, this.cameraRig.yaw, this.fx);
    const sprinting = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight');
    this.cameraRig.update(dt, this.player.pos, sprinting && this.player.vel.lengthSq() > 1);

    // casting (hold to fire) — LMB, or a cast key for trackpad players.
    // The keys skip the pointer-lock guard: that guard only exists so the click
    // that re-acquires lock doesn't also fire a spell.
    const casting = (this.input.mouseDown && this.input.pointerLocked)
      || CONTROLS.castKeys.some((k) => this.input.isDown(k));
    this.caster.setFiring(casting);   // held beams live inside caster.update()
    this.caster.update(dt);
    if (casting) this.caster.tryCast();

    // Staff Strike on its own bind, parallel to casting — RMB / V swings
    // whatever spell is selected and whatever the mana pool looks like.
    const swinging = (this.input.rightMouseDown && this.input.pointerLocked)
      || CONTROLS.meleeKeys.some((k) => this.input.isDown(k));
    if (swinging) this.caster.tryMelee();

    // state progression
    if (this.state === 'PREP' && this.stateT >= WAVE_RULES.prepTime) {
      this.setState('COMBAT');
      this.waves.releaseEnemies();
    }
    if (this.state === 'WAVE_COMPLETE' && this.stateT >= 1.5) {
      this.openUpgradeScreen();
      return;
    }

    // entities
    if (this.state === 'COMBAT') {
      this.spawner.update(dt);
      this.maybeOfferRelic(dt);
    }
    for (const e of this.enemies) e.update(dt);
    this.enemies = this.enemies.filter((e) => {
      if (e.removeMe) { e.dispose(); return false; }
      return true;
    });
    for (const p of this.projectiles) p.update(dt);
    this.projectiles = this.projectiles.filter((p) => p.alive);
    for (const p of this.enemyProjectiles) p.update(dt);
    this.enemyProjectiles = this.enemyProjectiles.filter((p) => p.alive);
    for (const p of this.pickups) p.update(dt);
    this.pickups = this.pickups.filter((p) => p.alive);
    for (const t of this.spawner.tasks) t.portal?.update(dt);
    // after the demons have moved, so a beat of the ward measures where they
    // actually are rather than where they stood last frame
    this.shield.update(dt);
    // and for the same reason: a needle drawn from last frame's positions lags
    // the world by a frame on top of everything it is already smoothing. After
    // the removeMe filter too, so the scan never sees a disposed body.
    this.sense.update(dt);

    this.hud.update(this, dt);
  }

  updateDeath(dt) {
    // world keeps breathing around the corpse
    for (const e of this.enemies) e.update(dt);
    this.enemies = this.enemies.filter((e) => {
      if (e.removeMe) { e.dispose(); return false; }
      return true;
    });
    for (const p of this.projectiles) p.update(dt);
    this.projectiles = this.projectiles.filter((p) => p.alive);
    for (const p of this.enemyProjectiles) p.update(dt);
    this.enemyProjectiles = this.enemyProjectiles.filter((p) => p.alive);
    for (const t of this.spawner.tasks) t.portal?.update(dt);
    this.player.update(dt, this.input, this.cameraRig.yaw, this.fx);

    // slow orbit around the fallen wizard
    const a = this.stateT * 0.35;
    const p = this.player.pos;
    const r = 6.5;
    this.camera.position.set(p.x + Math.cos(a) * r, p.y + 3.4, p.z + Math.sin(a) * r);
    this.camera.lookAt(p.x, p.y + 1, p.z);

    this.hud.update(this, dt);
    if (!this._deathShown && this.stateT > 1.7) {
      this._deathShown = true;
      this.menus.showDeath(this._deathStats, this._deathCause);
    }
  }
}

new Game();
