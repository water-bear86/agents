"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { PaperTown, type Pick, type TownState } from "./town";

export interface PaperTownHandle { zoomBy(f: number): void; resetView(): void; focus(x: number, z: number, zoom: number): void }

/** The paper diorama on the World page. Builds its Three.js scene once and feeds it the live town. */
const PaperTownView = forwardRef<PaperTownHandle, { state: TownState; onPick: (p: Pick | null) => void; label: string; focus?: { x: number; z: number; zoom: number } }>(function PaperTownView({ state, onPick, label, focus }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const town = useRef<PaperTown | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const pending = useRef<(() => void)[]>([]);

  useEffect(() => {
    const t = new PaperTown(host.current!, (p) => pick.current(p));
    town.current = t;
    t.update(state);
    if (focus) t.focus(focus.x, focus.z, focus.zoom);
    for (const f of pending.current.splice(0)) f();
    return () => { t.dispose(); town.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { town.current?.update(state); }, [state]);

  // Calls made before the scene exists (a deep link's focus, say) run once it does.
  const run = (f: (t: PaperTown) => void) => (town.current ? f(town.current) : pending.current.push(() => f(town.current!)));
  useImperativeHandle(ref, () => ({
    zoomBy: (f) => run((t) => t.zoomBy(f)),
    resetView: () => run((t) => t.resetView()),
    focus: (x, z, zoom) => run((t) => { t.update(state); t.focus(x, z, zoom); }),
  }));

  return <div ref={host} className="p3-host" role="img" aria-label={label} />;
});

export default PaperTownView;
