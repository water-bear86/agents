// Paper models for the 3D town. Grid (x, y) maps to world (x, z) with y up; one tile is one unit
// and SVG pixel heights become units at PX.
//
// What makes it read as paper rather than plastic:
// - Flat pieces are cut sheets: hand-cut outlines that wobble a little, a coloured face and a pale
//   cut edge where the paper's core shows (see `sheet`).
// - Solid pieces are folded card: crisp folds and faceted curves, never smooth CG cylinders, with a
//   pale line along every fold where the colour has cracked and the white paper shows through.
// - Nothing is quite square: every piece sits a fraction of a degree off, the way a hand glues it.
// - Windows, signs and notes are separate scraps glued on, a little crooked.
// - Trees are cut-out silhouettes slotted together, so their shadows are paper shapes too.

import * as THREE from "three";
import type { Project } from "../../../lib/api";
import { CAFE_TABLES, HOUSE, LOT, type Place, type Tier } from "../../../lib/world";
import { cutEdge, type Paper, type Palette } from "./materials";

/** SVG pixel heights to world units. */
export const PX = 1 / 40;

/** Anything this thin or thinner is a cut sheet rather than a folded box. */
const SHEET = 0.13;

/** Repeatable noise in [0, 1) from a few numbers, so a piece's wobble stays put between rebuilds. */
export function hash(...n: number[]) {
  let h = 2166136261;
  for (const v of n) { h ^= Math.round(v * 997); h = Math.imul(h, 16777619); h ^= h >>> 13; }
  return ((h >>> 0) % 100003) / 100003;
}

/** A hand-cut outline round a w x d rectangle centred on the origin: softened corners, edges that wander. */
export function cutRect(w: number, d: number, seed: number, wobble = 0.01): THREE.Vector2[] {
  const rc = Math.min(0.05, w / 4, d / 4);
  const pts: THREE.Vector2[] = [];
  const corners = [[w / 2, d / 2, 0], [-w / 2, d / 2, 1], [-w / 2, -d / 2, 2], [w / 2, -d / 2, 3]] as const;
  for (const [cx, cz, k] of corners) {
    const sx = Math.sign(cx), sz = Math.sign(cz);
    // Corner, as three points on a small arc.
    for (let a = 0; a <= 2; a++) {
      const t = (a / 2) * (Math.PI / 2) + (k * Math.PI) / 2;
      pts.push(new THREE.Vector2(cx - sx * rc + Math.cos(t) * rc, cz - sz * rc + Math.sin(t) * rc));
    }
    // The edge to the next corner, nudged in and out.
    const [nx, nz] = corners[(k + 1) % 4]!;
    const len = Math.hypot(nx - cx, nz - cz) - 2 * rc;
    const steps = Math.max(1, Math.floor(len / 0.35));
    const ux = (nx - cx) / (len + 2 * rc), uz = (nz - cz) / (len + 2 * rc);
    for (let i = 1; i < steps; i++) {
      const f = rc + (i / steps) * len, j = (hash(seed, k, i) - 0.5) * 2 * wobble;
      pts.push(new THREE.Vector2(cx + ux * f - uz * j, cz + uz * f + ux * j));
    }
  }
  // Shape space is (x, -z): the sheet is laid flat by rotating it about x.
  return pts.map((p) => new THREE.Vector2(p.x, -p.y));
}

export class Kit {
  constructor(readonly paper: Paper, readonly pal: Palette, readonly night: boolean) {}

  /** Paper colour by hue (oklch-ish via HSL), for houses and buildings that wear their owner's colour. */
  hueColor(h: number, l = 0.66, s = 0.5) { return new THREE.Color().setHSL(h / 360, s, l); }

  #mesh(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], fold?: THREE.ColorRepresentation) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    if (fold !== undefined) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), this.#foldMat(fold));
      e.raycast = () => {};
      m.add(e);
    }
    return m;
  }

  /** Fold lines: the paper's white core showing through cracked colour along a crease. */
  #folds = new Map<string, THREE.LineBasicMaterial>();
  #foldMat(color: THREE.ColorRepresentation) {
    const c = cutEdge(color, this.night).lerp(new THREE.Color(this.night ? 0x9aa6c0 : 0xffffff), 0.4);
    const key = c.getHexString();
    let m = this.#folds.get(key);
    if (!m) { m = new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: this.night ? 0.45 : 0.85 }); this.#folds.set(key, m); }
    return m;
  }

  /** How far off square a hand puts a piece this big: a fraction of a degree, less for big pieces. */
  #skew(seed: number, size: number) { return (hash(seed, 3) - 0.5) * 2 * Math.min(0.022, 0.012 / Math.max(0.5, size)); }

  /**
   * A cut sheet: `outline` (shape space, see cutRect) extruded `h` thick and laid flat, its top in
   * `color` and its cut edges in the paper's paler core.
   */
  sheet(outline: THREE.Vector2[], h: number, color: THREE.ColorRepresentation, opts: { glow?: boolean; edge?: THREE.ColorRepresentation; cardboard?: boolean } = {}) {
    const geo = new THREE.ExtrudeGeometry(new THREE.Shape(outline), { depth: h, bevelEnabled: false, curveSegments: 2 });
    geo.rotateX(-Math.PI / 2);
    if (opts.cardboard) return this.#mesh(geo, [this.mat(color), this.paper.flute(h, this.night)]);
    // The outline traces the cut, so the pale edge still shows when the sheet is too thin to see side on.
    return this.#mesh(geo, [this.mat(color, opts.glow), this.paper.get(opts.edge ?? cutEdge(color, this.night))], opts.edge ?? color);
  }

  /**
   * A box by its grid corner, footprint and height (units), raised to y0. Thin ones are cut sheets;
   * thicker ones are folded card boxes. `square` keeps it dead straight
   * (room shells, where a skew would open a gap at the corners); `sheet` forces a cut sheet.
   */
  box(gx: number, gz: number, sx: number, sz: number, h: number, color: THREE.ColorRepresentation, y0 = 0, opts: { glow?: boolean; edges?: boolean; square?: boolean; sheet?: boolean; cardboard?: boolean; edge?: THREE.ColorRepresentation; wobble?: number } = {}) {
    const seed = gx * 31.7 + gz * 17.3 + y0 * 7.1 + sx * 3.3 + h;
    let m: THREE.Mesh;
    if ((h <= SHEET || opts.sheet || opts.cardboard) && Math.min(sx, sz) > 0.03) {
      m = this.sheet(cutRect(sx, sz, seed, opts.wobble ?? Math.min(0.012, Math.min(sx, sz) * 0.04)), h, color, { glow: opts.glow, edge: opts.edge, cardboard: opts.cardboard });
      m.position.set(gx + sx / 2, y0, gz + sz / 2);
    } else {
      m = this.#mesh(new THREE.BoxGeometry(sx, h, sz), this.mat(color, opts.glow), opts.glow && this.night ? undefined : color);
      m.position.set(gx + sx / 2, y0 + h / 2, gz + sz / 2);
    }
    if (!opts.square) m.rotation.y = this.#skew(seed, Math.max(sx, sz));
    return m;
  }

  /**
   * A standing wall of corrugated cardboard, `len` long and `h` tall, `thick` through, running from
   * (gx, gz) along +x or +z. Along x it sits behind gz; along z it sits in front of gx. Paper is glued over both faces in
   * `color`; the top and the open end show the flutes.
   */
  cardWall(gx: number, gz: number, len: number, h: number, thick: number, color: THREE.ColorRepresentation, along: "x" | "z") {
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(len, 0), new THREE.Vector2(len, h), new THREE.Vector2(0, h)]);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
    // Shape x runs along the wall and y up; the extrusion is the thickness, behind the inner face.
    geo.translate(0, 0, -thick);
    const m = this.#mesh(geo, [this.mat(color), this.paper.flute(thick, this.night)]);
    // Turned to run along +z, the thickness runs from gx towards +x, so pass gx one thickness behind the inner face.
    if (along === "z") m.rotation.y = -Math.PI / 2;
    m.position.set(gx, 0, gz);
    return m;
  }

  /** A rolled or folded tube: faceted, so it reads as card bent round, not a lathe-turned rod. */
  cyl(cx: number, cz: number, r: number, h: number, color: THREE.ColorRepresentation, y0 = 0, opts: { top?: number; seg?: number; glow?: boolean } = {}) {
    const seg = opts.seg ?? (r < 0.12 ? 7 : r < 0.5 ? 10 : 14);
    const m = this.#mesh(new THREE.CylinderGeometry(opts.top ?? r, r, h, seg), this.mat(color, opts.glow, true), r > 0.06 && !(opts.glow && this.night) ? color : undefined);
    m.position.set(cx, y0 + h / 2, cz);
    m.rotation.y = hash(cx, cz, y0) * Math.PI;
    return m;
  }

  cone(cx: number, cz: number, r: number, h: number, color: THREE.ColorRepresentation, y0 = 0, seg = 7) {
    const m = this.#mesh(new THREE.ConeGeometry(r, h, Math.min(seg, 12)), this.mat(color, false, true), color);
    m.position.set(cx, y0 + h / 2, cz);
    return m;
  }

  /** A dome folded from gores, like a paper lantern cut in half. */
  dome(cx: number, cz: number, r: number, y0: number, color: THREE.ColorRepresentation, squash = 1) {
    const m = this.#mesh(new THREE.SphereGeometry(r, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2), this.mat(color, false, true), color);
    m.scale.y = squash;
    m.position.set(cx, y0, cz);
    return m;
  }

  /**
   * A scrap of paper glued flat onto a wall (window, sign, note) facing +z or +x, centred at a point:
   * it has a little thickness and a pale cut edge, stands just proud of the wall and sits a touch crooked.
   */
  panel(cx: number, cy: number, cz: number, w: number, h: number, color: THREE.ColorRepresentation, facing: "z" | "x", glow = false) {
    const t = 0.012;
    const face = this.mat(color, glow), edge = this.paper.get(cutEdge(color, this.night));
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), [edge, edge, edge, edge, face, face]);
    m.castShadow = true;
    m.receiveShadow = true;
    if (facing === "x") m.rotation.y = Math.PI / 2;
    m.rotation.z = (hash(cx, cy, cz) - 0.5) * 0.07;
    m.position.set(cx + (facing === "x" ? t : 0), cy, cz + (facing === "z" ? t : 0));
    return m;
  }

  mat(color: THREE.ColorRepresentation, glow = false, flat = false) {
    return glow && this.night ? this.paper.get(this.pal.window, { glow: this.pal.glow, glowIntensity: this.pal.glowIntensity, flat }) : this.paper.get(color, { flat });
  }

  /** Windows in rows on the two faces the camera sees (+z and +x), for a box at (gx, gz, sx, sz). */
  windows(g: THREE.Group, gx: number, gz: number, sx: number, sz: number, storeys: number[], lit: boolean) {
    for (const y of storeys) {
      for (let a = gx + 0.25; a < gx + sx - 0.15; a += 0.42) g.add(this.panel(a + 0.1, y, gz + sz + 0.006, 0.2, 0.18, this.pal.window, "z", lit));
      for (let b = gz + 0.25; b < gz + sz - 0.15; b += 0.42) g.add(this.panel(gx + sx + 0.006, y, b + 0.1, 0.2, 0.18, this.pal.window, "x", lit));
    }
  }

  // ---------------------------------------------------------------- places

  place(p: Place, tone: THREE.Color, act: { launching: boolean }): THREE.Group {
    const g = new THREE.Group();
    const { x, y, sx, sy } = p;
    const P = this.pal;
    switch (p.id) {
      case "exchange": {
        g.add(this.box(x, y, sx, sy, 0.18, P.paving));
        g.add(this.box(x + 0.55, y + 0.55, 1.9, 1.9, 2.6, P.wall, 0.18));
        g.add(this.box(x + 0.5, y + 0.5, 2.0, 2.0, 0.12, tone, 2.78));
        g.add(this.box(x + 0.5, y + 0.5, 2.0, 2.0, 0.16, tone, 0.95));
        this.windows(g, x + 0.55, y + 0.55, 1.9, 1.9, [0.55, 1.4, 1.75, 2.1, 2.45], true);
        break;
      }
      case "launchpad": {
        const cx = x + sx / 2, cz = y + sy / 2;
        g.add(this.box(x, y, sx, sy, 0.12, P.paving));
        g.add(this.cyl(cx, cz, 1.15, 0.1, tone, 0.12));
        g.add(this.box(x + 2.35, y + 0.45, 0.22, 0.22, 2.3, P.steel, 0.12));
        const rocket = new THREE.Group();
        rocket.add(this.cyl(0, 0, 0.2, 1.3, P.wall, 0));
        rocket.add(this.cone(0, 0, 0.2, 0.45, tone, 1.3, 18));
        for (let k = 0; k < 3; k++) {
          const fin = this.box(-0.02, -0.02, 0.04, 0.32, 0.36, tone, 0);
          fin.position.set(Math.cos((k * 2 * Math.PI) / 3) * 0.22, 0.18, Math.sin((k * 2 * Math.PI) / 3) * 0.22);
          fin.rotation.y = -(k * 2 * Math.PI) / 3;
          rocket.add(fin);
        }
        rocket.position.set(cx, 0.22, cz);
        rocket.name = "rocket";
        rocket.userData.launching = act.launching;
        g.add(rocket);
        break;
      }
      case "observatory": {
        const cx = x + 0.8, cz = y + 0.8;
        g.add(this.box(x, y, 1.6, 1.6, 0.22, P.wall));
        g.add(this.cyl(cx, cz, 0.68, 0.72, P.wall, 0.22));
        g.add(this.dome(cx, cz, 0.7, 0.94, tone));
        g.add(this.box(cx - 0.06, cz + 0.45, 0.12, 0.25, 0.55, 0x1b2230, 1.05));
        break;
      }
      case "debate": {
        const cx = x + 1.1, cz = y + 1.1;
        g.add(this.cyl(cx, cz, 1.05, 0.16, P.wall, 0));
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * Math.PI * 2;
          g.add(this.cyl(cx + Math.cos(a) * 0.82, cz + Math.sin(a) * 0.82, 0.07, 0.75, P.wall, 0.16, { seg: 10 }));
        }
        g.add(this.cyl(cx, cz, 1.0, 0.1, P.wall, 0.91));
        g.add(this.dome(cx, cz, 0.85, 1.0, tone, 0.45));
        break;
      }
      case "plaza": {
        g.add(this.box(x, y, sx, sy, 0.05, P.paving));
        const fx = x + 1.6, fz = y + 1.7;
        g.add(this.cyl(fx, fz, 0.6, 0.16, P.wall, 0.05));
        g.add(this.cyl(fx, fz, 0.5, 0.02, P.water, 0.2));
        g.add(this.cyl(fx, fz, 0.08, 0.45, P.wall, 0.05));
        g.add(this.box(x + 0.3, y + 0.15, 2.4, 0.1, 0.7, tone, 0.35));
        g.add(this.box(x + 0.35, y + 0.18, 0.06, 0.06, 0.35, P.steel, 0.05));
        g.add(this.box(x + 2.6, y + 0.18, 0.06, 0.06, 0.35, P.steel, 0.05));
        [0.5, 0.95, 1.4, 1.85].forEach((a, i) => g.add(this.panel(x + a, 0.75 - (i % 2) * 0.1, y + 0.26, 0.32, 0.36, [0xfffaf0, 0xf4e2a8, 0xd9e4f7][i % 3]!, "z")));
        g.add(this.box(x + 0.35, y + 2.45, 0.75, 0.2, 0.14, P.wood, 0.05));
        g.add(this.box(x + 2.45, y + 0.6, 0.2, 0.75, 0.14, P.wood, 0.05));
        break;
      }
      case "cafe": {
        g.add(this.box(10, 5, 4, 4, 0.05, P.wood));
        g.add(this.box(x, y, sx, sy, 0.85, P.wall, 0.05));
        g.add(this.box(x - 0.04, y - 0.04, sx + 0.08, sy + 0.08, 0.09, tone, 0.9));
        g.add(this.panel(x + 0.6, 0.45, y + sy + 0.004, 0.9, 0.5, P.window, "z", true));
        g.add(this.panel(x + 1.75, 0.45, y + sy + 0.004, 0.9, 0.5, P.window, "z", true));
        // Striped awning, sloping out over the terrace.
        for (let a = 0, k = 0; a < sx - 0.1; a += 0.3, k++) {
          const s = this.box(-0.15, 0, 0.3, 0.55, 0.03, k % 2 ? 0xfffaf0 : tone, 0, { edges: false });
          s.position.set(x + 0.1 + a + 0.15, 0.78, y + sy + 0.25);
          s.rotation.x = 0.35;
          g.add(s);
        }
        for (const t of CAFE_TABLES) {
          g.add(this.cyl(t.x, t.y, 0.04, 0.32, P.steel, 0.05, { seg: 8 }));
          g.add(this.cyl(t.x, t.y, 0.3, 0.04, P.wood, 0.37));
        }
        break;
      }
    }
    return g;
  }

  // ---------------------------------------------------------------- houses

  house(gx: number, gz: number, t: Tier, hue: number, lit: boolean): THREE.Group {
    const g = new THREE.Group();
    const n = HOUSE.size;
    const wall = t.wall * PX, roofH = t.roof * PX;
    const tone = this.hueColor(hue, 0.62, 0.45);
    g.add(this.box(gx, gz, n, n, wall, this.pal.wall));
    if (t.tier === 4) {
      g.add(this.box(gx - 0.04, gz - 0.04, n + 0.08, n + 0.08, 0.1, tone, wall));
    } else {
      // A gable roof: a triangular prism along x.
      const shape = new THREE.Shape([new THREE.Vector2(-n / 2 - 0.06, 0), new THREE.Vector2(n / 2 + 0.06, 0), new THREE.Vector2(0, roofH)]);
      // Gable ends are wall card; the slopes are one sheet of coloured card folded over the ridge.
      const roof = this.#mesh(new THREE.ExtrudeGeometry(shape, { depth: n + 0.12, bevelEnabled: false }), [this.paper.get(cutEdge(tone, this.night)), this.paper.get(tone, { flat: true })], tone);
      roof.rotation.y = Math.PI / 2;
      roof.position.set(gx - 0.06, wall, gz + n / 2);
      g.add(roof);
    }
    this.windows(g, gx, gz, n, n, t.storeys.map((s) => (s + 7) * PX), lit);
    g.add(this.panel(gx + n / 2, 0.19, gz + n + 0.004, 0.28, 0.38, tone.clone().multiplyScalar(0.6), "z"));
    return g;
  }

  // ---------------------------------------------------------------- the agents' quarter

  project(p: Project, gx: number, gz: number, hue: number, progress: number): THREE.Group {
    const g = new THREE.Group();
    const P = this.pal;
    const tone = this.hueColor(hue, 0.6, 0.5);
    const c = { x: gx + LOT / 2, z: gz + LOT / 2 };
    if (p.status === "proposed") {
      g.add(this.box(gx, gz, LOT, LOT, 0.03, 0xc9a77c));
      for (let k = 0; k <= 6; k++) {
        g.add(this.box(gx + (k / 6) * LOT - 0.02, gz + LOT - 0.03, 0.04, 0.04, 0.22, P.wood));
        g.add(this.box(gx + LOT - 0.03, gz + (k / 6) * LOT - 0.02, 0.04, 0.04, 0.22, P.wood));
      }
      const frac = Math.min(1, p.raised / p.cost);
      if (frac > 0) g.add(this.box(c.x - 0.25, c.z - 0.15, 0.5, 0.3, 0.05 + 0.35 * frac, 0xc4643f));
      return g;
    }
    if (p.status === "building") {
      g.add(this.box(gx, gz, LOT, LOT, 0.03, 0xc9a77c));
      const h = Math.max(0.2, 2.2 * progress);
      g.add(this.box(gx + 0.25, gz + 0.25, LOT - 0.5, LOT - 0.5, h, P.wall));
      for (const [a, b] of [[0.1, 0.1], [LOT - 0.1, 0.1], [0.1, LOT - 0.1], [LOT - 0.1, LOT - 0.1]] as const) g.add(this.box(gx + a - 0.02, gz + b - 0.02, 0.04, 0.04, h + 0.3, 0xd9a441));
      for (let y = 0.35; y < h + 0.3; y += 0.35) {
        g.add(this.box(gx + 0.08, gz + LOT - 0.12, LOT - 0.16, 0.04, 0.03, 0xd9a441, y));
        g.add(this.box(gx + LOT - 0.12, gz + 0.08, 0.04, LOT - 0.16, 0.03, 0xd9a441, y));
      }
      g.add(this.box(gx + 0.05, gz + 0.05, 0.08, 0.08, 3.2, 0xe2b84e));
      const jib = this.box(-0.2, -0.04, 1.6, 0.08, 0.08, 0xe2b84e, 0);
      jib.position.set(gx + 0.6, 3.2, gz + 0.09);
      jib.name = "jib";
      g.add(jib);
      return g;
    }
    switch (p.kind) {
      case "tower":
        g.add(this.box(gx + 0.3, gz + 0.3, 1, 1, 3.0, P.wall));
        g.add(this.box(gx + 0.25, gz + 0.25, 1.1, 1.1, 0.12, tone, 3.0));
        this.windows(g, gx + 0.3, gz + 0.3, 1, 1, [0.5, 1.0, 1.5, 2.0, 2.5], true);
        g.add(this.cyl(c.x, c.z, 0.08, 0.3, tone, 3.12, { glow: true }));
        break;
      case "dome":
        g.add(this.box(gx + 0.05, gz + 0.05, 1.5, 1.5, 0.2, P.wall));
        g.add(this.cyl(c.x, c.z, 0.7, 0.55, P.wall, 0.2));
        g.add(this.dome(c.x, c.z, 0.72, 0.75, tone));
        break;
      case "arcade":
        g.add(this.box(gx, gz + 0.2, 1.6, 1.2, 0.85, P.wall));
        g.add(this.box(gx - 0.04, gz + 0.16, 1.68, 1.28, 0.1, tone, 0.85));
        g.add(this.panel(gx + 0.8, 0.45, gz + 1.404, 1.3, 0.5, P.window, "z", true));
        break;
      case "garden":
        g.add(this.box(gx, gz, LOT, LOT, 0.04, P.grass));
        g.add(this.box(gx, gz, LOT, 0.18, 0.22, P.leafDark));
        g.add(this.box(gx, gz, 0.18, LOT, 0.22, P.leafDark));
        g.add(this.cyl(c.x, c.z, 0.35, 0.12, P.wall, 0.04));
        g.add(this.cyl(c.x, c.z, 0.28, 0.02, P.water, 0.16));
        for (const [a, b] of [[0.35, 1.25], [1.25, 0.35], [1.3, 1.3]] as const) g.add(this.dome(gx + a, gz + b, 0.13, 0.04, tone));
        break;
      case "statue":
        g.add(this.box(gx + 0.2, gz + 0.2, 1.2, 1.2, 0.04, P.paving));
        g.add(this.box(gx + 0.45, gz + 0.45, 0.7, 0.7, 0.5, P.wall, 0.04));
        g.add(this.box(gx + 0.4, gz + 0.4, 0.8, 0.8, 0.08, tone, 0.54));
        break;
      case "lighthouse":
        g.add(this.box(gx + 0.15, gz + 0.15, 1.3, 1.3, 0.15, P.wall));
        [[0.45, tone], [0.42, P.wall], [0.39, tone], [0.36, P.wall]].forEach(([r, col], i) => g.add(this.cyl(c.x, c.z, r as number, 0.6, col as THREE.ColorRepresentation, 0.15 + i * 0.6, { top: (r as number) - 0.03 })));
        g.add(this.cyl(c.x, c.z, 0.22, 0.3, P.glow, 2.55, { glow: true }));
        g.add(this.cone(c.x, c.z, 0.3, 0.3, tone, 2.85, 16));
        break;
      case "stage":
        g.add(this.box(gx, gz, 1.6, 1.4, 0.2, P.wood));
        g.add(this.box(gx + 0.05, gz + 0.05, 1.5, 0.1, 0.9, tone, 0.2));
        g.add(this.box(gx + 0.1, gz + 0.9, 0.22, 0.22, 0.4, P.steel, 0.2));
        g.add(this.box(gx + 1.25, gz + 0.9, 0.22, 0.22, 0.4, P.steel, 0.2));
        break;
      case "lab":
        g.add(this.box(gx + 0.1, gz + 0.1, 1.4, 1.4, 0.7, P.wall));
        g.add(this.box(gx + 0.2, gz + 0.2, 1.2, 1.2, 0.35, P.glass, 0.7));
        g.add(this.box(gx + 1.15, gz + 0.25, 0.22, 0.22, 0.6, tone, 0.7));
        this.windows(g, gx + 0.1, gz + 0.1, 1.4, 1.4, [0.35], true);
        break;
    }
    return g;
  }

  // ---------------------------------------------------------------- scenery

  /**
   * A paper tree: two cut-out silhouettes slotted into each other at right angles, one a shade darker,
   * standing on a short trunk. Some are round and leafy, some are pines.
   */
  tree(x: number, z: number, s: number) {
    const g = new THREE.Group();
    const pine = hash(x, z, 1) > 0.55;
    const key = pine ? "pine" : "round";
    const canopy = this.#cut(key, () => pine ? pineOutline() : blobOutline(hash(x, z, 2)));
    const trunk = this.#cut("trunk", () => [new THREE.Vector2(-0.035, 0), new THREE.Vector2(0.035, 0), new THREE.Vector2(0.028, 0.3), new THREE.Vector2(-0.028, 0.3)]);
    const turn = (hash(x, z, 3) - 0.5) * 0.5;
    [this.pal.leaf, this.pal.leafDark].forEach((col, k) => {
      const card = new THREE.Group();
      card.add(this.#mesh(trunk, [this.paper.get(this.pal.trunk), this.paper.get(cutEdge(this.pal.trunk, this.night))]));
      const leaves = this.#mesh(canopy, [this.paper.get(col), this.paper.get(cutEdge(col, this.night))]);
      leaves.position.y = pine ? 0.12 : 0.2;
      card.add(leaves);
      card.rotation.y = turn + (k * Math.PI) / 2;
      g.add(card);
    });
    g.scale.setScalar(s);
    g.position.set(x, 0, z);
    return g;
  }

  /** A cut-out silhouette, extruded paper-thin and centred on its own thickness; built once per kind. */
  #cuts = new Map<string, THREE.BufferGeometry>();
  #cut(key: string, outline: () => THREE.Vector2[]) {
    let geo = this.#cuts.get(key);
    if (!geo) {
      geo = new THREE.ExtrudeGeometry(new THREE.Shape(outline()), { depth: 0.014, bevelEnabled: false, curveSegments: 3 });
      geo.translate(0, 0, -0.007);
      this.#cuts.set(key, geo);
    }
    return geo;
  }

  lamp(x: number, z: number) {
    const g = new THREE.Group();
    g.add(this.cyl(x, z, 0.025, 0.85, this.pal.steel, 0, { seg: 6 }));
    g.add(this.cyl(x, z, 0.08, 0.08, 0xfff1c9, 0.85, { seg: 10, glow: true }));
    return g;
  }
}

/** A leafy canopy outline: a lumpy circle, scissor-cut in short straight snips. */
function blobOutline(seed: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const n = 22, R = 0.34;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = R * (1 + 0.1 * Math.sin(t * 5 + seed * 6) + 0.05 * Math.sin(t * 3 + seed * 11));
    pts.push(new THREE.Vector2(Math.cos(t) * r * 0.9, R + 0.02 + Math.sin(t) * r));
  }
  return pts;
}

/** A pine outline: three zigzag tiers to a point. */
function pineOutline(): THREE.Vector2[] {
  const tiers = [[0.36, 0], [0.28, 0.24], [0.2, 0.46]] as const;
  const right: THREE.Vector2[] = [];
  tiers.forEach(([w, y], i) => {
    right.push(new THREE.Vector2(w, y));
    const next = tiers[i + 1];
    right.push(new THREE.Vector2(next ? next[0] * 0.55 : 0, next ? next[1] : 0.78));
  });
  const left = right.slice(0, -1).reverse().map((p) => new THREE.Vector2(-p.x, p.y));
  return [new THREE.Vector2(0, 0), ...right, ...left];
}
