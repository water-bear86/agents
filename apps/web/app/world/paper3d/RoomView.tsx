"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, Decision } from "../../../lib/api";
import { useUnits } from "../../../lib/units";
import { houseTier, type PlaceId } from "../../../lib/world";
import { LEAD } from "../place-interior";
import { PaperRoom, type Board, type RoomSpec } from "./room";
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

/** Whether rooms show as text instead of the paper model, remembered per viewer. */
function useTextView(): [boolean, (on: boolean) => void] {
  const [on, set] = useState(false);
  useEffect(() => { try { set(localStorage.getItem("room-view") === "text"); } catch {} }, []);
  return [on, (v) => { set(v); try { localStorage.setItem("room-view", v ? "text" : "paper"); } catch {} }];
}

/** A paper room on the page: builds its scene once, refurnishes it as the spec changes. */
function RoomCanvas({ spec, label, onFail }: { spec: RoomSpec; label: string; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const room = useRef<PaperRoom | null>(null);
  const fail = useRef(onFail);
  fail.current = onFail;
  const night = useNight();
  useEffect(() => {
    let r: PaperRoom;
    try { r = new PaperRoom(host.current!, { onLost: () => fail.current() }); } catch { fail.current(); return; }
    room.current = r;
    return () => { r.dispose(); room.current = null; };
  }, []);
  useEffect(() => { room.current?.update(spec, night); }, [spec, night]);
  return <div ref={host} className="p3-host p3-room" role="img" aria-label={label} />;
}

/** One board on the wall as text: its title, then its rows (or pinned cards). */
function BoardText({ b }: { b: Board }) {
  const rows = (b.lines ?? []).map((l) => l.text).filter(Boolean);
  // A cork board's title is what it says when nothing is pinned to it.
  const title = b.style === "cork" ? ((b.cards ?? []).length ? "Pinned on the board" : b.title) : b.title;
  return (
    <section>
      {title && <h3>{title}</h3>}
      {rows.length > 0 && <ul>{rows.map((t, i) => <li key={i}>{t}</li>)}</ul>}
      {(b.cards ?? []).length > 0 && (
        <ul>
          {b.cards!.map((c, i) => (
            <li key={i}><b>{c.title}</b>{c.sub ? ` (${c.sub})` : ""}: {c.body}{c.foot ? ` ${c.foot}` : ""}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Everything written in the room, as text: what a screen reader reads, and what the Text view shows. */
function RoomText({ spec }: { spec: RoomSpec }) {
  const here = spec.agents.map((a) => `@${a.handle}`);
  const friends = spec.props.flatMap((p) => (p.k === "photo" ? [`@${p.label}`] : []));
  const coins = spec.props.flatMap((p) => (p.k === "coin" ? [`$${p.label}`] : []));
  return (
    <div className="room-text">
      <p>{here.length ? `Here: ${here.join(", ")}.` : "Nobody's here right now."}{spec.away ? ` ${spec.away.text}` : ""}</p>
      {spec.boards.map((b, i) => <BoardText key={i} b={b} />)}
      {coins.length > 0 && <p>Coins on the shelf: {coins.join(", ")}.</p>}
      {friends.length > 0 && <p>Photos on the wall: {friends.join(", ")}.</p>}
    </div>
  );
}

/** The room as a paper model with its text kept for screen readers, or as text alone. */
function Room({ spec, label, text, onFail }: { spec: RoomSpec; label: string; text: boolean; onFail: () => void }) {
  if (text) return <RoomText spec={spec} />;
  return (
    <>
      <RoomCanvas spec={spec} label={label} onFail={onFail} />
      <div className="sr-only"><RoomText spec={spec} /></div>
    </>
  );
}

function TextToggle({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return <button className="btn quiet small" aria-pressed={on} onClick={() => set(!on)}>Text view</button>;
}

export function HouseRoom3D({ a, home, where, last, symbols, onBack, onFail }: { a: Agent; home: boolean; where: string; last?: Decision; symbols: Map<string, string>; onBack: () => void; onFail: () => void }) {
  const t = houseTier(a.progress?.level);
  const spec = useMemo(() => houseSpec(a, home, where, last, symbols), [a, home, where, last, symbols]);
  const [text, setText] = useTextView();
  return (
    <div className="interior">
      <div className="interior-bar">
        <button className="btn quiet small" onClick={onBack} autoFocus>Back to town</button>
        <TextToggle on={text} set={setText} />
        <span className="muted">Inside @{a.handle}&rsquo;s {t.name}. {home ? "It's home." : `It's out: ${where}.`}</span>
      </div>
      <Room spec={spec} text={text} onFail={onFail} label={`A paper model of the inside of @${a.handle}'s ${t.name}`} />
    </div>
  );
}

export function PlaceRoom3D({ id, name, here, data, onBack, onFail }: { id: Exclude<PlaceId, "home" | "site">; name: string; here: Agent[]; data: Omit<PlaceData3D, "native" | "sym">; onBack: () => void; onFail: () => void }) {
  const fmt = useUnits();
  const spec = useMemo(() => placeSpec(id, here, { ...data, native: fmt.native, sym: fmt.sym }), [id, here, data, fmt]);
  const [text, setText] = useTextView();
  return (
    <div className="interior">
      <div className="interior-bar">
        <button className="btn quiet small" onClick={onBack} autoFocus>Back to town</button>
        <TextToggle on={text} set={setText} />
        <span className="muted">Inside the {name}. {LEAD[id]}</span>
      </div>
      <Room spec={spec} text={text} onFail={onFail} label={`A paper model of the inside of the ${name}, ${here.length} ${here.length === 1 ? "agent" : "agents"} here`} />
    </div>
  );
}
