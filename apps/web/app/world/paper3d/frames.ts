// Shared by the town and the rooms: draw only when something changed, keep the GPU load sensible
// on phones, and follow the viewer's reduced-motion setting.

/** Sharper than this costs a lot of fill rate for little gain on a paper model. */
export const pixelRatio = () => Math.min(1.5, window.devicePixelRatio || 1);
/** Phones and narrow windows get smaller shadow maps and fewer occlusion samples. */
export const smallScreen = () => matchMedia("(max-width: 700px)").matches;

/** Calls `on` now and whenever the viewer turns reduced motion on or off. Returns a stop function. */
export function watchReducedMotion(on: (reduced: boolean) => void): () => void {
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const f = () => on(mq.matches);
  f();
  mq.addEventListener("change", f);
  return () => mq.removeEventListener("change", f);
}

/**
 * Draws on demand: `request()` asks for one frame, and the draw function says whether it is still
 * animating (a walk, a lift-off, a pinch) and needs another. Nothing is drawn while nothing changes.
 */
export class Frames {
  #raf = 0;
  #stopped = false;
  constructor(readonly draw: (now: number) => boolean) {}
  request() {
    if (!this.#raf && !this.#stopped) this.#raf = requestAnimationFrame(this.#frame);
  }
  #frame = (now: number) => {
    this.#raf = 0;
    if (this.draw(now)) this.request();
  };
  dispose() {
    this.#stopped = true;
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }
}
