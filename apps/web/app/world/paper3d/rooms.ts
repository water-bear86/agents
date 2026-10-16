// Room specs: what goes in each paper room, built from the same live data as the flat interiors.
// Positions use the flat interiors' floor grid (0-7 each way) and pixel heights, so both views
// furnish a room the same way.

import { ago, hue, type Agent, type Call, type Chat, type Coin, type DebateRow, type Decision, type Idea, type Post } from "../../../lib/api";
import { moodOf } from "../../../lib/sprite";
import { houseTier, type PlaceId } from "../../../lib/world";
import type { BoardLine, Prop, RoomSpec } from "./room";

const WOOD = 0xc19468, STEEL = 0x8d96a3, SCREEN = 0x1b2230;
const bot = (a: Agent, last?: Decision, talking = false) => ({ handle: a.handle, style: a.style, level: a.progress?.level, mood: moodOf(a, last), talking });
const latestBy = (decisions: Decision[]) => {
  const m = new Map<string, Decision>();
  for (const d of decisions) if (d.handle && (!m.has(d.handle) || m.get(d.handle)!.at < d.at)) m.set(d.handle, d);
  return m;
};
const wrapWords = (s: string, n: number, max: number) => {
  const out: string[] = [];
  let cur = "";
  for (const w of s.split(/\s+/)) {
    if ((cur + " " + w).trim().length > n) { out.push(cur.trim()); cur = w; } else cur += ` ${w}`;
    if (out.length === max) break;
  }
  if (out.length < max && cur.trim()) out.push(cur.trim());
  return out;
};
/** Agents at given floor spots, back to front. */
const crowd = (here: Agent[], spots: [number, number][], latest: Map<string, Decision>, talking = false) =>
  here.slice(0, spots.length).map((a, i) => ({ handle: a.handle, x: spots[i]![0], y: spots[i]![1], bot: bot(a, latest.get(a.handle), talking) }));

// ---------------------------------------------------------------- houses

export function houseSpec(a: Agent, home: boolean, where: string, last: Decision | undefined, symbols: Map<string, string>): RoomSpec {
  const t = houseTier(a.progress?.level);
  const earned = (a.progress?.badges ?? []).filter((b) => b.earned).slice(0, 10);
  const thought = last?.thought && !/^turn \d+$/.test(last.thought) ? last.thought : "";
  const acts: BoardLine[] = (last?.actions ?? []).slice(0, 3).map((x) => ({ text: `${x.ok ? "✓" : "✗"} ${x.type}${x.token && symbols.get(x.token) ? ` $${symbols.get(x.token)}` : x.symbol ? ` $${x.symbol}` : ""}`, tone: x.ok ? "ok" : "no" }));
  const props: Prop[] = [
    // Desk, rug, lamp, plant; a sofa from two storeys up; a telescope if it makes price calls.
    { k: "box", x: 0.8, y: 0.15, sx: 3, sy: 1.05, h: 38, color: WOOD },
    { k: "box", x: 1.9, y: 2.9, sx: 3.7, sy: 3.3, h: 1, color: 0xd9c7a6 },
    { k: "lamp", x: 6.37, y: 0.52 },
    { k: "plant", x: 0.6, y: 6.35 },
    // Trophy shelves on the left wall.
    { k: "box", x: 0.02, y: 0.5, sx: 0.4, sy: 4.5, h: 3, z0: 134, color: WOOD },
    { k: "box", x: 0.02, y: 0.5, sx: 0.4, sy: 4.5, h: 3, z0: 88, color: WOOD },
    // Coin cabinet with what it holds on top, and the charging dock.
    { k: "box", x: 5.5, y: 2.9, sx: 1.2, sy: 1.6, h: 30, color: WOOD },
    { k: "cyl", x: 3.6, y: 4.4, r: 0.85, h: 4, color: 0x56627a },
    { k: "cyl", x: 3.6, y: 4.4, r: 0.6, h: 5, color: 0x4b63f2, glow: true },
  ];
  if (t.tier >= 2) props.push({ k: "box", x: 0.25, y: 3.2, sx: 0.9, sy: 2.2, h: 18, color: 0x8f6fb8 }, { k: "box", x: 0.25, y: 3.2, sx: 0.3, sy: 2.2, h: 34, color: 0x8f6fb8 });
  if ((a.calls?.made ?? 0) > 0) props.push({ k: "telescope", x: 5.3, y: 1.5, color: 0x6b4fd8 });
  earned.forEach((_, i) => props.push({ k: "trophy", x: 0.22, y: 1.0 + (i % 5) * 0.95, z0: i < 5 ? 137 : 91 }));
  a.positions.slice(0, 6).forEach((h, i) => props.push({ k: "coin", x: 5.75 + (i % 2) * 0.6, y: 3.2 + Math.floor(i / 2) * 0.5, z0: 30, label: symbols.get(h.token) ?? "?" }));
  (a.friends ?? []).slice(0, 4).forEach((f, i) => props.push({ k: "photo", wall: "right", a: 1.4 + i * 0.75, z: 168, best: f.level === "best friends", bot: { handle: f.handle, mood: "happy" }, label: f.handle }));
  return {
    wallHue: hue(a.handle), floor: "wood", window: true,
    boards: [
      { wall: "right", a0: 1.05, a1: 3.55, z0: 46, z1: 104, style: "dark", title: "Last turn", lines: [...wrapWords(thought || "No thoughts written down yet.", 34, 3).map((text) => ({ text })), ...acts] },
      { wall: "left", a0: 5.3, a1: 6.7, z0: 118, z1: 160, style: "plaque", title: `Level ${a.progress?.level ?? 1}`, lines: [{ text: a.progress?.title ?? "Rookie" }, { text: `Rank #${a.rank}` }] },
    ],
    props,
    agents: home ? [{ handle: a.handle, x: 3.6, y: 4.4, bot: bot(a, last), scale: 1.6 }] : [],
    away: home ? undefined : { x: 3.6, y: 4.6, text: `Out: ${where.length > 26 ? `${where.slice(0, 25)}…` : where}` },
  };
}

// ---------------------------------------------------------------- the town's buildings

export interface PlaceData3D {
  coins: Coin[]; decisions: Decision[]; calls: Call[]; debates: DebateRow[]; posts: Post[]; chats: Chat[]; ideas: Idea[];
  symbols: Map<string, string>; now: number; native: (wei: string) => string; sym: string;
}

const WALL_HUE: Record<string, number> = { exchange: 155, launchpad: 265, observatory: 290, debate: 195, plaza: 70, cafe: 15 };

export function placeSpec(id: Exclude<PlaceId, "home" | "site">, here: Agent[], d: PlaceData3D): RoomSpec {
  const latest = latestBy(d.decisions);
  const base = { wallHue: WALL_HUE[id] ?? 200, floor: "tile" as const, boards: [] as RoomSpec["boards"], props: [] as Prop[], agents: [] as RoomSpec["agents"] };
  switch (id) {
    case "exchange": {
      const board: BoardLine[] = [...d.coins].sort((a, b) => b.launchedAt - a.launchedAt).slice(0, 10)
        .map((c) => ({ text: `$${c.symbol.padEnd(8)} ${Number.isFinite(c.price) ? c.price.toExponential(2) : "-"}   ${d.native(c.ethReserveWei)} ${d.sym} in pool   ${c.market ? "mainnet" : c.opened ? "open" : "agents only"}`, tone: c.opened ? "ok" : undefined }));
      const fills: BoardLine[] = [];
      for (const dec of d.decisions) for (const x of dec.actions) if (x.ok && (x.type === "buy" || x.type === "sell") && fills.length < 9) {
        fills.push({ text: `@${dec.handle} ${x.type === "buy" ? "bought" : "sold"} ${x.token && d.symbols.get(x.token) ? `$${d.symbols.get(x.token)}` : "a coin"}`, tone: x.type === "buy" ? "ok" : "no" });
      }
      base.boards.push(
        { wall: "right", a0: 0.3, a1: 6.7, z0: 66, z1: 190, style: "dark", title: "Order board", lines: board.length ? board : [{ text: "No coins yet. The first launch lists here." }] },
        { wall: "left", a0: 0.4, a1: 6.6, z0: 104, z1: 190, style: "dark", title: "Latest fills", lines: fills.length ? fills : [{ text: "No trades yet." }] },
      );
      for (const [x, y] of [[1.4, 2.2], [3.9, 2.2], [1.4, 4.2], [3.9, 4.2]] as const) base.props.push({ k: "box", x, y, sx: 1.6, sy: 0.6, h: 24, color: WOOD }, { k: "box", x: x + 0.2, y: y + 0.1, sx: 1.2, sy: 0.08, h: 14, z0: 24, color: SCREEN, glow: true });
      base.agents = crowd(here, [[2.2, 3.1], [4.7, 3.1], [2.2, 5.1], [4.7, 5.1], [3.4, 6.1], [1.1, 6.2], [5.9, 6.1], [6.1, 1.6]], latest);
      return base;
    }
    case "launchpad": {
      const rows: BoardLine[] = [...d.coins].filter((c) => !c.market).sort((a, b) => b.launchedAt - a.launchedAt).slice(0, 10)
        .map((c) => ({ text: `$${c.symbol.padEnd(8)} by @${c.launcherHandle ?? "?"}   ${ago(c.launchedAt, d.now)}   ${c.opened ? "open to everyone" : "agents only"}`, tone: c.opened ? "ok" : undefined }));
      base.boards.push({ wall: "right", a0: 0.3, a1: 6.7, z0: 66, z1: 190, style: "dark", title: "Launches", lines: rows.length ? rows : [{ text: "Nothing launched yet." }] });
      base.props.push({ k: "rocket", x: 0.9, y: 2.1, color: 0x4b63f2 });
      for (const [x, y] of [[2.2, 1.6], [4.4, 1.6], [2.2, 3.6], [4.4, 3.6]] as const) base.props.push({ k: "box", x, y, sx: 1.4, sy: 0.7, h: 22, color: STEEL }, { k: "box", x: x + 0.1, y: y + 0.08, sx: 1.2, sy: 0.5, h: 3, z0: 22, color: 0x4b63f2, glow: true });
      base.agents = crowd(here, [[2.9, 2.6], [5.1, 2.6], [2.9, 4.6], [5.1, 4.6], [3.9, 5.8], [1.5, 5.8], [6.1, 5.4], [6.2, 2.8]], latest);
      return base;
    }
    case "observatory": {
      const open: BoardLine[] = d.calls.filter((c) => !c.outcome).slice(0, 9).map((c) => ({ text: `${c.direction === "up" ? "▲" : "▼"} $${c.symbol} @${c.handle}  ${Math.max(0, Math.round((c.resolveAt - d.now) / 60_000))}m`, tone: c.direction === "up" ? "ok" : "no" }));
      const done: BoardLine[] = d.calls.filter((c) => c.outcome).slice(0, 8).map((c) => ({ text: `${c.outcome === "right" ? "✓" : c.outcome === "wrong" ? "✗" : "="} @${c.handle} $${c.symbol} ${c.direction}`, tone: c.outcome === "right" ? "ok" : c.outcome === "wrong" ? "no" : undefined }));
      return {
        ...base, floor: "dark", starry: true,
        boards: [
          { wall: "right", a0: 2.4, a1: 6.8, z0: 70, z1: 186, style: "dark", title: "Open calls", lines: open.length ? open : [{ text: "No open calls." }] },
          { wall: "left", a0: 3.0, a1: 6.8, z0: 70, z1: 186, style: "dark", title: "Scored calls", lines: done.length ? done : [{ text: "None scored yet." }] },
        ],
        props: [{ k: "telescope", x: 3.6, y: 3.4, color: 0x8064dd, big: true }],
        agents: crowd(here, [[2.4, 4.8], [4.8, 4.6], [1.6, 3.2], [5.6, 2.6], [3.4, 6.0], [1.2, 5.8], [6.0, 5.6]], latest),
      };
    }
    case "debate": {
      const db = d.debates[0];
      const original: BoardLine[] = db ? [{ text: `@${db.againstHandle} said:`, tone: "who" }, ...wrapWords(db.original ?? "", 44, 6).map((text) => ({ text }))] : [{ text: "No debates yet." }];
      const reply: BoardLine[] = db ? [{ text: `@${db.handle} ${db.stance === "agree" ? "agreed" : "pushed back"}:`, tone: "who" }, ...wrapWords(db.reply ?? "", 44, 6).map((text) => ({ text }))] : [];
      const verdict = !db ? "" : db.winner === "challenger" ? `Jev: @${db.handle} made the stronger case` : db.winner === "original" ? `Jev: @${db.againstHandle} made the stronger case` : db.winner === "even" ? "Jev called it even" : "Waiting for Jev's verdict";
      const speakers = db ? here.filter((a) => a.handle === db.handle || a.handle === db.againstHandle) : [];
      base.boards.push({ wall: "left", a0: 0.6, a1: 6.6, z0: 96, z1: 190, style: "dark", title: "The original", lines: original });
      if (db) base.boards.push({ wall: "right", a0: 0.4, a1: 6.4, z0: 96, z1: 190, style: "dark", title: "The reply", lines: reply }, { wall: "right", a0: 1.2, a1: 5.6, z0: 64, z1: 86, style: "banner", title: verdict });
      base.props.push({ k: "box", x: 1.6, y: 1.6, sx: 0.8, sy: 0.6, h: 30, color: 0x22a2a2 }, { k: "box", x: 4.4, y: 1.6, sx: 0.8, sy: 0.6, h: 30, color: 0x22a2a2 });
      for (const y of [4.2, 5.4]) base.props.push({ k: "box", x: 1.2, y, sx: 4.6, sy: 0.45, h: 12, color: WOOD });
      base.agents = [...crowd(speakers, [[2.0, 1.2], [4.8, 1.2]], latest, true), ...crowd(here.filter((a) => !speakers.includes(a)), [[1.8, 5.0], [3.0, 5.0], [4.2, 5.0], [5.4, 5.0], [2.4, 6.2], [3.6, 6.2], [4.8, 6.2]], latest)];
      return base;
    }
    case "plaza": {
      const picks = d.posts.filter((x) => x.jev?.pick).slice(0, 3);
      base.boards.push(
        { wall: "right", a0: 0.3, a1: 6.7, z0: 52, z1: 192, style: "cork", title: "Nothing posted yet", cards: d.posts.slice(0, 4).map((post) => ({ title: `@${post.handle}${post.jev?.pick ? " ★" : ""}`, body: post.body, foot: ago(post.at, d.now) })) },
        { wall: "left", a0: 1.0, a1: 6.6, z0: 100, z1: 186, style: "dark", title: "Jev's picks", lines: picks.length ? picks.flatMap((pk) => [{ text: `@${pk.handle}`, tone: "who" as const }, ...wrapWords(pk.body, 48, 2).map((text) => ({ text }))]).slice(0, 8) : [{ text: "No picks yet." }] },
      );
      base.props.push({ k: "fountain", x: 4.6, y: 4.4 }, { k: "box", x: 0.8, y: 2.0, sx: 0.4, sy: 1.6, h: 10, color: WOOD }, { k: "box", x: 0.8, y: 4.6, sx: 0.4, sy: 1.6, h: 10, color: WOOD });
      base.agents = crowd(here, [[1.6, 2.6], [1.6, 5.3], [2.8, 1.6], [6.0, 2.6], [2.9, 6.2], [6.2, 5.9], [3.2, 3.6]], latest);
      return base;
    }
    case "cafe": {
      const TABLES: [number, number][] = [[2.9, 2.3], [5.2, 2.3], [2.9, 4.6], [5.2, 4.6], [4.0, 6.3]];
      // Agents talking to each other share a table.
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
      pairs.sort((x, y) => y.length - x.length);
      const agents: RoomSpec["agents"] = [];
      pairs.slice(0, TABLES.length).forEach((pr, k) => pr.forEach((a, j) => agents.push({ handle: a.handle, x: TABLES[k]![0] + (j ? 0.62 : -0.62), y: TABLES[k]![1], bot: bot(a, latest.get(a.handle), pr.length > 1) })));
      agents.push(...crowd(pairs.slice(TABLES.length).flat(), [[1.5, 1.6], [1.5, 3.2], [1.5, 4.8], [6.2, 6.0], [2.0, 6.4]], latest));
      const talk: BoardLine[] = d.chats.slice(0, 6).flatMap((c) => [{ text: `@${c.handle} to @${c.toHandle}`, tone: "who" as const }, ...wrapWords(c.body, 48, 2).map((text) => ({ text }))]).slice(0, 14);
      return {
        ...base, floor: "wood",
        boards: [
          { wall: "right", a0: 0.3, a1: 6.7, z0: 60, z1: 192, style: "cork", title: "No ideas pinned yet", cards: d.ideas.slice(0, 4).map((i) => ({ title: i.title, sub: `by @${i.handle}`, body: i.body, foot: i.launchedSymbol ? `Launched: $${i.launchedSymbol}` : `${i.riffs.length} riffs, ${i.backers.length} in` })) },
          { wall: "left", a0: 2.0, a1: 6.6, z0: 100, z1: 190, style: "dark", title: "Overheard", lines: talk.length ? talk : [{ text: "Nobody's talking yet." }] },
        ],
        props: [
          { k: "box", x: 0.3, y: 0.6, sx: 0.7, sy: 4.6, h: 34, color: WOOD },
          { k: "box", x: 0.4, y: 1.2, sx: 0.5, sy: 0.7, h: 22, z0: 34, color: STEEL },
          { k: "lamp", x: 0.65, y: 1.5 },
          { k: "lamp", x: 0.65, y: 4.6 },
          ...TABLES.flatMap(([x, y]): Prop[] => [{ k: "cyl", x, y, r: 0.05, h: 18, color: STEEL }, { k: "cyl", x, y, r: 0.42, h: 2, z0: 18, color: WOOD }]),
        ],
        agents,
      };
    }
  }
}
