import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  makeRadialGlowTexture, makeWindowTexture, makeArcaneCircleTexture,
  makeFlameTexture, makeScorchTexture,
} from '../fx/textures.js';
import { getSurface, setSurfaceAnisotropy, TEXEL_SCALE } from '../fx/surfaces.js';
import { stoneBoxGeometry, buildOccluderGrid, bakeVertexAO, applyVertexTint } from './stoneGeometry.js';
import { createLightShaft, createOculusShaft, createDustMotes, createGroundFog, createEmbers } from '../fx/atmosphere.js';
import { mulberry32 } from '../fx/noise.js';
import { QUALITY_PRESETS } from '../fx/postfx.js';

// Turns layout data into: collision boxes + merged PBR stone + lights +
// atmosphere. Returns { updatables: [(t, dt) => void], setTextureDetail }.

// Which procedural surface each layout tint is cut from. Layout boxes may
// override with an explicit `surf` field (see the jagged abyss rocks).
const SURFACE_BY_TINT = {
  0x5d5866: 'slab',    // floor
  0x4a4454: 'ashlar',  // floorDark — pilasters, supports
  0x453e50: 'slab',    // pit
  0x6d6472: 'marble',  // dais
  0x605a6a: 'slab',    // platform
  0x585264: 'slab',    // balcony
  0x6a6274: 'slab',    // stairs
  0x4e4858: 'ashlar',  // wall
  0x565064: 'ashlar',  // column
  0x525060: 'slab',    // bridge
  0x5e6258: 'rough',   // floating stones
  0x504a5a: 'rough',   // rubble
};

const TEXTURE_DETAIL = { low: 256, medium: 512, high: 512 };

// Marble is polished and slightly metallic; the rest is dry, dead stone.
const SURFACE_MATERIAL = {
  ashlar: { roughness: 1.0, metalness: 0.02, normalScale: 1.15 },
  slab:   { roughness: 0.98, metalness: 0.03, normalScale: 1.1 },
  marble: { roughness: 1.0, metalness: 1.0, normalScale: 0.9 },
  rough:  { roughness: 1.0, metalness: 0.02, normalScale: 2.0 },
};

export function buildArena(layout, scene, world, opts = {}) {
  const updatables = [];
  // Atmosphere is always *built*, only hidden on low — otherwise the graphics
  // setting could never turn shafts and dust back on without a page reload.
  const atmosphere = [];
  const quality = opts.quality ?? 'high';
  const texSize = TEXTURE_DETAIL[quality] ?? 512;
  setSurfaceAnisotropy(opts.anisotropy ?? 8);
  const rng = mulberry32(20260824);

  // ---------- collisions ----------
  for (const b of layout.colliders) {
    world.addBox(b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2]);
  }

  // ---------- stone: chamfered, world-UV'd, AO-baked, merged per surface ----------
  const allBoxes = [...layout.colliders, ...layout.visuals];
  // Everything solid occludes, including render-only trim — otherwise pilasters
  // and supports would float with no contact darkening at their base.
  const grid = buildOccluderGrid(allBoxes);

  const buckets = { ashlar: [], slab: [], marble: [], rough: [] };
  for (const b of allBoxes) {
    const geo = stoneBoxGeometry(b, { texel: TEXEL_SCALE, bevel: 0.07 });
    if (!geo) continue;
    const ao = bakeVertexAO(geo, grid, 0.95);
    applyVertexTint(geo, b.tint, ao, 0.025, rng, 1.55);
    (buckets[b.surf ?? SURFACE_BY_TINT[b.tint] ?? 'ashlar']).push(geo);
  }

  const stoneMaterials = {};
  for (const [kind, geos] of Object.entries(buckets)) {
    if (!geos.length) continue;
    const cfg = SURFACE_MATERIAL[kind];
    const s = getSurface(kind, texSize, 1000 + kind.length * 37);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: s.map,
      normalMap: s.normalMap,
      normalScale: new THREE.Vector2(cfg.normalScale, cfg.normalScale),
      roughnessMap: s.roughnessMap,
      aoMap: s.aoMap,
      aoMapIntensity: 1.0,
      metalnessMap: s.metalnessMap ?? null,
      // the maps carry the variation; these are pure multipliers over them
      roughness: cfg.roughness,
      metalness: cfg.metalness,
    });
    const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `stone:${kind}`;
    scene.add(mesh);
    geos.forEach((g) => g.dispose());
    stoneMaterials[kind] = mat;
  }

  // Swap in a different texture resolution and toggle atmosphere without
  // rebuilding geometry — lets the graphics-quality setting take effect
  // immediately instead of on the next page load.
  const setDetail = (q) => {
    const preset = QUALITY_PRESETS[q] ?? QUALITY_PRESETS.medium;
    for (const o of atmosphere) o.visible = preset.atmosphere;
    // Shadow map size is a live change: drop the existing map so three
    // reallocates it at the new resolution on the next frame.
    if (moonLight.shadow.mapSize.width !== preset.shadowMap) {
      moonLight.shadow.mapSize.setScalar(preset.shadowMap);
      moonLight.shadow.map?.dispose();
      moonLight.shadow.map = null;
    }
    const size = TEXTURE_DETAIL[q] ?? 512;
    for (const [kind, mat] of Object.entries(stoneMaterials)) {
      const s = getSurface(kind, size, 1000 + kind.length * 37);
      mat.map = s.map;
      mat.normalMap = s.normalMap;
      mat.roughnessMap = s.roughnessMap;
      mat.aoMap = s.aoMap;
      mat.metalnessMap = s.metalnessMap ?? null;
      mat.needsUpdate = true;
    }
  };

  // ---------- abyss rim warning strips ----------
  const rimGeos = [];
  for (const b of layout.rimStrips) {
    const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], d = b.max[2] - b.min[2];
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(b.min[0] + w / 2, b.min[1] + h / 2, b.min[2] + d / 2);
    rimGeos.push(geo);
  }
  // >1 channel values push the strips past the bloom threshold, so they read as
  // hot metal rather than as flat red paint.
  const rimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.0, 0.32, 0.14) });
  scene.add(new THREE.Mesh(mergeGeometries(rimGeos, false), rimMat));
  rimGeos.forEach((g) => g.dispose());
  updatables.push((t) => {
    const k = 0.72 + 0.34 * Math.sin(t * 2.6) + 0.08 * Math.sin(t * 11.3);
    rimMat.color.setRGB(2.0 * k, 0.32 * k, 0.14 * k);
  });

  // ---------- gothic windows ----------
  const winTex = makeWindowTexture();
  const winMat = new THREE.MeshBasicMaterial({ map: winTex, color: new THREE.Color(1.9, 1.9, 1.9) });
  const winGeos = [];
  for (const w of layout.windows) {
    const geo = new THREE.BoxGeometry(w.size[0], w.size[1], w.size[2]);
    geo.translate(w.pos[0], w.pos[1], w.pos[2]);
    winGeos.push(geo);
  }
  const winMesh = new THREE.Mesh(mergeGeometries(winGeos, false), winMat);
  winMesh.userData.noAO = true;
  scene.add(winMesh);
  winGeos.forEach((g) => g.dispose());
  updatables.push((t) => {
    // the hell-light below the windows breathes; the moonlit heads do not
    const k = 1.9 + 0.22 * Math.sin(t * 0.9) + 0.06 * Math.sin(t * 5.1);
    winMat.color.setScalar(k);
  });

  // ---------- moonlight shafts through the windows ----------
  {
    for (const w of layout.windows) {
      const [x, y, z] = w.pos;
      // aim inward toward the middle of the hall, and down
      const inward = new THREE.Vector3(-Math.sign(x) * (w.axis === 'x' ? 1 : 0), 0, -Math.sign(z) * (w.axis === 'z' ? 1 : 0));
      if (inward.lengthSq() === 0) inward.set(-Math.sign(x) || 1, 0, 0);
      const dir = inward.multiplyScalar(0.62).add(new THREE.Vector3(0, -1, 0)).normalize();
      const shaft = createLightShaft(new THREE.Vector3(x, y + 3.4, z), dir, {
        length: 26, width: Math.max(w.size[0], w.size[2]) * 1.5,
        color: 0xa9b9ff, opacity: 0.105,
      });
      scene.add(shaft);
      atmosphere.push(shaft);
    }
  }

  // ---------- abyss ----------
  const abyssGlowTex = makeRadialGlowTexture('rgba(255,80,26,0.95)', 'rgba(120,10,5,0)');
  for (const A of layout.abyssRects) {
    const w = A.x1 - A.x0, d = A.z1 - A.z0;
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 1.15, d * 1.15),
      new THREE.MeshBasicMaterial({
        map: abyssGlowTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, color: new THREE.Color(1.5, 1.5, 1.5),
      })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set((A.x0 + A.x1) / 2, -8.5, (A.z0 + A.z1) / 2);
    glow.userData.noAO = true;
    scene.add(glow);

    const deep = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 1.6, d * 1.6),
      new THREE.MeshBasicMaterial({ color: 0x180204, side: THREE.DoubleSide })
    );
    deep.rotation.x = -Math.PI / 2;
    deep.position.set((A.x0 + A.x1) / 2, -11.5, (A.z0 + A.z1) / 2);
    scene.add(deep);

    // updraft: a slow column of heat rising out of the breach
    const heat = createLightShaft(
      new THREE.Vector3((A.x0 + A.x1) / 2, -7, (A.z0 + A.z1) / 2),
      new THREE.Vector3(0, 1, 0),
      { length: 13, width: Math.min(w, d) * 0.9, color: 0xff5a1e, opacity: 0.16 }
    );
    scene.add(heat);
    atmosphere.push(heat);

    updatables.push((t) => {
      glow.material.opacity = 0.75 + 0.25 * Math.sin(t * 1.7 + A.x0);
    });
  }

  // ---------- magic circle on the dais ----------
  const circleTex = makeArcaneCircleTexture();
  const circleMat = new THREE.MeshBasicMaterial({
    map: circleTex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, color: new THREE.Color(0.8, 0.8, 0.8),
  });
  const circle = new THREE.Mesh(
    new THREE.PlaneGeometry(layout.magicCircle.radius * 2, layout.magicCircle.radius * 2),
    circleMat
  );
  circle.rotation.x = -Math.PI / 2;
  circle.position.set(...layout.magicCircle.pos);
  circle.userData.noAO = true;
  scene.add(circle);

  // a counter-rotating inner ring gives the sigil visible mechanism
  const inner = new THREE.Mesh(
    new THREE.PlaneGeometry(layout.magicCircle.radius * 1.05, layout.magicCircle.radius * 1.05),
    circleMat.clone()
  );
  inner.rotation.x = -Math.PI / 2;
  inner.position.set(layout.magicCircle.pos[0], layout.magicCircle.pos[1] + 0.01, layout.magicCircle.pos[2]);
  inner.userData.noAO = true;
  scene.add(inner);

  const circleLight = new THREE.PointLight(0x9b6cff, 10, 15, 2);
  circleLight.position.set(layout.magicCircle.pos[0], layout.magicCircle.pos[1] + 0.8, layout.magicCircle.pos[2]);
  scene.add(circleLight);

  updatables.push((t, dt) => {
    circle.rotation.z += dt * 0.10;
    inner.rotation.z -= dt * 0.17;
    const pulse = 0.72 + 0.16 * Math.sin(t * 1.3) + 0.05 * Math.sin(t * 4.7);
    circleMat.color.setScalar(pulse);
    inner.material.color.setScalar(pulse * 0.72);
    circleLight.intensity = 9 + 3.5 * Math.sin(t * 1.3);
  });

  // ---------- oculus: moon disc + the shaft it throws ----------
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(9, 48),
    new THREE.MeshBasicMaterial({
      map: makeRadialGlowTexture('rgba(215,225,255,0.98)', 'rgba(120,140,220,0)'),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, color: new THREE.Color(1.6, 1.6, 1.7),
    })
  );
  moon.rotation.x = Math.PI / 2;
  moon.position.set(0, 30, 0);
  moon.userData.noAO = true;
  scene.add(moon);

  {
    const oc = createOculusShaft({
      top: 27.4, bottom: layout.magicCircle.pos[1],
      rTop: 7.4, rBottom: 10.5, color: 0x9fb2ff, intensity: 0.34,
    });
    scene.add(oc.mesh);
    atmosphere.push(oc.mesh);
    updatables.push((t) => { if (oc.mesh.visible) oc.update(t); });
  }

  // ---------- torches ----------
  const flameTex = makeFlameTexture();
  const coreTex = makeRadialGlowTexture('rgba(255,246,214,1)', 'rgba(255,150,40,0)');
  const scorchTex = makeScorchTexture();
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x1d1a18, roughness: 0.55, metalness: 0.85 });
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0x2a1008, roughness: 0.95, emissive: 0xff4408, emissiveIntensity: 1.4,
  });

  const bracketGeos = [];
  const coalGeos = [];
  for (const t of layout.torches) {
    const [x, y, z] = t.pos;
    // wrought-iron sconce: a tapered post, a ring collar and a shallow bowl
    const post = new THREE.CylinderGeometry(0.055, 0.085, 0.62, 6);
    post.translate(x, y - 0.36, z);
    const collar = new THREE.TorusGeometry(0.15, 0.032, 4, 10);
    collar.rotateX(Math.PI / 2);
    collar.translate(x, y - 0.08, z);
    const bowl = new THREE.CylinderGeometry(0.26, 0.13, 0.2, 10, 1, true);
    bowl.translate(x, y + 0.02, z);
    bracketGeos.push(post, collar, bowl);
    // glowing coals sitting in the bowl
    const coal = new THREE.SphereGeometry(0.15, 8, 6);
    coal.scale(1, 0.5, 1);
    coal.translate(x, y + 0.06, z);
    coalGeos.push(coal);
  }
  if (bracketGeos.length) {
    const brackets = new THREE.Mesh(mergeGeometries(bracketGeos, false), ironMat);
    brackets.castShadow = true;
    scene.add(brackets);
    bracketGeos.forEach((g) => g.dispose());
    const coals = new THREE.Mesh(mergeGeometries(coalGeos, false), emberMat);
    scene.add(coals);
    coalGeos.forEach((g) => g.dispose());
    updatables.push((t) => {
      emberMat.emissiveIntensity = 1.3 + 0.35 * Math.sin(t * 3.1) + 0.15 * Math.sin(t * 9.7);
    });
  }

  for (const t of layout.torches) {
    const [x, y, z] = t.pos;
    const phase = rng() * 10;

    // three stacked cards: hot core, body, and a lazy outer lick
    const layers = [
      { tex: coreTex, scale: 0.42, dy: 0.16, color: new THREE.Color(2.6, 2.2, 1.5), speed: 15 },
      { tex: flameTex, scale: 0.95, dy: 0.30, color: new THREE.Color(2.2, 1.15, 0.42), speed: 9 },
      { tex: flameTex, scale: 1.5, dy: 0.46, color: new THREE.Color(1.1, 0.45, 0.14), speed: 5.5 },
    ];
    const sprites = layers.map((L) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: L.tex, blending: THREE.AdditiveBlending, depthWrite: false, color: L.color,
      }));
      s.position.set(x, y + L.dy, z);
      s.scale.setScalar(L.scale);
      s.userData.noAO = true;
      scene.add(s);
      return s;
    });

    // soot bloom on whatever the torch is bracketed to
    const scorch = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 3.0),
      new THREE.MeshBasicMaterial({ map: scorchTex, transparent: true, depthWrite: false, opacity: 0.75 })
    );
    scorch.position.set(x, y + 1.1, z);
    scorch.rotation.x = -Math.PI / 2;
    scorch.userData.noAO = true;
    scene.add(scorch);

    const light = new THREE.PointLight(0xff8a3a, 26, 18, 2);
    light.position.set(x, y + 0.4, z);
    scene.add(light);

    updatables.push((tt) => {
      // three detuned sines: never repeats on a period the eye can latch onto
      const n = Math.sin(tt * 9 + phase) * 0.5 + Math.sin(tt * 23 + phase * 2) * 0.3 + Math.sin(tt * 5.7 + phase) * 0.2;
      light.intensity = 26 * (0.78 + 0.28 * n);
      for (let i = 0; i < sprites.length; i++) {
        const L = layers[i];
        const w = Math.sin(tt * L.speed + phase * (i + 1)) * 0.5 + Math.sin(tt * L.speed * 2.3 + phase) * 0.3;
        sprites[i].scale.set(L.scale * (0.86 + 0.16 * w), L.scale * (0.9 + 0.26 * w), 1);
        sprites[i].position.y = y + L.dy + w * 0.03 * (i + 1);
      }
    });
  }

  // rising sparks off every brazier, one draw call for all of them
  if (layout.torches.length) {
    const embers = createEmbers(layout.torches.map((t) => t.pos), { perSource: 24, rise: 4.6 });
    scene.add(embers.points);
    atmosphere.push(embers.points);
    updatables.push((t) => { if (embers.points.visible) embers.update(t); });
  }

  // ---------- floating dust & ground fog ----------
  {
    const motes = createDustMotes({
      count: 2200,
      bounds: { min: [-27, -4, -27], max: [27, 22, 27] },
    });
    scene.add(motes.points);
    atmosphere.push(motes.points);
    updatables.push((t) => { if (motes.points.visible) motes.update(t); });

    const fog = createGroundFog({ y: 0.15, size: 62, layers: 2, opacity: 0.095 });
    scene.add(fog.group);
    atmosphere.push(fog.group);
    updatables.push((t) => { if (fog.group.visible) fog.update(t); });

    const pitFog = createGroundFog({ y: -2.85, size: 24, layers: 2, opacity: 0.13, repeat: 1.0, color: 0x7a5f8c });
    pitFog.group.position.set(-16.5, 0, 16.5);
    scene.add(pitFog.group);
    atmosphere.push(pitFog.group);
    updatables.push((t) => { if (pitFog.group.visible) pitFog.update(t); });
  }

  // ---------- global lighting & atmosphere ----------
  scene.fog = new THREE.FogExp2(0x0a0613, 0.0155);
  scene.background = new THREE.Color(0x08050f);

  // Sky/ground hemisphere: cold moonlight above, faint hell-glow bouncing up.
  const hemi = new THREE.HemisphereLight(0x5766a8, 0x2a1420, 1.05);
  scene.add(hemi);

  const moonLight = new THREE.DirectionalLight(0xa8b6e8, 1.9);
  moonLight.position.set(8, 42, 5);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(2048, 2048); // setDetail() re-sizes to the preset
  moonLight.shadow.camera.left = -34;
  moonLight.shadow.camera.right = 34;
  moonLight.shadow.camera.top = 34;
  moonLight.shadow.camera.bottom = -34;
  moonLight.shadow.camera.near = 4;
  moonLight.shadow.camera.far = 90;
  moonLight.shadow.bias = -0.0004;
  moonLight.shadow.normalBias = 0.045;
  scene.add(moonLight, moonLight.target);

  const ambient = new THREE.AmbientLight(0x39305e, 2.0);
  scene.add(ambient);

  // Warm uplight from the abyss, so the pit side of every object is not simply
  // black — it keeps silhouettes readable against the far wall.
  const abyssFill = new THREE.PointLight(0xff4a18, 22, 40, 2);
  abyssFill.position.set(-18, -6, -19);
  scene.add(abyssFill);
  const abyssFill2 = new THREE.PointLight(0xff4a18, 22, 40, 2);
  abyssFill2.position.set(21, -6, -2);
  scene.add(abyssFill2);
  updatables.push((t) => {
    const k = 0.8 + 0.25 * Math.sin(t * 1.1);
    abyssFill.intensity = 22 * k;
    abyssFill2.intensity = 22 * (1.6 - k);
  });

  setDetail(quality);
  return { updatables, setDetail, stoneMaterials };
}
