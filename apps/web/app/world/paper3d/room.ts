// Paper rooms: the inside of a house or one of the town's buildings as a cut-away paper model, a
// floor and two back walls in card stock under the same soft light as the town. Wall boards are
// printed paper panels, furniture is paper, and the agents inside are standees. A room is built
// from a plain spec (see rooms.ts), so the same engine furnishes every interior.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { BotProps } from "../../../lib/sprite";
import { PaperLens } from "./lens";
import { PALETTE, Paper } from "./materials";
import { Kit, PX } from "./models";
import { StandeePrinter, makeStandee } from "./standee";

export const ROOM = 7;
export const WALL_H = 196 * PX;
/** Where the track spotlights hang (on the wall tops) and where each one points. */
const SPOTS: { at: [number, number, number]; aim: [number, number, number]; color: number; intensity: number; angle: number; penumbra: number }[] = [
  { at: [1.6, 4.7, 0.35], aim: [2.2, 0, 3.6], color: 0xffe6c4, intensity: 14, angle: 0.72, penumbra: 0.72 },
  { at: [4.9, 4.7, 0.35], aim: [4.6, 0, 3.9], color: 0xffdcb0, intensity: 11, angle: 0.68, penumbra: 0.8 },
  { at: [0.35, 4.7, 4.4], aim: [3.4, 0, 5.0], color: 0xfff0d8, intensity: 10, angle: 0.76, penumbra: 0.7 },
];

export type Tone = "ok" | "no" | "who" | "dim";
export interface BoardLine { text: string; tone?: Tone }
/** A paper panel on a back wall. Positions follow the flat interiors: `a0..a1` along the wall, `z0..z1` heights in px. */
export interface Board {
  wall: "left" | "right";
  a0: number; a1: number; z0: number; z1: number;
  style: "dark" | "cork" | "plaque" | "banner";
  title?: string;
  lines?: BoardLine[];
  /** Pinned cards on a cork board: idea cards, notes. */
  cards?: { title: string; sub?: string; body: string; foot?: string }[];
}
export type Prop =
  | { k: "box"; x: number; y: number; sx: number; sy: number; h: number; z0?: number; color: THREE.ColorRepresentation; glow?: boolean }
  | { k: "cyl"; x: number; y: number; r: number; h: number; z0?: number; color: THREE.ColorRepresentation; glow?: boolean }
  | { k: "cone"; x: number; y: number; r: number; h: number; z0?: number; color: THREE.ColorRepresentation }
  | { k: "trophy"; x: number; y: number; z0: number }
  | { k: "coin"; x: number; y: number; z0: number; label: string }
  | { k: "rocket"; x: number; y: number; color: THREE.ColorRepresentation }
  | { k: "telescope"; x: number; y: number; color: THREE.ColorRepresentation; big?: boolean }
  | { k: "plant"; x: number; y: number }
  | { k: "lamp"; x: number; y: number }
  | { k: "photo"; wall: "right" | "left"; a: number; z: number; bot: BotProps; best?: boolean; label: string }
  | { k: "fountain"; x: number; y: number };
export interface RoomSpec {
  /** Wall colour (hue, for houses and buildings that wear a colour). */
  wallHue: number;
  floor: "wood" | "tile" | "dark";
  window?: boolean;
  starry?: boolean;
  boards: Board[];
  props: Prop[];
  agents: { handle: string; x: number; y: number; bot: BotProps; scale?: number }[];
  /** Words on a sign over the empty dock when the owner is out. */
  away?: { x: number; y: number; text: string };
}

const INK = { dark: "#e6edf7", ok: "#39d6a3", no: "#fb7185", who: "#ffffff", dim: "#9fb0c8" };

/** Prints a board onto a canvas the size of the panel. */
function paintBoard(b: Board, wUnits: number, hUnits: number): HTMLCanvasElement {
  const ppu = 120;
  const c = document.createElement("canvas");
  c.width = Math.round(wUnits * ppu); c.height = Math.round(hUnits * ppu);
  const g = c.getContext("2d")!;
  const W = c.width, H = c.height;
  const font = (px: number, weight = 600) => `${weight} ${px}px "Archivo", ui-sans-serif, system-ui, sans-serif`;
  if (b.style === "cork") {
    g.fillStyle = "#c9a477"; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(90,60,30,${0.05 + Math.random() * 0.08})`; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
    const cards = b.cards ?? [];
    const n = Math.max(1, cards.length);
    const cw = (W - 24 - (n - 1) * 14) / n;
    cards.forEach((card, i) => {
      const x = 12 + i * (cw + 14), y = 18 + (i % 2) * 10, h = H - 40;
      g.fillStyle = ["#fffaf0", "#f4e2a8", "#d9e4f7"][i % 3]!;
      g.shadowColor = "rgba(60,40,20,0.35)"; g.shadowOffsetX = 3; g.shadowOffsetY = 4; g.shadowBlur = 4;
      g.fillRect(x, y, cw, h);
      g.shadowColor = "transparent";
      g.fillStyle = "#c4643f"; g.beginPath(); g.arc(x + cw / 2, y + 10, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#18202e"; g.font = font(26, 800);
      let yy = y + 46;
      for (const l of wrapText(g, card.title, cw - 24).slice(0, 2)) { g.fillText(l, x + 12, yy); yy += 30; }
      if (card.sub) { g.fillStyle = "#5b6676"; g.font = font(20, 600); g.fillText(card.sub, x + 12, yy); yy += 30; }
      g.fillStyle = "#18202e"; g.font = font(21, 500);
      for (const l of wrapText(g, card.body, cw - 24).slice(0, 7)) { g.fillText(l, x + 12, yy); yy += 26; }
      if (card.foot) { g.fillStyle = "#2a5d3f"; g.font = font(20, 750); g.fillText(card.foot, x + 12, y + h - 18); }
    });
    if (!cards.length && b.title) { g.fillStyle = "#3d2a17"; g.font = font(34, 800); g.fillText(b.title, 24, H / 2); }
    return c;
  }
  if (b.style === "plaque") {
    g.fillStyle = "#e2b84e"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "#9c7a1e"; g.lineWidth = 8; g.strokeRect(6, 6, W - 12, H - 12);
    g.fillStyle = "#3d2a10"; g.font = font(44, 850); g.fillText(b.title ?? "", 26, 62);
    g.font = font(26, 650);
    (b.lines ?? []).forEach((l, i) => g.fillText(l.text, 26, 100 + i * 34));
    return c;
  }
  if (b.style === "banner") {
    g.fillStyle = "#e2b84e"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#3d2a10"; g.font = font(Math.min(40, H * 0.55), 800); g.textBaseline = "middle";
    g.fillText(b.title ?? "", 24, H / 2);
    return c;
  }
  // A dark printed board: a title and rows of text.
  g.fillStyle = "#1b2433"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#0d1726"; g.fillRect(10, 10, W - 20, H - 20);
  g.fillStyle = INK.dark; g.font = font(34, 850); g.fillText(b.title ?? "", 28, 58);
  g.font = font(24, 600);
  const lh = 31;
  (b.lines ?? []).forEach((l, i) => {
    const y = 98 + i * lh;
    if (y > H - 20) return;
    g.fillStyle = INK[l.tone ?? "dark"] ?? INK.dark;
    g.font = font(24, l.tone === "who" ? 800 : 600);
    g.fillText(fit(g, l.text, W - 56), 28, y);
  });
  return c;
}

function wrapText(g: CanvasRenderingContext2D, text: string, width: number) {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width > width && cur) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}
function fit(g: CanvasRenderingContext2D, text: string, width: number) {
  if (g.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t}…`;
}

export class PaperRoom {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0xbbbbbb, 1);
  /** A soft light from the open cut-away, so faces lit from behind stay readable. No shadow. */
  readonly fill = new THREE.DirectionalLight(0xfff8ee, 0.8);
  /** Warm bounce off the cardboard floor. No shadow. */
  readonly bounce = new THREE.DirectionalLight(0xd4a56a, 0.22);
  /** Daylight through the window in the back wall, when the room has one. */
  readonly windowLight = new THREE.DirectionalLight(0xd8eefc, 0);
  /** Track spotlights along the tops of the walls, like a shop: each throws its own soft shadow. */
  readonly spots = SPOTS.map((s) => {
    const l = new THREE.SpotLight(s.color, s.intensity, 12, s.angle, s.penumbra, 1.55);
    l.position.set(...s.at);
    l.target.position.set(...s.aim);
    l.castShadow = true;
    l.shadow.mapSize.set(1024, 1024);
    l.shadow.bias = -0.0006;
    l.shadow.normalBias = 0.02;
    l.shadow.radius = 3;
    l.shadow.camera.near = 0.5;
    l.shadow.camera.far = 14;
    return l;
  });
  readonly paper = new Paper(1.15);
  readonly lens: PaperLens;
  readonly printer = new StandeePrinter();
  #room = new THREE.Group();
  #key = "";
  #ro: ResizeObserver;
  #textures: THREE.Texture[] = [];

  constructor(readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = PALETTE.day.exposure;
    host.appendChild(this.renderer.domElement);
    this.lens = new PaperLens(this.renderer, this.scene, this.camera, { aoRadius: 0.55, blur: 2.5 });
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(envScene, 0.05).texture;
    this.scene.environmentIntensity = PALETTE.day.env;
    envScene.dispose();
    pmrem.dispose();
    // Lit like a shop: the spotlights on the wall tracks do the work, each with its own soft shadow,
    // so an agent standing in the middle throws a few overlapping shadows. Daylight from the open
    // cut-away and a fill from the camera keep the corners from going black; a window, when there
    // is one, adds a cooler pool of light against the back wall.
    this.sun.position.set(ROOM + 2, 10, ROOM + 5);
    this.sun.target.position.set(ROOM / 2, 0, ROOM / 2);
    for (const l of this.spots) this.scene.add(l, l.target);
    this.fill.position.set(ROOM + 8, 4, ROOM + 8);
    this.fill.target.position.set(ROOM / 2, 0, ROOM / 2);
    this.bounce.position.set(ROOM / 2, -1.6, ROOM / 2);
    this.bounce.target.position.set(ROOM / 2, 1.8, ROOM / 2);
    this.windowLight.position.set(5.25, 3.2, -3.4);
    this.windowLight.target.position.set(ROOM / 2, 1.1, ROOM / 2);
    this.scene.add(this.sun, this.sun.target, this.fill, this.fill.target, this.bounce, this.bounce.target, this.windowLight, this.windowLight.target, this.hemi, this.#room);
    // The cut-away corner, seen from the front like the town.
    const d = 60, elev = Math.PI / 6, az = Math.PI / 4;
    const t = new THREE.Vector3(ROOM / 2 - 0.2, 1.7, ROOM / 2 - 0.2);
    this.camera.position.set(t.x + Math.cos(elev) * Math.sin(az) * d, t.y + Math.sin(elev) * d, t.z + Math.cos(elev) * Math.cos(az) * d);
    this.camera.lookAt(t);
    this.#ro = new ResizeObserver(() => this.#resize());
    this.#ro.observe(host);
    this.#resize();
    this.renderer.setAnimationLoop(() => this.lens.render());
  }

  #resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.lens.setSize(w, h);
    const a = w / h, H = 9.4;
    this.camera.left = (-H * a) / 2; this.camera.right = (H * a) / 2; this.camera.top = H / 2; this.camera.bottom = -H / 2;
    this.camera.updateProjectionMatrix();
    this.lens.render();
  }

  update(spec: RoomSpec, night: boolean) {
    const key = JSON.stringify([spec, night]);
    if (key === this.#key) return;
    this.#key = key;
    for (const c of [...this.#room.children]) { this.#room.remove(c); c.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); }); }
    for (const t of this.#textures) t.dispose();
    this.#textures = [];
    const pal = night ? PALETTE.night : PALETTE.day;
    const kit = new Kit(this.paper, pal, night);
    this.scene.background = new THREE.Color(pal.sky);
    this.sun.color.set(night ? 0xc5d4ff : 0xffe6c4);
    this.sun.intensity = night ? 0.1 : 0.42;
    this.fill.color.set(pal.fill);
    this.fill.intensity = night ? 0.28 : 0.62;
    this.bounce.color.set(pal.bounce);
    this.bounce.intensity = night ? 0.14 : 0.32;
    this.windowLight.color.set(night ? 0x8aa0d0 : 0xd8eefc);
    this.windowLight.intensity = spec.window ? (night ? 0.12 : 0.7) : 0;
    this.spots.forEach((l, i) => { l.color.set(SPOTS[i]!.color); l.intensity = SPOTS[i]!.intensity * (night ? 1.35 : 1); });
    this.hemi.color.set(pal.hemiSky); this.hemi.groundColor.set(pal.hemiGround); this.hemi.intensity = pal.hemiIntensity * 0.7;
    this.renderer.toneMappingExposure = pal.exposure;
    this.scene.environmentIntensity = pal.env;

    const wall = spec.starry ? new THREE.Color(night ? 0x141c33 : 0x2a2f5a) : new THREE.Color().setHSL(spec.wallHue / 360, night ? 0.18 : 0.3, night ? 0.32 : 0.86);
    const floor = spec.floor === "wood" ? pal.wood : spec.floor === "dark" ? 0x2a3142 : pal.paving;
    // Shell: a cardboard floor and two cardboard walls, papered on the inside, flutes showing on top.
    this.#room.add(kit.box(0, 0, ROOM, ROOM, 0.18, floor, -0.18, { cardboard: true, square: true, wobble: 0.015 }));
    this.#room.add(kit.cardWall(0, 0, ROOM, WALL_H, 0.18, wall, "x"));
    this.#room.add(kit.cardWall(-0.18, -0.18, ROOM + 0.18, WALL_H, 0.18, wall, "z"));
    // The lighting track along both wall tops, and a can on it for every spotlight, aimed where it shines.
    this.#room.add(kit.box(0.1, 0.12, ROOM - 0.2, 0.08, 0.06, 0x2b2f38, WALL_H - 0.12, { square: true }));
    this.#room.add(kit.box(0.12, 0.1, 0.08, ROOM - 0.2, 0.06, 0x2b2f38, WALL_H - 0.12, { square: true }));
    for (const sp of SPOTS) {
      const can = new THREE.Group();
      const body = kit.cyl(0, 0, 0.13, 0.36, 0x2b2f38, -0.18, { top: 0.09 });
      body.rotation.x = Math.PI / 2;
      body.position.set(0, 0, 0);
      const lens = kit.cyl(0, 0, 0.12, 0.02, 0xfff1c9, 0, { glow: true });
      lens.rotation.x = Math.PI / 2;
      lens.position.set(0, 0, 0.19);
      lens.material = this.paper.get(0xfff1c9, { glow: 0xffe2b8, glowIntensity: 1.2 });
      can.add(body, lens);
      can.position.set(...sp.at);
      can.lookAt(new THREE.Vector3(...sp.aim));
      this.#room.add(can);
    }
    this.#room.add(kit.box(0, 0, 0.06, ROOM, 0.12, pal.wallShade, 0, { square: true }));
    this.#room.add(kit.box(0, 0, ROOM, 0.06, 0.12, pal.wallShade, 0, { square: true }));
    if (spec.starry) for (let i = 0; i < 60; i++) {
      const s = new THREE.Mesh(new THREE.CircleGeometry(0.025 + (i % 3) * 0.012, 6), new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
      if (i % 2) s.position.set(((i * 0.37) % 6.6) + 0.2, 1 + ((i * 53) % 150) / 40, 0.005); else { s.rotation.y = Math.PI / 2; s.position.set(0.005, 1 + ((i * 37) % 150) / 40, ((i * 0.41) % 6.6) + 0.2); }
      this.#room.add(s);
    }
    if (spec.window) {
      // A window on the right wall, with the sky for the time of day.
      const frame = kit.box(4.3, -0.05, 1.9, 0.1, 1.6, pal.wallShade, 2.2, { square: true });
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.4), new THREE.MeshBasicMaterial({ color: night ? 0x1d2a4a : 0xbfe0f5 }));
      sky.position.set(5.25, 3.0, 0.06);
      this.#room.add(frame, sky);
    }

    for (const b of spec.boards) this.#board(b);
    for (const p of spec.props) this.#prop(p, kit);
    for (const a of spec.agents) {
      const s = makeStandee();
      s.rotation.y = Math.PI / 4;
      s.scale.setScalar(a.scale ?? 1.25);
      s.position.set(a.x, 0, a.y);
      const card = s.getObjectByName("card") as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
      void this.printer.print(a.bot).then((tex) => { card.material.map = tex; card.material.needsUpdate = true; });
      this.#room.add(s);
    }
    if (spec.away) {
      const b: Board = { wall: "right", a0: 0, a1: 0, z0: 0, z1: 0, style: "banner", title: spec.away.text };
      const tex = new THREE.CanvasTexture(paintBoard(b, 3.2, 0.5));
      tex.colorSpace = THREE.SRGBColorSpace;
      this.#textures.push(tex);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.5), new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.88, sheen: 0.35, sheenRoughness: 0.8, sheenColor: new THREE.Color(0xf7f1e6), specularIntensity: 0.2 }));
      sign.rotation.y = Math.PI / 4;
      sign.position.set(spec.away.x, 0.9, spec.away.y);
      sign.castShadow = true;
      this.#room.add(sign);
    }
  }

  #board(b: Board) {
    const w = b.a1 - b.a0, h = (b.z1 - b.z0) * PX;
    const tex = new THREE.CanvasTexture(paintBoard(b, w, h));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.#textures.push(tex);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), [this.paper.get(0x1b2433), this.paper.get(0x1b2433), this.paper.get(0x1b2433), this.paper.get(0x1b2433), new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.86, sheen: 0.22, sheenRoughness: 0.8, sheenColor: new THREE.Color(0xf7f1e6), specularIntensity: 0.18 }), this.paper.get(0x1b2433)]);
    m.castShadow = m.receiveShadow = true;
    const cy = ((b.z0 + b.z1) / 2) * PX;
    if (b.wall === "right") m.position.set((b.a0 + b.a1) / 2, cy, 0.03);
    else { m.rotation.y = Math.PI / 2; m.position.set(0.03, cy, (b.a0 + b.a1) / 2); }
    this.#room.add(m);
  }

  #prop(p: Prop, kit: Kit) {
    const r = this.#room;
    switch (p.k) {
      case "box": r.add(kit.box(p.x, p.y, p.sx, p.sy, p.h * PX, p.color, (p.z0 ?? 0) * PX, { glow: p.glow })); break;
      case "cyl": r.add(kit.cyl(p.x, p.y, p.r, p.h * PX, p.color, (p.z0 ?? 0) * PX, { glow: p.glow })); break;
      case "cone": r.add(kit.cone(p.x, p.y, p.r, p.h * PX, p.color, (p.z0 ?? 0) * PX, 10)); break;
      case "trophy": {
        const y = p.z0 * PX;
        r.add(kit.cyl(p.x, p.y, 0.1, 0.05, 0xb8892a, y));
        r.add(kit.cyl(p.x, p.y, 0.03, 0.12, 0xe2b84e, y + 0.05, { seg: 8 }));
        r.add(kit.cyl(p.x, p.y, 0.14, 0.18, 0xe2b84e, y + 0.17, { top: 0.16 }));
        break;
      }
      case "coin": r.add(kit.cyl(p.x, p.y, 0.2, 0.07, 0xe2b84e, p.z0 * PX)); break;
      case "rocket": {
        r.add(kit.cyl(p.x, p.y, 0.3, 2.4, 0xfbf6ec, 0.1));
        r.add(kit.cone(p.x, p.y, 0.3, 0.7, p.color, 2.5, 18));
        r.add(kit.cyl(p.x, p.y, 0.31, 0.18, p.color, 1.6));
        break;
      }
      case "telescope": {
        const big = p.big ? 1.8 : 1;
        r.add(kit.box(p.x - 0.25 * big, p.y - 0.25 * big, 0.5 * big, 0.5 * big, 0.45 * big, 0x56627a));
        // The tube rides on the mount, tipped well back toward the window.
        const tube = kit.cyl(0, 0, 0.12 * big, 1.7 * big, p.color, -0.2 * big, { top: 0.09 * big });
        const pivot = new THREE.Group();
        pivot.position.set(p.x, 0.5 * big, p.y);
        pivot.rotation.set(-0.75, 0, 0.75);
        pivot.add(tube);
        r.add(pivot);
        break;
      }
      case "plant": {
        r.add(kit.box(p.x - 0.22, p.y - 0.22, 0.44, 0.44, 0.38, 0xc4643f));
        r.add(kit.cone(p.x, p.y, 0.35, 0.6, 0x7aae63, 0.38, 8));
        r.add(kit.cone(p.x, p.y, 0.26, 0.5, 0x93c27a, 0.72, 8));
        break;
      }
      case "lamp": {
        r.add(kit.cyl(p.x, p.y, 0.2, 0.06, 0x56627a, 0));
        r.add(kit.cyl(p.x, p.y, 0.03, 2.2, 0x56627a, 0.06, { seg: 6 }));
        r.add(kit.cyl(p.x, p.y, 0.3, 0.35, 0xfff1c9, 2.2, { top: 0.16, glow: true }));
        const bulb = new THREE.PointLight(0xffe2b0, 1.7, 6.5, 2);
        bulb.position.set(p.x, 2.35, p.y);
        r.add(bulb);
        break;
      }
      case "fountain": {
        r.add(kit.cyl(p.x, p.y, 1.3, 0.3, 0xe9e1d1, 0));
        r.add(kit.cyl(p.x, p.y, 1.15, 0.04, 0x9fcbe8, 0.3));
        r.add(kit.cyl(p.x, p.y, 0.14, 0.9, 0xe9e1d1, 0));
        break;
      }
      case "photo": {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.78, 0.05), this.paper.get(p.best ? 0xe2b84e : 0xc19468));
        frame.castShadow = frame.receiveShadow = true;
        const pic = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.64), new THREE.MeshPhysicalMaterial({ roughness: 0.88, color: 0xffffff, sheen: 0.35, sheenRoughness: 0.8, sheenColor: new THREE.Color(0xf7f1e6), specularIntensity: 0.2 }));
        pic.position.z = 0.03;
        void this.printer.print(p.bot).then((tex) => { (pic.material as THREE.MeshPhysicalMaterial).map = tex; (pic.material as THREE.MeshPhysicalMaterial).needsUpdate = true; });
        frame.add(pic);
        const y = p.z * PX;
        if (p.wall === "right") frame.position.set(p.a, y, 0.04); else { frame.rotation.y = Math.PI / 2; frame.position.set(0.04, y, p.a); }
        r.add(frame);
        break;
      }
    }
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.#ro.disconnect();
    for (const t of this.#textures) t.dispose();
    this.paper.dispose();
    this.lens.dispose();
    this.printer.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
