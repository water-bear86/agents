"use client";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, type KeyboardEvent } from "react";
import { PaperTown, type Pick, type TownState, type TownView } from "./town";

export interface PaperTownHandle { zoomBy(f: number): void; resetView(): void; focus(x: number, z: number, zoom: number): void }

/** Where the camera was when the town last closed (to open a room, say), so coming back puts it there again. */
let lastView: TownView | undefined;

interface Props {
  state: TownState;
  onPick: (p: Pick | null) => void;
  label: string;
  focus?: { x: number; z: number; zoom: number };
  /** Set when coming back from a room: keyboard focus goes back to its label, or to the map. */
  returnTo?: Pick;
  /** WebGL wouldn't start or was lost: the page shows the flat map instead. */
  onFail: () => void;
}

/** The paper diorama on the World page. Builds its Three.js scene once and feeds it the live town. */
const PaperTownView = forwardRef<PaperTownHandle, Props>(function PaperTownView({ state, onPick, label, focus, returnTo, onFail }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const town = useRef<PaperTown | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const fail = useRef(onFail);
  fail.current = onFail;
  const pending = useRef<(() => void)[]>([]);
  const keysId = useId();

  useEffect(() => {
    let t: PaperTown;
    try {
      t = new PaperTown(host.current!, (p) => pick.current(p), { onLost: () => fail.current() });
    } catch {
      fail.current();
      return;
    }
    town.current = t;
    t.renderer.domElement.setAttribute("aria-hidden", "true");
    t.update(state);
    const back = lastView;
    if (back) t.focus(back.x, back.z, back.zoom); else if (focus) t.focus(focus.x, focus.z, focus.zoom);
    for (const f of pending.current.splice(0)) f();
    // Back from a room: focus returns to what was opened, or to the map itself.
    if (returnTo && !t.focusPick(returnTo)) host.current?.focus({ preventScroll: true });
    return () => { lastView = t.view; t.dispose(); town.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { town.current?.update(state); }, [state]);

  // Calls made before the scene exists (a deep link's focus, say) run once it does.
  const run = (f: (t: PaperTown) => void) => (town.current ? f(town.current) : pending.current.push(() => f(town.current!)));
  useImperativeHandle(ref, () => ({
    zoomBy: (f) => run((t) => t.zoomBy(f)),
    resetView: () => run((t) => t.resetView()),
    focus: (x, z, zoom) => run((t) => { t.update(state); t.focus(x, z, zoom); }),
  }));

  // Arrow keys pan, + and − zoom, 0 resets. Tab moves between the place labels; Enter opens one.
  const onKey = (e: KeyboardEvent) => {
    const t = town.current;
    if (!t || e.altKey || e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? 0.3 : 0.1;
    const act: Record<string, () => void> = {
      ArrowLeft: () => t.pan(-step, 0), ArrowRight: () => t.pan(step, 0), ArrowUp: () => t.pan(0, step), ArrowDown: () => t.pan(0, -step),
      "+": () => t.zoomBy(1.25), "=": () => t.zoomBy(1.25), "-": () => t.zoomBy(0.8), "_": () => t.zoomBy(0.8), "0": () => t.resetView(),
    };
    const f = act[e.key];
    if (!f) return;
    e.preventDefault();
    f();
  };

  return (
    <div ref={host} className="p3-host" role="region" aria-label={label} aria-describedby={keysId} tabIndex={0} onKeyDown={onKey}>
      <p id={keysId} className="sr-only">Arrow keys pan the map, plus and minus zoom, 0 resets the view. Tab to a place&rsquo;s label and press Enter to open it.</p>
    </div>
  );
});

export default PaperTownView;
