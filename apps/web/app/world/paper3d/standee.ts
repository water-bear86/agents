// Agents as paper standees: the same robot the 2D town draws (face, mood, gear, level, emote) is
// printed onto a card with a white cut edge, and the card's alpha shapes its shadow.

import * as THREE from "three";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Bot, type BotProps } from "../../../lib/sprite";

/** The part of sprite space a standee prints: arms, gear and emotes included. */
const VIEW = { x: -27, y: -72, w: 54, h: 82 };
const SCALE = 5;
/** Card height in world units. */
export const CARD_H = 1.5;
export const CARD_W = (CARD_H * VIEW.w) / VIEW.h;
const EDGE = 2.6;

/** Styles that make a sprite look right when its SVG is drawn outside the page (classes don't travel). */
const PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-dasharray", "opacity", "display"] as const;

export class StandeePrinter {
  readonly #host: HTMLDivElement;
  readonly #cache = new Map<string, Promise<THREE.CanvasTexture>>();

  constructor() {
    this.#host = document.createElement("div");
    this.#host.setAttribute("aria-hidden", "true");
    Object.assign(this.#host.style, { position: "fixed", left: "-10000px", top: "0", width: "1px", height: "1px", overflow: "hidden", pointerEvents: "none" });
    document.body.appendChild(this.#host);
  }

  /** The card texture for an agent as it looks right now; cached by everything that changes its look. */
  print(p: BotProps): Promise<THREE.CanvasTexture> {
    const night = matchMedia("(prefers-color-scheme: dark)").matches;
    const key = JSON.stringify([p.handle, p.style, p.level, p.mood, p.emote, p.talking ? 1 : 0, night]);
    let t = this.#cache.get(key);
    if (!t) {
      t = this.#render(p);
      this.#cache.set(key, t);
      if (this.#cache.size > 400) this.#cache.delete(this.#cache.keys().next().value!);
    }
    return t;
  }

  async #render(p: BotProps): Promise<THREE.CanvasTexture> {
    // Draw the live sprite with the page's CSS, then copy the computed paint onto each element.
    // Markup, not a React root: this runs inside React effects, where a root can't render synchronously.
    this.#host.innerHTML = renderToStaticMarkup(createElement("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: `${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`, width: VIEW.w * SCALE, height: VIEW.h * SCALE, className: "world-svg" }, createElement(Bot, { ...p, walking: false })));
    const svg = this.#host.querySelector("svg")!;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const live = svg.querySelectorAll("*");
    clone.querySelectorAll("*").forEach((el, i) => {
      const cs = getComputedStyle(live[i]!);
      for (const k of PROPS) { const v = cs.getPropertyValue(k); if (v) el.setAttribute(k, v); }
      el.removeAttribute("class");
      el.removeAttribute("style");
    });
    clone.querySelector(".pawn-shadow, ellipse")?.remove();
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
    const img = new Image();
    img.src = url;
    await img.decode();

    // A white cut edge: the silhouette, dilated, under the sprite.
    const W = VIEW.w * SCALE, H = VIEW.h * SCALE;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    const sil = document.createElement("canvas");
    sil.width = W; sil.height = H;
    const s = sil.getContext("2d")!;
    s.drawImage(img, 0, 0);
    s.globalCompositeOperation = "source-in";
    s.fillStyle = "#fffdf7";
    s.fillRect(0, 0, W, H);
    for (let a = 0; a < 16; a++) ctx.drawImage(sil, Math.cos((a / 16) * Math.PI * 2) * EDGE * SCALE, Math.sin((a / 16) * Math.PI * 2) * EDGE * SCALE);
    ctx.drawImage(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  dispose() {
    for (const t of this.#cache.values()) void t.then((x) => x.dispose());
    this.#host.remove();
  }
}

/** A standee: the printed card on a little paper stand, turned to face the camera. */
export function makeStandee(): THREE.Group {
  const g = new THREE.Group();
  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_W, CARD_H),
    new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide, transparent: false }),
  );
  card.name = "card";
  card.castShadow = true;
  card.receiveShadow = true;
  // The robot's feet sit at sprite y = 0, which is 10/82 of the way up from the card's bottom.
  card.position.y = CARD_H / 2 - (CARD_H * (VIEW.y + VIEW.h)) / VIEW.h;
  g.add(card);
  const stand = new THREE.Mesh(new THREE.BoxGeometry(CARD_W * 0.45, 0.02, 0.22), new THREE.MeshStandardMaterial({ color: 0xfffaf0, roughness: 1 }));
  stand.position.y = 0.01;
  stand.castShadow = stand.receiveShadow = true;
  g.add(stand);
  return g;
}
