import * as THREE from 'three';
import { applyRimLight, dressMetal } from '../fx/charMaterials.js';

// Onikiri, the demon-cutter (PRD §6 procedural gear): a katana built from
// primitives — wrapped grip, iron tsuba, and a curved blade whose edge burns
// with the blood it has drunk. Origin sits at the butt of the grip with the
// blade running up +Y, so the same model serves the mage's hand and the
// point-down blade waiting in the cathedral floor.

const BLADE_LEN = 1.0;
const SEGMENTS = 3;
const SORI = 4.2;          // curvature radius in metres; larger = straighter

export function createKatana({ edgeColor = 0xff4a3a } = {}) {
  const group = new THREE.Group();

  // Low metalness on purpose: there is no environment map in this scene, and a
  // fully metallic surface with nothing to reflect renders black. The polish
  // comes from a faint self-glow plus the rim, which is what makes the blade
  // read as steel in an unlit corner of the hall.
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xc6d0dd, roughness: 0.3, metalness: 0.3,
    emissive: 0x8f9db4, emissiveIntensity: 0.3,
  });
  dressMetal(steelMat, { repeat: 4, normalScale: 0.35 });
  applyRimLight(steelMat, { color: 0xeaf2ff, power: 1.9, strength: 1.0 });

  const ironMat = new THREE.MeshStandardMaterial({ color: 0x3a3440, roughness: 0.62, metalness: 0.25, emissive: 0x201c28, emissiveIntensity: 0.5 });
  dressMetal(ironMat, { repeat: 3, normalScale: 0.9 });
  applyRimLight(ironMat, { color: 0x9a7bff, power: 2.6, strength: 0.4 });

  const wrapMat = new THREE.MeshStandardMaterial({ color: 0x2b1220, roughness: 0.92 });
  applyRimLight(wrapMat, { color: 0xff6a5a, power: 2.4, strength: 0.35 });

  // The hamon: its own material so the pickup beacon and the swing FX can pump
  // the glow without touching the steel.
  const edgeMat = new THREE.MeshStandardMaterial({
    color: 0x2a0a08, roughness: 0.4, emissive: edgeColor, emissiveIntensity: 1.15,
  });

  // grip (tsuka) + pommel
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.042, 0.27, 7), wrapMat);
  grip.position.y = 0.135;
  group.add(grip);
  const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.035, 7), ironMat);
  group.add(pommel);

  // guard (tsuba) + collar (habaki)
  const tsuba = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.088, 0.016, 10), ironMat);
  tsuba.position.y = 0.285;
  group.add(tsuba);
  const habaki = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.05, 8), steelMat);
  habaki.position.y = 0.318;
  group.add(habaki);

  // Blade: straight boxes stacked along a shallow arc. Each segment is placed
  // and tilted by its own arc angle, which is enough curve to read as a katana
  // from third person without a custom geometry.
  const segLen = BLADE_LEN / SEGMENTS;
  const base = 0.34;
  for (let i = 0; i < SEGMENTS; i++) {
    const s = segLen * (i + 0.5);
    const theta = s / SORI;
    const taper = 1 - i * 0.13;               // the blade narrows toward the tip
    const x = -SORI * (1 - Math.cos(theta));  // curves away from the cutting edge
    const y = base + SORI * Math.sin(theta);

    const seg = new THREE.Mesh(
      new THREE.BoxGeometry(0.03 * taper, segLen * 1.02, 0.078 * taper),
      steelMat
    );
    seg.position.set(x, y, 0);
    seg.rotation.z = theta;
    group.add(seg);

    // the lit edge, riding the outside of the curve
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(0.013, segLen * 1.02, 0.03 * taper),
      edgeMat
    );
    edge.position.set(x + 0.019 * taper, y, 0);
    edge.rotation.z = theta;
    group.add(edge);
  }

  // tip (kissaki): a wedge finishing the last segment's line
  const tipTheta = BLADE_LEN / SORI;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.13, 4), steelMat);
  tip.position.set(-SORI * (1 - Math.cos(tipTheta)), base + SORI * Math.sin(tipTheta) + 0.062, 0);
  tip.rotation.z = tipTheta;
  group.add(tip);

  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  return { group, edgeMat, steelMat, length: base + BLADE_LEN };
}
