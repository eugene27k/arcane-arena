import * as THREE from 'three';
import { fbm, mulberry32, blurField, clamp01, makeCanvas } from './noise.js';

// Air, not surfaces. Everything here is additive or soft-alpha, writes no
// depth, and is tagged userData.noAO so screen-space AO ignores it.

// ------------------------------------------------------------ shaft cards ---

// Soft gradient card: bright along the centre line, feathered at the sides,
// fading out along its length. Two of these crossed at 90 degrees read as a
// volume from any angle for a fraction of the cost of real volumetrics.
function makeShaftTexture(size = 256) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const rng = mulberry32(7);
  const grain = blurField(fbm(size, 6, 4, rng), size, 3);
  for (let y = 0; y < size; y++) {
    // y = 0 at the source (window), y = size at the far end
    const along = y / size;
    const lengthFade = Math.pow(1 - along, 1.6);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const side = Math.abs(x / size - 0.5) * 2;
      // the beam widens as it travels, so the usable core narrows in UV space
      const core = clamp01(1 - side / Math.max(0.25, 1 - along * 0.35));
      const a = Math.pow(core, 2.1) * lengthFade * (0.55 + grain[i] * 0.9);
      const j = i * 4;
      d[j] = 255; d[j + 1] = 246; d[j + 2] = 228;
      d[j + 3] = clamp01(a) * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let shaftTex = null;

/**
 * A moonlight shaft falling from `from` along `dir`.
 * Returns a Group of two crossed cards; add it to the scene.
 */
export function createLightShaft(from, dir, { length = 22, width = 3.2, color = 0x9fb4ff, opacity = 0.16 } = {}) {
  if (!shaftTex) shaftTex = makeShaftTexture();
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    map: shaftTex, color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    fog: true,
  });
  // widen toward the far end: the plane is built with its source edge at y = 0
  const geo = new THREE.PlaneGeometry(width, length, 1, 6);
  geo.translate(0, -length / 2, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = -pos.getY(i) / length;           // 0 at source, 1 at far end
    pos.setX(i, pos.getX(i) * (1 + t * 0.9));
  }
  // PlaneGeometry puts v=1 at +Y, which after the translate is the source edge
  // — exactly where makeShaftTexture is brightest. No UV flip needed.

  for (let k = 0; k < 2; k++) {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.y = k * Math.PI / 2;
    group.add(m);
  }
  group.position.copy(from);
  // the card's -Y runs down the beam, so aim -Y at `dir`
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
  group.userData.noAO = true;
  group.renderOrder = 4;
  return group;
}

// ------------------------------------------------------------- oculus cone ---

// The big shaft through the cathedral's broken roof, straight down onto the
// dais. A real cone rather than cards, because the player walks through it and
// orbits it on the menu and death screens.
export function createOculusShaft({ top, bottom, rTop, rBottom, color = 0xa8bcff, intensity = 0.5 }) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, top - bottom, 40, 12, true);
  geo.translate(0, (top + bottom) / 2, 0);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
      uTop: { value: top },
      uBottom: { value: bottom },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      varying vec3 vNrm;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNrm = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uIntensity, uTop, uBottom, uTime;
      varying vec3 vWorld;
      varying vec3 vNrm;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(21.7, 91.3))) * 43758.5); }

      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        // Face-on through the tube wall is thick; at the silhouette the wall is
        // edge-on and vanishes. That is what softens the cone's outline.
        float facing = pow(abs(dot(normalize(vNrm), V)), 0.75);
        float h = clamp((vWorld.y - uBottom) / (uTop - uBottom), 0.0, 1.0);
        float vertical = pow(h, 1.25) * 0.85 + 0.15;
        // lazy dust drift so the beam is never perfectly static
        float drift = 0.85 + 0.15 * sin(vWorld.y * 0.6 - uTime * 0.35 + hash(floor(vWorld.xz * 0.6)) * 6.28);
        float a = facing * vertical * drift * uIntensity;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.noAO = true;
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return { mesh, update: (t) => { mat.uniforms.uTime.value = t; } };
}

// -------------------------------------------------------------- dust motes ---

// One draw call of GPU-animated specks. They only really show up where a
// torch or a shaft catches them, which is exactly the point.
export function createDustMotes({ count = 2600, bounds, color = 0xb9c4e8 }) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const size = new Float32Array(count);
  const rng = mulberry32(4242);
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  for (let i = 0; i < count; i++) {
    // biased low: dust hangs where the fighting happens, not up at the vaults
    const yt = Math.pow(rng(), 1.9);
    pos[i * 3] = minX + rng() * (maxX - minX);
    pos[i * 3 + 1] = minY + yt * (maxY - minY);
    pos[i * 3 + 2] = minZ + rng() * (maxZ - minZ);
    seed[i] = rng() * 100;
    size[i] = 0.6 + rng() * 1.9;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uSpan: { value: maxY - minY }, uMinY: { value: minY } },
    vertexShader: /* glsl */`
      attribute float aSeed;
      attribute float aSize;
      uniform float uTime, uSpan, uMinY;
      varying float vFade;
      void main() {
        vec3 p = position;
        // slow convection: sideways wander plus a gentle sink that wraps
        p.x += sin(uTime * 0.20 + aSeed) * 0.9;
        p.z += cos(uTime * 0.17 + aSeed * 1.7) * 0.9;
        p.y = uMinY + mod(p.y - uMinY - uTime * 0.28 + aSeed, uSpan);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        // twinkle as they tumble through the light
        vFade = 0.35 + 0.65 * pow(abs(sin(uTime * 0.9 + aSeed * 3.1)), 2.0);
        gl_PointSize = aSize * (26.0 / max(0.6, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vFade;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(d)) * vFade * 0.34;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.noAO = true;
  points.renderOrder = 2;
  return { points, update: (t) => { mat.uniforms.uTime.value = t; } };
}

// -------------------------------------------------------------- ground fog ---

function makeFogTexture(size = 256) {
  const c = makeCanvas(size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const rng = mulberry32(99);
  const n = fbm(size, 4, 6, rng);
  const n2 = fbm(size, 9, 4, rng);
  for (let i = 0; i < n.length; i++) {
    const a = clamp01((n[i] * 0.7 + n2[i] * 0.3 - 0.42) * 2.6);
    const j = i * 4;
    d[j] = 190; d[j + 1] = 180; d[j + 2] = 225;
    d[j + 3] = a * 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Stacked scrolling fog sheets. Layers drift at different speeds and
 * directions so the parallax between them reads as depth rather than as a
 * texture sliding across the floor.
 */
export function createGroundFog({ y, size, layers = 3, color = 0x6a5f8c, opacity = 0.1, repeat = 1.6 }) {
  const tex = makeFogTexture();
  const group = new THREE.Group();
  const sheets = [];
  for (let i = 0; i < layers; i++) {
    const t = tex.clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.offset.set(i * 0.37, i * 0.61);
    const mat = new THREE.MeshBasicMaterial({
      map: t, color, transparent: true, opacity: opacity * (1 - i * 0.22),
      depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y + i * 0.55;
    mesh.userData.noAO = true;
    mesh.renderOrder = 1;
    group.add(mesh);
    sheets.push({ t, sx: (0.004 + i * 0.0035) * (i % 2 ? -1 : 1), sy: (0.003 + i * 0.0028) * (i % 2 ? 1 : -1) });
  }
  group.userData.noAO = true;
  return {
    group,
    update: (t) => {
      for (const s of sheets) { s.t.offset.x = t * s.sx; s.t.offset.y = t * s.sy; }
    },
  };
}

// ------------------------------------------------------------------ embers ---

/**
 * Sparks rising off every torch in the arena, in one GPU-animated draw call.
 * Each ember loops on its own period, so no two braziers pulse together.
 */
export function createEmbers(sources, { perSource = 26, rise = 4.2, color = 0xff9a3c } = {}) {
  const count = sources.length * perSource;
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const rng = mulberry32(31337);
  for (let s = 0; s < sources.length; s++) {
    const [x, y, z] = sources[s];
    for (let k = 0; k < perSource; k++) {
      const i = s * perSource + k;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      seed[i] = rng() * 100;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uRise: { value: rise } },
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime, uRise;
      varying float vLife;
      void main() {
        float period = 2.4 + fract(aSeed * 0.37) * 2.6;
        float t = fract((uTime + aSeed) / period);   // 0..1 lifetime
        vLife = t;
        vec3 p = position;
        p.y += t * uRise;
        // widen and wobble as the thermal loses coherence
        float spread = t * 0.9;
        p.x += sin(aSeed * 6.28 + t * 7.0) * spread;
        p.z += cos(aSeed * 4.11 + t * 6.1) * spread;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.0 - t * 0.65) * 5.0 * (90.0 / max(0.6, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vLife;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float m = smoothstep(0.5, 0.05, length(d));
        // flare in fast, cool and die out slowly
        float a = m * smoothstep(0.0, 0.12, vLife) * pow(1.0 - vLife, 1.6);
        vec3 c = mix(uColor, vec3(0.45, 0.06, 0.02), vLife);
        gl_FragColor = vec4(c * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.noAO = true;
  points.renderOrder = 2;
  return { points, update: (t) => { mat.uniforms.uTime.value = t; } };
}
