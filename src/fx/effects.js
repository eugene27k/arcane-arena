import * as THREE from 'three';
import { makeRadialGlowTexture } from './textures.js';
import { randRange } from '../core/mathUtils.js';
import { STRAND_WIDTH_PEAK } from '../config/spellConfig.js';

// One-shot visual effects: explosions, lightning arcs, impact sparks,
// portal-style flashes. Managed sprite/line lifetimes live here.
export class Effects {
  constructor(scene, particles, lightPool, post = null) {
    this.scene = scene;
    this.particles = particles;
    this.lights = lightPool;
    // optional post stack: lets a detonation blow out the whole frame for an
    // instant, instead of the bloom only reacting to the sprite it drew
    this.post = post;
    this.transients = []; // { obj, life, maxLife, update(t01) }
    this.beam = null;     // persistent: a held lightning beam
    this.helices = new Set(); // live Wyrmlance braids (more than one may fly)
    this.charge = null;   // persistent: the Mega Blast sun growing in the hands
    this.flashTex = makeRadialGlowTexture('rgba(255,240,220,1)', 'rgba(255,150,60,0)');
    this.blueFlashTex = makeRadialGlowTexture('rgba(230,248,255,1)', 'rgba(90,170,255,0)');
    this.ringTex = makeRingTexture();
    this.beamTex = makeBeamTexture();
    this.filamentTex = makeFilamentTexture();
  }

  _addTransient(obj, life, update) {
    this.scene.add(obj);
    this.transients.push({ obj, life, maxLife: life, update });
  }

  update(dt) {
    let w = 0;
    for (let i = 0; i < this.transients.length; i++) {
      const tr = this.transients[i];
      tr.life -= dt;
      if (tr.life <= 0) {
        this.scene.remove(tr.obj);
        if (tr.obj.material) tr.obj.material.dispose();
        if (tr.obj.geometry) tr.obj.geometry.dispose();
        continue;
      }
      tr.update?.(1 - tr.life / tr.maxLife);
      this.transients[w++] = tr;
    }
    this.transients.length = w;
  }

  clear() {
    this.beamStop();
    for (const h of Array.from(this.helices)) this.helixStop(h);
    this.chargeStop();
    for (const tr of this.transients) {
      this.scene.remove(tr.obj);
      tr.obj.material?.dispose();
      tr.obj.geometry?.dispose();
    }
    this.transients.length = 0;
  }

  // ---------- Fireball explosion ----------
  explosion(pos, radius) {
    this.post?.punch(Math.min(0.85, 0.22 + radius * 0.1));
    // flash sprite
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    flash.position.copy(pos);
    this._addTransient(flash, 0.22, (t) => {
      flash.scale.setScalar(radius * (0.8 + t * 2.2));
      flash.material.opacity = 1 - t;
    });
    // shockwave ring
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.ringTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      color: 0xffa050,
    }));
    ring.position.copy(pos);
    this._addTransient(ring, 0.4, (t) => {
      ring.scale.setScalar(radius * (0.5 + t * 3));
      ring.material.opacity = 0.9 * (1 - t);
    });
    // sparks
    this.particles.burst(pos, 30, () => ({
      pos, life: randRange(0.35, 0.8),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(-0.4, 1), randRange(-1, 1)).normalize().multiplyScalar(randRange(6, 16)),
      size: randRange(0.28, 0.55), sizeEnd: 0.05,
      color: 0xffd090, colorEnd: 0xc03a10, gravity: 12, drag: 1.6,
    }));
    // embers
    this.particles.burst(pos, 16, () => ({
      pos, life: randRange(0.7, 1.4),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(0.3, 1.4), randRange(-1, 1)).multiplyScalar(randRange(2, 5)),
      size: randRange(0.14, 0.3), sizeEnd: 0.02,
      color: 0xff8040, colorEnd: 0x501008, gravity: 3, drag: 0.8,
    }));
    this.lights.flash(pos, 0xff7a30, 320, radius * 6, 0.4);
  }

  // ---------- fireball muzzle + trail helpers ----------
  muzzleFlash(pos, color = 0xffa050) {
    this.lights.flash(pos, color, 60, 7, 0.14);
  }

  fireballTrail(pos) {
    this.particles.spawn({
      pos, life: randRange(0.25, 0.45),
      vel: new THREE.Vector3(randRange(-0.6, 0.6), randRange(-0.4, 0.8), randRange(-0.6, 0.6)),
      size: randRange(0.3, 0.5), sizeEnd: 0.04,
      color: 0xffb060, colorEnd: 0xa02808, drag: 1.5,
    });
  }

  // ---------- Lightning ----------
  lightningArc(from, to, isChain = false) {
    const points = jaggedPath(from, to, isChain ? 8 : 12, isChain ? 0.45 : 0.8);
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const core = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xeaf8ff, blending: THREE.AdditiveBlending, transparent: true,
    }));
    this._addTransient(core, 0.14, (t) => { core.material.opacity = 1 - t; });

    // glow beads along the path (fake thickness)
    for (let i = 0; i < points.length; i += 2) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.blueFlashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
        color: 0x9adcff,
      }));
      s.position.copy(points[i]);
      const base = randRange(0.5, 0.9) * (isChain ? 0.7 : 1);
      this._addTransient(s, 0.16, (t) => {
        s.scale.setScalar(base * (1 - t * 0.5));
        s.material.opacity = 0.85 * (1 - t);
      });
    }
    // impact
    this.particles.burst(to, isChain ? 6 : 12, () => ({
      pos: to, life: randRange(0.15, 0.4),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(-0.5, 1), randRange(-1, 1)).multiplyScalar(randRange(3, 9)),
      size: randRange(0.12, 0.3), sizeEnd: 0.03,
      color: 0xd0f0ff, colorEnd: 0x3060c0, gravity: 6, drag: 2,
    }));
    this.lights.flash(to, 0x86d4ff, 140, 10, 0.16);
  }

  // ---------- Lightning beam (held) ----------
  // The Quake 3 lightning gun's shaft. Three layers, because no one of them
  // reads as a bolt on its own: a camera-facing ribbon for the solid core (a
  // GL line is one pixel wide and a row of sprites reads as beads), two jagged
  // line strands writhing around it for the crackle, and glows pinned at the
  // hand and the impact. Unlike everything else in this file it is
  // *persistent* — built when the beam strikes up, rewritten in place every
  // frame, torn down when the trigger lifts.
  beamStart(color = 0x86d4ff, coreColor = 0xeaf8ff) {
    if (this.beam) this.beamStop();
    const n = BEAM_SEGMENTS + 1;

    // ribbon: a quad strip that twists to face the camera each frame
    const rGeo = new THREE.BufferGeometry();
    rGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const uv = new THREE.BufferAttribute(new Float32Array(n * 2 * 2), 2);
    const index = [];
    for (let i = 0; i < n; i++) {
      const v = i / (n - 1);
      uv.setXY(i * 2, 0, v);
      uv.setXY(i * 2 + 1, 1, v);
      if (i < n - 1) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    rGeo.setAttribute('uv', uv);
    rGeo.setIndex(index);
    const ribbon = new THREE.Mesh(rGeo, new THREE.MeshBasicMaterial({
      map: this.beamTex, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    ribbon.frustumCulled = false; // rewritten per frame; its bounds always lag

    const strands = [];
    for (let i = 0; i < 2; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color, blending: THREE.AdditiveBlending, transparent: true,
        opacity: 0.5, depthWrite: false,
      }));
      line.frustumCulled = false;
      strands.push(line);
    }

    const glow = (c, scale) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.blueFlashTex, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true, color: c,
      }));
      sp.scale.setScalar(scale);
      return sp;
    };
    const muzzle = glow(coreColor, 0.9);
    const impact = glow(color, 1.6);
    // rig slots, not new lights: the scene's point-light count is baked into
    // every lit material's program cache key, so a beam that added two lights
    // would recompile the whole arena each time the trigger is pulled
    const impactLight = this.lights.acquire(4);
    const muzzleLight = this.lights.acquire(4);

    for (const o of [ribbon, ...strands, muzzle, impact]) this.scene.add(o);
    this.beam = { ribbon, strands, muzzle, impact, impactLight, muzzleLight, color, coreColor, t: 0, sparkAcc: 0 };
  }

  // from/to in world space; `hot` = the far end is a demon, not stone.
  beamUpdate(from, to, hot, dt, camera) {
    const beam = this.beam;
    if (!beam) return;
    beam.t += dt;
    const len = from.distanceTo(to);
    // a short beam should not writhe as hard as one at the end of its leash
    const scale = Math.min(1, len / 8);

    // One shared path for the core, so the ribbon and its glows agree; the
    // strands each get their own wilder version of the same run.
    // The core kinks hard enough to read as electricity rather than a hose,
    // and the shaft thickens a little with distance so a beam at the end of its
    // leash doesn't thin out to nothing under perspective.
    buildPath(_beamPath, from, to, 0.26 * scale);
    writeRibbon(beam.ribbon.geometry, _beamPath, camera, 0.045 + 0.016 * Math.min(len, 16));
    beam.ribbon.material.opacity = 0.85 + 0.15 * Math.sin(beam.t * 61);

    for (let i = 0; i < beam.strands.length; i++) {
      const attr = beam.strands[i].geometry.attributes.position;
      buildPath(_beamPath2, from, to, (0.5 + i * 0.22) * scale);
      for (let k = 0; k < _beamPath2.length; k++) {
        const p = _beamPath2[k];
        attr.setXYZ(k, p.x, p.y, p.z);
      }
      attr.needsUpdate = true;
      // out of phase with each other and with the core, so the whole shaft
      // shimmers instead of pulsing as one block
      beam.strands[i].material.opacity = 0.3 + 0.28 * Math.sin(beam.t * (37 + i * 23) + i);
    }

    beam.muzzle.position.copy(from);
    beam.muzzle.scale.setScalar(0.72 + 0.16 * Math.sin(beam.t * 53));
    beam.impact.position.copy(to);
    beam.impact.scale.setScalar((hot ? 1.5 : 1) * (0.9 + 0.25 * Math.sin(beam.t * 47)));
    this.lights.hold(beam.muzzleLight, from, beam.coreColor, 18 + Math.sin(beam.t * 53) * 6, 6);
    this.lights.hold(beam.impactLight, to, beam.color, (hot ? 46 : 24) + Math.sin(beam.t * 47) * 10, 10);

    // continuous spatter off the impact point, paced so a long burn can't
    // swallow the particle budget
    beam.sparkAcc += dt;
    const every = hot ? 0.022 : 0.05;
    while (beam.sparkAcc >= every) {
      beam.sparkAcc -= every;
      this.particles.spawn({
        pos: to, life: randRange(0.1, 0.3),
        vel: new THREE.Vector3(randRange(-1, 1), randRange(-0.4, 1), randRange(-1, 1)).multiplyScalar(randRange(3, 10)),
        size: randRange(0.1, 0.26), sizeEnd: 0.02,
        color: 0xd8f2ff, colorEnd: 0x3060c0, gravity: 7, drag: 2.2,
      });
    }
  }

  beamStop() {
    const beam = this.beam;
    if (!beam) return;
    this.beam = null;
    this.lights.release(beam.impactLight);
    this.lights.release(beam.muzzleLight);
    for (const o of [beam.ribbon, ...beam.strands, beam.muzzle, beam.impact]) {
      this.scene.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
  }


  // ---------- Wyrmlance: the thrown braid ----------
  // Two strands wound around one advancing axis. Everything here draws a *rod*
  // — the segment [tail, head] that the bolt currently occupies — rather than a
  // shaft from the hand to the horizon, so the braid reads as a thrown thing
  // travelling rather than a beam being held.
  //
  // Two hard-won rules live in this block; both were bugs in the channel it
  // replaces, and neither is obvious from the code alone.
  //
  // 1. THE PHASE IS ROD-LOCAL. A rigid corkscrew that merely translates has no
  //    apparent rotation at all. If the phase were keyed to world distance
  //    along the axis (the obvious implementation), a fixed observer would see
  //    it sweep at boltSpeed x twist — around 110 rad/s against a 60 Hz frame
  //    clock — and a two-strand figure with 180-degree symmetry would render as
  //    a frozen or backwards-crawling screw. Keying it to the distance *within
  //    the rod* means the only roll the eye sees is `twistSpin`, which is slow
  //    and cannot alias at any speed or frame rate.
  //
  // 2. THE COIL NEVER TAPERS TO ZERO. A ribbon that faces the camera is built
  //    from cross(tangent, view), which collapses when the tangent points at
  //    the camera — the normal third-person case for a bolt flying away. A helix
  //    is saved from this by its own geometry: its tangent sits atan(r*k) off
  //    the axis, so as long as coilRadius * twist stays well above ~0.4 the
  //    strip keeps its width end-on. The channel version tapered the coil to a
  //    point at the muzzle and vanished for it. Nothing here tapers.
  //
  // There is deliberately no straight core ribbon. A dead-straight camera-facing
  // strip down the axis is the one case the fallback below cannot rescue — its
  // tangent IS the view direction along its whole length — so the axis is left
  // implied by the two strands winding around it.

  helixStart(stats, muzzles) {
    const n = COIL_SEGMENTS + 1;
    const count = stats.strandCount;
    const strands = [];
    for (let i = 0; i < count; i++) {
      const geo = makeRibbonGeometry(n);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: this.filamentTex, color: stats.color,
        blending: THREE.AdditiveBlending, transparent: true,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      mesh.frustumCulled = false; // rewritten per frame; its bounds always lag
      this.scene.add(mesh);
      strands.push(mesh);
    }

    const tip = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.blueFlashTex, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, color: stats.coreColor,
    }));
    tip.scale.setScalar(0.7 + 0.5 * (stats.power01 ?? 0));
    this.scene.add(tip);

    // No PointLight per bolt: changing the scene's point-light count re-keys
    // every material's shader program in three, so a stream of bolts appearing
    // and vanishing recompiles on the way. The pooled flash keeps the count
    // fixed, and bloom carries the glow in flight — which is how everything
    // else in this game is lit.
    this.lights.flash(muzzles[0], stats.color, 46, 9, 0.16);

    const handle = {
      strands, tip,
      color: stats.color, coreColor: stats.coreColor,
      coil: stats.coilRadius,
      halfWidth: stats.strandRadius * (STRAND_WIDTH_PEAK - 0.5 + 0.5 * (stats.power01 ?? 0)),
      twist: stats.twistTurns * Math.PI * 2,   // config is turns/m; work in rad/m
      spin: stats.twistSpin,
      power01: stats.power01 ?? 0,
      trailStep: stats.trailStep,
      lastTrail: 0,
      // The hand-to-hand line, so the braid leaves the two palms rather than
      // some arbitrary world axis. Captured once: the mage keeps moving, the
      // thrown thing does not care.
      splay: new THREE.Vector3().subVectors(muzzles[0], muzzles[1]),
      // Where each strand is actually born. The damage axis is the crosshair
      // ray — which passes near the mage's *eyes*, not their hands — so without
      // this the braid would appear out of thin air above their head. Each
      // strand starts in its own palm and winds onto the axis over the first
      // `openDistance` metres, which is the whole reason that field exists. A
      // third serpent is born between the two hands.
      hands: [muzzles[0].clone(), muzzles[1].clone(),
              new THREE.Vector3().addVectors(muzzles[0], muzzles[1]).multiplyScalar(0.5)],
      openDistance: stats.openDistance,
    };
    this.helices.add(handle);
    return handle;
  }

  helixUpdate(handle, origin, dir, head, tail, t, dt, camera) {
    if (!handle || !this.helices.has(handle)) return;
    const rodLen = Math.max(0.001, head - tail);

    // A stable perpendicular basis, seeded from the hand-to-hand line so the
    // strands emerge from the palms. Falls back the moment the mage happens to
    // be aiming straight down that line.
    _hxSide.copy(handle.splay).addScaledVector(dir, -handle.splay.dot(dir));
    if (_hxSide.lengthSq() < 1e-6) {
      _hxSide.crossVectors(dir, UP);
      if (_hxSide.lengthSq() < 1e-6) _hxSide.set(1, 0, 0);
    }
    _hxSide.normalize();
    _hxUp.crossVectors(dir, _hxSide);

    const count = handle.strands.length;
    for (let sIdx = 0; sIdx < count; sIdx++) {
      const phase0 = handle.spin * t + (sIdx * Math.PI * 2) / count;
      for (let i = 0; i <= COIL_SEGMENTS; i++) {
        const u = i / COIL_SEGMENTS;
        const local = u * rodLen;              // 0..rodLen: the rod-local phase
        const along = tail + local;
        const ph = phase0 + local * handle.twist;
        const c = Math.cos(ph), sn = Math.sin(ph);
        const rx = _hxSide.x * c + _hxUp.x * sn;
        const ry = _hxSide.y * c + _hxUp.y * sn;
        const rz = _hxSide.z * c + _hxUp.z * sn;
        const pt = _coilPath[i] || (_coilPath[i] = new THREE.Vector3());
        let px = origin.x + dir.x * along + rx * handle.coil;
        let py = origin.y + dir.y * along + ry * handle.coil;
        let pz = origin.z + dir.z * along + rz * handle.coil;
        // Wind out of the palm. Only the first frames of a throw have any
        // sample inside openDistance, but those are exactly the frames the
        // camera is pointed at the mage's hands.
        if (along < handle.openDistance) {
          const o = Math.max(0, along) / handle.openDistance;
          const w = o * o * (3 - 2 * o);             // smoothstep, so it leaves cleanly
          const h = handle.hands[Math.min(sIdx, 2)];
          px = h.x + (px - h.x) * w;
          py = h.y + (py - h.y) * w;
          pz = h.z + (pz - h.z) * w;
        }
        pt.set(px, py, pz);
        // The ribbon's fallback frame stays the PURE helix radial even where the
        // position is being blended toward a palm — the blend collapses the coil
        // near the muzzle, and a frame derived from the blended path would
        // collapse with it. This is the whole reason writeHelixRibbon takes the
        // radial as a separate argument.
        const rad = _coilRad[i] || (_coilRad[i] = new THREE.Vector3());
        rad.set(rx, ry, rz);
      }
      _coilPath.length = COIL_SEGMENTS + 1;
      _coilRad.length = COIL_SEGMENTS + 1;
      // The head is the hot end: the strand fades out along the tail, so the
      // braid reads as a thing moving rather than a stick lying in the air.
      writeHelixRibbon(handle.strands[sIdx].geometry, _coilPath, _coilRad, dir, camera, handle.halfWidth);
      handle.strands[sIdx].material.opacity =
        0.7 + 0.25 * handle.power01 + 0.05 * Math.sin(t * (47 + sIdx * 19) + sIdx);
    }

    handle.tip.position.set(
      origin.x + dir.x * head, origin.y + dir.y * head, origin.z + dir.z * head
    );

    // Motes shed off the braid on a DISTANCE clock, so the trail has the same
    // density at 30 fps and 144.
    while (head - handle.lastTrail >= handle.trailStep) {
      handle.lastTrail += handle.trailStep;
      const local = Math.max(0, Math.min(rodLen, handle.lastTrail - tail));
      const ph = handle.spin * t + local * handle.twist + (Math.random() < 0.5 ? 0 : Math.PI);
      const c = Math.cos(ph) * handle.coil, sn = Math.sin(ph) * handle.coil;
      _hxTmp.set(
        origin.x + dir.x * handle.lastTrail + _hxSide.x * c + _hxUp.x * sn,
        origin.y + dir.y * handle.lastTrail + _hxSide.y * c + _hxUp.y * sn,
        origin.z + dir.z * handle.lastTrail + _hxSide.z * c + _hxUp.z * sn
      );
      this.particles.spawn({
        pos: _hxTmp, life: randRange(0.16, 0.4),
        vel: new THREE.Vector3(randRange(-1, 1), randRange(-0.3, 1), randRange(-1, 1)).multiplyScalar(randRange(1.2, 3.4)),
        size: randRange(0.07, 0.19), sizeEnd: 0.01,
        color: 0xc8ffdc, colorEnd: 0x0d6a3a, gravity: 2.2, drag: 2.4,
      });
    }
  }

  // A demon taken by the braid. The core burst is doubled — one flare per fang,
  // the second a beat behind — because that pair is the whole readout.
  helixPierce(handle, x, y, z, core) {
    _hxTmp.set(x, y, z);
    const colour = core ? (handle?.coreColor ?? 0xdcffe9) : (handle?.color ?? 0x2fe08a);
    const n = core ? 16 : 5;
    for (let i = 0; i < n; i++) {
      this.particles.spawn({
        pos: _hxTmp, life: randRange(0.14, core ? 0.4 : 0.22),
        vel: new THREE.Vector3(randRange(-1, 1), randRange(-0.6, 1), randRange(-1, 1))
          .normalize().multiplyScalar(randRange(2, core ? 9 : 4)),
        size: randRange(0.1, core ? 0.3 : 0.16), sizeEnd: 0.01,
        color: colour, colorEnd: 0x0d6a3a, gravity: 5, drag: 2.6,
      });
    }
    if (core) this.lights.flash(_hxTmp, handle?.color ?? 0x2fe08a, 40, 8, 0.14);
  }

  // The braid earths on stone. A scorch and a puff — never damage, never a
  // blast: zero area of effect includes the wall.
  helixScorch(origin, dir, head, handle) {
    _hxTmp.set(
      origin.x + dir.x * head, origin.y + dir.y * head, origin.z + dir.z * head
    );
    for (let i = 0; i < 10; i++) {
      this.particles.spawn({
        pos: _hxTmp, life: randRange(0.15, 0.45),
        vel: new THREE.Vector3(randRange(-1, 1), randRange(0, 1), randRange(-1, 1))
          .normalize().multiplyScalar(randRange(1.5, 5)),
        size: randRange(0.08, 0.2), sizeEnd: 0.01,
        color: 0xc8ffdc, colorEnd: 0x0d6a3a, gravity: 6, drag: 2.4,
      });
    }
    this.lights.flash(_hxTmp, handle?.color ?? 0x2fe08a, 26, 7, 0.12);
  }

  helixStop(handle) {
    if (!handle || !this.helices.has(handle)) return;
    this.helices.delete(handle);
    for (const o of [...handle.strands, handle.tip]) {
      this.scene.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
  }

  // ---------- ignite: licking flames on a burning enemy ----------
  burnFlame(center, radius = 0.5) {
    this.particles.spawn({
      pos: new THREE.Vector3(
        center.x + randRange(-radius, radius) * 0.7,
        center.y + randRange(-0.3, 0.6),
        center.z + randRange(-radius, radius) * 0.7
      ),
      life: randRange(0.25, 0.5),
      vel: new THREE.Vector3(randRange(-0.4, 0.4), randRange(1.2, 2.6), randRange(-0.4, 0.4)),
      size: randRange(0.22, 0.42), sizeEnd: 0.04,
      color: 0xffa040, colorEnd: 0x801808, drag: 1.2,
    });
  }

  // ---------- Frost Nova ----------
  frostNova(pos, radius) {
    // ring sprite: the bright band of ringTex sits at ~0.65 of its half-size, so
    // ~3x radius is where the wave visually lands on the damage edge
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.ringTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      color: 0x9fd8ff,
    }));
    ring.position.copy(pos);
    this._addTransient(ring, 0.5, (t) => {
      ring.scale.setScalar(radius * (0.3 + t * 2.8));
      ring.material.opacity = 0.95 * (1 - t * t);
    });
    // core flash
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.blueFlashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    flash.position.copy(pos);
    this._addTransient(flash, 0.26, (t) => {
      flash.scale.setScalar(radius * (0.5 + t * 1.4));
      flash.material.opacity = 1 - t;
    });
    // ice shards, thrown outward along the ground plane
    this.particles.burst(pos, 34, () => {
      const a = randRange(0, Math.PI * 2);
      return {
        pos, life: randRange(0.4, 0.85),
        vel: new THREE.Vector3(Math.cos(a), randRange(-0.1, 0.35), Math.sin(a)).multiplyScalar(randRange(5, 13)),
        size: randRange(0.16, 0.36), sizeEnd: 0.03,
        color: 0xeaf6ff, colorEnd: 0x1e5a96, gravity: 5, drag: 1.5,
      };
    });
    // lingering chill: slow, heavy mist that sinks
    this.particles.burst(pos, 22, () => {
      const a = randRange(0, Math.PI * 2);
      return {
        pos, life: randRange(0.9, 1.6),
        vel: new THREE.Vector3(Math.cos(a), randRange(-0.2, 0.2), Math.sin(a)).multiplyScalar(randRange(1.5, 4)),
        size: randRange(0.3, 0.6), sizeEnd: 0.06,
        color: 0x9fd8ff, colorEnd: 0x142c4a, gravity: 1.2, drag: 1.1, alpha: 0.7,
      };
    });
    this.lights.flash(pos, 0x9fd8ff, 260, radius * 5, 0.45);
  }

  // ---------- chill: icy wisps drifting off a slowed enemy ----------
  frostMist(center, radius = 0.5) {
    // Ringed *outside* the body, not inside it: this mist sinks instead of
    // rising like burnFlame, so anything spawned in the torso stays there and
    // gets depth-culled by the model for its whole life.
    const a = randRange(0, Math.PI * 2);
    const r = radius * randRange(1.1, 1.6);
    this.particles.spawn({
      pos: new THREE.Vector3(
        center.x + Math.cos(a) * r,
        center.y + randRange(-0.85, 0.15),
        center.z + Math.sin(a) * r
      ),
      life: randRange(0.5, 0.9),
      // cold air falls — the mirror of burnFlame's rising licks
      vel: new THREE.Vector3(Math.cos(a) * 0.5, randRange(-0.9, -0.3), Math.sin(a) * 0.5),
      size: randRange(0.24, 0.44), sizeEnd: 0.03,
      color: 0xcfeaff, colorEnd: 0x1b4a78, drag: 1,
    });
  }

  // ---------- Meteor Storm ----------
  // Cast tell: the circle of ground the rain is about to cover, drawn once so
  // the player can read the storm's edge before the first rock lands.
  meteorSummon(center, radius) {
    const geo = new THREE.RingGeometry(radius * 0.94, radius, 64, 1);
    geo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xff7a30, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    ring.position.set(center.x, center.y + 0.06, center.z);
    this._addTransient(ring, 1.1, (t) => {
      ring.scale.setScalar(0.15 + t * 0.85);
      ring.material.opacity = 0.85 * (1 - t * t);
    });
    // embers dragged up toward the sky the mage just tore open
    this.particles.burst(center, 26, () => {
      const a = randRange(0, Math.PI * 2);
      const r = randRange(0.5, radius * 0.5);
      return {
        pos: new THREE.Vector3(center.x + Math.cos(a) * r, center.y + randRange(-0.4, 0.4), center.z + Math.sin(a) * r),
        life: randRange(0.6, 1.2),
        vel: new THREE.Vector3(randRange(-0.6, 0.6), randRange(5, 11), randRange(-0.6, 0.6)),
        size: randRange(0.2, 0.4), sizeEnd: 0.02,
        color: 0xffb060, colorEnd: 0x902808, drag: 0.9,
      };
    });
    this.lights.flash(new THREE.Vector3(center.x, center.y + 3, center.z), 0xff6a20, 300, 26, 0.6);
  }

  // Impact telegraph: a reticle on the stone that tightens while the rock falls.
  meteorWarning(pos, radius, life) {
    const geo = new THREE.RingGeometry(radius * 0.82, radius, 28, 1);
    geo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xff4a14, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    ring.position.set(pos.x, pos.y + 0.05, pos.z);
    this._addTransient(ring, life, (t) => {
      ring.scale.setScalar(1.5 - t * 0.5);          // closes in on the impact point
      ring.material.opacity = 0.25 + 0.6 * t * t;   // and brightens as it arrives
    });
  }

  // Rock in flight: fire at the head, smoke falling behind it.
  meteorTrail(pos, big = false) {
    this.particles.spawn({
      pos, life: randRange(0.3, 0.6) * (big ? 1.3 : 1),
      vel: new THREE.Vector3(randRange(-0.8, 0.8), randRange(0.4, 1.8), randRange(-0.8, 0.8)),
      size: randRange(0.35, 0.6) * (big ? 1.5 : 0.8), sizeEnd: 0.05,
      color: 0xffc070, colorEnd: 0x8c2408, drag: 1.2,
    });
    if (big && Math.random() < 0.5) {
      this.particles.spawn({
        pos, life: randRange(0.6, 1.1),
        vel: new THREE.Vector3(randRange(-0.5, 0.5), randRange(-0.2, 0.6), randRange(-0.5, 0.5)),
        size: randRange(0.5, 0.9), sizeEnd: 0.2,
        color: 0x603028, colorEnd: 0x140a0a, drag: 0.7, alpha: 0.55,
      });
    }
  }

  // Landing. Same bones as explosion(), but throwing stone: a low dust collar
  // stays on the ground where the rock hit.
  meteorImpact(pos, radius, big = false) {
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    flash.position.copy(pos);
    this._addTransient(flash, big ? 0.3 : 0.2, (t) => {
      flash.scale.setScalar(radius * (0.9 + t * 2.4));
      flash.material.opacity = 1 - t;
    });
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.ringTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      color: 0xff8434,
    }));
    ring.position.copy(pos);
    this._addTransient(ring, big ? 0.55 : 0.35, (t) => {
      ring.scale.setScalar(radius * (0.5 + t * 3.2));
      ring.material.opacity = 0.9 * (1 - t);
    });
    // splinters, thrown up and out
    this.particles.burst(pos, big ? 34 : 16, () => ({
      pos, life: randRange(0.3, 0.8),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(0.2, 1.2), randRange(-1, 1)).normalize().multiplyScalar(randRange(5, big ? 18 : 11)),
      size: randRange(0.2, 0.5), sizeEnd: 0.04,
      color: 0xffd090, colorEnd: 0xa02c0c, gravity: 14, drag: 1.5,
    }));
    // dust collar hugging the stone
    this.particles.burst(pos, big ? 18 : 8, () => {
      const a = randRange(0, Math.PI * 2);
      return {
        pos, life: randRange(0.7, 1.5),
        vel: new THREE.Vector3(Math.cos(a), randRange(0.1, 0.5), Math.sin(a)).multiplyScalar(randRange(2, big ? 7 : 4)),
        size: randRange(0.4, 0.8) * (big ? 1.3 : 1), sizeEnd: 0.12,
        color: 0x6a4438, colorEnd: 0x180c0a, gravity: 1.5, drag: 1.4, alpha: 0.6,
      };
    });
    this.lights.flash(pos, 0xff6a24, big ? 340 : 150, radius * 6, big ? 0.42 : 0.26);
  }

  // ---------- Mega Blast ----------
  // The charge: a sun the mage grows in both hands over five seconds. The
  // second persistent effect in here, built on the same bones as the beam —
  // made once, rewritten in place every frame, torn down on release. Everything
  // about it scales off `t01` so the last second looks nothing like the first.
  chargeStart(color = 0x2f7bff, coreColor = 0xbfe4ff) {
    if (this.charge) this.chargeStop();
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.blueFlashTex, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, color: coreColor,
    }));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.blueFlashTex, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, color, opacity: 0.55,
    }));
    // The containment ring: a hoop around the orb, tumbling faster as the
    // charge fights harder to stay a sphere.
    const ringGeo = new THREE.RingGeometry(0.62, 0.72, 40, 1);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: coreColor, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    // And a second one flat on the stone under the mage, tightening inward —
    // the tell a demon's-eye view of the arena can read from across the hall.
    const floorGeo = new THREE.RingGeometry(0.88, 1, 48, 1);
    floorGeo.rotateX(-Math.PI / 2);
    const floorRing = new THREE.Mesh(floorGeo, new THREE.MeshBasicMaterial({
      color, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    const light = this.lights.acquire(4); // a rig slot — see LightPool
    for (const o of [core, halo, ring, floorRing]) this.scene.add(o);
    this.charge = { core, halo, ring, floorRing, light, color, coreColor, t: 0, moteAcc: 0 };
  }

  // orbPos: where the sun hangs (between the hands); footPos: the mage's boots.
  // t01 runs 0 -> 1 across the whole charge.
  chargeUpdate(orbPos, footPos, t01, dt) {
    const c = this.charge;
    if (!c) return;
    c.t += dt;
    // Growth is eased late: most of the mass arrives in the final second, so a
    // charge interrupted early never looked like it was nearly done.
    const grow = t01 * t01;
    const flicker = 1 + Math.sin(c.t * (14 + 40 * t01)) * 0.06 * t01;
    const size = (0.5 + grow * 2.9) * flicker;

    c.core.position.copy(orbPos);
    c.core.scale.setScalar(size);
    c.core.material.opacity = 0.65 + 0.35 * t01;

    c.halo.position.copy(orbPos);
    c.halo.scale.setScalar(size * 2.1);
    c.halo.material.opacity = (0.2 + 0.4 * t01) * flicker;

    c.ring.position.copy(orbPos);
    c.ring.scale.setScalar(size * 1.5);
    c.ring.rotation.x = c.t * (0.8 + 3 * t01);
    c.ring.rotation.y = c.t * (1.3 + 4 * t01);
    c.ring.material.opacity = 0.25 + 0.6 * t01;

    c.floorRing.position.set(footPos.x, footPos.y + 0.06, footPos.z);
    c.floorRing.scale.setScalar(3.4 - 2.2 * t01);   // closes in as the boom nears
    c.floorRing.rotation.y = -c.t * 1.4;
    c.floorRing.material.opacity = 0.2 + 0.55 * t01;

    this.lights.hold(c.light, orbPos, c.color, (20 + 190 * grow) * flicker, 8 + 12 * t01);

    // Motes of raw mana dragged out of the air and swallowed by the orb. Spawned
    // on a shell and given an inward velocity, so the flow reads as feeding it.
    c.moteAcc += dt * (14 + 46 * t01);
    while (c.moteAcc >= 1) {
      c.moteAcc -= 1;
      const a = randRange(0, Math.PI * 2);
      const pitch = randRange(-0.9, 0.9);
      const r = randRange(1.6, 3.4);
      const dir = new THREE.Vector3(Math.cos(a) * Math.cos(pitch), Math.sin(pitch), Math.sin(a) * Math.cos(pitch));
      const from = orbPos.clone().addScaledVector(dir, r);
      const life = randRange(0.18, 0.34);
      this.particles.spawn({
        pos: from,
        life,
        vel: dir.multiplyScalar(-r / life),   // arrives at the orb as it dies
        size: randRange(0.1, 0.24), sizeEnd: 0.02,
        color: c.coreColor, colorEnd: c.color, drag: 0,
      });
    }
  }

  chargeStop() {
    const c = this.charge;
    if (!c) return;
    this.charge = null;
    for (const o of [c.core, c.halo, c.ring, c.floorRing]) {
      this.scene.remove(o);
      o.geometry?.dispose();
      o.material.dispose();
    }
    this.lights.release(c.light);
  }

  // Release: the held sun tears loose. A hard ring left behind at the hands so
  // the launch has a recoil, not just a projectile appearing.
  megaBlastLaunch(pos, color = 0x2f7bff, coreColor = 0xbfe4ff) {
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.ringTex, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, color: coreColor,
    }));
    ring.position.copy(pos);
    this._addTransient(ring, 0.34, (t) => {
      ring.scale.setScalar(1.5 + t * 9);
      ring.material.opacity = 0.9 * (1 - t);
    });
    this.particles.burst(pos, 26, () => ({
      pos, life: randRange(0.2, 0.5),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(-0.5, 1), randRange(-1, 1)).normalize().multiplyScalar(randRange(4, 12)),
      size: randRange(0.16, 0.34), sizeEnd: 0.03,
      color: coreColor, colorEnd: color, gravity: 3, drag: 2,
    }));
    this.lights.flash(pos, coreColor, 260, 14, 0.22);
  }

  megaBlastTrail(pos) {
    this.particles.spawn({
      pos, life: randRange(0.35, 0.7),
      vel: new THREE.Vector3(randRange(-0.9, 0.9), randRange(-0.5, 1.1), randRange(-0.9, 0.9)),
      size: randRange(0.45, 0.85), sizeEnd: 0.05,
      color: 0xbfe4ff, colorEnd: 0x14307a, drag: 1.3,
    });
    if (Math.random() < 0.4) {
      // cold cinders shed sideways off the orb, the blue answer to fireball soot
      this.particles.spawn({
        pos, life: randRange(0.6, 1.1),
        vel: new THREE.Vector3(randRange(-2.2, 2.2), randRange(-1.4, 0.6), randRange(-2.2, 2.2)),
        size: randRange(0.14, 0.3), sizeEnd: 0.02,
        color: 0x6aa8ff, colorEnd: 0x0a1440, gravity: 4, drag: 1,
      });
    }
  }

  // The boom. explosion()'s bones at ultimate scale, in blue, with a second
  // delayed ring so the shockwave keeps expanding after the flash is gone.
  megaBlastImpact(pos, radius) {
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.blueFlashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    flash.position.copy(pos);
    this._addTransient(flash, 0.42, (t) => {
      flash.scale.setScalar(radius * (0.9 + t * 2.4));
      flash.material.opacity = 1 - t * t;
    });
    for (const [delay, life, tint] of [[0, 0.55, 0xbfe4ff], [0.09, 0.75, 0x4a90ff]]) {
      const ring = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.ringTex, blending: THREE.AdditiveBlending, depthWrite: false,
        transparent: true, color: tint,
      }));
      ring.position.copy(pos);
      this._addTransient(ring, life + delay, (t) => {
        const k = Math.max(0, (t * (life + delay) - delay) / life);
        ring.scale.setScalar(radius * (0.4 + k * 2.8));
        ring.material.opacity = 0.95 * (1 - k) * (k > 0 ? 1 : 0);
      });
    }
    // shards, thrown far — this is the widest blast in the book
    this.particles.burst(pos, 54, () => ({
      pos, life: randRange(0.4, 1),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(-0.3, 1), randRange(-1, 1)).normalize().multiplyScalar(randRange(9, 26)),
      size: randRange(0.3, 0.6), sizeEnd: 0.04,
      color: 0xe4f2ff, colorEnd: 0x123a9a, gravity: 10, drag: 1.4,
    }));
    // a cold shroud that hangs over the crater
    this.particles.burst(pos, 26, () => {
      const a = randRange(0, Math.PI * 2);
      return {
        pos, life: randRange(0.9, 1.7),
        vel: new THREE.Vector3(Math.cos(a), randRange(0, 0.5), Math.sin(a)).multiplyScalar(randRange(3, 9)),
        size: randRange(0.5, 1), sizeEnd: 0.12,
        color: 0x3f6ec0, colorEnd: 0x080c24, gravity: 1, drag: 1.3, alpha: 0.6,
      };
    });
    this.lights.flash(pos, 0x4a90ff, 620, radius * 6, 0.55);
    this.post?.punch(0.9);
  }

  // ---------- generic impact puff (enemy bolts hitting walls, etc.) ----------
  impactPuff(pos, color = 0xc060ff) {
    this.particles.burst(pos, 10, () => ({
      pos, life: randRange(0.2, 0.5),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(0, 1.2), randRange(-1, 1)).multiplyScalar(randRange(2, 6)),
      size: randRange(0.15, 0.3), sizeEnd: 0.03,
      color, colorEnd: 0x201040, gravity: 4, drag: 2,
    }));
    this.lights.flash(pos, color, 40, 6, 0.15);
  }

  // ---------- mana pickup sparkle ----------
  pickupSparkle(pos, color = 0x50d0ff) {
    this.particles.burst(pos, 14, () => ({
      pos, life: randRange(0.3, 0.6),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(0.5, 2), randRange(-1, 1)).multiplyScalar(randRange(2, 5)),
      size: randRange(0.14, 0.3), sizeEnd: 0.02,
      color, colorEnd: 0x104080, gravity: -1.5, drag: 1.4,
    }));
    this.lights.flash(pos, color, 50, 7, 0.25);
  }

  // ---------- enemy death burst ----------
  deathBurst(pos, color = 0x8a1a10) {
    this.particles.burst(pos, 22, () => ({
      pos, life: randRange(0.4, 0.9),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(0.2, 1.5), randRange(-1, 1)).multiplyScalar(randRange(3, 8)),
      size: randRange(0.2, 0.45), sizeEnd: 0.04,
      color, colorEnd: 0x180408, gravity: 7, drag: 1.2,
    }));
  }

  // ---------- portal swirl (called every frame while a portal is open) ----------
  portalSwirl(pos, t) {
    if (Math.random() < 0.5) {
      const a = randRange(0, Math.PI * 2);
      const r = randRange(0.6, 1.4);
      this.particles.spawn({
        pos: new THREE.Vector3(pos.x + Math.cos(a) * r, pos.y + randRange(0, 2.4), pos.z + Math.sin(a) * r),
        life: randRange(0.3, 0.7),
        vel: new THREE.Vector3(-Math.sin(a) * 2.5, randRange(-0.5, 0.5), Math.cos(a) * 2.5),
        size: randRange(0.15, 0.35), sizeEnd: 0.03,
        color: 0xff4a30, colorEnd: 0x600a18, drag: 0.5,
      });
    }
  }

  // ---------- ambient embers over the abyss ----------
  abyssEmber(rect) {
    this.particles.spawn({
      pos: new THREE.Vector3(randRange(rect.x0, rect.x1), randRange(-8, -3), randRange(rect.z0, rect.z1)),
      life: randRange(1.5, 3),
      vel: new THREE.Vector3(randRange(-0.3, 0.3), randRange(0.8, 2), randRange(-0.3, 0.3)),
      size: randRange(0.08, 0.2), sizeEnd: 0.02,
      color: 0xff5020, colorEnd: 0x400804, drag: 0.2,
    });
  }

  // ---------- mid-air jump: an arcane kick-off ring under the feet ----------
  // tier 1 = double jump, tier 2 = triple — twice the mana, so twice the show.
  airJumpBurst(pos, tier = 1) {
    const count = tier === 1 ? 14 : 26;
    const color = tier === 1 ? 0xb490ff : 0xd8a0ff;
    this.particles.burst(pos, count, (i) => {
      const a = (i / count) * Math.PI * 2 + randRange(-0.2, 0.2);
      const speed = randRange(3.5, 6) * (tier === 1 ? 1 : 1.5);
      return {
        pos: new THREE.Vector3(pos.x, pos.y + 0.12, pos.z),
        life: randRange(0.25, 0.5) * (tier === 1 ? 1 : 1.25),
        // flung outward and down — the wizard shoves off the air itself
        vel: new THREE.Vector3(Math.cos(a) * speed, randRange(-2.4, -0.6) * tier, Math.sin(a) * speed),
        size: randRange(0.18, 0.34) * (tier === 1 ? 1 : 1.3), sizeEnd: 0.03,
        color, colorEnd: 0x2a1050, drag: 2.6,
      };
    });
    this.lights.flash(new THREE.Vector3(pos.x, pos.y + 0.3, pos.z), color, 45 * tier, 5 + tier, 0.16 + 0.06 * (tier - 1));
  }

  // ---------- Staff Strike: a crescent sweep carved in front of the mage ----------
  staffSweep(origin, yaw, range, arc, color = 0xc9a6ff) {
    // Ring segment built in the XY plane, laid flat once at construction so the
    // mesh's own Y rotation is free to aim it: after rotateX(-90 deg) theta 0
    // points along +X, hence the yaw - 90 deg offset to centre it on the aim.
    const geo = new THREE.RingGeometry(range * 0.42, range * 0.98, 24, 1, -arc / 2, arc);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.position.copy(origin);
    this._addTransient(mesh, 0.22, (t) => {
      // the whole crescent rotates through the swing — the arc reads as a sweep,
      // not a stamp
      mesh.rotation.y = yaw - Math.PI / 2 + (0.4 - t * 0.8);
      mesh.scale.setScalar(0.88 + t * 0.2);
      mesh.material.opacity = 0.55 * (1 - t) * (1 - t);
    });
    // sparks thrown off the head of the staff, along the arc
    this.particles.burst(origin, 10, () => {
      const a = yaw + randRange(-arc / 2, arc / 2);
      const r = range * randRange(0.5, 0.95);
      return {
        pos: new THREE.Vector3(origin.x + Math.sin(a) * r, origin.y + randRange(-0.2, 0.25), origin.z + Math.cos(a) * r),
        life: randRange(0.14, 0.34),
        vel: new THREE.Vector3(Math.sin(a), randRange(0, 0.7), Math.cos(a)).multiplyScalar(randRange(1.5, 4)),
        size: randRange(0.1, 0.22), sizeEnd: 0.02,
        color, colorEnd: 0x2a1050, drag: 2.6,
      };
    });
    this.lights.flash(origin, color, 35, 6, 0.12);
  }

  // ---------- Mana Shield ----------
  // A demon leaning into the ward: a few sparks struck off its own body, cheap
  // enough to fire for every demon inside the bubble on every beat.
  wardBite(pos, color = 0xe6dcff) {
    this.particles.burst(pos, 5, () => ({
      pos, life: randRange(0.12, 0.3),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(0, 1.2), randRange(-1, 1)).multiplyScalar(randRange(2, 5)),
      size: randRange(0.1, 0.22), sizeEnd: 0.02,
      color, colorEnd: 0x2a1050, gravity: 3, drag: 2.4,
    }));
  }

  // The ward discharging, once per beat that actually landed — a thin ring
  // rolled out along the bubble's own edge (ringTex's bright band sits at ~0.65
  // of its half-size, so ~3x radius is where it reads as the shield surface).
  wardPulse(center, radius, color = 0xa080ff) {
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.ringTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color,
    }));
    ring.position.copy(center);
    this._addTransient(ring, 0.3, (t) => {
      ring.scale.setScalar(radius * (2.6 + t * 0.7));
      ring.material.opacity = 0.5 * (1 - t);
    });
  }

  // ---------- Onikiri ----------
  // The cut. Same crescent grammar as the staff sweep, but doubled: a pale
  // steel arc with a crimson edge riding just outside it, and a hard rotation
  // so the two read as one stroke rather than a stamped cone.
  bladeSweep(origin, yaw, range, arc, color = 0xffe0c0, edgeColor = 0xff4a3a) {
    const crescent = (rIn, rOut, tint, life, opacity) => {
      const geo = new THREE.RingGeometry(range * rIn, range * rOut, 28, 1, -arc / 2, arc);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: tint, blending: THREE.AdditiveBlending, transparent: true,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      mesh.position.copy(origin);
      this._addTransient(mesh, life, (t) => {
        mesh.rotation.y = yaw - Math.PI / 2 + (0.55 - t * 1.25);
        mesh.scale.setScalar(0.9 + t * 0.24);
        mesh.material.opacity = opacity * (1 - t) * (1 - t);
      });
    };
    crescent(0.5, 1.02, color, 0.19, 0.85);
    crescent(0.9, 1.1, edgeColor, 0.26, 0.7);

    // the blood the edge throws, flung along the arc and falling
    this.particles.burst(origin, 16, () => {
      const a = yaw + randRange(-arc / 2, arc / 2);
      const r = range * randRange(0.55, 1.0);
      return {
        pos: new THREE.Vector3(origin.x + Math.sin(a) * r, origin.y + randRange(-0.25, 0.3), origin.z + Math.cos(a) * r),
        life: randRange(0.16, 0.42),
        vel: new THREE.Vector3(Math.sin(a), randRange(0.2, 1.2), Math.cos(a)).multiplyScalar(randRange(3, 8)),
        size: randRange(0.09, 0.2), sizeEnd: 0.02,
        color: 0xfff0e0, colorEnd: edgeColor, gravity: 9, drag: 2.2,
      };
    });
    this.lights.flash(origin, color, 70, 8, 0.11);
  }

  // Claimed from the stone: a ring of steel light snapping shut on the mage.
  bladeClaim(pos, color = 0xff4a3a) {
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.ringTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color,
    }));
    ring.position.copy(pos);
    this._addTransient(ring, 0.5, (t) => {
      ring.scale.setScalar(9 * (1 - t) + 1.2);   // closes inward, unlike an explosion
      ring.material.opacity = 0.9 * t * (1 - t) * 4;
    });
    this.particles.burst(pos, 26, () => ({
      pos, life: randRange(0.4, 0.9),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(0.2, 1.3), randRange(-1, 1)).normalize().multiplyScalar(randRange(3, 9)),
      size: randRange(0.14, 0.3), sizeEnd: 0.03,
      color: 0xfff0e0, colorEnd: color, gravity: 7, drag: 1.8,
    }));
    this.lights.flash(pos, color, 260, 16, 0.5);
  }

  // The binding fails: the same ring, run outward and dying, plus embers off
  // the hand where the steel was.
  bladeLapse(pos, color = 0xff4a3a) {
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.ringTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, color,
    }));
    ring.position.copy(pos);
    this._addTransient(ring, 0.45, (t) => {
      ring.scale.setScalar(1.2 + t * 4.5);
      ring.material.opacity = 0.55 * (1 - t);
    });
    this.particles.burst(pos, 12, () => ({
      pos, life: randRange(0.5, 1.1),
      vel: new THREE.Vector3(randRange(-0.8, 0.8), randRange(0.4, 1.4), randRange(-0.8, 0.8)),
      size: randRange(0.08, 0.16), sizeEnd: 0.02,
      color, colorEnd: 0x2a1010, drag: 1.4,
    }));
    this.lights.flash(pos, color, 70, 8, 0.3);
  }

  // ---------- life relic spent ----------
  // Everything else in the arena blows outward. A relic reads inward: rings
  // closing onto the mage, embers rising instead of falling, and a light warm
  // enough to be legible through the low-HP vignette that is (still) up.
  lifeBloom(pos, color = 0xff4058, full = false) {
    const rings = full ? 2 : 1;
    for (let i = 0; i < rings; i++) {
      const ring = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.ringTex, blending: THREE.AdditiveBlending, depthWrite: false,
        transparent: true, color: i === 0 ? color : 0xffe0d0,
      }));
      ring.position.copy(pos);
      const from = full ? 7.5 : 5;
      const delay = i * 0.14;
      this._addTransient(ring, 0.55 + delay, (t) => {
        const u = Math.max(0, (t * (0.55 + delay) - delay) / 0.55);
        ring.scale.setScalar(from * (1 - u) + 1);
        ring.material.opacity = u <= 0 ? 0 : 0.55 * u * (1 - u) * 4;
      });
    }
    // The pillar a font throws when it empties itself into the mage.
    if (full) {
      const col = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 1.5, 7, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color, blending: THREE.AdditiveBlending, transparent: true,
          depthWrite: false, side: THREE.DoubleSide,
        })
      );
      col.position.set(pos.x, pos.y + 2.6, pos.z);
      this._addTransient(col, 0.6, (t) => {
        col.scale.set(1 - t * 0.55, 1 + t * 0.5, 1 - t * 0.55);
        col.material.opacity = 0.3 * (1 - t) * (1 - t);
      });
    }
    this.particles.burst(pos, full ? 34 : 18, () => ({
      pos, life: randRange(0.5, 1.2),
      vel: new THREE.Vector3(randRange(-1, 1), randRange(1.2, 3.4), randRange(-1, 1))
        .multiplyScalar(randRange(1.2, 2.6)),
      size: randRange(0.1, 0.24), sizeEnd: 0.02,
      color: 0xfff0f0, colorEnd: color, gravity: -1.2, drag: 1.5,
    }));
    this.lights.flash(pos, color, full ? 150 : 70, full ? 14 : 9, full ? 0.5 : 0.32);
  }

  dashPuff(pos, dir) {
    this.particles.burst(pos, 8, () => ({
      pos, life: randRange(0.2, 0.4),
      vel: new THREE.Vector3(-dir.x * randRange(2, 5) + randRange(-1, 1), randRange(0.5, 1.5), -dir.z * randRange(2, 5) + randRange(-1, 1)),
      size: randRange(0.2, 0.4), sizeEnd: 0.05,
      color: 0x9a8ac0, colorEnd: 0x201830, drag: 2,
    }));
  }
}

const UP = new THREE.Vector3(0, 1, 0);
// The rod carries ~2.4 turns; ~20 samples a turn is where the spiral stops
// stairstepping. 2 strands x 49 x 2 verts is a few hundred vertices a bolt —
// less than the single 145-segment shaft the held channel used to draw.
const COIL_SEGMENTS = 48;
// Below RIBBON_MIN_SIN the camera-facing cross product is numerical noise, so
// the ribbon frame is blended toward the coil's own outward radial instead of
// snapping to an arbitrary axis. The radial is exactly perpendicular to the
// helix tangent everywhere, so it is a legal frame rather than a patch, and it
// is what the cross product converges to in the limit — the handover is
// invisible instead of a pop.
const RIBBON_MIN_SIN = 0.34;
const _coilPath = [];
const _coilRad = [];
const _hxSide = new THREE.Vector3();
const _hxUp = new THREE.Vector3();
const _hxTmp = new THREE.Vector3();
const _wrSeg = new THREE.Vector3();
const _wrView = new THREE.Vector3();
const _wrSide = new THREE.Vector3();

const BEAM_SEGMENTS = 13; // few enough that the kinks read as kinks, not noise

// A run of points from one end of the beam to the other, displaced
// perpendicular to the shaft and tapered to nothing at both tips so the bolt
// never detaches from the hand or from the demon it is burning.
const _beamPath = [];
const _beamPath2 = [];
const _bDir = new THREE.Vector3();
const _bPerpA = new THREE.Vector3();
const _bPerpB = new THREE.Vector3();
function buildPath(out, from, to, amplitude) {
  _bDir.subVectors(to, from);
  _bPerpA.crossVectors(_bDir, UP);
  if (_bPerpA.lengthSq() < 1e-6) _bPerpA.set(1, 0, 0);
  _bPerpA.normalize();
  _bPerpB.crossVectors(_bDir, _bPerpA).normalize();
  for (let i = 0; i <= BEAM_SEGMENTS; i++) {
    const t = i / BEAM_SEGMENTS;
    const p = out[i] || (out[i] = new THREE.Vector3());
    p.copy(from).addScaledVector(_bDir, t);
    if (i > 0 && i < BEAM_SEGMENTS) {
      const amp = amplitude * Math.sin(Math.PI * t);
      p.addScaledVector(_bPerpA, randRange(-amp, amp));
      p.addScaledVector(_bPerpB, randRange(-amp, amp));
    }
  }
  out.length = BEAM_SEGMENTS + 1;
}

// Widen a path into a strip that faces the camera: at every point, step sideways
// along the vector perpendicular to both the shaft and the line of sight. This
// is what gives the bolt real thickness — a GL line is one pixel wide however
// close you stand to it.
const _rSeg = new THREE.Vector3();
const _rView = new THREE.Vector3();
const _rSide = new THREE.Vector3();
// The quad strip every ribbon in this file is built on. Two verts a sample, a v
// running 0..1 down its length, indexed once at construction.
function makeRibbonGeometry(n) {
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage); // rewritten every frame
  geo.setAttribute('position', pos);
  const uv = new THREE.BufferAttribute(new Float32Array(n * 2 * 2), 2);
  const index = [];
  for (let i = 0; i < n; i++) {
    const v = i / (n - 1);
    uv.setXY(i * 2, 0, v);
    uv.setXY(i * 2 + 1, 1, v);
    if (i < n - 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geo.setAttribute('uv', uv);
  geo.setIndex(index);
  return geo;
}

// Camera-facing ribbon for a helical path, guarded against the end-on case.
// `radial` is the coil's outward unit vector at each sample; see RIBBON_MIN_SIN.
// The sign is taken from the axis rather than from the (noisy) cross product,
// because a sign flip between adjacent samples bowties the strip.
function writeHelixRibbon(geo, path, radial, axis, camera, halfWidth) {
  const attr = geo.attributes.position;
  const camPos = camera.position;
  const flip = _wrView.subVectors(path[0], camPos).dot(axis) < 0 ? -1 : 1;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    _wrSeg.subVectors(path[Math.min(i + 1, path.length - 1)], path[Math.max(i - 1, 0)]).normalize();
    _wrView.subVectors(p, camPos).normalize();
    _wrSide.crossVectors(_wrSeg, _wrView);
    // both inputs are unit, so |cross| IS the sine of the angle between them
    const sin = _wrSide.length();
    const r = radial[i];
    if (sin < RIBBON_MIN_SIN) {
      // blend, don't switch: pure cross at the threshold, pure radial at zero
      const k = sin / RIBBON_MIN_SIN;
      if (sin > 1e-6) _wrSide.multiplyScalar(k / sin);
      else _wrSide.set(0, 0, 0);
      _wrSide.x += r.x * flip * (1 - k);
      _wrSide.y += r.y * flip * (1 - k);
      _wrSide.z += r.z * flip * (1 - k);
      if (_wrSide.lengthSq() < 1e-8) _wrSide.copy(r);
    }
    _wrSide.normalize().multiplyScalar(halfWidth);
    attr.setXYZ(i * 2, p.x - _wrSide.x, p.y - _wrSide.y, p.z - _wrSide.z);
    attr.setXYZ(i * 2 + 1, p.x + _wrSide.x, p.y + _wrSide.y, p.z + _wrSide.z);
  }
  attr.needsUpdate = true;
}

function writeRibbon(geo, path, camera, halfWidth) {
  const attr = geo.attributes.position;
  const camPos = camera.position;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    _rSeg.subVectors(path[Math.min(i + 1, path.length - 1)], path[Math.max(i - 1, 0)]);
    _rView.subVectors(p, camPos);
    _rSide.crossVectors(_rSeg, _rView);
    if (_rSide.lengthSq() < 1e-8) _rSide.set(1, 0, 0);
    _rSide.normalize().multiplyScalar(halfWidth);
    attr.setXYZ(i * 2, p.x - _rSide.x, p.y - _rSide.y, p.z - _rSide.z);
    attr.setXYZ(i * 2 + 1, p.x + _rSide.x, p.y + _rSide.y, p.z + _rSide.z);
  }
  attr.needsUpdate = true;
}

// Cross-section of the bolt: a white-hot filament bleeding out to blue.
function makeBeamTexture(w = 64) {
  const c = document.createElement('canvas');
  c.width = w; c.height = 4;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(60,150,255,0)');
  grad.addColorStop(0.28, 'rgba(120,200,255,0.55)');
  grad.addColorStop(0.46, 'rgba(235,250,255,1)');
  grad.addColorStop(0.54, 'rgba(235,250,255,1)');
  grad.addColorStop(0.72, 'rgba(120,200,255,0.55)');
  grad.addColorStop(1, 'rgba(60,150,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Cross-section of the braid. Neutral white, unlike the bolt's blue one, so the
// strand and core materials can tint the same map to two different greens.
function makeFilamentTexture(w = 64) {
  const c = document.createElement('canvas');
  c.width = w; c.height = 4;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.4)');
  grad.addColorStop(0.48, 'rgba(255,255,255,1)');
  grad.addColorStop(0.52, 'rgba(255,255,255,1)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function jaggedPath(from, to, segments, amplitude) {
  const points = [];
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  const perpA = new THREE.Vector3().crossVectors(dir, UP).normalize();
  if (perpA.lengthSq() < 0.01) perpA.set(1, 0, 0);
  const perpB = new THREE.Vector3().crossVectors(dir, perpA).normalize();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = new THREE.Vector3().copy(from).addScaledVector(dir, t);
    if (i > 0 && i < segments) {
      const amp = amplitude * Math.sin(Math.PI * t) * (len / 12);
      p.addScaledVector(perpA, randRange(-amp, amp));
      p.addScaledVector(perpB, randRange(-amp, amp));
    }
    points.push(p);
  }
  return points;
}

function makeRingTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
