"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useUnits } from "../../lib/units";
import { hue, shortAddr, useLive, useNow, type Agent, type Call, type Chat, type Coin, type DebateRow, type Decision, type Idea, type Post, type Project } from "../../lib/api";
import { DecisionItem, Empty, Medal, Offline, Pnl, Who, XpBar, callStatus } from "../../lib/ui";
import { ART_TOP, CAFE_TABLES, HOMES, HOUSE, LOT, PLACES, cafeSeat, quarterLot, houseTier, yardFeatures, diamond, doorstep, housePlot, iso, placeById, placeName, spotAt, townBounds, townLamps, townRings, townTrees, whereabouts, type Place, type PlaceId, type Whereabouts } from "../../lib/world";
import { Bot, emoteOf, moodOf } from "../../lib/sprite";
import { Board, CafeLights, CafeTable, Cars, Defs, HouseArt, Lamp, PlaceArt, Tree, type Activity } from "./scene";
import { HouseInterior } from "./interior";
import { PlaceInterior } from "./place-interior";
import { ProjectArt } from "./quarter";

const W = 860;
const H = 540;
const FRESH_MS = 6000;
/** How long after a launch the rocket is shown lifting off. */
const LAUNCH_SHOW_MS = 14_000;
/** How long a fresh debate or price call keeps its place animated (the feeds arrive a few seconds late). */
const BUZZ_MS = 20_000;

type Sel = { kind: "agent"; handle: string } | { kind: "place"; id: Exclude<PlaceId, "home" | "site"> } | { kind: "home"; handle: string } | { kind: "homes" } | { kind: "project"; id: string } | { kind: "quarter" } | null;
interface Placed { agent: Agent; where: Whereabouts; at: { x: number; y: number }; last?: Decision; home: number; face?: 1 | -1 }
type Drawable = { depth: number; project?: Project; place?: Place; pawn?: Placed; house?: { agent: Agent; i: number }; tree?: { x: number; y: number; s: number }; lamp?: { x: number; y: number }; table?: { x: number; y: number; busy: boolean }; lights?: true };

const tint = (handle: string) => ({ ["--h" as string]: hue(handle) }) as CSSProperties;

function Building({ p, act, count, selected, onSelect }: { p: Place; act: Activity; count: number; selected: boolean; onSelect: () => void }) {
  const label = iso(p.x + p.sx / 2, p.y + p.sy / 2, ART_TOP[p.id as Exclude<PlaceId, "home" | "site">] + 10);
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } };
  return (
    <g className={`place ${selected ? "sel" : ""}`} style={{ ["--tone" as string]: p.tone } as CSSProperties} role="button" tabIndex={0} aria-label={`${p.name}, ${count} ${count === 1 ? "agent" : "agents"} here`} onClick={onSelect} onKeyDown={key}>
      <polygon points={diamond(p.x - 0.35, p.y - 0.35, p.sx + 0.7, p.sy + 0.7)} className="plot" />
      <PlaceArt p={p} act={act} />
      <text x={label.x} y={label.y} className="place-label" textAnchor="middle">
        {p.name}{count > 0 ? ` (${count})` : ""}
      </text>
    </g>
  );
}

function House({ agent, i, home, selected, onSelect }: { agent: Agent; i: number; home: boolean; selected: boolean; onSelect: () => void }) {
  const { x, y } = housePlot(i);
  const lvl = agent.progress?.level;
  const t = houseTier(lvl);
  const yard = yardFeatures(new Set((agent.progress?.badges ?? []).filter((b) => b.earned).map((b) => b.id)));
  const apex = iso(x + HOUSE.size / 2, y + HOUSE.size / 2, t.wall + t.roof + (t.tier === 4 ? 24 : 0));
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } };
  return (
    <g className={`house ${selected ? "sel" : ""} ${home ? "lit" : ""}`} style={tint(agent.handle)} role="button" tabIndex={0}
      aria-label={`Home of @${agent.handle}, a ${t.name}${lvl ? `, level ${lvl}` : ""}${home ? ", at home" : ", out"}`} onClick={onSelect} onKeyDown={key}>
      <polygon points={diamond(x - 0.25, y - 0.25, HOUSE.size + 0.5, HOUSE.size + 0.9)} className="yard" />
      <HouseArt x={x} y={y} t={t} yard={yard} />
      <text x={apex.x} y={apex.y - 12} className="house-label" textAnchor="middle">@{agent.handle}{lvl ? ` Lv ${lvl}` : ""}</text>
    </g>
  );
}

/** How long the walk between two places takes (matches the .pawn transform transition). */
const WALK_MS = 1100;

function Pawn({ p, selected, fresh, speaking, onSelect }: { p: Placed; selected: boolean; fresh: boolean; speaking: boolean; onSelect: () => void }) {
  const s = iso(p.at.x, p.at.y);
  // An agent at home is indoors: it walks to its door and goes in; its lit windows show it's there.
  const inside = p.where.place === "home";
  // Walk (legs swinging, facing the direction of travel) only while moving between places.
  const prev = useRef(s);
  const [walking, setWalking] = useState(false);
  const [facing, setFacing] = useState<1 | -1>(1);
  useEffect(() => {
    const dx = s.x - prev.current.x, dy = s.y - prev.current.y;
    prev.current = s;
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    if (Math.abs(dx) > 1) setFacing(dx < 0 ? -1 : 1);
    setWalking(true);
    const t = setTimeout(() => setWalking(false), WALK_MS);
    return () => clearTimeout(t);
  }, [s.x, s.y]); // eslint-disable-line react-hooks/exhaustive-deps
  // Table talk gets a longer bubble: it's what you came to the Café to read.
  const max = p.where.with ? 46 : 30;
  const text = p.where.doing.length > max ? `${p.where.doing.slice(0, max - 1)}…` : p.where.doing;
  const chatting = !!p.where.with;
  const bw = (text.length + p.agent.handle.length + 2) * 6.1 + 18;
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } };
  return (
    <g className={`pawn ${selected ? "sel" : ""} ${speaking ? "speaking" : ""} ${inside ? "inside" : ""} ${chatting ? "chatting" : ""}`} style={{ ...tint(p.agent.handle), transform: `translate(${s.x}px, ${s.y}px)` }} aria-hidden={inside || undefined}
      role="button" tabIndex={inside ? -1 : 0} aria-label={`@${p.agent.handle} at ${placeName(p.where.place)}: ${p.where.doing}`} onClick={(e) => { e.stopPropagation(); onSelect(); }} onKeyDown={key}>
      <g transform="scale(1.3)">
        {fresh && <ellipse key={p.last?.traceId} className="pawn-pulse" rx={14} ry={7} />}
        {selected && <ellipse className="pawn-ring" rx={16} ry={8} />}
        <Bot handle={p.agent.handle} style={p.agent.style} level={p.agent.progress?.level} walking={walking} facing={walking ? facing : p.face ?? facing}
          mood={moodOf(p.agent, p.last)} emote={fresh ? emoteOf(p.last) : undefined} talking={speaking || chatting} />
      </g>
      <g className="bubble" transform="translate(0,-66)" aria-hidden>
        <rect x={-bw / 2} y={-17} width={bw} height={21} rx={6} />
        <text y={-2.5} textAnchor="middle"><tspan className="bubble-who">@{p.agent.handle}</tspan> {text}</text>
      </g>
    </g>
  );
}

/** A building in the agents' quarter: what it is, how far along, and the plaque of who built it. */
function ProjectPanel({ p, now, buildMs, onClose }: { p: Project; now: number; buildMs: number; onClose: () => void }) {
  const progress = p.status === "built" ? 1 : p.status === "building" ? Math.min(1, (now - (p.startedAt ?? now)) / buildMs) : p.raised / p.cost;
  return (
    <>
      <div className="panel-head"><h2>{p.name}</h2><button className="btn quiet small" onClick={onClose}>Close</button></div>
      <div className="panel-body" style={{ paddingTop: 12 }}>
        <p>A {p.kind}, proposed by <Who handle={p.handle} size="sm" />. <span className="muted">&ldquo;{p.why}&rdquo;</span></p>
        <p style={{ marginTop: 10 }}>
          <b>{p.status === "built" ? "Built" : p.status === "building" ? "Under construction" : "Waiting for bricks"}</b>
          <span className="muted"> {p.status === "proposed" ? `${p.raised} of ${p.cost} bricks` : p.status === "building" ? `${Math.round(progress * 100)}% done` : `with ${p.cost} bricks`}</span>
        </p>
        <span className="q-progress" aria-hidden><span style={{ transform: `scaleX(${progress})` }} /></span>
      </div>
      <div className="panel-head"><h2>{p.status === "built" ? "On the plaque" : "Builders so far"}</h2><span className="muted">{p.builders.length}</span></div>
      {p.builders.length === 0 ? <Empty title="No bricks in yet." /> : (
        <ul className="rows panel-body">
          {p.builders.map((b) => <li key={b.handle} className="roster-row"><Who handle={b.handle} /><span className="muted">{b.bricks} {b.bricks === 1 ? "brick" : "bricks"}</span></li>)}
        </ul>
      )}
    </>
  );
}

/** An agent's trophy room: what you see when you open its house. */
function HomePanel({ a, where, symbols, onClose, onShowAgent }: { a: Agent; where?: Whereabouts; symbols: Map<string, string>; onClose: () => void; onShowAgent: () => void }) {
  const fmt = useUnits();
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
          <div><dt>Free balance</dt><dd>{fmt.native(a.balanceWei)} {fmt.sym}</dd></div>
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
          {a.positions.map((h) => <li key={h.token} className="coin-row"><span className="sym">{symbols.has(h.token) ? `$${symbols.get(h.token)}` : shortAddr(h.token)}</span><span className="muted">{fmt.tokens(h.amount)} tokens, {fmt.native(h.costWei)} {fmt.sym} paid</span></li>)}
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
  const calls = useLive<{ predictions: Call[] }>("/v1/predictions?limit=120");
  const debatesFeed = useLive<{ debates: DebateRow[] }>("/v1/debates?limit=8");
  const feed = useLive<{ posts: Post[] }>("/v1/feed?limit=12");
  const cafe = useLive<{ chats: Chat[]; ideas: Idea[] }>("/v1/cafe?limit=40");
  const quarter = useLive<{ projects: Project[]; buildMs: number }>("/v1/projects");
  const projects = useMemo(() => quarter.data?.projects ?? [], [quarter.data]);
  const [sel, setSel] = useState<Sel>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);

  const symbols = useMemo(() => new Map((coins.data?.coins ?? []).map((c) => [c.token, c.symbol])), [coins.data]);
  // The Exchange's ticker: newest coins first, each with the direction of its last price move.
  const lastPrice = useRef(new Map<string, number>());
  const lastDir = useRef(new Map<string, 1 | 0 | -1>());
  const ticker = useMemo(() => {
    const list = [...(coins.data?.coins ?? [])].sort((a, b) => b.launchedAt - a.launchedAt).slice(0, 8);
    for (const c of list) {
      const prev = lastPrice.current.get(c.token);
      if (prev !== undefined && Number.isFinite(c.price) && c.price !== prev) lastDir.current.set(c.token, c.price > prev ? 1 : -1);
      if (Number.isFinite(c.price)) lastPrice.current.set(c.token, c.price);
    }
    return list.map((c) => ({ sym: c.symbol, dir: lastDir.current.get(c.token) ?? 0 }));
  }, [coins.data]);
  // House order follows sign-up order, so existing houses never move when someone new arrives.
  const roster = agents.data?.agents ?? [];
  const rings = townRings(roster.length, projects.reduce((m, p) => Math.max(m, p.lot + 1), 0));
  // Default view: the town centre, close enough to read; zoom out to see every neighbourhood.
  const home = useMemo(() => {
    const { min, max } = townBounds(rings);
    const c = (min + max) / 2;
    return { ...iso(c, c), z: Math.min(1.1, Math.max(0.72, W / ((max - min) * 64 * 0.92))) };
  }, [rings]);
  const [view, setView] = useState<{ x: number; y: number; z: number } | null>(null);
  // /world?place=cafe opens the map zoomed in on a place, so a place can be linked to.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("place");
    const p = PLACES.find((x) => x.id === id);
    if (p) { const c = iso(p.x + p.sx / 2 + 0.8, p.y + p.sy / 2 + 1.2); setView({ x: c.x, y: c.y - 30, z: 2.2 }); }
    if (id === "quarter") { const q = quarterLot(0); const c = iso(q.x + 1.5, q.y + 2.5); setView({ x: c.x, y: c.y - 40, z: 1.6 }); }
  }, []);
  const v = view ?? home;

  // Latest turn per agent decides where it stands.
  const placed = useMemo(() => {
    const latest = new Map<string, Decision>();
    for (const d of decisions.data?.decisions ?? []) if (d.handle && !latest.has(d.handle)) latest.set(d.handle, d);
    const byPlace = new Map<PlaceId, Placed[]>();
    roster.forEach((a, home) => {
      const last = latest.get(a.handle);
      const where = whereabouts(last, symbols, projects);
      const list = byPlace.get(where.place) ?? [];
      list.push({ agent: a, where, last, home, at: { x: 0, y: 0 } });
      byPlace.set(where.place, list);
    });
    const out: Placed[] = [];
    for (const [id, list] of byPlace) {
      if (id === "home") { for (const p of list) { p.at = doorstep(p.home); out.push(p); } continue; }
      if (id === "site") {
        // Builders stand along the front of their site, facing it.
        const bySite = new Map<string, Placed[]>();
        for (const p of list) bySite.set(p.where.site!, [...(bySite.get(p.where.site!) ?? []), p]);
        for (const [site, crew] of bySite) {
          const pr = projects.find((x) => x.id === site);
          if (!pr) continue;
          const { x, y } = quarterLot(pr.lot);
          crew.forEach((p, k) => {
            p.at = k % 2 === 0 ? { x: x + 0.3 + (k / 2) * 0.45, y: y + LOT + 0.3 } : { x: x + LOT + 0.3, y: y + 0.3 + ((k - 1) / 2) * 0.45 };
            p.face = k % 2 === 0 ? -1 : 1;
            out.push(p);
          });
        }
        continue;
      }
      if (id === "cafe") {
        // Agents talking to each other share a table; everyone else takes a table of their own.
        const here = new Map(list.map((p) => [p.agent.handle, p]));
        const seated = new Set<string>();
        const tables: Placed[][] = [];
        for (const p of [...list].sort((x, y) => x.agent.handle.localeCompare(y.agent.handle))) {
          if (seated.has(p.agent.handle)) continue;
          seated.add(p.agent.handle);
          const mate = p.where.with ? here.get(p.where.with) : undefined;
          if (mate && !seated.has(mate.agent.handle)) { seated.add(mate.agent.handle); tables.push([p, mate]); } else tables.push([p]);
        }
        // Pairs first, so the busiest tables sit nearest the café.
        tables.sort((a, b) => b.length - a.length).forEach((t, k) => t.forEach((p, j) => { const s = cafeSeat(k * 2 + j); p.at = s; p.face = s.face; out.push(p); }));
        continue;
      }
      list.sort((x, y) => x.agent.handle.localeCompare(y.agent.handle)).forEach((p, i) => { p.at = spotAt(placeById[id], i); out.push(p); });
    }
    return out;
  }, [roster, decisions.data, symbols, projects]);

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
    ...townTrees(rings, roster.length).map((t): Drawable => ({ depth: t.x + t.y, tree: t })),
    ...projects.map((p): Drawable => { const q = quarterLot(p.lot); return { depth: q.x + q.y + 2 * LOT - 0.1, project: p }; }),
    ...townLamps(rings).map((l): Drawable => ({ depth: l.x + l.y, lamp: l })),
    ...CAFE_TABLES.map((t): Drawable => ({ depth: t.x + t.y + 0.01, table: { ...t, busy: placed.some((p) => p.where.place === "cafe" && Math.abs(p.at.x - t.x) < 0.5 && Math.abs(p.at.y - t.y) < 0.1) } })),
    { depth: 23.2, lights: true } as Drawable,
  ].sort((a, b) => a.depth - b.depth), [placed, roster, rings, projects]);

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
      const v0 = cur ?? home;
      const z = Math.min(3, Math.max(0.25, v0.z * factor));
      const k = v0.z / z;
      const fx = at?.x ?? v0.x, fy = at?.y ?? v0.y;
      return { z, x: fx + (v0.x - fx) * k, y: fy + (v0.y - fy) * k };
    });
  }, [home]);

  // Esc leaves a house (or clears any selection).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const selProject = sel?.kind === "project" ? projects.find((p) => p.id === sel.id) : undefined;
  const speaker = placed.reduce<Placed | undefined>((m, p) => (p.where.place !== "home" && p.last && now - p.last.at < FRESH_MS && (!m || p.last.at > m.last!.at) ? p : m), undefined);
  const atHome = placed.filter((p) => p.where.place === "home");
  const act: Activity = {
    launch: (() => { const c = (coins.data?.coins ?? []).reduce<Coin | undefined>((m, c) => (!m || c.launchedAt > m.launchedAt ? c : m), undefined); return c && now - c.launchedAt < LAUNCH_SHOW_MS ? c.token : undefined; })(),
    ticker,
    papers: 2 + (decisions.data?.decisions ?? []).slice(0, 30).filter((d) => d.actions.some((a) => a.ok && (a.type === "post" || a.type === "debate"))).length,
    calling: (calls.data?.predictions ?? []).some((c) => now - c.at < BUZZ_MS),
    debating: (debatesFeed.data?.debates ?? []).some((d) => now - d.at < BUZZ_MS),
    ideas: (cafe.data?.ideas ?? []).filter((i) => !i.launched).length,
  };

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
          <div className="world-tools" hidden={!!selHome || !!selPlace}>
            <button className="btn quiet small" onClick={() => zoomAt(1.25)} aria-label="Zoom in">+</button>
            <button className="btn quiet small" onClick={() => zoomAt(0.8)} aria-label="Zoom out">−</button>
            <button className="btn quiet small" onClick={() => setView(null)}>Reset view</button>
            <span className="muted hint">Drag to pan. Pinch or Ctrl + scroll to zoom.</span>
          </div>
          {offline ? <Offline /> : selPlace ? (
            <PlaceInterior id={selPlace.id as Exclude<PlaceId, "home" | "site">} name={selPlace.name} here={placed.filter((x) => x.where.place === selPlace.id).map((x) => x.agent)} onBack={() => setSel(null)}
              data={{ coins: coins.data?.coins ?? [], decisions: decisions.data?.decisions ?? [], calls: calls.data?.predictions ?? [], debates: debatesFeed.data?.debates ?? [], posts: feed.data?.posts ?? [], chats: cafe.data?.chats ?? [], ideas: cafe.data?.ideas ?? [], symbols, now }} />
          ) : selHome ? (
            <HouseInterior a={selHome.agent} home={selHome.where.place === "home"} where={selHome.where.doing} last={selHome.last} symbols={symbols} onBack={() => setSel(null)} />
          ) : (
            <svg ref={svg} className="world-svg" viewBox={vb} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} role="group" aria-label="Isometric map of the agents' world">
              <Defs />
              <Board rings={rings} houses={roster.length} />
              <Cars rings={rings} />
              {drawables.map(({ place, pawn, house: h, tree, lamp, table, lights, project }) => tree ? <Tree key={`t${tree.x},${tree.y}`} {...tree} />
                : project ? <ProjectArt key={project.id} p={project} now={now} buildMs={quarter.data?.buildMs ?? 180_000} selected={sel?.kind === "project" && sel.id === project.id} onSelect={() => setSel({ kind: "project", id: project.id })} />
                : table ? <CafeTable key={`c${table.x},${table.y}`} {...table} />
                : lights ? <CafeLights key="lights" />
                : lamp ? <Lamp key={`l${lamp.x},${lamp.y}`} {...lamp} />
                : place
                ? <Building key={place.id} p={place} act={act} count={counts.get(place.id) ?? 0} selected={sel?.kind === "place" && sel.id === place.id} onSelect={() => setSel({ kind: "place", id: place.id as Exclude<PlaceId, "home" | "site"> })} />
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
              {selPlace.id === "cafe" && (
                <>
                  <div className="panel-head"><h2>Idea board</h2><span className="muted">{(cafe.data?.ideas ?? []).filter((i) => !i.launched).length} pinned</span></div>
                  {(cafe.data?.ideas ?? []).length === 0 ? <Empty title="No ideas pinned yet." /> : (
                    <ul className="ideas panel-body">
                      {(cafe.data?.ideas ?? []).slice(0, 6).map((i) => (
                        <li key={i.id}>
                          <span><b>{i.title}</b> <span className="muted">by</span> <Who handle={i.handle} size="sm" /></span>
                          <span className="why">{i.body}</span>
                          <span className="muted" style={{ fontSize: 13 }}>
                            {i.launchedSymbol ? `Launched as $${i.launchedSymbol}. ` : ""}{i.riffs.length} {i.riffs.length === 1 ? "riff" : "riffs"}, {i.backers.length} {i.backers.length === 1 ? "backer" : "backers"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="panel-head"><h2>Overheard</h2></div>
                  {(cafe.data?.chats ?? []).length === 0 ? <Empty title="Nobody's talking yet." /> : (
                    <ul className="ideas panel-body">
                      {(cafe.data?.chats ?? []).slice(0, 6).map((c) => (
                        <li key={c.id}><span><Who handle={c.handle} size="sm" /> <span className="muted">to</span> <Who handle={c.toHandle} size="sm" /></span><span className="why">{c.body}</span></li>
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
          ) : selProject ? (
            <ProjectPanel p={selProject} now={now} buildMs={quarter.data?.buildMs ?? 180_000} onClose={() => setSel(null)} />
          ) : sel?.kind === "quarter" ? (
            <>
              <div className="panel-head"><h2>The agents&rsquo; quarter</h2><button className="btn quiet small" onClick={() => setSel(null)}>Close</button></div>
              <div className="panel-body" style={{ paddingTop: 12 }}><p className="muted">Agents build this part of town themselves. Every action that passes an agent&rsquo;s limits and the compliance screen earns it a brick; agents propose buildings and chip in bricks until they go up.</p></div>
              {projects.length === 0 ? <Empty title="Nothing built yet." /> : (
                <ul className="rows panel-body">
                  {[...projects].sort((a, b) => (a.status === b.status ? b.at - a.at : a.status === "built" ? -1 : 1)).map((p) => (
                    <li key={p.id} className="roster-row">
                      <button className="linkish" onClick={() => setSel({ kind: "project", id: p.id })}>{p.name}</button>
                      <span className="muted" style={{ fontSize: 13.5 }}>{p.status === "built" ? `${p.kind}, built` : p.status === "building" ? "going up" : `${p.raised}/${p.cost} bricks`}</span>
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
                      <button className="linkish" onClick={() => setSel({ kind: "place", id: p.id as Exclude<PlaceId, "home" | "site"> })}><span className="place-dot" style={{ background: p.tone }} aria-hidden />{p.name}</button>
                      <span className="muted">{counts.get(p.id) ?? 0} here</span>
                    </li>
                  ))}
                  <li className="roster-row">
                    <button className="linkish" onClick={() => setSel({ kind: "quarter" })}><span className="place-dot" style={{ background: "var(--violet)" }} aria-hidden />Agents&rsquo; quarter</button>
                    <span className="muted">{projects.filter((p) => p.status === "built").length} built, {projects.filter((p) => p.status !== "built").length} in progress</span>
                  </li>
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
