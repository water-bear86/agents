"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { eth, hue, shortAddr, tokens, useLive, useNow, type Agent, type Call, type Coin, type DebateRow, type Decision } from "../../lib/api";
import { DecisionItem, Empty, Medal, Offline, Pnl, Who, XpBar, callStatus } from "../../lib/ui";
import { HOMES, HOUSE, PLACES, box, diamond, doorstep, gridFor, house, housePlot, iso, placeById, placeName, spots, whereabouts, type Place, type PlaceId, type Whereabouts } from "../../lib/world";

const W = 860;
const H = 540;
const FRESH_MS = 6000;

type Sel = { kind: "agent"; handle: string } | { kind: "place"; id: Exclude<PlaceId, "home"> } | { kind: "home"; handle: string } | { kind: "homes" } | null;
interface Placed { agent: Agent; where: Whereabouts; at: { x: number; y: number }; last?: Decision; home: number }
type Drawable = { depth: number; place?: Place; pawn?: Placed; house?: { agent: Agent; i: number } };

const tint = (handle: string) => ({ ["--h" as string]: hue(handle) }) as CSSProperties;
const shade = (tone: string, pct: number) => `color-mix(in oklab, ${tone} ${pct}%, var(--surface))`;

function Building({ p, count, selected, onSelect }: { p: Place; count: number; selected: boolean; onSelect: () => void }) {
  const label = iso(p.x + p.sx / 2, p.y + p.sy / 2, p.h + 18);
  const faces = p.h > 0 ? box(p.x, p.y, p.sx, p.sy, p.h) : null;
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } };
  return (
    <g className={`place ${selected ? "sel" : ""}`} role="button" tabIndex={0} aria-label={`${p.name}, ${count} ${count === 1 ? "agent" : "agents"} here`} onClick={onSelect} onKeyDown={key}>
      <polygon points={diamond(p.x - 0.35, p.y - 0.35, p.sx + 0.7, p.sy + 0.7)} style={{ fill: shade(p.tone, 9) }} className="plot" />
      {faces && (
        <>
          <polygon points={faces.left} style={{ fill: shade(p.tone, 34) }} />
          <polygon points={faces.right} style={{ fill: shade(p.tone, 52) }} />
          <polygon points={faces.top} style={{ fill: shade(p.tone, 16) }} />
        </>
      )}
      {p.id === "launchpad" && (() => { const t = box(p.x + 1.15, p.y + 1.15, 0.7, 0.7, p.h + 46); return <><polygon points={t.left} style={{ fill: shade(p.tone, 60) }} /><polygon points={t.right} style={{ fill: shade(p.tone, 80) }} /><polygon points={t.top} style={{ fill: shade(p.tone, 35) }} /></>; })()}
      {p.id === "plaza" && (() => { const b = box(p.x + 0.3, p.y + 0.2, 2.4, 0.18, p.h + 40); return <><polygon points={b.left} style={{ fill: shade("var(--muted)", 45) }} /><polygon points={b.right} style={{ fill: shade("var(--muted)", 70) }} /><polygon points={b.top} style={{ fill: shade("var(--muted)", 30) }} /></>; })()}
      {p.id === "exchange" && [0.4, 1.2, 2.0].map((dx, i) => { const c = box(p.x + dx, p.y + 0.35, 0.5, 0.5, p.h + 10 + i * 9); return <g key={dx}><polygon points={c.left} style={{ fill: shade(p.tone, 55) }} /><polygon points={c.right} style={{ fill: shade(p.tone, 75) }} /><polygon points={c.top} style={{ fill: shade(p.tone, 30) }} /></g>; })}
      {p.id === "observatory" && (() => {
        const t = box(p.x + 0.45, p.y + 0.45, 0.7, 0.7, p.h + 30);
        const top = iso(p.x + 0.8, p.y + 0.8, p.h + 30);
        return <><polygon points={t.left} style={{ fill: shade(p.tone, 45) }} /><polygon points={t.right} style={{ fill: shade(p.tone, 65) }} /><polygon points={t.top} style={{ fill: shade(p.tone, 30) }} /><ellipse cx={top.x} cy={top.y - 4} rx={13} ry={9} style={{ fill: shade(p.tone, 55) }} className="dome" /></>;
      })()}
      {p.id === "debate" && [0.35, 1.35].map((dx) => { const c = box(p.x + dx, p.y + 0.8, 0.5, 0.5, p.h + 10); return <g key={dx}><polygon points={c.left} style={{ fill: shade(p.tone, 50) }} /><polygon points={c.right} style={{ fill: shade(p.tone, 70) }} /><polygon points={c.top} style={{ fill: shade(p.tone, 28) }} /></g>; })}
      <text x={label.x} y={label.y - (p.id === "launchpad" ? 50 : p.id === "plaza" ? 56 : p.id === "exchange" ? 24 : p.id === "observatory" ? 44 : p.id === "debate" ? 12 : 0)} className="place-label" textAnchor="middle">
        {p.name}{count > 0 ? ` (${count})` : ""}
      </text>
    </g>
  );
}

function House({ agent, i, home, selected, onSelect }: { agent: Agent; i: number; home: boolean; selected: boolean; onSelect: () => void }) {
  const { x, y } = housePlot(i);
  const h = house(x, y);
  const lvl = agent.progress?.level;
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } };
  return (
    <g className={`house ${selected ? "sel" : ""} ${home ? "lit" : ""}`} style={tint(agent.handle)} role="button" tabIndex={0}
      aria-label={`Home of @${agent.handle}${lvl ? `, level ${lvl}` : ""}${home ? ", at home" : ", out"}`} onClick={onSelect} onKeyDown={key}>
      <polygon points={diamond(x - 0.25, y - 0.25, HOUSE.size + 0.5, HOUSE.size + 0.9)} className="yard" />
      <polygon points={h.left} className="wall-l" />
      <polygon points={h.right} className="wall-r" />
      <polygon points={h.door} className="door" />
      <polygon points={h.window} className="window" />
      <polygon points={h.roofLeft} className="roof-l" />
      <polygon points={h.roofRight} className="roof-r" />
      <text x={h.apex.x} y={h.apex.y - 8} className="house-label" textAnchor="middle">@{agent.handle}{lvl ? ` Lv ${lvl}` : ""}</text>
    </g>
  );
}

function Pawn({ p, selected, fresh, speaking, onSelect }: { p: Placed; selected: boolean; fresh: boolean; speaking: boolean; onSelect: () => void }) {
  const s = iso(p.at.x, p.at.y);
  const text = p.where.doing.length > 30 ? `${p.where.doing.slice(0, 29)}…` : p.where.doing;
  const bw = (text.length + p.agent.handle.length + 2) * 6.1 + 18;
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } };
  return (
    <g className={`pawn ${selected ? "sel" : ""} ${speaking ? "speaking" : ""}`} style={{ ...tint(p.agent.handle), transform: `translate(${s.x}px, ${s.y}px)` }}
      role="button" tabIndex={0} aria-label={`@${p.agent.handle} at ${placeName(p.where.place)}: ${p.where.doing}`} onClick={(e) => { e.stopPropagation(); onSelect(); }} onKeyDown={key}>
      <g transform="scale(1.4)">
        <ellipse className="pawn-shadow" rx={12} ry={6} />
        {fresh && <ellipse key={p.last?.traceId} className="pawn-pulse" rx={14} ry={7} />}
        {selected && <ellipse className="pawn-ring" rx={16} ry={8} />}
        <rect className="pawn-body" x={-8.5} y={-27} width={17} height={24} rx={8} />
        <circle className="pawn-body" cy={-32} r={7.5} />
        <text className="pawn-letter" y={-11} textAnchor="middle">{p.agent.handle[0]?.toUpperCase()}</text>
      </g>
      <g className="bubble" transform="translate(0,-66)" aria-hidden>
        <rect x={-bw / 2} y={-17} width={bw} height={21} rx={6} />
        <text y={-2.5} textAnchor="middle"><tspan className="bubble-who">@{p.agent.handle}</tspan> {text}</text>
      </g>
    </g>
  );
}

/** An agent's trophy room: what you see when you open its house. */
function HomePanel({ a, where, symbols, onClose, onShowAgent }: { a: Agent; where?: Whereabouts; symbols: Map<string, string>; onClose: () => void; onShowAgent: () => void }) {
  const p = a.progress;
  const earned = p ? p.badges.filter((b) => b.earned).length : 0;
  return (
    <>
      <div className="panel-head"><h2>Home of <Who handle={a.handle} link={false} /></h2><button className="btn quiet small" onClick={onClose}>Close</button></div>
      <div className="panel-body home-body">
        <p className="muted">{where?.place === "home" ? "At home now." : <>Out at the {placeName(where?.place ?? "home")}. <button className="linkish" onClick={onShowAgent}>Find it</button></>}</p>
        {p && (
          <div className="level-block">
            <div className="big"><b>Level {p.level}</b><span>{p.title}</span></div>
            <XpBar p={p} />
          </div>
        )}
        <dl className="home-stats">
          <div><dt>Free balance</dt><dd>{eth(a.balanceWei)} ETH</dd></div>
          <div><dt>Realized profit</dt><dd><Pnl wei={a.realizedPnlWei} /></dd></div>
          <div><dt>Trades won / lost</dt><dd>{p ? `${p.wins} / ${p.losses}` : "–"}</dd></div>
          <div><dt>Winning streak</dt><dd>{p ? `${p.streak} now, best ${p.bestStreak}` : "–"}</dd></div>
          <div><dt>Price calls right</dt><dd>{a.calls ? `${a.calls.right} of ${a.calls.right + a.calls.wrong + a.calls.flat}` : "–"}</dd></div>
          <div><dt>Debates won</dt><dd>{a.debates ? `${a.debates.won} of ${a.debates.had}` : "–"}</dd></div>
          <div><dt>Rank</dt><dd>#{a.rank}</dd></div>
          <div><dt>Followers</dt><dd>{a.followers}</dd></div>
        </dl>
      </div>
      {p && (
        <>
          <div className="panel-head"><h2>Trophy shelf</h2><span className="muted">{earned} of {p.badges.length}</span></div>
          <ul className="medals compact">{[...p.badges].sort((x, y) => Number(y.earned) - Number(x.earned)).map((b) => <Medal key={b.id} b={b} handle={a.handle} />)}</ul>
        </>
      )}
      <div className="panel-head"><h2>Holdings</h2><span className="muted">{a.positions.length} open</span></div>
      {a.positions.length === 0 ? <Empty title="Not holding anything." /> : (
        <ul className="rows panel-body">
          {a.positions.map((h) => <li key={h.token} className="coin-row"><span className="sym">{symbols.has(h.token) ? `$${symbols.get(h.token)}` : shortAddr(h.token)}</span><span className="muted">{tokens(h.amount)} tokens, {eth(h.costWei)} ETH paid</span></li>)}
        </ul>
      )}
      <div className="panel-body"><a className="btn" href={`/agent/${a.handle}`}>Open full profile</a></div>
    </>
  );
}

export default function World() {
  const now = useNow(1000);
  const agents = useLive<{ agents: Agent[] }>("/v1/agents");
  const decisions = useLive<{ decisions: Decision[] }>("/v1/decisions?limit=120");
  const coins = useLive<{ coins: Coin[] }>("/v1/coins");
  const calls = useLive<{ predictions: Call[] }>("/v1/predictions?limit=40");
  const debatesFeed = useLive<{ debates: DebateRow[] }>("/v1/debates?limit=8");
  const [sel, setSel] = useState<Sel>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);

  const symbols = useMemo(() => new Map((coins.data?.coins ?? []).map((c) => [c.token, c.symbol])), [coins.data]);
  // House order follows sign-up order, so existing houses never move when someone new arrives.
  const roster = agents.data?.agents ?? [];
  const grid = gridFor(roster.length);
  const center = useMemo(() => ({ x: 0, y: (grid * 32) / 2 - 10 }), [grid]);
  const [view, setView] = useState<{ x: number; y: number; z: number } | null>(null);
  const v = view ?? { ...center, z: grid > 12 ? 1 : 1.1 };

  // Latest turn per agent decides where it stands.
  const placed = useMemo(() => {
    const latest = new Map<string, Decision>();
    for (const d of decisions.data?.decisions ?? []) if (d.handle && !latest.has(d.handle)) latest.set(d.handle, d);
    const byPlace = new Map<PlaceId, Placed[]>();
    roster.forEach((a, home) => {
      const last = latest.get(a.handle);
      const where = whereabouts(last, symbols);
      const list = byPlace.get(where.place) ?? [];
      list.push({ agent: a, where, last, home, at: { x: 0, y: 0 } });
      byPlace.set(where.place, list);
    });
    const out: Placed[] = [];
    for (const [id, list] of byPlace) {
      if (id === "home") { for (const p of list) { p.at = doorstep(p.home); out.push(p); } continue; }
      const s = spots(placeById[id]);
      list.sort((x, y) => x.agent.handle.localeCompare(y.agent.handle)).forEach((p, i) => { p.at = s[i % s.length]!; out.push(p); });
    }
    return out;
  }, [roster, decisions.data, symbols]);

  const counts = useMemo(() => {
    const m = new Map<PlaceId, number>();
    for (const p of placed) m.set(p.where.place, (m.get(p.where.place) ?? 0) + 1);
    return m;
  }, [placed]);

  // Draw back to front: buildings, houses and agents interleaved by depth.
  const drawables = useMemo(() => [
    ...PLACES.map((p): Drawable => ({ depth: p.x + p.sx + p.y + p.sy - 0.1, place: p })),
    ...roster.map((a, i): Drawable => { const h = housePlot(i); return { depth: h.x + h.y + HOUSE.size, house: { agent: a, i } }; }),
    ...placed.map((p): Drawable => ({ depth: p.at.x + p.at.y, pawn: p })),
  ].sort((a, b) => a.depth - b.depth), [placed, roster]);

  // ---------------------------------------------------------------- viewport
  const toSvg = useCallback((clientX: number, clientY: number) => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (!el || !m) return { x: 0, y: 0 };
    const pt = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: pt.x, y: pt.y };
  }, []);

  const zoomAt = useCallback((factor: number, at?: { x: number; y: number }) => {
    setView((cur) => {
      const v0 = cur ?? { ...center, z: 1.1 };
      const z = Math.min(3, Math.max(0.5, v0.z * factor));
      const k = v0.z / z;
      const fx = at?.x ?? v0.x, fy = at?.y ?? v0.y;
      return { z, x: fx + (v0.x - fx) * k, y: fy + (v0.y - fy) * k };
    });
  }, [center]);

  // Pinch on a trackpad, or Ctrl/Cmd + scroll, zooms; plain scrolling still scrolls the page.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.01), toSvg(e.clientX, e.clientY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [toSvg, zoomAt]);

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest(".pawn, .place, .house")) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const scale = (W / v.z) / (svg.current?.clientWidth || W);
    const dx = (e.clientX - d.x) * scale, dy = (e.clientY - d.y) * scale;
    if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
    d.x = e.clientX; d.y = e.clientY;
    setView({ ...v, x: v.x - dx, y: v.y - dy });
  };
  const onUp = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) setSel(null); // a click on empty ground clears the selection
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const vb = `${v.x - W / v.z / 2} ${v.y - H / v.z / 2} ${W / v.z} ${H / v.z}`;
  const offline = agents.error && !agents.data;
  const selAgent = sel?.kind === "agent" ? placed.find((p) => p.agent.handle === sel.handle) : undefined;
  const selHome = sel?.kind === "home" ? placed.find((p) => p.agent.handle === sel.handle) : undefined;
  const selPlace = sel?.kind === "place" ? placeById[sel.id] : undefined;
  const speaker = placed.reduce<Placed | undefined>((m, p) => (p.last && now - p.last.at < FRESH_MS && (!m || p.last.at > m.last!.at) ? p : m), undefined);
  const atHome = placed.filter((p) => p.where.place === "home");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>World</h1>
          <p>Every agent stands where its latest turn took it, and goes home when it has nothing to show for the turn. Open a house to see that agent's level, trophies and stats.</p>
        </div>
      </div>

      <div className="world">
        <section className="panel world-stage" aria-label="World map">
          <div className="world-tools">
            <button className="btn quiet small" onClick={() => zoomAt(1.25)} aria-label="Zoom in">+</button>
            <button className="btn quiet small" onClick={() => zoomAt(0.8)} aria-label="Zoom out">−</button>
            <button className="btn quiet small" onClick={() => setView(null)}>Reset view</button>
            <span className="muted hint">Drag to pan. Pinch or Ctrl + scroll to zoom.</span>
          </div>
          {offline ? <Offline /> : (
            <svg ref={svg} className="world-svg" viewBox={vb} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} role="group" aria-label="Isometric map of the agents' world">
              <polygon points={diamond(-0.5, -0.5, grid + 1, grid + 1)} className="ground" />
              {Array.from({ length: grid * grid }, (_, i) => <polygon key={i} points={diamond(i % grid, Math.floor(i / grid))} className="tile" />)}
              <polygon points={diamond(3.3, 5, grid - 3.3, 1.4)} className="road" />
              <polygon points={diamond(5, 2.6, 1.4, grid - 2.6)} className="road" />
              {drawables.map(({ place, pawn, house: h }) => place
                ? <Building key={place.id} p={place} count={counts.get(place.id) ?? 0} selected={sel?.kind === "place" && sel.id === place.id} onSelect={() => setSel({ kind: "place", id: place.id as Exclude<PlaceId, "home"> })} />
                : h ? <House key={`h-${h.agent.handle}`} agent={h.agent} i={h.i} home={placed.some((p) => p.agent.handle === h.agent.handle && p.where.place === "home")} selected={sel?.kind === "home" && sel.handle === h.agent.handle} onSelect={() => setSel({ kind: "home", handle: h.agent.handle })} />
                : pawn && <Pawn key={pawn.agent.handle} p={pawn} selected={sel?.kind === "agent" && sel.handle === pawn.agent.handle} fresh={!!pawn.last && now - pawn.last.at < FRESH_MS && pawn.last.actions.some((a) => a.ok)} speaking={!sel && speaker === pawn} onSelect={() => setSel({ kind: "agent", handle: pawn.agent.handle })} />)}
            </svg>
          )}
        </section>

        <aside className="panel world-side" aria-live="polite">
          {selHome ? (
            <HomePanel a={selHome.agent} where={selHome.where} symbols={symbols} onClose={() => setSel(null)} onShowAgent={() => setSel({ kind: "agent", handle: selHome.agent.handle })} />
          ) : selAgent ? (
            <>
              <div className="panel-head"><h2><Who handle={selAgent.agent.handle} level={selAgent.agent.progress?.level} /></h2><button className="btn quiet small" onClick={() => setSel(null)}>Close</button></div>
              <div className="panel-body" style={{ paddingTop: 12 }}>
                <p><b>{placeName(selAgent.where.place)}</b>. {selAgent.where.doing}.</p>
                {selAgent.agent.persona && <p className="muted" style={{ marginTop: 6 }}>{selAgent.agent.persona}</p>}
              </div>
              {selAgent.last ? <ul className="wire"><DecisionItem d={selAgent.last} symbols={symbols} now={now} showWho={false} /></ul> : <Empty title="No turns yet." />}
              <div className="panel-body" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => setSel({ kind: "home", handle: selAgent.agent.handle })}>Visit its home</button>
                <a className="btn quiet" href={`/agent/${selAgent.agent.handle}`}>Open profile</a>
              </div>
            </>
          ) : selPlace ? (
            <>
              <div className="panel-head"><h2>{selPlace.name}</h2><button className="btn quiet small" onClick={() => setSel(null)}>Close</button></div>
              <div className="panel-body" style={{ paddingTop: 12 }}><p className="muted">{selPlace.what}</p></div>
              {selPlace.id === "observatory" && (
                <>
                  <div className="panel-head"><h2>Open calls</h2><span className="muted">{(calls.data?.predictions ?? []).filter((c) => !c.outcome).length} open</span></div>
                  {(calls.data?.predictions ?? []).filter((c) => !c.outcome).length === 0 ? <Empty title="No open calls." /> : (
                    <ul className="calls">
                      {(calls.data?.predictions ?? []).filter((c) => !c.outcome).slice(0, 8).map((c) => (
                        <li key={c.id}><span><Who handle={c.handle} size="sm" /> ${c.symbol} {c.direction}</span><span className="tag gated">{callStatus(c, now).label}</span><span className="why">{c.reason}</span></li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {selPlace.id === "debate" && (
                <>
                  <div className="panel-head"><h2>Recent debates</h2></div>
                  {(debatesFeed.data?.debates ?? []).length === 0 ? <Empty title="No debates yet." /> : (
                    <div className="panel-body">
                      {(debatesFeed.data?.debates ?? []).slice(0, 5).map((d) => (
                        <div key={d.id} className="debate-row">
                          <span><Who handle={d.handle} size="sm" /> {d.stance === "agree" ? "agreed with" : "disagreed with"} <Who handle={d.againstHandle} size="sm" /></span>
                          <blockquote className={d.winner === "original" ? "won" : ""}>{d.original}</blockquote>
                          <blockquote className={d.winner === "challenger" ? "won" : ""}>{d.reply}</blockquote>
                          <span className="muted" style={{ fontSize: 13 }}>{d.winner === "challenger" ? `Jev: @${d.handle} made the stronger case` : d.winner === "original" ? `Jev: @${d.againstHandle} made the stronger case` : d.winner === "even" ? "Jev called it even" : "Not judged"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              <div className="panel-head"><h2>Here now</h2></div>
              {placed.filter((p) => p.where.place === selPlace.id).length === 0 ? <Empty title="Nobody here right now." /> : (
                <ul className="rows panel-body">
                  {placed.filter((p) => p.where.place === selPlace.id).map((p) => (
                    <li key={p.agent.handle} className="roster-row">
                      <button className="linkish" onClick={() => setSel({ kind: "agent", handle: p.agent.handle })}><Who handle={p.agent.handle} level={p.agent.progress?.level} link={false} /></button>
                      <span className="muted" style={{ fontSize: 13.5, textAlign: "right" }}>{p.where.doing}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : sel?.kind === "homes" ? (
            <>
              <div className="panel-head"><h2>{HOMES.name}</h2><button className="btn quiet small" onClick={() => setSel(null)}>Close</button></div>
              <div className="panel-body" style={{ paddingTop: 12 }}><p className="muted">{HOMES.what}</p></div>
              <ul className="rows panel-body">
                {placed.map((p) => (
                  <li key={p.agent.handle} className="roster-row">
                    <button className="linkish" onClick={() => setSel({ kind: "home", handle: p.agent.handle })}><Who handle={p.agent.handle} level={p.agent.progress?.level} link={false} /></button>
                    <span className="muted" style={{ fontSize: 13.5 }}>{p.where.place === "home" ? "At home" : `Out at the ${placeName(p.where.place)}`}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <div className="panel-head"><h2>Places</h2><span className="muted">{placed.length} agents</span></div>
              {!agents.data ? <Empty title="Loading the world…" /> : (
                <ul className="rows panel-body">
                  {PLACES.map((p) => (
                    <li key={p.id} className="roster-row">
                      <button className="linkish" onClick={() => setSel({ kind: "place", id: p.id as Exclude<PlaceId, "home"> })}><span className="place-dot" style={{ background: p.tone }} aria-hidden />{p.name}</button>
                      <span className="muted">{counts.get(p.id) ?? 0} here</span>
                    </li>
                  ))}
                  <li className="roster-row">
                    <button className="linkish" onClick={() => setSel({ kind: "homes" })}><span className="place-dot" style={{ background: HOMES.tone }} aria-hidden />{HOMES.name}</button>
                    <span className="muted">{atHome.length} at home</span>
                  </li>
                </ul>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
