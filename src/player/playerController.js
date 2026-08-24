import * as THREE from 'three';
import { PLAYER } from '../config/playerConfig.js';
import { clamp } from '../core/mathUtils.js';
import { createWizardModel, animateWizard } from './wizardModel.js';

// PlayerController + HealthComponent + ManaComponent (PRD §40 modules folded
// into one class; spells live in SpellCaster).
export class PlayerController {
  constructor(scene, world, events) {
    this.world = world;
    this.events = events; // { onDamaged, onDeath, onLand, onDash, onJump(tier), onManaFail }

    this.pos = new THREE.Vector3(PLAYER.spawnPos.x, PLAYER.spawnPos.y, PLAYER.spawnPos.z);
    this.vel = new THREE.Vector3();
    this.grounded = false;
    this.alive = true;

    this.airJumpsLeft = PLAYER.airJumps; // mid-air jumps left this airborne stretch
    this.airJumpLock = 0;      // brief lockout right after leaving the ground
    this.jumpBuffer = 0;       // a Space tap waiting for the air jump to open up

    this.maxHP = PLAYER.maxHP;
    this.hp = PLAYER.maxHP;
    this.maxMana = PLAYER.maxMana;
    this.mana = PLAYER.startMana;

    this.dashCooldownMult = 1;
    this.dashTimer = 0;        // remaining dash duration
    this.dashCooldown = 0;
    this.dashDir = new THREE.Vector3();
    this.invulnTimer = 0;
    this.essenceOverflow = false; // upgrade: full-mana essence pickups heal
    this.manaDebtRegenMult = 1;   // upgrade: how fast an overdrawn well climbs back
    this.godMode = false;         // GODMODE cheat: unwoundable, bottomless pool

    this.castT = 0;            // cast animation timer (counts down)
    this.aimPitch = 0;
    this.swingT = 0;           // staff-swing animation timer (counts down)
    // Mega Blast: a *held* pose rather than a timer, driven by the caster for
    // as long as the gather lasts. 0 -> 1 across the charge.
    this.charging = false;
    this.charge01 = 0;
    this.swingDur = 0.34;
    this.fallPeakSpeed = 0;

    this.model = createWizardModel();
    this.modelRoot = new THREE.Group();
    this.modelRoot.add(this.model.group);
    // faint hero light so the wizard reads even far from torches
    this.heroLight = new THREE.PointLight(0xc0a8ff, 7, 9, 2);
    this.heroLight.position.set(0, 2.6, 0);
    this.modelRoot.add(this.heroLight);
    scene.add(this.modelRoot);
    this._time = 0;
  }

  reset() {
    this.pos.set(PLAYER.spawnPos.x, PLAYER.spawnPos.y, PLAYER.spawnPos.z);
    this.vel.set(0, 0, 0);
    this.airJumpsLeft = PLAYER.airJumps;
    this.airJumpLock = 0;
    this.jumpBuffer = 0;
    this.maxHP = PLAYER.maxHP;
    this.hp = this.maxHP;
    this.maxMana = PLAYER.maxMana;
    this.mana = PLAYER.startMana;
    this.dashCooldownMult = 1;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.invulnTimer = 0;
    this.essenceOverflow = false;
    this.manaDebtRegenMult = 1;
    this.alive = true;
    // `godMode` is deliberately not cleared here — the cheat outlives the run
    // it was typed in, and there is no way back out of it.
    this.castT = 0;
    this.swingT = 0;
    this.endChargeAnim();
    this.model.group.rotation.set(0, 0, 0);
    this.model.group.position.set(0, 0, 0);
    this._anim = null;
  }

  heal(amount) {
    this.hp = clamp(this.hp + amount, 0, this.maxHP);
  }

  // Empty is not the bottom of the pool: Meteor Storm can overdraw the well,
  // and essence collected while in debt pays the debt down rather than being
  // rounded away at zero.
  get manaFloor() {
    return -this.maxMana * PLAYER.manaFloorFrac;
  }

  get inManaDebt() {
    return this.mana < 0;
  }

  addMana(amount) {
    this.mana = clamp(this.mana + amount, this.manaFloor, this.maxMana);
  }

  // allowOverdraft: the cast may sink the pool below zero, but never past the
  // floor — a storm that would is refused like any other unaffordable spell.
  trySpendMana(amount, allowOverdraft = false) {
    if (this.godMode) return true;
    const floor = allowOverdraft ? this.manaFloor : 0;
    if (this.mana - amount < floor) {
      this.events.onManaFail?.();
      return false;
    }
    this.mana -= amount;
    return true;
  }

  takeDamage(amount, fromPos = null) {
    if (!this.alive || this.godMode || this.invulnTimer > 0) return;
    this.hp -= amount;
    this.events.onDamaged?.(amount, fromPos);
    if (this.hp <= 0) {
      this.hp = 0;
      this.die('slain');
    }
  }

  die(cause) {
    if (!this.alive || this.godMode) return;
    this.alive = false;
    this.events.onDeath?.(cause);
  }

  get dashCooldownTime() {
    return PLAYER.dashCooldown * this.dashCooldownMult;
  }

  get center() {
    return new THREE.Vector3(this.pos.x, this.pos.y + PLAYER.height * 0.55, this.pos.z);
  }

  handWorldPos(side = 1) {
    // right hand, transformed by facing yaw
    const yaw = this.modelRoot.rotation.y;
    const localX = 0.36 * side, localZ = 0.25;
    return new THREE.Vector3(
      this.pos.x + Math.sin(yaw) * localZ + Math.cos(yaw) * localX,
      this.pos.y + PLAYER.handHeight,
      this.pos.z + Math.cos(yaw) * localZ - Math.sin(yaw) * localX
    );
  }

  triggerCastAnim(aimPitch) {
    this.castT = 0.28;
    this.aimPitch = aimPitch;
  }

  returnToSpawn() {
    this.pos.set(PLAYER.spawnPos.x, PLAYER.spawnPos.y, PLAYER.spawnPos.z);
    this.vel.set(0, 0, 0);
    this.fallPeakSpeed = 0;
  }

  // Driven every frame of a Mega Blast charge; endChargeAnim() drops the pose
  // whether the gather went off or was interrupted.
  setChargeAnim(t01) {
    this.charging = true;
    this.charge01 = clamp(t01, 0, 1);
  }

  endChargeAnim() {
    this.charging = false;
    this.charge01 = 0;
    // The pose puts the hands back itself rather than leaving it to the next
    // animateWizard(): dying mid-charge returns early from the death branch, so
    // otherwise the corpse would collapse still burning cold blue.
    for (const m of [this.model.handMatL, this.model.handMatR]) {
      m.emissive.setHex(this.model.handEmissive);
      m.emissiveIntensity = 0;
    }
  }

  triggerSwingAnim(duration) {
    this.swingT = duration;
    this.swingDur = duration;
  }

  // Which melee weapon the model is holding: 'staff', or 'katana' while an
  // Onikiri binding lasts. Pushed by the caster on every change.
  setMelee(id) {
    this.model.setMelee(id);
  }

  update(dt, input, cameraYaw, fx) {
    this._time += dt;
    if (!this.alive) {
      animateWizard(this.model, { dead: true }, dt, this._time);
      return;
    }

    this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.castT = Math.max(0, this.castT - dt);
    this.swingT = Math.max(0, this.swingT - dt);
    this.airJumpLock = Math.max(0, this.airJumpLock - dt);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

    // --- input direction in camera space ---
    let ix = 0, iz = 0;
    if (input.isDown('KeyW')) iz += 1;
    if (input.isDown('KeyS')) iz -= 1;
    if (input.isDown('KeyA')) ix -= 1;
    if (input.isDown('KeyD')) ix += 1;
    const sy = Math.sin(cameraYaw), cy = Math.cos(cameraYaw);
    // camera basis: forward = (sy, 0, cy), right = (-cy, 0, sy)
    const wish = new THREE.Vector3(sy * iz - cy * ix, 0, cy * iz + sy * ix);
    if (wish.lengthSq() > 0) wish.normalize();

    const sprinting = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const maxSpeed = sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;

    // --- dash ---
    const dashPressed = input.wasPressed('ControlLeft') || input.wasPressed('ControlRight') || input.wasPressed('KeyQ');
    if (dashPressed && this.dashCooldown <= 0 && this.dashTimer <= 0) {
      const dir = wish.lengthSq() > 0 ? wish.clone() : new THREE.Vector3(sy, 0, cy);
      this.dashDir.copy(dir);
      this.dashTimer = PLAYER.dashDuration;
      this.dashCooldown = this.dashCooldownTime;
      this.invulnTimer = Math.max(this.invulnTimer, PLAYER.dashInvulnTime);
      this.events.onDash?.();
      fx?.dashPuff(this.pos.clone().add(new THREE.Vector3(0, 0.6, 0)), dir);
    }

    if (this.dashTimer > 0) {
      this.dashTimer -= dt;
      const k = Math.max(0.35, this.dashTimer / PLAYER.dashDuration);
      this.vel.x = this.dashDir.x * PLAYER.dashSpeed * k;
      this.vel.z = this.dashDir.z * PLAYER.dashSpeed * k;
      if (this.grounded) this.vel.y = Math.max(this.vel.y, 0);
    } else {
      // --- normal acceleration ---
      const accel = this.grounded ? PLAYER.groundAccel : PLAYER.airAccel;
      this.vel.x += wish.x * accel * dt;
      this.vel.z += wish.z * accel * dt;

      // friction / drag
      const hv = new THREE.Vector2(this.vel.x, this.vel.z);
      const speed = hv.length();
      if (this.grounded && wish.lengthSq() === 0 && speed > 0) {
        const drop = speed * PLAYER.groundFriction * dt;
        const ns = Math.max(0, speed - drop);
        hv.multiplyScalar(speed > 0 ? ns / speed : 0);
        this.vel.x = hv.x; this.vel.z = hv.y;
      } else if (speed > maxSpeed) {
        hv.multiplyScalar(maxSpeed / speed);
        this.vel.x = hv.x; this.vel.z = hv.y;
      }
    }

    // --- jump (ground, then the mana-paid double and triple jumps) ---
    if (input.wasPressed('Space')) {
      if (this.grounded) {
        this.vel.y = PLAYER.jumpSpeed;
        this.grounded = false;
        this.airJumpsLeft = PLAYER.airJumps;
        this.airJumpLock = PLAYER.airJumpDelay;
        this.jumpBuffer = 0;
        this.events.onJump?.(0);
      } else {
        // Buffered, not spent immediately: a fast double-tap arrives while the
        // launch velocity is still above the air-jump speed, where firing now
        // would cut the arc short. It goes off the moment the lockout clears.
        this.jumpBuffer = PLAYER.jumpBufferTime;
      }
    }
    if (this.jumpBuffer > 0 && !this.grounded && this.airJumpsLeft > 0 && this.airJumpLock <= 0) {
      const tier = PLAYER.airJumps - this.airJumpsLeft + 1; // 1 = double, 2 = triple
      this.jumpBuffer = 0;
      // Paid for like a cast: too little mana and the wizard simply keeps falling
      // (trySpendMana raises the usual insufficient-mana tell).
      if (this.trySpendMana(PLAYER.airJumpCosts[tier - 1])) {
        this.airJumpsLeft--;
        this.airJumpLock = PLAYER.airJumpDelay;
        this.vel.y = PLAYER.airJumpSpeeds[tier - 1]; // absolute, so it also arrests a fall
        this.fallPeakSpeed = 0;         // the fall it cancelled isn't a landing slam
        this.events.onJump?.(tier);
        fx?.airJumpBurst(this.pos.clone(), tier);
      }
    }

    // --- gravity ---
    this.vel.y -= PLAYER.gravity * dt;
    this.vel.y = Math.max(this.vel.y, -PLAYER.terminalFall);
    if (this.vel.y < this.fallPeakSpeed) this.fallPeakSpeed = this.vel.y;

    // --- move & collide ---
    const wasGrounded = this.grounded;
    const res = this.world.moveEntity(
      this.pos, this.vel, dt,
      { radius: PLAYER.radius, height: PLAYER.height, stepHeight: PLAYER.stepHeight },
      this.grounded
    );
    this.grounded = res.grounded;
    // Refilled while standing, so walking off a ledge still leaves one air jump.
    if (this.grounded) this.airJumpsLeft = PLAYER.airJumps;
    if (!wasGrounded && this.grounded) {
      this.events.onLand?.(-this.fallPeakSpeed);
      this.fallPeakSpeed = 0;
    }

    // --- abyss ---
    if (this.pos.y < PLAYER.killPlaneY) {
      // Nothing kills a god — so the abyss hands the wizard back to the floor
      // instead of leaving them falling below the world forever.
      if (this.godMode) this.returnToSpawn();
      else { this.die('abyss'); return; }
    }

    // --- mana ---
    if (this.godMode) {
      this.mana = this.maxMana; // bottomless: casts are free, the bar just stays lit
    } else if (this.mana < PLAYER.manaReserve) {
      // emergency attunement (soft-lock guard) — and, below zero, the only
      // thing besides essence that repays an arcane debt
      const rate = PLAYER.manaReserveRegen * (this.inManaDebt ? this.manaDebtRegenMult : 1);
      this.mana = Math.min(PLAYER.manaReserve, this.mana + rate * dt);
    }

    // --- model transform + animation ---
    this.modelRoot.position.copy(this.pos);
    this.modelRoot.rotation.y = cameraYaw; // model +z aligns with camera forward
    const latVel = this.vel.x * cy - this.vel.z * sy;
    animateWizard(this.model, {
      speed: Math.hypot(this.vel.x, this.vel.z),
      lateral: latVel / PLAYER.sprintSpeed,
      grounded: this.grounded,
      dashing: this.dashTimer > 0,
      castT: this.castT,
      aimPitch: this.aimPitch,
      swingT: this.swingT,
      swingDur: this.swingDur,
      charging: this.charging,
      charge01: this.charge01,
      dead: false,
    }, dt, this._time);
  }
}
