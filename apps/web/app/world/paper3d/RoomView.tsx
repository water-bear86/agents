"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Decision } from "../../../lib/api";
import { useUnits } from "../../../lib/units";
import { houseTier, type PlaceId } from "../../../lib/world";
import { LEAD } from "../place-interior";
import { PaperRoom, type RoomSpec } from "./room";
import { houseSpec, placeSpec, type PlaceData3D } from "./rooms";

function useNight() {
  const [night, setNight] = useState(false);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setNight(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return night;
}

/** A paper room on the page: builds its scene once, refurnishes it as the spec changes. */
function RoomCanvas({ spec, label }: { spec: RoomSpec; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const room = useRef<PaperRoom | null>(null);
  const night = useNight();
  useEffect(() => {
    const r = new PaperRoom(host.current!);
    room.current = r;
    return () => { r.dispose(); room.current = null; };
  }, []);
  useEffect(() => { room.current?.update(spec, night); }, [spec, night]);
  return <div ref={host} className="p3-host p3-room" role="img" aria-label={label} />;
}

export function HouseRoom3D({ a, home, where, last, symbols, onBack }: { a: Agent; home: boolean; where: string; last?: Decision; symbols: Map<string, string>; onBack: () => void }) {
  const t = houseTier(a.progress?.level);
  const spec = useMemo(() => houseSpec(a, home, where, last, symbols), [a, home, where, last, symbols]);
  return (
    <div className="interior">
      <div className="interior-bar">
        <button className="btn quiet small" onClick={onBack} autoFocus>Back to town</button>
        <span className="muted">Inside @{a.handle}&rsquo;s {t.name}. {home ? "It's home." : `It's out: ${where}.`}</span>
      </div>
      <RoomCanvas spec={spec} label={`A paper model of the inside of @${a.handle}'s ${t.name}`} />
    </div>
  );
}

export function PlaceRoom3D({ id, name, here, data, onBack }: { id: Exclude<PlaceId, "home" | "site">; name: string; here: Agent[]; data: Omit<PlaceData3D, "native" | "sym">; onBack: () => void }) {
  const fmt = useUnits();
  const spec = useMemo(() => placeSpec(id, here, { ...data, native: fmt.native, sym: fmt.sym }), [id, here, data, fmt]);
  return (
    <div className="interior">
      <div className="interior-bar">
        <button className="btn quiet small" onClick={onBack} autoFocus>Back to town</button>
        <span className="muted">Inside the {name}. {LEAD[id]}</span>
      </div>
      <RoomCanvas spec={spec} label={`A paper model of the inside of the ${name}, ${here.length} ${here.length === 1 ? "agent" : "agents"} here`} />
    </div>
  );
}
