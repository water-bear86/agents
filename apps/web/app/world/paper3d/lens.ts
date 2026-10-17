// The camera the diorama is photographed with. A paper model only reads as a real object once it's
// shot like one: contact shadow where card meets card (ambient occlusion), a shallow-focus blur at the
// top and bottom of the frame (the tilt-shift look of a macro shot of a miniature) and a soft
// vignette. Labels are HTML on top and stay sharp.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { HorizontalTiltShiftShader } from "three/examples/jsm/shaders/HorizontalTiltShiftShader.js";
import { VerticalTiltShiftShader } from "three/examples/jsm/shaders/VerticalTiltShiftShader.js";

export interface LensOpts {
  /** Contact-shadow reach, in world units. */
  aoRadius: number;
  /** Blur at the very top and bottom of the frame, in pixels; 0 for none. */
  blur: number;
}

export class PaperLens {
  readonly composer: EffectComposer;
  readonly #ao: GTAOPass;
  readonly #tiltH = new ShaderPass(HorizontalTiltShiftShader);
  readonly #tiltV = new ShaderPass(VerticalTiltShiftShader);

  constructor(readonly renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, readonly opts: LensOpts) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.#ao = new GTAOPass(scene, camera, 512, 512);
    this.#ao.updateGtaoMaterial({ radius: opts.aoRadius, distanceExponent: 1.35, thickness: 1.15, scale: 1.45, samples: 12 });
    this.#ao.blendIntensity = 1.05;
    this.composer.addPass(this.#ao);
    if (opts.blur > 0) {
      this.#tiltH.uniforms.r!.value = 0.5;
      this.#tiltV.uniforms.r!.value = 0.5;
      this.composer.addPass(this.#tiltH);
      this.composer.addPass(this.#tiltV);
    }
    this.composer.addPass(new ShaderPass(Vignette));
    this.composer.addPass(new OutputPass());
  }

  /** Size in CSS pixels, after the renderer's own setSize. */
  setSize(w: number, h: number) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    // The tilt-shift shaders scale their taps by distance from the focus line (at most 0.5), so
    // twice the pixel blur, over the canvas size, gives `blur` pixels at the frame's edge.
    this.#tiltH.uniforms.h!.value = (this.opts.blur * 2) / 4 / Math.max(1, w);
    this.#tiltV.uniforms.v!.value = (this.opts.blur * 2) / 4 / Math.max(1, h);
  }

  render() { this.composer.render(); }

  dispose() {
    this.#ao.dispose();
    this.composer.dispose();
  }
}

/** Darkens the corners a touch and lays a still grain over the frame, like a photograph of a model. */
const Vignette = {
  name: "PaperVignette",
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.26 }, grain: { value: 0.032 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform float grain;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c.rgb *= 1.0 - amount * smoothstep(0.32, 0.82, d);
      float n = fract(sin(dot(vUv * vec2(1647.3, 913.1), vec2(12.9898, 78.233))) * 43758.5453);
      c.rgb += (n - 0.5) * grain;
      gl_FragColor = c;
    }`,
};
