// Wyrmlance's projectile: a heavy PAIR of bolts braided around one axis.
//
// Deliberately not a `Projectile`. That class stops at the first thing it hits
// and detonates a blast radius — the exact opposite weapon. This one passes
// through everything on its line, weakens for nothing, and never spreads
// sideways at all.
//
// THE BRAID IS DRAWN; THE AXIS BITES. It is tempting to give each rendered
// strand its own hitbox and let "both fangs land on a centred demon" fall out
// of the geometry. It does not work. A strand only reaches a given azimuth once
// per turn, so whether a particular demon is swept by one strand or two depends
// on the sub-metre phase the braid happens to be at when it arrives — two
// identical shots would deal different damage for reasons the player cannot
// see. Tighten the twist until both strands always sweep every azimuth in range
// and the distinction collapses to all-or-nothing instead. Either way the
// gradient is a fiction. So damage is resolved against the axis in two bands,
// and the pair is made real where it can be made *reliable*: a core hit spends
// one separate `takeDamage` per strand, so the demon is bitten twice, flashes
// twice and thuds twice, every single time.
//
// The rod, not the point. The pair occupies `braidLength` metres behind its
// head. That is what makes it read as a thrown thing rather than a dot, and it
// is also the anti-tunnelling margin: the swept band each frame is the rod or
// the frame's travel, whichever is longer, so nothing slips between two frames
// however fast the bolt flies or however badly the frame hitches.
export class HelixBolt {
  constructor(game, stats, origin, dir, maxRange, hitStone, muzzles) {
    this.game = game;
    this.origin = origin.clone();
    this.dir = dir.clone();
    this.maxRange = maxRange;
    this.hitStone = hitStone;   // did the run end on a wall, or just run out?
    this.speed = stats.boltSpeed;
    this.lifeTime = stats.lifeTime;
    this.head = 0;
    this.t = 0;
    this.alive = true;

    this.strandCount = stats.strandCount;
    this.strandDamage = stats.damage;      // per fang
    this.grazeDamage = stats.grazeDamage;
    this.coreRadius = stats.coreRadius;
    this.coreGirthFrac = stats.coreGirthFrac;
    this.sleeveRadius = stats.sleeveRadius;
    this.braidLength = stats.braidLength;
    this.wallTrauma = stats.wallTrauma;

    // One allocation for the bolt's whole life. Every demon it has already
    // bitten lives here, so a body sitting inside the rod for three frames is
    // struck once, not three times.
    this.struck = new Set();
    // The second fang lands a frame later than the first, so a centred hit
    // *marks* twice. -1 = nothing pending.
    this._markT = -1;
    this._markKill = false;

    this.fx = game.fx.helixStart(stats, muzzles);
  }

  update(dt) {
    if (!this.alive) return;
    this.t += dt;

    this._flushMark(dt);

    if (this.t >= this.lifeTime) { this._expire(false); return; }

    const head0 = this.head;
    this.head = Math.min(this.maxRange, this.head + this.speed * dt);
    // The band swept this frame: the rod, or the distance travelled, whichever
    // covers more. Without the max() a fast bolt on a slow frame would step
    // clean over a demon standing between two rod positions.
    const tail = this.head - Math.max(this.braidLength, this.head - head0);

    this._scan(tail);
    this.game.fx.helixUpdate(this.fx, this.origin, this.dir, this.head, tail, this.t, dt, this.game.camera);

    if (this.head >= this.maxRange) { this._expire(this.hitStone); return; }
  }

  // One sweep of the rod. Walks every live demon once, sorts it into the core
  // band, the sleeve, or neither, purely by perpendicular distance from the
  // axis. No sqrt, no allocation, no line-of-sight test — the run was already
  // bounded by stone at spawn, so everything inside `maxRange` is clear air.
  _scan(tail) {
    const enemies = this.game.enemies;
    const ox = this.origin.x, oy = this.origin.y, oz = this.origin.z;
    const dx = this.dir.x, dy = this.dir.y, dz = this.dir.z;
    let anyCore = false, anyGraze = false, anyKill = false;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive || this.struck.has(e)) continue;

      // Enemy centre, inline. `e.center` builds a fresh Vector3 on every read,
      // and this runs for every demon on every frame of every bolt in flight.
      const cx = e.pos.x;
      const cy = e.pos.y + e.cfg.height * 0.55;
      const cz = e.pos.z;
      const vx = cx - ox, vy = cy - oy, vz = cz - oz;
      const along = vx * dx + vy * dy + vz * dz;
      const r = e.cfg.radius;

      if (along + r < tail) continue;       // the rod has already gone past them
      if (along - r > this.head) continue;  // the rod has not reached them yet
      if (along < -r) continue;             // behind the mage: the line runs one way

      const perp2 = vx * vx + vy * vy + vz * vz - along * along;
      const outer = this.sleeveRadius + r;
      if (perp2 > outer * outer) continue;  // outside both bands — untouched

      const coreLim = this.coreRadius + r * this.coreGirthFrac;
      const core = perp2 <= coreLim * coreLim;

      // Marked before it is damaged, so a demon this bolt kills still counts as
      // already bitten and can never be re-entered by a later frame.
      this.struck.add(e);

      if (core) {
        // The pair, as a mechanical fact rather than a picture: one bite per
        // strand. Silent — the bolt plays its own doubled voice instead of
        // stacking N copies of the generic hit sting on a single frame.
        for (let s = 0; s < this.strandCount; s++) {
          if (!e.alive) break;              // a later fang is wasted on a corpse
          e.takeDamage(this.strandDamage, this.origin, 'wyrmlance', true);
        }
        anyCore = true;
      } else {
        e.takeDamage(this.grazeDamage, this.origin, 'wyrmlance', true);
        anyGraze = true;
      }
      if (!e.alive) anyKill = true;
      this.game.fx.helixPierce(this.fx, cx, cy, cz, core);
    }

    // Silence is the tell: a whiff spends a full cast and reports nothing.
    if (anyCore) {
      // A pierce can core demons on consecutive frames. Land any marker still
      // owed from the last one before arming this one, or every demon in the
      // line but the last would silently lose the second half of its pair.
      this._flushMark(Infinity);
      this.game.hud.hitmarker(anyKill);
      this._markT = 0.028;                  // the second fang, a frame behind
      this._markKill = anyKill;
      this.game.audio.play('wyrmBite');
    } else if (anyGraze) {
      this.game.hud.hitmarker(anyKill);
      this.game.audio.play('wyrmGraze');
    }
  }

  // Land a second-fang marker that is due, or overdue. `dt` of Infinity forces
  // it — used when something is about to make the pending one unreachable.
  _flushMark(dt) {
    if (this._markT < 0) return;
    this._markT -= dt;
    if (this._markT <= 0) { this.game.hud.hitmarker(this._markKill); this._markT = -1; }
  }

  // The run ends. Nothing is damaged here — zero area of effect includes the
  // wall it earths on.
  _expire(onStone) {
    if (!this.alive) return;
    this.alive = false;
    // update() will never run again, so anything still owed lands now: a
    // centred kill on the last frame of a run must still read as a pair.
    this._flushMark(Infinity);
    if (onStone) {
      const g = this.game;
      g.fx.helixScorch(this.origin, this.dir, this.head, this.fx);
      g.audio.play('wyrmWall');
      g.cameraRig.addTrauma(this.wallTrauma);
    }
    this.dispose();
  }

  // Idempotent: the run-reset teardown disposes everything still in flight, and
  // a bolt that expired on the same frame must not free its handle twice.
  dispose() {
    this.alive = false;
    if (!this.fx) return;
    this.game.fx.helixStop(this.fx);
    this.fx = null;
  }
}
