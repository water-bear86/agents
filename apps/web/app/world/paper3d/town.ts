// The paper diorama: the whole town as matte paper models under a low raking sun, with PCF soft
// shadows in a tightly fitted shadow box, a cool fill from the camera and a warm bounce off the
// kraft board, so shadows stay soft and tinted, never black. Orthographic and isometric, like the 2D map.

import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Project } from "../../../lib/api";
import type { BotProps } from "../../../lib/sprite";
import { BLOCK, PITCH, quarterLot, townBounds, townLamps, townLots, townTrees, type Place, type Tier, housePlot } from "../../../lib/world";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { PALETTE, Paper } from "./materials";
import { Kit } from "./models";
import { PaperLens } from "./lens";
import { StandeePrinter, makeStandee } from "./standee";
import { Frames, pixelRatio, smallScreen, watchReducedMotion } from "./frames";

export type Pick = { kind: "place"; id: string } | { kind: "home"; handle: string } | { kind: "agent"; handle: string } | { kind: "project"; id: string };

export interface TownState {
  night: boolean;
  rings: number;
  houseCount: number;
  places: { place: Place; tone: string; label: string }[];
  houses: { handle: string; i: number; hue: number; tier: Tier; lit: boolean; label: string }[];
  projects: { p: Project; hue: number; progress: number }[];
  pawns: { handle: string; x: number; z: number; bot: BotProps; hidden: boolean; bubble?: string; selected: boolean }[];
  launching: boolean;
  selected?: Pick;
}

interface Pawn { group: THREE.Group; from: THREE.Vector3; to: THREE.Vector3; t0: number; texKey: string; bubble?: CSS2DObject }

const WALK_MS = 1100;
/** How far a building or standee lifts off the board while the pointer is over it. */
const HOVER_LIFT = 0.1;
/** The crane's jib swings slowly, so it's redrawn at about ten frames a second, not sixty. */
const IDLE_MS = 100;

export interface TownOptions {
  /** The browser took the WebGL context away (a GPU reset, too many tabs): show something else. */
  onLost?: () => void;
}
export interface TownView { x: number; z: number; zoom: number }
/** A stable key for a pick, used to find its label button again. */
export const pickKey = (p: Pick) => `${p.kind}:${"id" in p ? p.id : p.handle}`;
/** The top of the paper blocks everything stands on: road sheet, foam pads, then the block. */
const GROUND = 0.12;
/** Camera elevation for a 2:1 isometric view, and its azimuth (looking from +x +z). */
const ELEV = Math.PI / 6;
const AZ = Math.PI / 4;

export class PaperTown {
  readonly renderer: THREE.WebGLRenderer;
  readonly labels = new CSS2DRenderer();
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0xbbbbbb, 1);
  /** A soft light from the camera's side, so fronts lit from behind stay readable. No shadow. */
  readonly fill = new THREE.DirectionalLight(0xfff8ee, 0.8);
  /** Warm bounce off the kraft board, from the sun's opposite side. No shadow. */
  readonly bounce = new THREE.DirectionalLight(0xd4a56a, 0.28);
  readonly paper = new Paper(1.35);
  readonly lens: PaperLens;
  readonly printer = new StandeePrinter();
  readonly target = new THREE.Vector3();
  #frustum = 16;
  #static = new THREE.Group();
  #staticKey = "";
  #pawns = new Map<string, Pawn>();
  #picks: THREE.Object3D[] = [];
  #ring?: THREE.Mesh;
  #state?: TownState;
  #ro: ResizeObserver;
  #drag: { x: number; y: number; moved: boolean; ground: THREE.Vector3 } | null = null;
  #ray = new THREE.Raycaster();
  #home = { target: new THREE.Vector3(), zoom: 1 };
  #frames = new Frames((now) => this.#tick(now));
  #idle = 0;
  #reduced = false;
  #unwatch: () => void;
  #jibs: THREE.Object3D[] = [];
  /** Fingers (or the mouse) currently down, for one-finger pan and two-finger pinch. */
  #pointers = new Map<number, { clientX: number; clientY: number }>();
  #pinch: { dist: number } | null = null;
  #hover: THREE.Object3D | null = null;
  #hoverAt = 0;

  constructor(readonly host: HTMLElement, readonly onPick: (p: Pick | null) => void, readonly opts: TownOptions = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(pixelRatio());
    // 1. Soft shadows: crucial for smooth paper edges.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = PALETTE.day.exposure;
    host.appendChild(this.renderer.domElement);
    this.lens = new PaperLens(this.renderer, this.scene, this.camera, { aoRadius: 0.42, blur: 4.5, aoSamples: smallScreen() ? 6 : 8 });
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(envScene, 0.06).texture;
    this.scene.environmentIntensity = PALETTE.day.env;
    envScene.dispose();
    pmrem.dispose();
    Object.assign(this.labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    host.appendChild(this.labels.domElement);

    // 2-5. The sun: a directional light with a tight shadow box, a large map and a small bias.
    this.sun.castShadow = true;
    const shadow = smallScreen() ? 1024 : 2048;
    this.sun.shadow.mapSize.set(shadow, shadow);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun, this.sun.target, this.fill, this.fill.target, this.bounce, this.bounce.target);
    // 6. Bounce light keeps the paper colours vibrant and the shadows grey-brown, not black.
    this.scene.add(this.hemi);
    this.scene.add(this.#static);

    this.#ro = new ResizeObserver(() => this.#resize());
    this.#ro.observe(host);
    const el = this.renderer.domElement;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", this.#down);
    el.addEventListener("pointermove", this.#move);
    el.addEventListener("pointerup", this.#up);
    el.addEventListener("pointercancel", this.#up);
    el.addEventListener("pointerleave", this.#leave);
    el.addEventListener("wheel", this.#wheel, { passive: false });
    el.addEventListener("webglcontextlost", this.#lost);
    this.#unwatch = watchReducedMotion((r) => { this.#reduced = r; this.#frames.request(); });
    // Size and draw right away: a page in a background tab gets no animation frames until it's shown.
    this.#resize();
    if (process.env.NODE_ENV !== "production") (window as unknown as { __paperTown?: PaperTown }).__paperTown = this;
  }

  // ---------------------------------------------------------------- state

  update(s: TownState) {
    this.#state = s;
    const pal = s.night ? PALETTE.night : PALETTE.day;
    this.scene.background = new THREE.Color(pal.sky);
    this.sun.color.set(pal.sun);
    this.sun.intensity = pal.sunIntensity;
    this.hemi.color.set(pal.hemiSky);
    this.hemi.groundColor.set(pal.hemiGround);
    this.hemi.intensity = pal.hemiIntensity;
    this.fill.color.set(pal.fill);
    this.fill.intensity = pal.fillIntensity;
    this.bounce.color.set(pal.bounce);
    this.bounce.intensity = pal.bounceIntensity;
    this.renderer.toneMappingExposure = pal.exposure;
    this.scene.environmentIntensity = pal.env;

    const key = JSON.stringify([s.night, s.rings, s.houseCount, s.places.map((p) => p.label), s.houses.map((h) => [h.i, h.hue, h.tier.tier, h.lit]), s.projects.map((p) => [p.p.id, p.p.status, p.p.lot, p.p.kind, Math.round(p.progress * 10), p.p.raised])]);
    if (key !== this.#staticKey) {
      this.#staticKey = key;
      this.#build(s, new Kit(this.paper, pal, s.night));
    }
    this.#syncPawns(s);
    // Mission control's rocket lifts off when an agent launches a coin.
    const rocket = this.#static.getObjectByName("rocket");
    if (rocket && s.launching && !rocket.userData.t0) rocket.userData.t0 = performance.now();
    // Drawn now rather than on the next frame, so a background tab still gets a picture.
    if (this.#tick(performance.now())) this.#frames.request();
  }

  /** Asks for a redraw on the next animation frame. */
  redraw() { this.#frames.request(); }

  #build(s: TownState, kit: Kit) {
    for (const c of [...this.#static.children]) { this.#static.remove(c); disposeTree(c); }
    this.#picks = [];
    if (this.#hover && !this.#hover.userData.pawn) this.#setHover(null);
    const { min, max } = townBounds(s.rings);
    const size = max - min;
    const P = kit.pal;
    // The board is a sheet of corrugated cardboard, flutes showing along its cut edge. The roads are a grey sheet glued flat on it; every block
    // is a sheet of coloured paper raised on foam pads, so it floats a little above the road and throws
    // a thin shadow along its edge, and its pale cut edge shows.
    this.#static.add(kit.box(min, min, size, size, 0.25, P.kraft, -0.25, { cardboard: true, liner: true, square: true, wobble: 0.03 }));
    this.#static.add(kit.box(min + 0.15, min + 0.15, size - 0.3, size - 0.3, 0.025, P.road, 0, { square: true, wobble: 0.02 }));
    for (let k = -s.rings; k <= 2 + s.rings; k++) {
      const c = k * PITCH - 0.5;
      this.#static.add(kit.box(c - 0.025, min + 0.3, 0.05, size - 0.6, 0.006, P.lane, 0.025, { square: true, wobble: 0.004 }));
      this.#static.add(kit.box(min + 0.3, c - 0.025, size - 0.6, 0.05, 0.006, P.lane, 0.025, { square: true, wobble: 0.004 }));
    }
    for (const l of townLots(s.rings)) {
      const colour = l.kind === "homes" ? ((l.bx + l.by) % 2 ? P.grass : P.grassAlt) : P.paving;
      // Foam pad under each block, inset a little so the pale foam core shows as a lip.
      this.#static.add(kit.box(l.bx * PITCH + 0.07, l.by * PITCH + 0.07, BLOCK - 0.14, BLOCK - 0.14, GROUND - 0.05, P.foam, 0.025, { square: true, wobble: 0.006 }));
      this.#static.add(kit.box(l.bx * PITCH, l.by * PITCH, BLOCK, BLOCK, 0.025, colour, GROUND - 0.025));
    }
    const y0 = GROUND;
    const lift = (o: THREE.Object3D) => { o.position.y += y0; return o; };
    for (const t of townTrees(s.rings, s.houseCount)) this.#static.add(lift(kit.tree(t.x, t.y, t.s * 1.1)));
    for (const l of townLamps(s.rings)) this.#static.add(lift(kit.lamp(l.x, l.y)));

    // Places, houses and the quarter: each one pickable, with a label.
    for (const { place, tone, label } of s.places) {
      const g = lift(kit.place(place, new THREE.Color(tone), { launching: s.launching }));
      this.#pickable(g, { kind: "place", id: place.id });
      this.#static.add(g);
      this.#label(label, place.x + place.sx / 2, (place.id === "exchange" ? 3.3 : place.id === "launchpad" ? 2.6 : place.id === "observatory" ? 3.6 : place.id === "debate" ? 0.7 : 1.5) + y0, place.y + place.sy / 2, "p3-label", { kind: "place", id: place.id });
    }
    for (const h of s.houses) {
      const { x, y } = housePlot(h.i);
      const g = lift(kit.house(x, y, h.tier, h.hue, h.lit));
      this.#pickable(g, { kind: "home", handle: h.handle });
      this.#static.add(g);
    }
    for (const { p, hue, progress } of s.projects) {
      const q = quarterLot(p.lot);
      const g = lift(kit.project(p, q.x, q.y, hue, progress));
      this.#pickable(g, { kind: "project", id: p.id });
      this.#static.add(g);
      if (p.status !== "built") this.#label(`${p.name}${p.status === "proposed" ? `, ${p.raised}/${p.cost} bricks` : ", going up"}`, q.x + 0.8, (p.status === "building" ? 2.6 : 0.9) + y0, q.y + 0.8, "p3-label small", { kind: "project", id: p.id });
    }
    this.#jibs = [];
    this.#static.traverse((o) => { if (o.name === "jib") this.#jibs.push(o); });

    // Fit the light's shadow box tightly round the town: the smaller it is, the crisper the shadows.
    const cx = (min + max) / 2;
    const half = size * 0.88;
    // A low raking sun, so the paper grain reads and shadows stretch the way a miniature's do.
    this.sun.position.set(cx - size * 0.72, size * 0.34, cx + size * 0.18);
    this.fill.position.set(cx + size * 0.95, size * 0.45, cx + size * 0.95);
    this.fill.target.position.set(cx, 0, cx);
    this.bounce.position.set(cx + size * 0.65, size * 0.18, cx - size * 0.2);
    this.bounce.target.position.set(cx, 0.6, cx);
    this.sun.target.position.set(cx, 0, cx);
    const cam = this.sun.shadow.camera;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 0.5; cam.far = size * 3.4;
    cam.updateProjectionMatrix();
    if (!this.#home.zoom || this.#home.target.lengthSq() === 0) {
      this.#home = { target: new THREE.Vector3(cx, 0, cx), zoom: Math.min(1.4, 16 / (size * 0.62)) };
      if (this.target.lengthSq() === 0) this.resetView();
    }
  }

  #pickable(g: THREE.Object3D, p: Pick) {
    g.traverse((o) => { o.userData.pick = p; o.userData.root = g; });
    this.#picks.push(g);
  }

  /** A label over the model. A pickable one is a real button, so it can be reached with Tab and opened with Enter. */
  #label(text: string, x: number, y: number, z: number, cls: string, pick?: Pick) {
    const el = document.createElement(pick ? "button" : "div");
    el.className = pick ? `${cls} p3-pick` : cls;
    el.textContent = text;
    if (pick) {
      (el as HTMLButtonElement).type = "button";
      el.dataset.pick = pickKey(pick);
      el.addEventListener("click", () => this.onPick(pick));
    }
    const o = new CSS2DObject(el);
    o.position.set(x, y, z);
    this.#static.add(o);
  }

  #syncPawns(s: TownState) {
    const seen = new Set<string>();
    for (const p of s.pawns) {
      seen.add(p.handle);
      let pawn = this.#pawns.get(p.handle);
      const to = new THREE.Vector3(p.x, GROUND, p.z);
      if (!pawn) {
        const group = makeStandee();
        group.rotation.y = AZ;
        group.position.copy(to);
        group.userData.pawn = true;
        group.traverse((o) => { o.userData.pick = { kind: "agent", handle: p.handle }; o.userData.root = group; });
        this.scene.add(group);
        pawn = { group, from: to.clone(), to: to.clone(), t0: 0, texKey: "" };
        this.#pawns.set(p.handle, pawn);
      }
      if (!pawn.to.equals(to)) { pawn.from.copy(pawn.group.position); pawn.to.copy(to); pawn.t0 = performance.now(); }
      pawn.group.visible = !p.hidden;
      const texKey = JSON.stringify([p.bot.mood, p.bot.emote, p.bot.level, p.bot.style, p.bot.talking, s.night]);
      if (texKey !== pawn.texKey) {
        pawn.texKey = texKey;
        const card = pawn.group.getObjectByName("card") as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
        void this.printer.print(p.bot).then((tex) => { if (pawn!.texKey === texKey) { card.material.map = tex; card.material.needsUpdate = true; this.#frames.request(); } });
      }
      // Speech bubbles for whoever is talking or selected.
      if (p.bubble && !p.hidden) {
        if (!pawn.bubble) {
          const div = document.createElement("div");
          div.className = "p3-bubble";
          pawn.bubble = new CSS2DObject(div);
          pawn.bubble.position.set(0, 1.6, 0);
          pawn.group.add(pawn.bubble);
        }
        pawn.bubble.element.textContent = p.bubble;
      } else if (pawn.bubble) {
        pawn.group.remove(pawn.bubble);
        pawn.bubble.element.remove();
        pawn.bubble = undefined;
      }
    }
    for (const [h, pawn] of this.#pawns) if (!seen.has(h)) { if (this.#hover === pawn.group) this.#setHover(null); this.scene.remove(pawn.group); pawn.bubble?.element.remove(); disposeTree(pawn.group, false); this.#pawns.delete(h); }
    // A paper ring under whoever is selected.
    const sel = s.pawns.find((p) => p.selected && !p.hidden);
    if (sel) {
      if (!this.#ring) {
        this.#ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.4, 40), new THREE.MeshBasicMaterial({ color: 0x1f3bff, transparent: true, opacity: 0.8 }));
        this.#ring.rotation.x = -Math.PI / 2;
        this.scene.add(this.#ring);
      }
      this.#ring.visible = true;
      this.#ring.userData.handle = sel.handle;
    } else if (this.#ring) this.#ring.visible = false;
  }

  // ---------------------------------------------------------------- camera

  resetView() {
    this.target.copy(this.#home.target);
    this.camera.zoom = this.#home.zoom;
    this.#placeCamera();
  }

  focus(x: number, z: number, zoom: number) {
    this.target.set(x, 0, z);
    this.camera.zoom = zoom;
    this.#placeCamera();
  }

  zoomBy(f: number) {
    this.camera.zoom = Math.min(6, Math.max(0.25, this.camera.zoom * f));
    this.camera.updateProjectionMatrix();
    this.#frames.request();
  }

  /** Pans by a fraction of the visible width/height: +x to the right on screen, +y up. */
  pan(dx: number, dy: number) {
    const w = (this.camera.right - this.camera.left) / this.camera.zoom;
    const h = (this.camera.top - this.camera.bottom) / this.camera.zoom;
    // Screen right and screen up, flattened onto the board, for a camera looking in from +x +z.
    const right = new THREE.Vector3(Math.cos(AZ), 0, -Math.sin(AZ));
    const up = new THREE.Vector3(-Math.sin(AZ), 0, -Math.cos(AZ));
    this.target.addScaledVector(right, dx * w).addScaledVector(up, (dy * h) / Math.sin(ELEV));
    this.#placeCamera();
  }

  /** Where the camera is, to put it back later. */
  get view(): TownView { return { x: this.target.x, z: this.target.z, zoom: this.camera.zoom }; }

  /** Moves keyboard focus to a pick's label button, if it has one. */
  focusPick(p: Pick): boolean {
    const el = this.labels.domElement.querySelector<HTMLElement>(`[data-pick="${CSS.escape(pickKey(p))}"]`);
    el?.focus({ preventScroll: true });
    return !!el;
  }

  #placeCamera() {
    this.#resize();
    const d = 120;
    this.camera.position.set(this.target.x + Math.cos(ELEV) * Math.sin(AZ) * d, Math.sin(ELEV) * d, this.target.z + Math.cos(ELEV) * Math.cos(AZ) * d);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.#frames.request();
  }

  #resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.lens.setSize(w, h);
    this.labels.setSize(w, h);
    const a = w / h;
    this.camera.left = (-this.#frustum * a) / 2;
    this.camera.right = (this.#frustum * a) / 2;
    this.camera.top = this.#frustum / 2;
    this.camera.bottom = -this.#frustum / 2;
    this.camera.updateProjectionMatrix();
    this.#frames.request();
  }

  #ndc(e: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  #ground(e: { clientX: number; clientY: number }) {
    this.#ray.setFromCamera(this.#ndc(e), this.camera);
    const hit = new THREE.Vector3();
    return this.#ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit) ? hit : null;
  }

  /** The pickable thing under a point on screen, if any. */
  #hit(e: { clientX: number; clientY: number }): THREE.Object3D | null {
    this.#ray.setFromCamera(this.#ndc(e), this.camera);
    const pawns = [...this.#pawns.values()].filter((p) => p.group.visible).map((p) => p.group);
    return this.#ray.intersectObjects([...pawns, ...this.#picks], true).find((h) => h.object.userData.pick && (h.object as THREE.Mesh).isMesh)?.object ?? null;
  }

  /** Zooms by `f`, keeping the board point under `at` where it is. */
  #zoomAround(at: { clientX: number; clientY: number }, f: number) {
    const before = this.#ground(at);
    this.zoomBy(f);
    const after = this.#ground(at);
    if (before && after) { this.target.add(before.sub(after)); this.#placeCamera(); }
  }

  #spread() {
    const [a, b] = [...this.#pointers.values()];
    return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
  }

  #mid() {
    const [a, b] = [...this.#pointers.values()];
    return { clientX: (a!.clientX + b!.clientX) / 2, clientY: (a!.clientY + b!.clientY) / 2 };
  }

  #down = (e: PointerEvent) => {
    this.#pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    this.renderer.domElement.setPointerCapture(e.pointerId);
    if (this.#pointers.size >= 2) {
      // A second finger turns the pan into a pinch.
      this.#drag = null;
      this.#pinch = { dist: this.#spread() };
      return;
    }
    const g = this.#ground(e);
    if (!g) return;
    this.#drag = { x: e.clientX, y: e.clientY, moved: false, ground: g };
  };

  #move = (e: PointerEvent) => {
    if (this.#pointers.has(e.pointerId)) this.#pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (this.#pinch) {
      const dist = this.#spread();
      if (dist > 0 && this.#pinch.dist > 0) this.#zoomAround(this.#mid(), dist / this.#pinch.dist);
      this.#pinch.dist = dist;
      return;
    }
    const d = this.#drag;
    if (!d) {
      // Hovering with a mouse or pen: show what can be opened. Throttled, since a raycast isn't free.
      if (e.pointerType !== "touch" && performance.now() - this.#hoverAt > 50) {
        this.#hoverAt = performance.now();
        this.#setHover(this.#hit(e));
      }
      return;
    }
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true;
    if (!d.moved) return;
    if (this.#hover) this.#setHover(null);
    const g = this.#ground(e);
    if (!g) return;
    this.target.add(d.ground.clone().sub(g));
    this.#placeCamera();
  };

  #up = (e: PointerEvent) => {
    this.#pointers.delete(e.pointerId);
    if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
    if (this.#pinch) {
      // The finger left after a pinch neither pans nor picks until it's lifted too.
      if (this.#pointers.size < 2) this.#pinch = null;
      this.#drag = null;
      return;
    }
    const d = this.#drag;
    this.#drag = null;
    if (!d || d.moved || e.type === "pointercancel") return;
    const hit = this.#hit(e);
    this.onPick(hit ? (hit.userData.pick as Pick) : null);
  };

  #leave = () => { if (!this.#drag) this.#setHover(null); };

  /** Lifts the hovered building or standee a little and shows a pointer over it. */
  #setHover(o: THREE.Object3D | null) {
    const root = (o?.userData.root as THREE.Object3D | undefined) ?? null;
    if (root === this.#hover) return;
    if (this.#hover && !this.#hover.userData.pawn) this.#hover.position.y -= HOVER_LIFT;
    this.#hover = root;
    if (root && !root.userData.pawn) root.position.y += HOVER_LIFT;
    this.renderer.domElement.style.cursor = root ? "pointer" : "";
    this.#frames.request();
  }

  /** Pinch on a trackpad, or Ctrl/Cmd + scroll, zooms at the pointer; plain scrolling scrolls the page. */
  #wheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    this.#zoomAround(e, Math.exp(-e.deltaY * 0.01));
  };

  #lost = (e: Event) => {
    e.preventDefault();
    this.#frames.dispose();
    this.opts.onLost?.();
  };

  // ---------------------------------------------------------------- frames

  /** Draws one frame. Returns true while something is still moving and needs the next frame too. */
  #tick = (now: number): boolean => {
    let busy = !!this.#pinch;
    for (const p of this.#pawns.values()) {
      // With reduced motion a standee steps straight to where it's going.
      const t = p.t0 && !this.#reduced ? Math.min(1, (now - p.t0) / WALK_MS) : 1;
      if (t < 1) busy = true;
      p.group.position.lerpVectors(p.from, p.to, t * t * (3 - 2 * t));
      // A paper puppet hops when it walks.
      p.group.position.y = GROUND + (t < 1 ? Math.abs(Math.sin(t * Math.PI * 5)) * 0.12 : 0) + (this.#hover === p.group ? HOVER_LIFT : 0);
    }
    if (this.#ring?.visible) {
      const p = this.#pawns.get(this.#ring.userData.handle);
      if (p) this.#ring.position.set(p.group.position.x, GROUND + 0.015, p.group.position.z);
    }
    const rocket = this.#static.getObjectByName("rocket");
    if (rocket?.userData.t0) {
      const t = this.#reduced ? 1 : (now - rocket.userData.t0) / 6000;
      rocket.position.y = 0.22 + (t < 1 ? t * t * 9 : 0);
      if (t >= 1) rocket.userData.t0 = 0; else busy = true;
    }
    for (const j of this.#jibs) j.rotation.y = this.#reduced ? 0 : Math.sin(now / 2600) * 0.6;
    this.lens.render();
    this.labels.render(this.scene, this.camera);
    // The crane keeps swinging between changes, at a low frame rate.
    clearTimeout(this.#idle);
    if (!busy && this.#jibs.length && !this.#reduced) this.#idle = window.setTimeout(() => this.#frames.request(), IDLE_MS);
    return busy;
  };

  dispose() {
    this.#frames.dispose();
    clearTimeout(this.#idle);
    this.#unwatch();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.#lost);
    this.#ro.disconnect();
    for (const c of [...this.#static.children]) disposeTree(c);
    for (const p of this.#pawns.values()) disposeTree(p.group, false);
    this.paper.dispose();
    this.printer.dispose();
    this.lens.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}

/** Frees geometries (and, unless they're shared paper, materials) under an object; removes label elements. */
function disposeTree(o: THREE.Object3D, shared = true) {
  o.traverse((c) => {
    if (c instanceof CSS2DObject) c.element.remove();
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (!shared && m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    if ((c as THREE.LineSegments).isLineSegments) ((c as THREE.LineSegments).material as THREE.Material).dispose();
  });
}
