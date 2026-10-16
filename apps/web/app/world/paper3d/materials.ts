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
  tex.repeat.set(3, 3);
  return tex;
}

/** Shared paper materials, one per colour, all sharing the grain. */
export class Paper {
  readonly grain = paperNormalMap();
  readonly #cache = new Map<string, THREE.MeshStandardMaterial>();

  /** Matte card stock in `color`; `glow` makes it a lit window or lamp at night. */
  get(color: THREE.ColorRepresentation, opts: { glow?: THREE.ColorRepresentation; glowIntensity?: number; side?: THREE.Side; alphaMap?: THREE.Texture } = {}) {
    const key = `${new THREE.Color(color).getHexString()}|${opts.glow ? new THREE.Color(opts.glow).getHexString() : ""}|${opts.glowIntensity ?? 0}|${opts.side ?? 0}`;
    let m = this.#cache.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color, roughness: 1, metalness: 0, normalMap: this.grain, normalScale: new THREE.Vector2(0.55, 0.55),
        emissive: opts.glow ?? 0x000000, emissiveIntensity: opts.glowIntensity ?? 0, side: opts.side ?? THREE.FrontSide,
      });
      this.#cache.set(key, m);
    }
    return m;
  }

  dispose() {
    for (const m of this.#cache.values()) m.dispose();
    this.grain.dispose();
  }
}

/** Paper colours for day and night: construction paper by day, the same sheets under moonlight at night. */
export const PALETTE = {
  day: {
    board: 0xe6dcc8, road: 0x9aa0ab, lane: 0xf6f1e4, grass: 0xb5cf9c, grassAlt: 0xa8c48f, paving: 0xf2eadb, wall: 0xfbf6ec, wallShade: 0xe9e1d1,
    wood: 0xc19468, steel: 0x9aa1ac, glass: 0xbfd0e6, window: 0x8ea4c9, leaf: 0x93c27a, leafDark: 0x7aae63, trunk: 0x8a6a4f, water: 0x9fcbe8,
    sky: 0xece6d9, hemiSky: 0xfffaf0, hemiGround: 0xb8ad98, sun: 0xfff4e0, sunIntensity: 2.4, hemiIntensity: 1.35, glow: 0xffcf6e, glowIntensity: 0,
  },
  night: {
    board: 0x2a3446, road: 0x262f40, lane: 0x5a6680, grass: 0x24402f, grassAlt: 0x203a2a, paving: 0x323e54, wall: 0x46587a, wallShade: 0x36465f,
    wood: 0x6b4f39, steel: 0x56627a, glass: 0x2a3a56, window: 0xffc861, leaf: 0x2f5a43, leafDark: 0x23463a, trunk: 0x4b3a2c, water: 0x2d5f86,
    sky: 0x0f1726, hemiSky: 0x6f84b8, hemiGround: 0x141a26, sun: 0xb9c8ff, sunIntensity: 0.9, hemiIntensity: 0.9, glow: 0xffc861, glowIntensity: 1.6,
  },
} as const;
export type Palette = (typeof PALETTE)["day"] | (typeof PALETTE)["night"];
