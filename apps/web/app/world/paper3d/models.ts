// Paper models for the 3D town. Grid (x, y) maps to world (x, z) with y up; one tile is one unit
// and SVG pixel heights become units at PX. Every piece casts and receives soft shadows, and edges
// get a faint cut line so boxes read as folded card rather than plastic.

import * as THREE from "three";
import type { Project } from "../../../lib/api";
import { CAFE_TABLES, HOUSE, LOT, type Place, type Tier } from "../../../lib/world";
import type { Paper, Palette } from "./materials";

/** SVG pixel heights to world units. */
export const PX = 1 / 40;

export class Kit {
  constructor(readonly paper: Paper, readonly pal: Palette, readonly night: boolean) {}

  /** Paper colour by hue (oklch-ish via HSL), for houses and buildings that wear their owner's colour. */
  hueColor(h: number, l = 0.66, s = 0.5) { return new THREE.Color().setHSL(h / 360, s, l); }

  #mesh(geo: THREE.BufferGeometry, mat: THREE.Material, edges = true) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    if (edges) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: this.night ? 0x8a93a8 : 0xfffaf0, transparent: true, opacity: this.night ? 0.25 : 0.55 }));
      e.raycast = () => {};
      m.add(e);
    }
    return m;
  }

  /** A box by its grid corner, footprint and height (units), raised to y0. */
  box(gx: number, gz: number, sx: number, sz: number, h: number, color: THREE.ColorRepresentation, y0 = 0, opts: { glow?: boolean; edges?: boolean } = {}) {
    const m = this.#mesh(new THREE.BoxGeometry(sx, h, sz), this.mat(color, opts.glow), opts.edges ?? true);
    m.position.set(gx + sx / 2, y0 + h / 2, gz + sz / 2);
    return m;
  }

  cyl(cx: number, cz: number, r: number, h: number, color: THREE.ColorRepresentation, y0 = 0, opts: { top?: number; seg?: number; glow?: boolean } = {}) {
    const m = this.#mesh(new THREE.CylinderGeometry(opts.top ?? r, r, h, opts.seg ?? 28), this.mat(color, opts.glow), false);
    m.position.set(cx, y0 + h / 2, cz);
    return m;
  }

  cone(cx: number, cz: number, r: number, h: number, color: THREE.ColorRepresentation, y0 = 0, seg = 7) {
    const m = this.#mesh(new THREE.ConeGeometry(r, h, seg), this.mat(color), false);
    (m.material as THREE.MeshStandardMaterial).flatShading = true;
    m.position.set(cx, y0 + h / 2, cz);
    return m;
  }

  dome(cx: number, cz: number, r: number, y0: number, color: THREE.ColorRepresentation, squash = 1) {
    const m = this.#mesh(new THREE.SphereGeometry(r, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), this.mat(color), false);
    m.scale.y = squash;
    m.position.set(cx, y0, cz);
    return m;
  }

  /** A flat panel (window, sign, note) facing +z or +x, centred at a point. */
  panel(cx: number, cy: number, cz: number, w: number, h: number, color: THREE.ColorRepresentation, facing: "z" | "x", glow = false) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.mat(color, glow));
    m.receiveShadow = true;
    if (facing === "x") m.rotation.y = Math.PI / 2;
    m.position.set(cx, cy, cz);
    return m;
  }

  mat(color: THREE.ColorRepresentation, glow = false) {
    return glow && this.night ? this.paper.get(this.pal.window, { glow: this.pal.glow, glowIntensity: this.pal.glowIntensity }) : this.paper.get(color);
  }

  /** Windows in rows on the two faces the camera sees (+z and +x), for a box at (gx, gz, sx, sz). */
  windows(g: THREE.Group, gx: number, gz: number, sx: number, sz: number, storeys: number[], lit: boolean) {
    for (const y of storeys) {
      for (let a = gx + 0.25; a < gx + sx - 0.15; a += 0.42) g.add(this.panel(a + 0.1, y, gz + sz + 0.003, 0.2, 0.18, this.pal.window, "z", lit));
      for (let b = gz + 0.25; b < gz + sz - 0.15; b += 0.42) g.add(this.panel(gx + sx + 0.003, y, b + 0.1, 0.2, 0.18, this.pal.window, "x", lit));
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
      const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: n + 0.12, bevelEnabled: false }), this.paper.get(tone));
      (roof.material as THREE.MeshStandardMaterial).flatShading = true;
      roof.castShadow = roof.receiveShadow = true;
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

  tree(x: number, z: number, s: number) {
    const g = new THREE.Group();
    // A paper tree: a short trunk and two folded tiers of leaves.
    g.add(this.cyl(x, z, 0.05 * s, 0.26 * s, this.pal.trunk, 0, { seg: 6 }));
    g.add(this.cone(x, z, 0.4 * s, 0.42 * s, this.pal.leaf, 0.2 * s, 8));
    g.add(this.cone(x, z, 0.3 * s, 0.36 * s, this.pal.leafDark, 0.46 * s, 8));
    return g;
  }

  lamp(x: number, z: number) {
    const g = new THREE.Group();
    g.add(this.cyl(x, z, 0.025, 0.85, this.pal.steel, 0, { seg: 6 }));
    g.add(this.cyl(x, z, 0.08, 0.08, 0xfff1c9, 0.85, { seg: 10, glow: true }));
    return g;
  }
}
