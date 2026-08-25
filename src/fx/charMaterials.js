import * as THREE from 'three';
import { getSurface } from './surfaces.js';

// Material dressing for characters. The models stay primitive-built — this adds
// the surface detail and the rim light that make them read as *objects* in a
// dark room rather than as flat coloured shapes.

// Fresnel rim, injected into the standard material. In a hall lit by scattered
// torches, a grazing-angle rim is the only thing that separates a demon from
// the wall behind it — without it, silhouettes disappear at range.
export function applyRimLight(mat, { color = 0x8a6aff, power = 2.6, strength = 0.5 } = {}) {
  const rimColor = new THREE.Color(color);
  mat.userData.rim = { color: rimColor, power, strength };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimPower = { value: power };
    shader.uniforms.uRimStrength = { value: strength };
    mat.userData.rimUniforms = shader.uniforms;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uRimColor;
        uniform float uRimPower;
        uniform float uRimStrength;`)
      .replace('#include <dithering_fragment>', `
        {
          // vViewPosition points from the fragment toward the eye, and normal
          // is the normal-mapped view-space normal, so the rim picks up detail
          vec3 rimV = normalize(vViewPosition);
          float rimF = 1.0 - saturate(dot(normalize(normal), rimV));
          gl_FragColor.rgb += uRimColor * pow(rimF, uRimPower) * uRimStrength;
        }
        #include <dithering_fragment>`);
  };
  // programs are cached by this key, so two rims with different settings do not
  // silently share one compiled shader
  mat.customProgramCacheKey = () => `rim|${color}|${power}|${strength}`;
  mat.needsUpdate = true;
  return mat;
}

// Live control over an already-compiled rim (used for hit flashes and the
// chilled/frozen tint on demons).
export function setRim(mat, { color, strength } = {}) {
  const u = mat.userData.rimUniforms;
  if (!u) return;
  if (color !== undefined) u.uRimColor.value.setHex(color);
  if (strength !== undefined) u.uRimStrength.value = strength;
}

// A clone per material would be a fresh GPU upload of the same pixels every
// time — and one that nothing ever disposes, since Material.dispose() does not
// touch its maps. Clones are keyed by source and tile count instead, so every
// demon in a wave shares one texture object.
const tileCache = new Map();

function tiled(tex, repeat) {
  if (!tex) return null;
  const key = `${tex.uuid}:${repeat}`;
  let t = tileCache.get(key);
  if (!t) {
    t = tex.clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    tileCache.set(key, t);
  }
  return t;
}

/**
 * Woven wool: normal + roughness only, so the model's authored colours are
 * untouched and only the surface gains structure.
 */
export function dressCloth(mat, { repeat = 3, normalScale = 0.85, size = 256 } = {}) {
  const s = getSurface('cloth', size, 77);
  mat.normalMap = tiled(s.normalMap, repeat);
  mat.normalScale = new THREE.Vector2(normalScale, normalScale);
  mat.roughnessMap = tiled(s.roughnessMap, repeat);
  mat.needsUpdate = true;
  return mat;
}

/**
 * Demon hide: pebbled scales, plus an emissive map so the heat only burns
 * through the cracks between them instead of over the whole body.
 */
export function dressHide(mat, { repeat = 2, normalScale = 1.1, emissive = true, size = 256 } = {}) {
  const s = getSurface('hide', size, 88);
  mat.normalMap = tiled(s.normalMap, repeat);
  mat.normalScale = new THREE.Vector2(normalScale, normalScale);
  mat.roughnessMap = tiled(s.roughnessMap, repeat);
  if (emissive && s.emissiveMap) mat.emissiveMap = tiled(s.emissiveMap, repeat);
  mat.needsUpdate = true;
  return mat;
}

/**
 * Pitted, hammered iron for braziers, staff collars and armour trim.
 */
export function dressMetal(mat, { repeat = 2, normalScale = 0.7, size = 256 } = {}) {
  const s = getSurface('rough', size, 91);
  mat.normalMap = tiled(s.normalMap, repeat);
  mat.normalScale = new THREE.Vector2(normalScale, normalScale);
  mat.needsUpdate = true;
  return mat;
}
