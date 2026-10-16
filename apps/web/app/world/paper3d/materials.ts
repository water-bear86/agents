// Paper for the 3D town: matte card stock (roughness 1, metalness 0) with a paper-grain normal
// map generated on the fly, so light raking across a sheet picks out its fibres. Colours are
// paper colours; shadows stay soft and tinted because the hemisphere light bounces plenty of
// light back in (see town.ts).

import * as THREE from "three";

/** A tileable paper-grain normal map: soft value noise for the pulp plus short fibres, as normals. */
export function paperNormalMap(size = 256): THREE.CanvasTexture {
  const h = new Float32Array(size * size);
  // Value noise in a few octaves, wrapped so the texture tiles.
  const rnd = (x: number, y: number, s: number) => {
    let n = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (const [cells, amp, seed] of [[8, 0.5, 1], [16, 0.3, 2], [48, 0.2, 3]] as const) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, fy = (y / size) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = smooth(fx - x0), ty = smooth(fy - y0);
      const v = (i: number, j: number) => rnd((x0 + i) % cells, (y0 + j) % cells, seed);
      const a = v(0, 0) + (v(1, 0) - v(0, 0)) * tx, b = v(0, 1) + (v(1, 1) - v(0, 1)) * tx;
      h[y * size + x]! += (a + (b - a) * ty) * amp;
    }
  }
  // Fibres: short raised strokes in every direction.
  for (let f = 0; f < 420; f++) {
    let x = rnd(f, 1, 9) * size, y = rnd(f, 2, 9) * size;
    const ang = rnd(f, 3, 9) * Math.PI * 2, len = 6 + rnd(f, 4, 9) * 18;
    for (let s = 0; s < len; s++) {
      x += Math.cos(ang); y += Math.sin(ang);
      const i = ((Math.round(y) % size) + size) % size * size + (((Math.round(x) % size) + size) % size);
      h[i]! += 0.12;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2, dy = (at(x, y + 1) - at(x, y - 1)) * 2.2;
    const len = Math.hypot(dx, dy, 1);
    const o = (y * size + x) * 4;
    img.data[o] = ((-dx / len) * 0.5 + 0.5) * 255;
    img.data[o + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
    img.data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
}

/** Paper's colour: pulp mottling and fibres in the albedo, near white so it tints whatever colour the sheet is. */
export function paperAlbedo(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fbfaf6";
  ctx.fillRect(0, 0, size, size);
  let seed = 7;
  const r = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  // The faintest cloudiness in the pulp, drawn wrapped so the texture tiles.
  for (let k = 0; k < 40; k++) {
    const x = r() * size, y = r() * size, rad = 16 + r() * 40;
    for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]] as const) {
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
      g.addColorStop(0, "rgba(232,226,212,0.18)");
      g.addColorStop(1, "rgba(232,226,212,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
    }
  }
  // Fine fibres, a touch lighter or darker than the sheet.
  ctx.lineCap = "round";
  for (let k = 0; k < 220; k++) {
    const x = r() * size, y = r() * size, a = r() * Math.PI * 2, len = 3 + r() * 9;
    ctx.strokeStyle = r() > 0.4 ? "rgba(255,255,255,0.7)" : "rgba(200,190,170,0.18)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The paper core a cut edge shows: the sheet's own colour, washed out towards white. */
export function cutEdge(color: THREE.ColorRepresentation, night = false) {
  return new THREE.Color(color).lerp(new THREE.Color(night ? 0x8a96b0 : 0xfffcf4), night ? 0.35 : 0.72);
}

/**
 * The cut edge of corrugated cardboard: two kraft liners with the wavy flute between them, and the
 * dark air gaps the flute leaves. One flute per texture width; the full thickness down its height.
 */
export function fluteTexture(): THREE.CanvasTexture {
  const w = 64, h = 64;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#4a3523";
  ctx.fillRect(0, 0, w, h);
  const liner = 9;
  ctx.strokeStyle = "#b98d5d";
  ctx.lineWidth = 6;
  ctx.beginPath();
  for (let x = 0; x <= w; x++) {
    const y = h / 2 + Math.sin((x / w) * Math.PI * 2) * (h / 2 - liner - 3);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = "#c9a476";
  ctx.fillRect(0, 0, w, liner);
  ctx.fillRect(0, h - liner, w, liner);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface PaperOpts { glow?: THREE.ColorRepresentation; glowIntensity?: number; side?: THREE.Side; flat?: boolean }

/**
 * Shared paper materials, one per colour, all sharing the grain. The grain is mapped from world
 * space (whichever axis a face looks along), so a big sheet and a tiny one show fibres the same
 * size, the way real paper does, instead of stretching one texture over every face.
 */
export class Paper {
  readonly grain = paperNormalMap();
  readonly albedo = paperAlbedo();
  readonly flutes = fluteTexture();
  readonly #cache = new Map<string, THREE.MeshStandardMaterial>();

  /** `scale`: grain tiles per world unit. */
  constructor(readonly scale = 1.6) {}

  /** Matte card stock in `color`; `glow` makes it a lit window or lamp at night; `flat` shows folds as facets. */
  get(color: THREE.ColorRepresentation, opts: PaperOpts = {}) {
    const key = `${new THREE.Color(color).getHexString()}|${opts.glow ? new THREE.Color(opts.glow).getHexString() : ""}|${opts.glowIntensity ?? 0}|${opts.side ?? 0}|${opts.flat ? 1 : 0}`;
    let m = this.#cache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color, roughness: 1, metalness: 0, map: this.albedo, normalMap: this.grain, normalScale: new THREE.Vector2(0.35, 0.35),
        emissive: opts.glow ?? 0x000000, emissiveIntensity: opts.glowIntensity ?? 0, side: opts.side ?? THREE.FrontSide, flatShading: opts.flat ?? false,
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
            vNormalMapUv = pUv * 1.7;
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
  flute(thick: number, night: boolean, pitch = 0.05) {
    const key = `flute|${thick.toFixed(3)}|${night ? 1 : 0}`;
    let m = this.#cache.get(key);
    if (!m) {
      const map = this.flutes.clone();
      map.repeat.set(1 / pitch, 1 / thick);
      map.offset.set(0, -(1 - thick) / thick);
      m = new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0, color: night ? 0x8a8478 : 0xffffff });
      this.#cache.set(key, m);
    }
    return m;
  }

  dispose() {
    for (const m of this.#cache.values()) { if (m.map && m.map !== this.albedo) m.map.dispose(); m.dispose(); }
    this.flutes.dispose();
    this.grain.dispose();
    this.albedo.dispose();
  }
}

/** Paper colours for day and night: construction paper by day, the same sheets under moonlight at night. */
export const PALETTE = {
  day: {
    board: 0xc9a57c, boardEdge: 0xb08c62, kraft: 0xc9a476, road: 0x8f97a6, lane: 0xffffff, grass: 0x9fd07f, grassAlt: 0x8cc46e, paving: 0xf5e6c8, wall: 0xfffaf0, wallShade: 0xece2cf,
    wood: 0xc19468, steel: 0x9aa1ac, glass: 0xbfd0e6, window: 0x8ea4c9, leaf: 0x7cc35a, leafDark: 0x58a447, trunk: 0x8a6a4f, water: 0x9fcbe8,
    sky: 0xece6d9, hemiSky: 0xe8eefc, hemiGround: 0xc9b38f, sun: 0xffe6c4, sunIntensity: 3.4, hemiIntensity: 0.85, glow: 0xffcf6e, glowIntensity: 0,
  },
  night: {
    board: 0x3a3832, boardEdge: 0x2c2a26, kraft: 0x5a4a38, road: 0x262f40, lane: 0x5a6680, grass: 0x24402f, grassAlt: 0x203a2a, paving: 0x323e54, wall: 0x46587a, wallShade: 0x36465f,
    wood: 0x6b4f39, steel: 0x56627a, glass: 0x2a3a56, window: 0xffc861, leaf: 0x2f5a43, leafDark: 0x23463a, trunk: 0x4b3a2c, water: 0x2d5f86,
    sky: 0x0f1726, hemiSky: 0x6f84b8, hemiGround: 0x141a26, sun: 0xb9c8ff, sunIntensity: 0.9, hemiIntensity: 0.9, glow: 0xffc861, glowIntensity: 1.6,
  },
} as const;
export type Palette = (typeof PALETTE)["day"] | (typeof PALETTE)["night"];
