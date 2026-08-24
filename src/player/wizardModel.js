import * as THREE from 'three';
import { applyRimLight, dressCloth, dressMetal } from '../fx/charMaterials.js';
import { createKatana } from './katanaModel.js';

// Stylized dark-fantasy wizard built from primitives (PRD §6: hooded robe,
// glowing hands, casts with hands). Procedural animation: run bob, cast arm,
// dash lean, airborne pose, death collapse.
export function createWizardModel() {
  const group = new THREE.Group();

  const robeMat = new THREE.MeshStandardMaterial({ color: 0x2c2140, roughness: 0.85 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x4a3868, roughness: 0.7, emissive: 0x2a1a50, emissiveIntensity: 0.4 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x16101f, roughness: 0.95 });
  const handMat = new THREE.MeshStandardMaterial({ color: 0xd8c8b8, roughness: 0.6, emissive: 0xff8830, emissiveIntensity: 0 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x86d4ff });

  // Woven wool on the robe, plus an arcane rim so the hooded silhouette still
  // reads when the wizard is standing in an unlit corner of the hall.
  dressCloth(robeMat, { repeat: 3.2, normalScale: 0.9 });
  dressCloth(trimMat, { repeat: 4, normalScale: 0.55 });
  applyRimLight(robeMat, { color: 0x7d5cff, power: 2.4, strength: 0.55 });
  applyRimLight(trimMat, { color: 0x9a7bff, power: 2.2, strength: 0.6 });
  applyRimLight(darkMat, { color: 0x4a3a80, power: 3.0, strength: 0.35 });
  applyRimLight(handMat, { color: 0xffb070, power: 2.0, strength: 0.5 });

  // robe (flared cone)
  const robe = new THREE.Mesh(new THREE.ConeGeometry(0.52, 1.42, 9), robeMat);
  robe.position.y = 0.71;
  group.add(robe);

  // torso / chest
  const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, 0.52, 8), robeMat);
  chest.position.y = 1.28;
  group.add(chest);

  // sash
  const sash = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.4), trimMat);
  sash.position.y = 1.0;
  group.add(sash);

  // shoulders
  const shoulderGeo = new THREE.SphereGeometry(0.15, 8, 6);
  const shL = new THREE.Mesh(shoulderGeo, trimMat);
  shL.position.set(-0.34, 1.5, 0);
  const shR = new THREE.Mesh(shoulderGeo, trimMat);
  shR.position.set(0.34, 1.5, 0);
  group.add(shL, shR);

  // hood + shadowed face + glowing eyes
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.52, 8), robeMat);
  hood.position.y = 1.86;
  group.add(hood);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), darkMat);
  head.position.y = 1.7;
  group.add(head);
  const eyeGeo = new THREE.SphereGeometry(0.028, 6, 5);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.07, 1.72, 0.15);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeR.position.set(0.07, 1.72, 0.15);
  group.add(eyeL, eyeR);

  // arms (pivot at shoulder, hang down by default)
  const makeArm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.36 * side, 1.5, 0);
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.62, 7), robeMat);
    upper.position.y = -0.31;
    pivot.add(upper);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), handMat.clone());
    hand.position.y = -0.68;
    pivot.add(hand);
    return { pivot, hand };
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);
  group.add(armL.pivot, armR.pivot);

  // The staff: parented to the right arm's shoulder pivot, so it carries,
  // points on a cast, and sweeps on a melee strike without any extra rigging.
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.9 });
  dressMetal(woodMat, { repeat: 3, normalScale: 0.8 });
  applyRimLight(woodMat, { color: 0x8a6aff, power: 2.6, strength: 0.4 });
  const crystalMat = new THREE.MeshStandardMaterial({
    color: 0x8a6ad0, roughness: 0.25, emissive: 0xc9a6ff, emissiveIntensity: 1.1,
  });
  const staff = new THREE.Group();
  staff.position.y = -0.55;   // grip sits at the hand
  staff.rotation.x = 0.1;     // head leans back a touch
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.7, 6), woodMat);
  staff.add(shaft);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.07, 6), trimMat);
  collar.position.y = 0.78;
  staff.add(collar);
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.11), crystalMat);
  crystal.position.y = 0.93;
  staff.add(crystal);
  armR.pivot.add(staff);

  // Onikiri hangs from the same shoulder pivot as the staff, and exactly one of
  // the two is ever visible — so a claimed blade sweeps on the identical rig,
  // with no second animation path to keep in step.
  const katana = createKatana();
  katana.group.position.y = -0.74;  // grip closed in the fist
  katana.group.rotation.x = 0.12;
  katana.group.visible = false;
  armR.pivot.add(katana.group);

  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });

  return {
    group,
    armL, armR,
    staff, crystal, katana,
    parts: { robe, hood },
    handMatR: armR.hand.material,
    handMatL: armL.hand.material,
    // What the hands burn when nothing is being charged — the Mega Blast pose
    // swaps them cold and has to have something to put back.
    handEmissive: handMat.emissive.getHex(),
    crystalMat,
    // 'staff' | 'katana' — which weapon the hand is holding right now
    setMelee(id) {
      const blade = id === 'katana';
      staff.visible = !blade;
      katana.group.visible = blade;
    },
  };
}

// Mega Blast burns the hands cold; the pose swaps to this and back on release.
const CHARGE_HAND_EMISSIVE = 0x4a9cff;

// 0..1 ease, flat at both ends
function smoothstep(t) {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

export function animateWizard(model, anim, dt, time) {
  const { armL, armR, group } = model;
  const speedFactor = Math.min(1, anim.speed / 7);

  if (anim.dead) {
    // collapse: sink + tip forward
    anim.deathT = Math.min(1, (anim.deathT ?? 0) + dt * 1.2);
    group.rotation.x = anim.deathT * 1.35;
    group.position.y = -anim.deathT * 0.5;
    return;
  }
  group.rotation.x = 0;
  group.position.y = 0;

  // run bob + lean
  const bob = anim.grounded ? Math.sin(time * 11) * 0.05 * speedFactor : 0;
  group.position.y = bob + (anim.grounded ? 0 : 0.05);
  group.rotation.z = -anim.lateral * 0.07;
  const forwardLean = anim.dashing ? 0.34 : speedFactor * 0.12;
  group.rotation.x = forwardLean;

  // arms: idle sway / run swing; cast overrides right arm
  const swing = anim.grounded ? Math.sin(time * 11) * 0.55 * speedFactor : 0.25;
  armL.pivot.rotation.x = swing;
  if (anim.castT > 0) {
    // raise toward aim pitch
    const raise = Math.min(1, anim.castT / 0.09);
    armR.pivot.rotation.x = -(Math.PI / 2) * raise - anim.aimPitch * 0.7 * raise;
    model.handMatR.emissiveIntensity = 2.4 * raise;
  } else {
    armR.pivot.rotation.x = -swing;
    model.handMatR.emissiveIntensity = Math.max(0, model.handMatR.emissiveIntensity - dt * 8);
  }
  // secondary hand glow while charging/holding
  model.handMatL.emissiveIntensity = Math.max(0, model.handMatL.emissiveIntensity - dt * 8);

  if (!anim.grounded) {
    armL.pivot.rotation.z = 0.5;
    armR.pivot.rotation.z = -0.5;
  } else {
    armL.pivot.rotation.z = 0.12;
    armR.pivot.rotation.z = -0.12;
  }

  // Staff Strike — applied last, so it wins over the idle swing and the cast
  // pose. With the arm pitched to about -90 deg the pivot's Z rotation reads as
  // a flat arc in front of the wizard: the same sweep the hitbox measures.
  if (anim.swingT > 0) {
    const s = 1 - anim.swingT / anim.swingDur;
    let pitch, sweep, charge;
    if (s < 0.24) {                                   // cock back over the shoulder
      const k = smoothstep(s / 0.24);
      pitch = -1.2 * k; sweep = 1.2 * k; charge = k;
    } else if (s < 0.55) {                            // the sweep itself
      const k = smoothstep((s - 0.24) / 0.31);
      pitch = -1.2 - 0.22 * Math.sin(k * Math.PI);
      sweep = 1.2 - 2.5 * k; charge = 1;
    } else {                                          // recover to a carry
      const k = smoothstep((s - 0.55) / 0.45);
      pitch = -1.2 * (1 - k); sweep = -1.3 * (1 - k); charge = 1 - k;
    }
    armR.pivot.rotation.x = pitch;
    armR.pivot.rotation.z = sweep;
    group.rotation.y = -sweep * 0.16;                 // torso follows through
    model.crystalMat.emissiveIntensity = 1.1 + 2.6 * charge;
    model.katana.edgeMat.emissiveIntensity = 1.15 + 3.6 * charge;
  } else {
    group.rotation.y = 0;
    model.crystalMat.emissiveIntensity = Math.max(1.1, model.crystalMat.emissiveIntensity - dt * 6);
    model.katana.edgeMat.emissiveIntensity = Math.max(1.15, model.katana.edgeMat.emissiveIntensity - dt * 7);
  }
  // Mega Blast — the held pose, applied after everything else because it is the
  // one animation that lasts seconds rather than frames. Both arms come up and
  // close around the sun growing between the hands, which burn colder and
  // brighter as it fills. The right arm yields to a staff sweep mid-charge (the
  // mage can still swat with one hand); the left keeps cradling it throughout.
  if (anim.charging) {
    const k = anim.charge01;
    // a tremor that tightens with the charge — holding it gets harder
    const tremor = Math.sin(time * (17 + 34 * k)) * 0.04 * k;
    const lift = -1.12 - 0.26 * k + tremor;
    const close = 0.4 - 0.16 * k;   // hands draw together around the orb
    armL.pivot.rotation.x = lift;
    armL.pivot.rotation.z = close;
    if (anim.swingT <= 0) {
      armR.pivot.rotation.x = lift;
      armR.pivot.rotation.z = -close;
      group.rotation.y = 0;
    }
    group.rotation.x -= 0.14 * k;   // brace back against what is being held
    const glow = 1.4 + 7 * k * k;
    model.handMatL.emissive.setHex(CHARGE_HAND_EMISSIVE);
    model.handMatR.emissive.setHex(CHARGE_HAND_EMISSIVE);
    model.handMatL.emissiveIntensity = glow;
    model.handMatR.emissiveIntensity = glow;
    model.crystalMat.emissiveIntensity = Math.max(model.crystalMat.emissiveIntensity, 1.1 + 4 * k);
  }
}
