import * as THREE from 'three';
import { makeRadialGlowTexture } from '../fx/textures.js';
import { applyRimLight, dressHide, dressMetal } from '../fx/charMaterials.js';

let flyerGlowTex = null;
let gruntGlowTex = null;

// Give a material a permanent inner glow that survives the white hit-flash
// (EnemyBase.applyHitFlash restores these userData values, not black).
function setBaseEmissive(mat, hex, intensity) {
  mat.emissive.setHex(hex);
  mat.emissiveIntensity = intensity;
  mat.userData.baseEmissive = hex;
  mat.userData.baseEmissiveIntensity = intensity;
}

// Primitive-built demons with procedural animation hooks.

// Every model is a two-level rig, like the wizard's: `root` carries the world
// transform the entity writes each frame (position + facing), `group` carries
// the purely local animation (bob, lean, death tilt). Keeping them apart is
// what stops an animation offset from overwriting the entity's real altitude.
function buildGruntModel() {
  const root = new THREE.Group();
  const group = new THREE.Group();
  root.add(group);
  // `transparent` from the start, not from the death frame: three folds it into
  // every material's program cache key, so flipping it when a demon starts to
  // fade would recompile that shader mid-fight — a whole wave dying at once
  // used to cost half a second of frozen frames. At opacity 1 with depth
  // writing on, a transparent material draws the same pixels as an opaque one.
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x7a221a, roughness: 0.8, transparent: true });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a0e0a, roughness: 0.9, transparent: true });
  const hornMat = new THREE.MeshStandardMaterial({ color: 0xc8b090, roughness: 0.6, transparent: true });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffc020, transparent: true });
  const clawMat = new THREE.MeshStandardMaterial({ color: 0x1a0a08, roughness: 0.5, transparent: true });
  // faint internal heat so the silhouette reads in unlit corners
  setBaseEmissive(bodyMat, 0x3a0d06, 0.8);
  setBaseEmissive(darkMat, 0x220704, 0.8);
  // Scaled hide with heat burning through the cracks between the scales, and a
  // hot rim so a charging grunt separates from the wall it is silhouetted on.
  dressHide(bodyMat, { repeat: 2.4, normalScale: 1.15 });
  dressHide(darkMat, { repeat: 3, normalScale: 1.0 });
  dressMetal(hornMat, { repeat: 2, normalScale: 0.9 });
  applyRimLight(bodyMat, { color: 0xff5a1e, power: 2.2, strength: 0.75 });
  applyRimLight(darkMat, { color: 0xc03a12, power: 2.6, strength: 0.5 });
  applyRimLight(hornMat, { color: 0xffcf90, power: 2.4, strength: 0.45 });

  // legs (squat digitigrade suggestion)
  const legGeo = new THREE.CylinderGeometry(0.11, 0.16, 0.7, 6);
  const legL = new THREE.Mesh(legGeo, darkMat); legL.position.set(-0.22, 0.35, 0);
  const legR = new THREE.Mesh(legGeo, darkMat); legR.position.set(0.22, 0.35, 0);
  group.add(legL, legR);

  // torso
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), bodyMat);
  torso.scale.set(1, 1.25, 0.85);
  torso.position.y = 1.05;
  group.add(torso);

  // head + horns + eyes
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), bodyMat);
  head.position.y = 1.62;
  group.add(head);
  const hornGeo = new THREE.ConeGeometry(0.07, 0.34, 6);
  const hornL = new THREE.Mesh(hornGeo, hornMat);
  hornL.position.set(-0.16, 1.82, -0.02); hornL.rotation.z = 0.5;
  const hornR = new THREE.Mesh(hornGeo, hornMat);
  hornR.position.set(0.16, 1.82, -0.02); hornR.rotation.z = -0.5;
  group.add(hornL, hornR);
  const eyeGeo = new THREE.SphereGeometry(0.065, 6, 5);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.1, 1.66, 0.2);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(0.1, 1.66, 0.2);
  group.add(eyeL, eyeR);

  // additive face glow: the demon's eyes read at range, in any lighting
  if (!gruntGlowTex) gruntGlowTex = makeRadialGlowTexture('rgba(255,170,60,0.95)', 'rgba(200,60,10,0)');
  const faceGlowMat = new THREE.SpriteMaterial({
    map: gruntGlowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8,
  });
  const faceGlow = new THREE.Sprite(faceGlowMat);
  faceGlow.scale.setScalar(0.7);
  faceGlow.position.set(0, 1.66, 0.14);
  group.add(faceGlow);

  // arms with claws (pivot at shoulder)
  const makeArm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.42 * side, 1.34, 0);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.62, 6), bodyMat);
    arm.position.y = -0.31;
    pivot.add(arm);
    const claw = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.26, 5), clawMat);
    claw.position.y = -0.7;
    claw.rotation.x = Math.PI;
    pivot.add(claw);
    return pivot;
  };
  const armL = makeArm(-1), armR = makeArm(1);
  group.add(armL, armR);

  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  // eyeMat + faceGlowMat included so the death fade takes them down with the body
  const mats = [bodyMat, darkMat, hornMat, clawMat, eyeMat, faceGlowMat];
  // the death fade drives opacity down from here, and reuse restores it
  for (const m of mats) m.userData.baseOpacity = m.opacity;
  return { root, group, armL, armR, legL, legR, eyeMat, faceGlowMat, mats };
}

export function animateGrunt(model, anim, dt, time) {
  const { group, armL, armR, legL, legR } = model;
  if (anim.dying) {
    const t = anim.deathT;
    group.rotation.x = t * 1.5;
    group.scale.setScalar(Math.max(0.01, 1 - t * 0.6));
    group.position.y = -t * 0.4;
    for (const m of model.mats) m.opacity = 1 - t;
    return;
  }
  const sf = Math.min(1, anim.speed / 5);
  const swing = Math.sin(time * 10) * 0.6 * sf;
  legL.rotation.x = swing;
  legR.rotation.x = -swing;
  group.position.y = Math.abs(Math.sin(time * 10)) * 0.06 * sf;

  if (anim.windup > 0) {
    // telegraph: rear back, raise both claws
    const w = Math.min(1, anim.windup / 0.3);
    armL.rotation.x = -2.2 * w;
    armR.rotation.x = -2.2 * w;
    group.rotation.x = -0.15 * w;
    model.eyeMat.color.setHex(0xff3010);
    model.faceGlowMat.color.setHex(0xff3010);
  } else if (anim.strike > 0) {
    const s = 1 - anim.strike / 0.15;
    armL.rotation.x = -2.2 + s * 3.1;
    armR.rotation.x = -2.2 + s * 3.1;
    group.rotation.x = 0.25 * s;
  } else {
    armL.rotation.x = -swing * 0.8 + 0.2;
    armR.rotation.x = swing * 0.8 + 0.2;
    group.rotation.x = 0.12 * sf;
    model.eyeMat.color.setHex(0xffc020);
    model.faceGlowMat.color.setHex(0xffffff);
  }
}

function buildFlyerModel() {
  const root = new THREE.Group();
  const group = new THREE.Group();
  root.add(group);
  // transparent up front — see the note in createGruntModel
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x50123a, roughness: 0.75, transparent: true });
  const wingMat = new THREE.MeshStandardMaterial({ color: 0x2c0a20, roughness: 0.85, side: THREE.DoubleSide, transparent: true });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff40c0, transparent: true });
  const mouthMat = new THREE.MeshBasicMaterial({ color: 0x30052a, transparent: true });
  setBaseEmissive(bodyMat, 0x2a0824, 0.8);
  setBaseEmissive(wingMat, 0x180514, 0.8);
  dressHide(bodyMat, { repeat: 2.2, normalScale: 1.0 });
  // wings are thin membrane: veined normal detail, but no heat glowing through
  dressHide(wingMat, { repeat: 1.6, normalScale: 1.4, emissive: false });
  applyRimLight(bodyMat, { color: 0xff45c0, power: 2.1, strength: 0.8 });
  applyRimLight(wingMat, { color: 0xd03a9a, power: 1.7, strength: 0.9 });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), bodyMat);
  body.scale.set(1, 0.9, 1.15);
  body.position.y = 0.6;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 7), bodyMat);
  head.position.set(0, 0.78, 0.28);
  group.add(head);
  const eyeGeo = new THREE.SphereGeometry(0.062, 6, 5);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.09, 0.84, 0.42);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(0.09, 0.84, 0.42);
  group.add(eyeL, eyeR);
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), mouthMat);
  mouth.position.set(0, 0.72, 0.44);
  group.add(mouth);

  const hornGeo = new THREE.ConeGeometry(0.05, 0.22, 5);
  const hornMat = new THREE.MeshStandardMaterial({ color: 0xa08868, roughness: 0.6, transparent: true });
  const hL = new THREE.Mesh(hornGeo, hornMat); hL.position.set(-0.12, 0.95, 0.2); hL.rotation.z = 0.4;
  const hR = new THREE.Mesh(hornGeo, hornMat); hR.position.set(0.12, 0.95, 0.2); hR.rotation.z = -0.4;
  group.add(hL, hR);

  // wings (pivot at body sides)
  const wingGeo = new THREE.PlaneGeometry(0.95, 0.55);
  wingGeo.translate(0.5, 0, 0);
  const wingL = new THREE.Group(); wingL.position.set(-0.2, 0.72, 0.05); wingL.rotation.y = Math.PI;
  wingL.add(new THREE.Mesh(wingGeo, wingMat));
  const wingR = new THREE.Group(); wingR.position.set(0.2, 0.72, 0.05);
  wingR.add(new THREE.Mesh(wingGeo, wingMat));
  group.add(wingL, wingR);

  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.6, 6), bodyMat);
  tail.position.set(0, 0.5, -0.42);
  tail.rotation.x = 1.9;
  group.add(tail);

  // wisp glow so flyers read against the dark hall at range
  if (!flyerGlowTex) flyerGlowTex = makeRadialGlowTexture('rgba(255,90,200,0.9)', 'rgba(120,10,90,0)');
  const wispMat = new THREE.SpriteMaterial({
    map: flyerGlowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85,
  });
  const wisp = new THREE.Sprite(wispMat);
  wisp.scale.setScalar(1.7);
  wisp.position.y = 0.6;
  group.add(wisp);

  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const mats = [bodyMat, wingMat, hornMat, eyeMat, wispMat];
  for (const m of mats) m.userData.baseOpacity = m.opacity;
  return { root, group, wingL, wingR, mouth, eyeMatL: eyeMat, mats };
}

export function animateFlyer(model, anim, dt, time) {
  const { group, wingL, wingR } = model;
  if (anim.dying) {
    const t = anim.deathT;
    group.rotation.z = t * 2.5;
    group.scale.setScalar(Math.max(0.01, 1 - t * 0.7));
    for (const m of model.mats) m.opacity = 1 - t;
    wingL.rotation.z = 1.2;
    wingR.rotation.z = -1.2;
    return;
  }
  const flap = Math.sin(time * 13) * 0.75;
  wingL.rotation.z = -flap - 0.15;
  wingR.rotation.z = flap + 0.15;
  group.position.y = Math.sin(time * 2.6) * 0.12;
  group.rotation.z = anim.bank * 0.4;

  // attack telegraph: mouth glows
  if (anim.windup > 0) {
    const w = Math.min(1, anim.windup / 0.4);
    model.mouth.material.color.setRGB(0.6 + 0.4 * w, 0.1, 0.9 * w + 0.1);
  } else {
    model.mouth.material.color.setHex(0x30052a);
  }
}

// ---------- model pooling ----------
// Demon bodies are checked out of a pool and handed back on death, never
// rebuilt. Building one costs twenty-odd geometries, six materials and seven
// texture uploads; *disposing* one is worse, because dropping the last material
// that used a compiled program makes three delete that program, so the next
// demon to walk out of a portal recompiles it from source. A wave that ended
// and a wave that began used to trade the same shaders back and forth for
// hundreds of milliseconds each way. The pool is bounded by how many demons can
// be alive at once, so it never grows past a handful.
const gruntPool = [];
const flyerPool = [];

// Undo everything a life and a death wrote on a body, so a reused one is
// indistinguishable from a fresh one. Animation rewrites the limbs every frame,
// but the death tilt, the fade and the windup eye colour would otherwise
// survive into the next demon.
function resetModel(model, eyeHex, glowHex) {
  const { root, group } = model;
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.setScalar(1);
  root.visible = true;
  group.position.set(0, 0, 0);
  group.rotation.set(0, 0, 0);
  group.scale.setScalar(1);
  for (const m of model.mats) {
    m.opacity = m.userData.baseOpacity ?? 1;
    if (m.emissive) {
      m.emissive.setHex(m.userData.baseEmissive ?? 0x000000);
      m.emissiveIntensity = m.userData.baseEmissiveIntensity ?? 0;
    }
  }
  model.eyeMat?.color.setHex(eyeHex);
  model.eyeMatL?.color.setHex(eyeHex);
  model.faceGlowMat?.color.setHex(glowHex);
}

export function createGruntModel() {
  const m = gruntPool.pop();
  if (!m) return buildGruntModel();
  resetModel(m, 0xffc020, 0xffffff);
  return m;
}

export function createFlyerModel() {
  const m = flyerPool.pop();
  if (!m) return buildFlyerModel();
  resetModel(m, 0xff40c0, 0xffffff);
  m.mouth.material.color.setHex(0x30052a);
  m.wingL.rotation.set(0, 0, 0);
  m.wingR.rotation.set(0, 0, 0);
  return m;
}

// Hand a body back. The caller has already taken it out of the scene; nothing
// here is disposed, which is the point.
export function releaseGruntModel(model) { if (model) gruntPool.push(model); }
export function releaseFlyerModel(model) { if (model) flyerPool.push(model); }
