// Paper for the 3D town: matte card stock with a slight fibre sheen, a paper-grain normal and a
// roughness map generated on the fly, so light raking across a sheet picks out pulp and fibres the
// way a real photograph of a paper model does. Cardboard uses a coarser kraft liner (recycled
// specks, flute ridges showing through) and a corrugated cut edge. Colours are paper colours;
// shadows stay soft and tinted because the hemisphere light bounces plenty of light back in
// (see town.ts).

import * as THREE from "three";

const rnd = (x: number, y: number, s: number) => {
  let n = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Tileable value-noise height field, a few octaves. */
function pulp(size: number, octaves: readonly [number, number, number][], out?: Float32Array) {
  const h = out ?? new Float32Array(size * size);
  for (const [cells, amp, seed] of octaves) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, fy = (y / size) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = smooth(fx - x0), ty = smooth(fy - y0);
      const v = (i: number, j: number) => rnd((x0 + i) % cells, (y0 + j) % cells, seed);
      const a = v(0, 0) + (v(1, 0) - v(0, 0)) * tx, b = v(0, 1) + (v(1, 1) - v(0, 1)) * tx;
      h[y * size + x]! += (a + (b - a) * ty) * amp;
    }
  }
  return h;
}

function canvasTex(canvas: HTMLCanvasElement, srgb = false) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return tex;
}

/** A tileable paper-grain normal map: pulp plus short fibres, mostly along the machine direction. */
export function paperNormalMap(size = 512): THREE.CanvasTexture {
  const h = pulp(size, [[8, 0.45, 1], [16, 0.28, 2], [48, 0.16, 3], [96, 0.08, 4]]);
  // Fibres: most run with the machine direction, a few cross it, the way a real sheet is made.
  for (let f = 0; f < 720; f++) {
    let x = rnd(f, 1, 9) * size, y = rnd(f, 2, 9) * size;
    const cross = rnd(f, 5, 9) > 0.82;
    const ang = cross ? Math.PI / 2 + (rnd(f, 3, 9) - 0.5) * 0.5 : (rnd(f, 3, 9) - 0.5) * 0.55;
    const len = 8 + rnd(f, 4, 9) * 22;
    const w = cross ? 0.08 : 0.16;
    for (let s = 0; s < len; s++) {
      x += Math.cos(ang); y += Math.sin(ang);
      const i = ((Math.round(y) % size) + size) % size * size + (((Math.round(x) % size) + size) % size);
      h[i]! += w;
    }
  }
  // Crinkles: the sheet has been handled, so it carries big soft facets and a finer crumple on top.
  crinkle(h, size, 18, 0.9, 41);
  crinkle(h, size, 40, 0.3, 42);
  return heightToNormal(h, size, 2.6);
}

/**
 * Crumpled paper, added into a tileable height field: a scatter of fold lines that cross each other,
 * each one a ridge or a valley that fades out towards its ends, the way a sheet looks once it's been
 * scrunched and smoothed flat again. `count` folds; `height` is a fold's depth at its middle.
 */
function crinkle(h: Float32Array, size: number, count: number, height: number, seed: number) {
  for (let f = 0; f < count; f++) {
    const cx = rnd(f, 1, seed) * size, cy = rnd(f, 2, seed) * size;
    const ang = rnd(f, 3, seed) * Math.PI;
    const half = (0.18 + rnd(f, 4, seed) * 0.4) * size;
    const reach = 6 + rnd(f, 5, seed) * 22;
    const amp = (rnd(f, 6, seed) > 0.5 ? 1 : -1) * height * (0.5 + rnd(f, 7, seed));
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const ext = Math.ceil(half + reach);
    for (let y = Math.floor(cy - ext); y <= cy + ext; y++) for (let x = Math.floor(cx - ext); x <= cx + ext; x++) {
      const dx = x - cx, dy = y - cy;
      const along = dx * ux + dy * uy, across = Math.abs(-dx * uy + dy * ux);
      if (across >= reach || Math.abs(along) >= half) continue;
      // A tent across the fold, tapering towards both ends.
      const taper = 1 - (along / half) ** 2;
      const i = (((y % size) + size) % size) * size + (((x % size) + size) % size);
      h[i]! += amp * taper * (1 - across / reach);
    }
  }
}

/** Card glued over corrugated board: a smooth paper face with the flute ridges pressing through it. */
export function corrugatedNormalMap(size = 256): THREE.CanvasTexture {
  const h = pulp(size, [[8, 0.3, 51], [24, 0.15, 52]]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // Rounded bumps, one per flute, wandering a touch where the board was pressed unevenly.
    const ridge = Math.sin((y / size) * Math.PI * 2 * 4 + Math.sin((x / size) * Math.PI * 2) * 0.25);
    h[y * size + x]! += ridge * 0.5;
  }
  crinkle(h, size, 6, 0.4, 53);
  return heightToNormal(h, size, 4);
}

/** Kraft liner: coarser pulp, recycled specks, and the flute ridges showing through the face. */
export function kraftNormalMap(size = 256): THREE.CanvasTexture {
  const h = pulp(size, [[6, 0.55, 11], [14, 0.32, 12], [36, 0.18, 13]]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const ridge = Math.sin((y / size) * Math.PI * 2 * 4 + Math.sin((x / size) * Math.PI * 2 * 2) * 0.3);
    h[y * size + x]! += ridge * 0.32;
  }
  for (let f = 0; f < 280; f++) {
    let x = rnd(f, 1, 19) * size, y = rnd(f, 2, 19) * size;
    const ang = (rnd(f, 3, 19) - 0.5) * 0.8, len = 5 + rnd(f, 4, 19) * 14;
    for (let s = 0; s < len; s++) {
      x += Math.cos(ang); y += Math.sin(ang);
      const i = ((Math.round(y) % size) + size) % size * size + (((Math.round(x) % size) + size) % size);
      h[i]! += 0.14;
    }
  }
  return heightToNormal(h, size, 3.1);
}

function heightToNormal(h: Float32Array, size: number, k: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * k, dy = (at(x, y + 1) - at(x, y - 1)) * k;
    const len = Math.hypot(dx, dy, 1);
    const o = (y * size + x) * 4;
    img.data[o] = ((-dx / len) * 0.5 + 0.5) * 255;
    img.data[o + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
    img.data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasTex(canvas);
}

/** Paper's colour: pulp mottling, fibres and a few shives, near white so it tints whatever colour the sheet is. */
export function paperAlbedo(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fbfaf6";
  ctx.fillRect(0, 0, size, size);
  let seed = 7;
  const r = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < 70; k++) {
    const x = r() * size, y = r() * size, rad = 18 + r() * 52;
    for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]] as const) {
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
      g.addColorStop(0, r() > 0.55 ? "rgba(236,228,210,0.22)" : "rgba(255,252,245,0.2)");
      g.addColorStop(1, "rgba(236,228,210,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
    }
  }
  ctx.lineCap = "round";
  for (let k = 0; k < 380; k++) {
    const x = r() * size, y = r() * size, a = (r() - 0.5) * 0.6, len = 4 + r() * 12;
    ctx.strokeStyle = r() > 0.42 ? "rgba(255,255,255,0.55)" : "rgba(196,184,162,0.22)";
    ctx.lineWidth = 0.45 + r() * 0.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  // Tiny inclusions in the pulp.
  for (let k = 0; k < 90; k++) {
    ctx.fillStyle = r() > 0.5 ? "rgba(90,70,50,0.12)" : "rgba(255,255,255,0.35)";
    ctx.fillRect(r() * size, r() * size, 1 + r() * 1.5, 1 + r() * 1.5);
  }
  return canvasTex(canvas, true);
}

/** Kraft liner albedo: cream-brown mottling and recycled specks, still near-white so the material colour tints it. */
export function kraftAlbedo(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f3eadc";
  ctx.fillRect(0, 0, size, size);
  let seed = 19;
  const r = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < 50; k++) {
    const x = r() * size, y = r() * size, rad = 14 + r() * 44;
    for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]] as const) {
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
      g.addColorStop(0, "rgba(196,154,102,0.28)");
      g.addColorStop(1, "rgba(196,154,102,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
    }
  }
  for (let k = 0; k < 420; k++) {
    ctx.fillStyle = r() > 0.55 ? "rgba(70,48,28,0.22)" : "rgba(255,236,210,0.28)";
    ctx.fillRect(r() * size, r() * size, 1 + r() * 2.2, 1 + r() * 1.6);
  }
  ctx.lineCap = "round";
  for (let k = 0; k < 160; k++) {
    const x = r() * size, y = r() * size, a = (r() - 0.5) * 0.7, len = 5 + r() * 14;
    ctx.strokeStyle = "rgba(120,88,52,0.14)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  return canvasTex(canvas, true);
}

/** Roughness from pulp: calendered fibres a touch smoother, clumps a touch chalkier. Encodes absolute roughness. */
export function paperRoughness(size = 512): THREE.CanvasTexture {
  const h = pulp(size, [[8, 0.5, 21], [24, 0.3, 22], [64, 0.2, 23]]);
  return heightToRoughness(h, size, 0.78, 0.97);
}

export function kraftRoughness(size = 256): THREE.CanvasTexture {
  const h = pulp(size, [[6, 0.55, 31], [20, 0.3, 32]]);
  return heightToRoughness(h, size, 0.86, 1);
}

function heightToRoughness(h: Float32Array, size: number, lo: number, hi: number) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < h.length; i++) { const v = h[i]!; if (v < min) min = v; if (v > max) max = v; }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const span = max - min || 1;
  for (let i = 0; i < size * size; i++) {
    const g = (lo + ((h[i]! - min) / span) * (hi - lo)) * 255;
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasTex(canvas);
}

/** The paper core a cut edge shows: the sheet's own colour, washed out towards cream. */
export function cutEdge(color: THREE.ColorRepresentation, night = false) {
  return new THREE.Color(color).lerp(new THREE.Color(night ? 0x8a96b0 : 0xfff6ea), night ? 0.35 : 0.72);
}

/**
 * The cut edge of corrugated cardboard: two kraft liners with the wavy flute between them, and the
 * dark air gaps the flute leaves. One flute per texture width; the full thickness down its height.
 */
export function fluteTexture(): THREE.CanvasTexture {
  const w = 128, h = 64;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#3a2718";
  ctx.fillRect(0, 0, w, h);
  const liner = 11, amp = h / 2 - liner - 4, mid = h / 2, thick = 7;
  ctx.beginPath();
  for (let x = 0; x <= w; x++) {
    const y = mid + Math.sin((x / w) * Math.PI * 2) * amp;
    if (x === 0) ctx.moveTo(x, y + thick / 2); else ctx.lineTo(x, y + thick / 2);
  }
  for (let x = w; x >= 0; x--) {
    const y = mid + Math.sin((x / w) * Math.PI * 2) * amp;
    ctx.lineTo(x, y - thick / 2);
  }
  ctx.closePath();
  ctx.fillStyle = "#c4a06c";
  ctx.fill();
  ctx.strokeStyle = "#a07848";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  const speck = (y0: number, hh: number) => {
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = i % 2 ? "rgba(70,48,28,0.22)" : "rgba(255,230,200,0.2)";
      ctx.fillRect(Math.random() * w, y0 + Math.random() * hh, 1.4, 1.1);
    }
  };
  ctx.fillStyle = "#d2ae7a";
  ctx.fillRect(0, 0, w, liner);
  ctx.fillStyle = "#c9a476";
  ctx.fillRect(0, h - liner, w, liner);
  speck(0, liner);
  speck(h - liner, liner);
  return canvasTex(canvas, true);
}

export interface PaperOpts {
  glow?: THREE.ColorRepresentation;
  glowIntensity?: number;
  side?: THREE.Side;
  flat?: boolean;
  /** Kraft liner + flute-through grain, for corrugated faces. */
  cardboard?: boolean;
  /** Coloured card glued over corrugated board: the sheet's colour, with the flutes showing through. */
  corrugated?: boolean;
}

/**
 * Shared paper materials, one per colour, all sharing the grain. The grain is mapped from world
 * space (whichever axis a face looks along), so a big sheet and a tiny one show fibres the same
 * size, the way real paper does, instead of stretching one texture over every face.
 */
export class Paper {
  readonly grain = paperNormalMap();
  readonly albedo = paperAlbedo();
  readonly rough = paperRoughness();
  readonly kraftGrain = kraftNormalMap();
  readonly ridges = corrugatedNormalMap();
  readonly kraftAlbedo = kraftAlbedo();
  readonly kraftRough = kraftRoughness();
  readonly flutes = fluteTexture();
  readonly #cache = new Map<string, THREE.MeshPhysicalMaterial>();

  /** `scale`: grain tiles per world unit. */
  constructor(readonly scale = 1.6) {}

  /** Matte card stock in `color`; `glow` makes it a lit window or lamp at night; `flat` shows folds as facets. */
  get(color: THREE.ColorRepresentation, opts: PaperOpts = {}) {
    const key = `${opts.cardboard ? "c" : opts.corrugated ? "r" : "p"}|${new THREE.Color(color).getHexString()}|${opts.glow ? new THREE.Color(opts.glow).getHexString() : ""}|${opts.glowIntensity ?? 0}|${opts.side ?? 0}|${opts.flat ? 1 : 0}`;
    let m = this.#cache.get(key);
    if (!m) {
      const board = !!opts.cardboard;
      const lit = (opts.glowIntensity ?? 0) > 0;
      const ribbed = !board && !!opts.corrugated;
      const n = board ? 0.8 : ribbed ? 0.9 : 0.75;
      m = new THREE.MeshPhysicalMaterial({
        color, roughness: 1, metalness: 0,
        map: board ? this.kraftAlbedo : this.albedo,
        roughnessMap: board ? this.kraftRough : this.rough,
        normalMap: board ? this.kraftGrain : ribbed ? this.ridges : this.grain,
        normalScale: new THREE.Vector2(n, n),
        sheen: lit ? 0.14 : board ? 0.22 : 0.36,
        sheenRoughness: board ? 0.92 : 0.78,
        sheenColor: new THREE.Color(board ? 0xe6c9a0 : 0xf7f1e6),
        specularIntensity: lit ? 0.35 : board ? 0.12 : 0.2,
        emissive: opts.glow ?? 0x000000, emissiveIntensity: opts.glowIntensity ?? 0,
        side: opts.side ?? THREE.FrontSide, flatShading: opts.flat ?? false,
      });
      const scale = this.scale.toFixed(3);
      m.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace("#include <uv_vertex>", `#include <uv_vertex>
          vec3 pWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          vec3 nWorld = abs(normalize(mat3(modelMatrix) * normal));
          vec2 pUv = (nWorld.y > max(nWorld.x, nWorld.z) ? pWorld.xz : (nWorld.x > nWorld.z ? pWorld.zy : pWorld.xy)) * ${scale};
          #ifdef USE_MAP
            vMapUv = pUv;
          #endif
          #ifdef USE_NORMALMAP
            vNormalMapUv = pUv * 0.85;
          #endif
          #ifdef USE_ROUGHNESSMAP
            vRoughnessMapUv = pUv;
          #endif`);
      };
      m.customProgramCacheKey = () => `paper-${scale}`;
      this.#cache.set(key, m);
    }
    return m;
  }

  /** A cut sheet's two materials: its colour on the faces, the paper core on the cut edges. */
  sheet(color: THREE.ColorRepresentation, night: boolean, opts: PaperOpts = {}): [THREE.Material, THREE.Material] {
    return [this.get(color, opts), this.get(cutEdge(color, night))];
  }

  /**
   * The corrugated cut edge of a cardboard sheet `thick` units thick, for ExtrudeGeometry's side
   * walls (their v runs 1 - depth), with a flute every `pitch` units along the edge.
   */
  flute(thick: number, night: boolean, pitch = 0.075) {
    const key = `flute|${thick.toFixed(3)}|${night ? 1 : 0}`;
    let m = this.#cache.get(key);
    if (!m) {
      const map = this.flutes.clone();
      map.repeat.set(1 / pitch, 1 / thick);
      map.offset.set(0, -(1 - thick) / thick);
      m = new THREE.MeshPhysicalMaterial({
        map, roughness: 0.92, metalness: 0, color: night ? 0x8a8478 : 0xffffff,
        sheen: 0.18, sheenRoughness: 0.88, sheenColor: new THREE.Color(0xe6c9a0), specularIntensity: 0.12,
      });
      this.#cache.set(key, m);
    }
    return m;
  }

  dispose() {
    for (const m of this.#cache.values()) { if (m.map && m.map !== this.albedo && m.map !== this.kraftAlbedo && m.map !== this.flutes) m.map.dispose(); m.dispose(); }
    this.flutes.dispose();
    this.grain.dispose();
    this.albedo.dispose();
    this.rough.dispose();
    this.kraftGrain.dispose();
    this.ridges.dispose();
    this.kraftAlbedo.dispose();
    this.kraftRough.dispose();
  }
}

/** Paper colours for day and night: construction paper by day, the same sheets under moonlight at night. */
export const PALETTE = {
  day: {
    board: 0xc9a57c, boardEdge: 0xb08c62, kraft: 0xc9a476, road: 0x8f97a6, lane: 0xffffff, grass: 0x9fd07f, grassAlt: 0x8cc46e, paving: 0xf5e6c8, wall: 0xfffaf0, wallShade: 0xece2cf,
    wood: 0xc19468, steel: 0x9aa1ac, glass: 0xbfd0e6, window: 0x8ea4c9, leaf: 0x7cc35a, leafDark: 0x58a447, trunk: 0x8a6a4f, water: 0x9fcbe8, foam: 0xe7e0d0,
    sky: 0xe7dfd0, hemiSky: 0xd2e0f6, hemiGround: 0xc4a078, sun: 0xffe2b8, sunIntensity: 2.7, hemiIntensity: 0.52,
    fill: 0xd6e4ff, fillIntensity: 0.4, bounce: 0xd4a56a, bounceIntensity: 0.28, exposure: 1.04,
    glow: 0xffcf6e, glowIntensity: 0, env: 0.12,
  },
  night: {
    board: 0x3a3832, boardEdge: 0x2c2a26, kraft: 0x5a4a38, road: 0x262f40, lane: 0x5a6680, grass: 0x24402f, grassAlt: 0x203a2a, paving: 0x323e54, wall: 0x46587a, wallShade: 0x36465f,
    wood: 0x6b4f39, steel: 0x56627a, glass: 0x2a3a56, window: 0xffc861, leaf: 0x2f5a43, leafDark: 0x23463a, trunk: 0x4b3a2c, water: 0x2d5f86, foam: 0x3e3c36,
    sky: 0x0f1726, hemiSky: 0x6f84b8, hemiGround: 0x1a140e, sun: 0xc5d4ff, sunIntensity: 0.55, hemiIntensity: 0.42,
    fill: 0x6a7aa0, fillIntensity: 0.12, bounce: 0x3a2e22, bounceIntensity: 0.08, exposure: 0.92,
    glow: 0xffc861, glowIntensity: 1.75, env: 0.06,
  },
} as const;
export type Palette = (typeof PALETTE)["day"] | (typeof PALETTE)["night"];
