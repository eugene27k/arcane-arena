import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Post stack. In a game lit almost entirely by torches, spell impacts and
// glowing eyes, bloom is what turns "a bright pixel" into "a light source" —
// so this is where most of the mood comes from.
//
// Chain: scene -> [GTAO] -> bloom -> tonemap/sRGB -> grade -> screen.
// Everything before OutputPass works in linear half-float; three skips the
// material-level tonemap when rendering into a render target, so OutputPass is
// the only place it happens.
//
// This is entirely fill-rate bound, so the presets are budgeted in *pixels*,
// not in features. Measured on an M4 Air at a 1440x900 window:
//
//   DPR 2 + MSAA 4 + full-res bloom + GTAO ... 45.8 ms   (22 fps)
//   DPR 1.5 + MSAA 4 + full-res bloom ....... 15.1 ms   (66 fps)
//   DPR 1.5 + no MSAA + 1/2 bloom + GTAO .... 10.7 ms   (94 fps)
//   DPR 1.25 + no MSAA + 1/2 bloom ...........  5.3 ms  (188 fps)
//   DPR 1 + no MSAA + 1/2 bloom ..............  3.5 ms  (290 fps)
//
// The two lessons baked in below: MSAA on a half-float target costs ~70%, and
// bloom does not need to run at native resolution to look like bloom.

const GradeShader = {
  name: 'ArcaneGrade',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uVignette: { value: 1 },
    uAberration: { value: 0.9 },
    uGrain: { value: 0.045 },
    uSaturation: { value: 1.12 },
    uContrast: { value: 1.06 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime, uVignette, uAberration, uGrain, uSaturation, uContrast;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // lateral chromatic aberration, zero in the middle so the crosshair and
      // the HUD-adjacent centre of the screen stay clean
      float amt = uAberration * r2 * 0.02;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv - c * amt).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv + c * amt).b
      );

      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;
      // split-tone: cold blue shadows against the warm torchlight
      col = mix(col * vec3(0.84, 0.89, 1.16), col, smoothstep(0.0, 0.5, l));
      col = mix(col, col * vec3(1.07, 1.0, 0.90), smoothstep(0.55, 1.0, l));

      float v = smoothstep(1.05, 0.18, r2 * 2.1);
      col *= mix(1.0, v, uVignette);

      // grain, weighted into the shadows where half-float banding shows; it
      // also does useful work hiding the edge aliasing left by dropping MSAA
      float g = hash(vUv * uResolution + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (1.25 - l);

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

// `pixelRatio` is the cap on a small window; `maxPixels` is the backstop that
// keeps a large window or a 4K external display from quietly costing 3x more.
export const QUALITY_PRESETS = {
  low: {
    pixelRatio: 1, maxPixels: 2.4e6, bloomScale: 0.5, gtao: false, atmosphere: false,
    bloom: { strength: 0.62, radius: 0.6, threshold: 0.78 },
    grain: 0.03, aberration: 0, shadowMap: 1024,
  },
  medium: {
    pixelRatio: 1.25, maxPixels: 3.4e6, bloomScale: 0.5, gtao: false, atmosphere: true,
    bloom: { strength: 0.70, radius: 0.68, threshold: 0.72 },
    grain: 0.042, aberration: 0.8, shadowMap: 1536,
  },
  high: {
    pixelRatio: 1.5, maxPixels: 4.4e6, bloomScale: 0.5, gtao: true, atmosphere: true,
    bloom: { strength: 0.70, radius: 0.7, threshold: 0.72 },
    grain: 0.045, aberration: 0.9, shadowMap: 2048,
  },
};

export class PostFX {
  constructor(renderer, scene, camera, quality = 'medium') {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
    this.quality = QUALITY_PRESETS[quality] ? quality : 'medium';
    this._time = 0;
    const s = renderer.getSize(new THREE.Vector2());
    this._w = s.x || window.innerWidth || 1280;
    this._h = s.y || window.innerHeight || 720;
    this._build();
  }

  get preset() { return QUALITY_PRESETS[this.quality] ?? QUALITY_PRESETS.medium; }

  // Never exceed the preset's pixel budget, whatever window or display this
  // ends up on. Below 1 would just look blurry, so that is the floor.
  _targetPixelRatio(w, h) {
    const p = this.preset;
    const byBudget = Math.sqrt(p.maxPixels / Math.max(1, w * h));
    return Math.max(1, Math.min(window.devicePixelRatio || 1, p.pixelRatio, byBudget));
  }

  _build() {
    this.dispose();
    const p = this.preset;
    const w = this._w, h = this._h;
    const pr = this._targetPixelRatio(w, h);
    this._appliedPr = pr;

    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // No `samples` here on purpose — MSAA on a HalfFloat target measured ~70%
    // slower, for edge quality the grain and the >1 pixel ratio already hide.
    const rt = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(w * pr)),
      Math.max(1, Math.round(h * pr)),
      { type: THREE.HalfFloatType }
    );
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    if (p.gtao) {
      const gtao = new GTAOPass(this.scene, this.camera, w * pr, h * pr);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.9;
      gtao.updateGtaoMaterial({
        radius: 0.55, distanceExponent: 1.4, thickness: 0.6,
        scale: 1.4, samples: 12, screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({ lumaPhi: 8, depthPhi: 2.5, normalPhi: 3.2, radius: 4, samples: 8 });
      // Sprites (torch flames, glows, spell flashes) are additive cards with no
      // real surface — letting them into the AO G-buffer punches dark holes
      // behind every flame. The base cache is already populated by the original
      // traversal, so restoreVisibility() still puts them back.
      const baseOverride = gtao.overrideVisibility.bind(gtao);
      gtao.overrideVisibility = () => {
        baseOverride();
        gtao.scene.traverse((o) => { if (o.isSprite || o.userData.noAO) o.visible = false; });
      };
      this.composer.addPass(gtao);
      this.gtao = gtao;
    }

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(w * pr * p.bloomScale, h * pr * p.bloomScale),
      p.bloom.strength, p.bloom.radius, p.bloom.threshold
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uGrain.value = p.grain;
    this.grade.uniforms.uAberration.value = p.aberration;
    this.composer.addPass(this.grade);

    this._applySizes();
  }

  // composer.setSize() hands every pass the full effective resolution, so the
  // bloom override has to come after it.
  _applySizes() {
    const p = this.preset, pr = this._appliedPr;
    const w = this._w, h = this._h;
    this.composer.setSize(w, h);
    this.bloom.setSize(Math.max(1, w * pr * p.bloomScale), Math.max(1, h * pr * p.bloomScale));
    this.grade.uniforms.uResolution.value.set(w * pr, h * pr);
  }

  setQuality(q) {
    if (!QUALITY_PRESETS[q] || q === this.quality) return;
    this.quality = q;
    this._build();
  }

  setSize(w, h) {
    if (!w || !h) return;
    this._w = w;
    this._h = h;
    // A different window size can change the budgeted pixel ratio, and the
    // composer bakes its ratio in at construction — so that needs a rebuild.
    if (Math.abs(this._targetPixelRatio(w, h) - this._appliedPr) > 0.01) {
      this._build();
      return;
    }
    this.renderer.setSize(w, h, false);
    this._applySizes();
  }

  // Momentary bloom kick — used when something big detonates, so the flash
  // blows out the whole frame for an instant instead of just the sprite.
  punch(amount = 0.5, decay = 2.6) {
    this._punch = Math.min(2, (this._punch ?? 0) + amount);
    this._punchDecay = decay;
  }

  render(dt) {
    this._time += dt;
    if (this.grade) this.grade.uniforms.uTime.value = this._time;
    if (this._punch > 0) {
      this.bloom.strength = this.preset.bloom.strength + this._punch;
      this._punch = Math.max(0, this._punch - dt * (this._punchDecay ?? 2.6));
      if (this._punch === 0) this.bloom.strength = this.preset.bloom.strength;
    }
    if (this.enabled && this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (!this.composer) return;
    for (const pass of this.composer.passes) pass.dispose?.();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer = null;
    this.gtao = null;
  }
}
