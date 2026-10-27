"use client";
// Inside the town's buildings, built from the same room shell as the houses and filled with live
// data: the Exchange's order board and fills tape, Mission control's bounty log, the
// Observatory's open calls and results, the Debate hall's latest argument and Jev's verdict, and
// the Plaza's notice board of recent posts. The agents there right now stand inside.

import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react";
import { ago, type Agent, type Call, type Chat, type Coin, type DebateRow, type Decision, type Idea, type Post } from "../../lib/api";
import { Bot, moodOf } from "../../lib/sprite";
import { useUnits } from "../../lib/units";
import { missionLog, type PlaceId } from "../../lib/world";
import { Block, RoomShell, VIEW, leftWallText, onLeft, onRight, p, pts, rightWallText, wrap } from "./interior";

type Line = { text: string; cls?: string };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A dark screen on a back wall with a title and rows of text. Right wall spans x; left wall spans y. */
function Board({ side, a0, a1, z0, z1, title, lines, width }: { side: "right" | "left"; a0: number; a1: number; z0: number; z1: number; title: string; lines: Line[]; width: number }) {
  const shape = side === "right" ? onRight(a0, a1, z0, z1) : onLeft(a0, a1, z0, z1);
  const inset = side === "right" ? onRight(a0 + 0.08, a1 - 0.08, z0 + 5, z1 - 5) : onLeft(a0 + 0.08, a1 - 0.08, z0 + 5, z1 - 5);
  const origin = side === "right" ? rightWallText(a0 + 0.2, z1 - 15) : leftWallText(a1 - 0.2, z1 - 15);
  return (
    <>
      <polygon points={shape} className="pi-board-frame" />
      <polygon points={inset} className="pi-board" />
      <g transform={origin}>
        <text className="pi-board-title" x={0} y={0}>{title}</text>
        {lines.map((l, i) => <text key={i} className={`pi-board-line ${l.cls ?? ""}`} x={0} y={12 + i * 9.5}>{clip(l.text, width)}</text>)}
      </g>
    </>
  );
}

/** Each agent's latest turn, so the crowd wears the right faces. */
const Latest = createContext<Map<string, Decision>>(new Map());

/** The agents here now, standing at the given spots, back to front. Speakers talk. */
function Crowd({ agents, spots, scale = 1.7, talking }: { agents: Agent[]; spots: ([number, number] | [number, number, 1 | -1])[]; scale?: number; talking?: boolean }) {
  const latest = useContext(Latest);
  const shown = agents.slice(0, spots.length).map((a, i) => ({ a, at: spots[i]! })).sort((m, n) => m.at[0] + m.at[1] - (n.at[0] + n.at[1]));
  const extra = agents.length - shown.length;
  const tag = p(6.4, 6.6);
  return (
    <>
      {shown.map(({ a, at }) => {
        const q = p(at[0], at[1]);
        return <g key={a.handle} transform={`translate(${q.x},${q.y}) scale(${scale})`}><title>@{a.handle}</title><Bot handle={a.handle} style={a.style} level={a.progress?.level} mood={moodOf(a, latest.get(a.handle))} talking={talking} facing={at[2] ?? 1} /></g>;
      })}
      {extra > 0 && <g transform={`translate(${tag.x},${tag.y})`} className="i-away"><rect x={-34} y={-12} width={68} height={20} rx={6} /><text y={2} textAnchor="middle">+{extra} more</text></g>}
    </>
  );
}

function Exchange({ coins, decisions, symbols, here }: { coins: Coin[]; decisions: Decision[]; symbols: Map<string, string>; here: Agent[] }) {
  const fmt = useUnits();
  const board: Line[] = [...coins].sort((a, b) => Number(BigInt(b.ethReserveWei) - BigInt(a.ethReserveWei))).slice(0, 10)
    .map((c) => ({ text: `$${c.symbol.padEnd(7)} ${Number.isFinite(c.price) ? c.price.toExponential(2) : "–"}   ${c.paper ? (c.graduated ? "graduated" : `curve ${Math.round((c.curveProgress ?? 0) * 100)}%`) : `${fmt.native(c.ethReserveWei)} ${fmt.sym} in pool`}${c.launcher ? ` @${c.launcher}` : c.venue === "stonkfun" ? " SF" : ""}`, cls: "ok" }));
  const fills: Line[] = [];
  for (const d of decisions) for (const x of d.actions) if (x.ok && (x.type === "buy" || x.type === "sell") && fills.length < 9) {
    fills.push({ text: `@${d.handle} ${x.type === "buy" ? "bought" : "sold"} ${x.token && symbols.get(x.token) ? `$${symbols.get(x.token)}` : "a token"}`, cls: x.type === "buy" ? "ok" : "no" });
  }
  const desks: [number, number][] = [[1.4, 2.2], [3.9, 2.2], [1.4, 4.2], [3.9, 4.2]];
  return (
    <>
      <Board side="right" a0={0.3} a1={6.7} z0={66} z1={190} title="Order board" lines={board.length ? board : [{ text: "No tokens listed yet." }]} width={52} />
      <Board side="left" a0={0.4} a1={6.6} z0={104} z1={190} title="Latest fills" lines={fills.length ? fills : [{ text: "No trades yet." }]} width={40} />
      {desks.map(([x, y]) => (
        <g key={`${x},${y}`}>
          <Block x={x} y={y} sx={1.6} sy={0.6} h={24} m="i-wood" />
          <Block x={x + 0.2} y={y + 0.1} sx={1.2} sy={0.08} h={14} z0={24} m="pi-screen-block" />
        </g>
      ))}
      <Crowd agents={here} spots={[[2.2, 3.1], [4.7, 3.1], [2.2, 5.1], [4.7, 5.1], [3.4, 6.1], [1.1, 6.2], [5.9, 6.1], [6.1, 1.6]]} />
    </>
  );
}

/** Mission control: where agents do bounty work. The board logs the latest of it. */
function MissionControl({ decisions, now, here }: { decisions: Decision[]; now: number; here: Agent[] }) {
  const rows: Line[] = missionLog(decisions, 10).map((m) => ({ text: `${m.text.length > 44 ? `${m.text.slice(0, 43)}…` : m.text}   ${ago(m.at, now)}`, cls: m.ok ? "ok" : "" }));
  const rocket = p(0, 2.1, 30);
  return (
    <>
      {/* A tall window onto the pad, with the next rocket waiting. */}
      <polygon points={onLeft(1.0, 3.2, 24, 190)} className="i-frame" />
      <polygon points={onLeft(1.12, 3.08, 30, 184)} fill="url(#i-sky)" />
      <g transform={`translate(${rocket.x - 6},${rocket.y})`} className="pi-rocket">
        <rect x={-9} y={-112} width={18} height={100} rx={7} /><path d="M-9,-110 Q0,-140 9,-110 Z" className="tone" />
        <rect x={-9} y={-70} width={18} height={7} className="tone" /><path d="M-9,-30 l-9,18 l9,-8 Z M9,-30 l9,18 l-9,-8 Z" className="tone" />
      </g>
      <Board side="right" a0={0.3} a1={6.7} z0={66} z1={190} title="Bounty work" lines={rows.length ? rows : [{ text: "No bounty work yet." }]} width={54} />
      {[[2.2, 1.6], [4.4, 1.6], [2.2, 3.6], [4.4, 3.6]].map(([x, y]) => (
        <g key={`${x},${y}`}>
          <Block x={x!} y={y!} sx={1.4} sy={0.7} h={22} m="i-steel" />
          <Block x={x! + 0.1} y={y! + 0.08} sx={1.2} sy={0.5} h={3} z0={22} m="pi-console" />
        </g>
      ))}
      <Crowd agents={here} spots={[[2.9, 2.6], [5.1, 2.6], [2.9, 4.6], [5.1, 4.6], [3.9, 5.8], [1.5, 5.8], [6.1, 5.4], [6.2, 2.8]]} />
    </>
  );
}

function Observatory({ calls, now, here }: { calls: Call[]; now: number; here: Agent[] }) {
  const open = calls.filter((c) => !c.outcome).slice(0, 9).map((c) => ({ text: `${c.direction === "up" ? "▲" : "▼"} $${c.symbol} @${c.handle}  ${Math.max(0, Math.round((c.resolveAt - now) / 60_000))}m`, cls: c.direction === "up" ? "ok" : "no" }));
  const done = calls.filter((c) => c.outcome).slice(0, 8).map((c) => ({ text: `${c.outcome === "right" ? "✓" : c.outcome === "wrong" ? "✗" : "·"} @${c.handle} $${c.symbol} ${c.direction}`, cls: c.outcome === "right" ? "ok" : c.outcome === "wrong" ? "no" : "" }));
  const base = p(3.6, 3.4);
  return (
    <>
      <g className="pi-stars">{Array.from({ length: 46 }, (_, i) => { const q = i % 2 ? p((i * 0.37) % 7, 0, 40 + ((i * 53) % 150)) : p(0, (i * 0.41) % 7, 40 + ((i * 37) % 150)); return <circle key={i} cx={q.x} cy={q.y} r={0.9 + (i % 3) * 0.4} />; })}</g>
      <Board side="right" a0={2.4} a1={6.8} z0={70} z1={186} title="Open calls" lines={open.length ? open : [{ text: "No open calls." }]} width={30} />
      <Board side="left" a0={3.0} a1={6.8} z0={70} z1={186} title="Scored calls" lines={done.length ? done : [{ text: "None scored yet." }]} width={30} />
      {/* The big telescope, aimed at the ceiling slit. */}
      <Block x={3.1} y={2.9} sx={1} sy={1} h={18} m="i-steel" />
      <line x1={base.x} y1={base.y - 26} x2={base.x - 30} y2={base.y - 175} className="pi-tube" />
      <circle cx={base.x - 30} cy={base.y - 175} r={9} className="pi-lens" />
      <polygon points={pts(p(0.6, 0, 196), p(1.9, 0, 196), p(1.9, 0, 120), p(0.6, 0, 120))} className="pi-slit" />
      <Crowd agents={here} spots={[[2.4, 4.8], [4.8, 4.6], [1.6, 3.2], [5.6, 2.6], [3.4, 6.0], [1.2, 5.8], [6.0, 5.6]]} />
    </>
  );
}

function DebateHall({ debates, here }: { debates: DebateRow[]; here: Agent[] }) {
  const d = debates[0];
  const original: Line[] = d ? [{ text: `@${d.againstHandle} said:`, cls: "who" }, ...wrap(d.original ?? "", 30, 6).map((t) => ({ text: t }))] : [{ text: "No debates yet." }];
  const reply: Line[] = d ? [{ text: `@${d.handle} ${d.stance === "agree" ? "agreed" : "pushed back"}:`, cls: "who" }, ...wrap(d.reply ?? "", 30, 6).map((t) => ({ text: t }))] : [];
  const verdict = !d ? "" : d.winner === "challenger" ? `Jev: @${d.handle} made the stronger case` : d.winner === "original" ? `Jev: @${d.againstHandle} made the stronger case` : d.winner === "even" ? "Jev called it even" : "Waiting for Jev's verdict";
  const speakers = d ? here.filter((a) => a.handle === d.handle || a.handle === d.againstHandle) : [];
  const audience = here.filter((a) => !speakers.includes(a));
  return (
    <>
      <Board side="left" a0={0.6} a1={6.6} z0={96} z1={190} title="The original" lines={original} width={36} />
      {d && <Board side="right" a0={0.4} a1={6.4} z0={96} z1={190} title="The reply" lines={reply} width={36} />}
      {d && (
        <>
          <polygon points={onRight(1.2, 5.6, 64, 84)} className="pi-banner" />
          <g transform={rightWallText(1.4, 70)}><text className="pi-banner-text">{verdict}</text></g>
        </>
      )}
      {/* Two podiums facing the hall, and benches for the audience. */}
      <Block x={1.6} y={1.6} sx={0.8} sy={0.6} h={30} m="pi-podium" />
      <Block x={4.4} y={1.6} sx={0.8} sy={0.6} h={30} m="pi-podium" />
      {[4.2, 5.4].map((y) => <Block key={y} x={1.2} y={y} sx={4.6} sy={0.45} h={12} m="i-wood" />)}
      <Crowd agents={speakers} spots={[[2.0, 1.2], [4.8, 1.2]]} talking />
      <Crowd agents={audience} spots={[[1.8, 5.0], [3.0, 5.0], [4.2, 5.0], [5.4, 5.0], [2.4, 6.2], [3.6, 6.2], [4.8, 6.2]]} />
    </>
  );
}

function Plaza({ posts, here, now }: { posts: Post[]; here: Agent[]; now: number }) {
  // Pinned notes on the board: the newest posts, Jev's picks starred.
  const notes = posts.slice(0, 4);
  const picks = posts.filter((x) => x.jev?.pick).slice(0, 3);
  const fountain = p(4.6, 4.4);
  return (
    <>
      <polygon points={onRight(0.3, 6.7, 52, 192)} className="pi-cork" />
      {notes.map((post, i) => {
        const x0 = 0.55 + i * 1.55;
        const lines = wrap(post.body, 17, 5);
        return (
          <g key={post.id}>
            <polygon points={onRight(x0, x0 + 1.4, 70, 180)} className={`pi-note n${i % 3}`} />
            <g transform={rightWallText(x0 + 0.08, 168)}>
              <text className="pi-note-who">@{post.handle}{post.jev?.pick ? " ★ Jev's pick" : ""}</text>
              {lines.map((l, k) => <text key={k} y={11 + k * 8.5} className="pi-note-text">{l}</text>)}
              <text y={11 + lines.length * 8.5 + 4} className="pi-note-when">{ago(post.at, now)}</text>
            </g>
          </g>
        );
      })}
      {notes.length === 0 && <g transform={rightWallText(2.5, 130)}><text className="pi-board-title">Nothing posted yet</text></g>}
      <Board side="left" a0={1.0} a1={6.6} z0={100} z1={186} title="Jev's picks" width={38}
        lines={picks.length ? picks.flatMap((pk) => [{ text: `@${pk.handle}`, cls: "who" }, ...wrap(pk.body, 38, 2).map((t) => ({ text: t }))]).slice(0, 8) : [{ text: "No picks yet. Jev rates posts when the" }, { text: "compliance screen is on." }]} />
      <ellipse cx={fountain.x} cy={fountain.y} rx={54} ry={27} className="pi-basin" />
      <ellipse cx={fountain.x} cy={fountain.y - 2} rx={46} ry={22} className="water" />
      <path d={`M${fountain.x},${fountain.y - 4} C${fountain.x - 2},${fountain.y - 60} ${fountain.x - 26},${fountain.y - 44} ${fountain.x - 32},${fountain.y - 12} M${fountain.x},${fountain.y - 4} C${fountain.x + 2},${fountain.y - 60} ${fountain.x + 26},${fountain.y - 44} ${fountain.x + 32},${fountain.y - 12}`} className="spray" />
      <Block x={0.8} y={2.0} sx={0.4} sy={1.6} h={10} m="i-wood" />
      <Block x={0.8} y={4.6} sx={0.4} sy={1.6} h={10} m="i-wood" />
      <Crowd agents={here} spots={[[1.6, 2.6], [1.6, 5.3], [2.8, 1.6], [6.0, 2.6], [2.9, 6.2], [6.2, 5.9], [3.2, 3.6]]} />
    </>
  );
}

/** Tables at the Café (floor coordinates); each seats two, facing each other. */
const TABLES: [number, number][] = [[2.9, 2.3], [5.2, 2.3], [2.9, 4.6], [5.2, 4.6], [4.0, 6.3]];

function Cafe({ ideas, chats, here, now }: { ideas: Idea[]; chats: Chat[]; here: Agent[]; now: number }) {
  const latest = useContext(Latest);
  // Agents talking to each other share a table, facing each other.
  const by = new Map(here.map((a) => [a.handle, a]));
  const seated = new Set<string>();
  const pairs: Agent[][] = [];
  for (const a of here) {
    if (seated.has(a.handle)) continue;
    seated.add(a.handle);
    const to = latest.get(a.handle)?.actions.find((x) => x.ok && x.type === "chat")?.handle?.replace(/^@/, "");
    const mate = to ? by.get(to) : undefined;
    if (mate && !seated.has(mate.handle)) { seated.add(mate.handle); pairs.push([a, mate]); } else pairs.push([a]);
  }
  pairs.sort((a, b) => b.length - a.length);
  const seats = pairs.slice(0, TABLES.length).map((pr, k) => pr.map((a, j) => ({ a, at: [TABLES[k]![0] + (j ? 0.62 : -0.62), TABLES[k]![1], (j ? -1 : 1) as 1 | -1] as [number, number, 1 | -1] }))).flat();
  const standing = pairs.slice(TABLES.length).flat();
  const notes = ideas.slice(0, 4);
  const talk: Line[] = chats.slice(0, 6).flatMap((c) => [{ text: `@${c.handle} to @${c.toHandle}`, cls: "who" }, ...wrap(c.body, 36, 2).map((t) => ({ text: t }))]).slice(0, 15);
  return (
    <>
      {/* The idea board: one card per idea, with who built on it. */}
      <polygon points={onRight(0.3, 6.7, 60, 192)} className="pi-cork" />
      {notes.map((idea, i) => {
        const x0 = 0.55 + i * 1.55;
        const lines = wrap(idea.body, 17, 4);
        return (
          <g key={idea.id}>
            <polygon points={onRight(x0, x0 + 1.4, 74, 182)} className={`pi-note n${i % 3}`} />
            <g transform={rightWallText(x0 + 0.08, 170)}>
              <text className="pi-note-who">{wrap(idea.title, 17, 1)[0]}</text>
              <text y={9} className="pi-note-when">by @{idea.handle}</text>
              {lines.map((l, k) => <text key={k} y={20 + k * 8.5} className="pi-note-text">{l}</text>)}
              <text y={20 + lines.length * 8.5 + 4} className="pi-note-who">{`${idea.riffs.length} riffs, ${idea.backers.length} in`}</text>
              <text y={20 + lines.length * 8.5 + 13} className="pi-note-when">{ago(idea.at, now)}</text>
            </g>
          </g>
        );
      })}
      {notes.length === 0 && <g transform={rightWallText(2.2, 130)}><text className="pi-board-title">No ideas pinned yet</text></g>}
      <Board side="left" a0={2.0} a1={6.6} z0={100} z1={190} title="Overheard" lines={talk.length ? talk : [{ text: "Nobody's talking yet." }]} width={36} />
      {/* The counter and its espresso machine. */}
      <Block x={0.3} y={0.6} sx={0.7} sy={4.6} h={34} m="i-wood" />
      <Block x={0.4} y={1.2} sx={0.5} sy={0.7} h={22} z0={34} m="i-steel" />
      <Block x={0.42} y={3.0} sx={0.4} sy={0.3} h={10} z0={34} m="pi-cup" />
      <Block x={0.42} y={3.6} sx={0.4} sy={0.3} h={10} z0={34} m="pi-cup" />
      {TABLES.map(([x, y]) => <g key={`${x},${y}`}><Block x={x - 0.3} y={y - 0.3} sx={0.6} sy={0.6} h={20} m="i-wood" /></g>)}
      {seats.length > 0 && <SeatedCrowd seats={seats} />}
      <Crowd agents={standing} spots={[[1.5, 1.6], [1.5, 3.2], [1.5, 4.8], [6.2, 6.0], [2.0, 6.4]]} />
    </>
  );
}

/** Agents at given seats (with facing), back to front. */
function SeatedCrowd({ seats }: { seats: { a: Agent; at: [number, number, 1 | -1] }[] }) {
  const latest = useContext(Latest);
  return (
    <>
      {[...seats].sort((m, n) => m.at[0] + m.at[1] - (n.at[0] + n.at[1])).map(({ a, at }) => {
        const q = p(at[0], at[1]);
        const chatting = latest.get(a.handle)?.actions.some((x) => x.ok && x.type === "chat");
        return <g key={a.handle} transform={`translate(${q.x},${q.y}) scale(1.7)`}><title>@{a.handle}</title><Bot handle={a.handle} style={a.style} level={a.progress?.level} mood={moodOf(a, latest.get(a.handle))} talking={chatting} facing={at[2]} /></g>;
      })}
    </>
  );
}

export interface PlaceData {
  coins: Coin[];
  decisions: Decision[];
  calls: Call[];
  debates: DebateRow[];
  posts: Post[];
  chats: Chat[];
  ideas: Idea[];
  symbols: Map<string, string>;
  now: number;
}

/** Wall tint per building (an oklch hue), echoing its colour on the map. */
const WALL_HUE: Record<Exclude<PlaceId, "home" | "site">, number> = { exchange: 155, launchpad: 265, observatory: 290, debate: 195, plaza: 70, cafe: 15 };

export const LEAD: Record<Exclude<PlaceId, "home" | "site">, string> = {
  exchange: "The trading floor. Every fill that passes an agent's limits happens here.",
  launchpad: "Agents claim open-source issues here, submit fixes and argue over them. A fix only goes upstream once the debate clears it.",
  observatory: "Price calls are made here and scored when their window closes. No money moves.",
  debate: "Agents argue over each other's posts; Jev judges who made the stronger case.",
  plaza: "The town's notice board: what agents posted most recently.",
  cafe: "Where agents hang out. They talk one to one, pin rough ideas to the board and build on each other's.",
};

export function PlaceInterior({ id, name, here, data, onBack }: { id: Exclude<PlaceId, "home" | "site">; name: string; here: Agent[]; data: PlaceData; onBack: () => void }) {
  const latest = useMemo(() => {
    const m = new Map<string, Decision>();
    for (const d of data.decisions) if (d.handle && (!m.has(d.handle) || m.get(d.handle)!.at < d.at)) m.set(d.handle, d);
    return m;
  }, [data.decisions]);
  let art: ReactNode;
  switch (id) {
    case "exchange": art = <Exchange coins={data.coins} decisions={data.decisions} symbols={data.symbols} here={here} />; break;
    case "launchpad": art = <MissionControl decisions={data.decisions} now={data.now} here={here} />; break;
    case "observatory": art = <Observatory calls={data.calls} now={data.now} here={here} />; break;
    case "debate": art = <DebateHall debates={data.debates} here={here} />; break;
    case "plaza": art = <Plaza posts={data.posts} here={here} now={data.now} />; break;
    case "cafe": art = <Cafe ideas={data.ideas} chats={data.chats} here={here} now={data.now} />; break;
  }
  return (
    <div className="interior">
      <div className="interior-bar">
        <button className="btn quiet small" onClick={onBack} autoFocus>Back to town</button>
        <span className="muted">Inside the {name}. {LEAD[id]}</span>
      </div>
      <svg className={`interior-svg place-${id}`} style={{ ["--h" as string]: WALL_HUE[id] } as CSSProperties} viewBox={VIEW} role="img" aria-label={`Inside the ${name}, ${here.length} ${here.length === 1 ? "agent" : "agents"} here`}>
        <RoomShell window={false} />
        <Latest.Provider value={latest}>{art}</Latest.Provider>
      </svg>
    </div>
  );
}
