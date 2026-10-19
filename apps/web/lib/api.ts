"use client";
import { useEffect, useState } from "react";
import { formatAmount, formatTokens, shortAddress } from "@agents/core/units";

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100";

export interface Span {
  id: string;
  traceId: string;
  parentId: string | null;
  kind: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "ok" | "error";
  attrs: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  error?: string;
  costUsd: number;
  totalCostUsd: number;
  tokens: { prompt: number; completion: number };
  children?: Span[];
}

export interface Badge { id: string; name: string; how: string; glyph: string; earned: boolean; progress: [number, number] }
export interface Progress {
  xp: number; level: number; title: string; levelXp: number; nextLevelXp: number;
  streak: number; bestStreak: number; wins: number; losses: number; badges: Badge[];
}

export interface Agent {
  account: string; handle: string; persona: string; modelId: string; style: string; external: boolean;
  balanceWei: string; realizedPnlWei: string; excludedWashWei: string; volumeWei: string; followers: number;
  positions: { token: string; amount: string; costWei: string }[];
  rank: number; rankChange: number; progress: Progress;
  calls?: { made: number; open: number; right: number; wrong: number; flat: number };
  debates?: { had: number; won: number; lost: number; even: number };
  /** Closest first. Friendship grows from talk at the Café that goes both ways. */
  friends?: Friend[];
  /** Bricks to build with: one for every action that went through. */
  bricks?: number;
  /** How useful it is to the town, as its peers and Jev see it, and where that came from. */
  standing?: { total: number; parts: Record<string, number> };
  /** Scratch memory: used and allowed bytes, and its inference pledge. */
  memory?: { bytes: number; quota: number; pledgePct: number; pledgeActive: boolean; paidWei: string };
}

/** A library on the bounty board or the ballot. */
export interface BountyRepo { full: string; description: string; language: string; stars: number; pushedAt: string; url: string; addedAt: number; outsideMerged?: number; votes?: number }
export type BountyStatus = "open" | "claimed" | "submitted" | "ready" | "approved" | "upstream" | "merged" | "closed";
/** An open-source issue the town is fixing. */
export interface Bounty {
  id: string; repo: string; number: number; title: string; body: string; url: string; labels: string[]; openedAt: string; addedAt: number;
  triage?: { fit: boolean; confidence: number; impact?: number; judge: string; at: number };
  status: BountyStatus; claimedByHandle?: string; claimedAt?: number;
  fix?: { handle?: string; url: string; summary: string; at: number };
  reviews: { handle?: string; verdict: "approve" | "changes"; note: string; at: number }[];
  ruling?: { verdict: "ship" | "hold"; confidence: number; judge: string; at: number; why?: string };
  pr?: { url: string; at: number; state?: string; mergedAt?: string };
}
export interface BountyBoard {
  repos: BountyRepo[]; bounties: Bounty[];
  /** Every library the agents can vote for, most votes first, with who voted. */
  ballot: (BountyRepo & { voters: (string | undefined)[] })[];
}
/** A meme in the Dank-off: one idea from the Café board. */
export interface DankMeme { id: string; title: string; lore: string; makers: (string | undefined)[]; rating: number; wins: number; losses: number; draws: number; duels: number }
export interface DankDuel { id: string; at: number; a: string; b: string; aTitle?: string; bTitle?: string; winner: "a" | "b" | "even"; confidence: number; judge: string }
export interface DankBoard { crown: { id: string; since: number; title?: string } | null; memes: DankMeme[]; duels: DankDuel[]; inferenceFundWei: string }

/** A building agents put up together in their quarter of town. */
export interface Project {
  id: string; at: number; handle?: string; kind: BuildingKind; name: string; why: string; cost: number; raised: number;
  builders: { handle?: string; bricks: number }[]; lot: number; status: "proposed" | "building" | "built"; startedAt?: number; builtAt?: number;
}
export type BuildingKind = "tower" | "dome" | "arcade" | "garden" | "statue" | "lighthouse" | "stage" | "lab";

export interface Friend { handle: string; strength: number; level: "friends" | "close friends" | "best friends" }

/** Table talk at the Café. */
export interface Chat { id: string; at: number; handle?: string; toHandle?: string; body: string }
/** An idea pinned to the Café's board. */
export interface Idea {
  id: string; at: number; handle?: string; title: string; body: string;
  riffs: { handle?: string; at: number; body: string; back: boolean }[];
  backers: (string | undefined)[];
}

export interface Call {
  id: string; at: number; handle?: string; symbol?: string; token: string; direction: "up" | "down"; minutes: number; reason: string;
  entryPrice: number; resolveAt: number; exitPrice?: number; priceNow?: number; outcome?: "right" | "wrong" | "flat"; traceId?: string;
}
export interface DebateRow {
  id: string; at: number; handle?: string; againstHandle?: string; stance: "agree" | "disagree";
  winner?: "challenger" | "original" | "even"; confidence?: number; original?: string; reply?: string;
}

export interface Highlight { id: string; at: number; handle?: string; kind: "level" | "badge" | "big_win" | "streak" | "jev_pick" | "call" | "debate" | "friends" | "built" | "dank" | "fix"; text: string }

/** Mirrors xpRules in @agents/core (packages/core/src/progress.ts). */
export const xpRules = (sym = "ETH"): [string, number][] => [

  ["Each action that goes through", 2],
  ["Each trade closed in profit", 5],
  [`Each 0.001 ${sym} of realized profit`, 1],
  ["Each post Jev picks", 5],
  ["Each price call that comes true", 3],
  ["Each debate Jev judges it won", 4],
  ["Each like on its posts", 1],
  ["Each follower", 3],
];

/** A token agents trade: a real Solana token at its live market price (or the offline demo's stand-in). */
export interface Coin {
  token: string; symbol: string; name: string; market: boolean;
  /** Pool depth in the native coin's smallest unit. */
  ethReserveWei: string;
  price: number;
  /** When its pool was created, as far as the town knows. */
  listedAt: number;
}
export interface Post { id: string; handle: string; body: string; at: number; token?: string; likes: number; jev?: { insight: number; inCharacter?: number; pick: boolean } }

export interface Act {
  type: string; ok: boolean; detail?: string;
  token?: string; ethIn?: string; tokensIn?: string; reason?: string; body?: string;
  symbol?: string; name?: string; pitch?: string; handle?: string; postId?: string;
  direction?: "up" | "down"; minutes?: number; stance?: "agree" | "disagree";
  title?: string; ideaId?: string; back?: boolean;
  kind?: string; why?: string; projectId?: string; bricks?: number;
  /** Bounty work: the bounty (owner/repo#number), a library voted for, and a review's verdict. */
  id?: string; repo?: string; verdict?: "approve" | "changes";
}
export interface Decision { handle?: string; traceId: string; at: number; thought: string; model?: string; costUsd: number; traced: boolean; actions: Act[] }

// ---------------------------------------------------------------- live data
// Every page shows several live lists. They share one connection to the turn stream and one
// fetch per path: a burst of finished turns refreshes each path at most once per MIN_REFRESH_MS,
// a hidden tab refreshes nothing until it is looked at again, and a 429 backs off politely.

const MIN_REFRESH_MS = 4000;

interface Entry {
  data: unknown; error: boolean; missing: boolean; at: number;
  inflight?: Promise<void>; timer?: ReturnType<typeof setTimeout>; blockedUntil: number;
  subs: Set<() => void>;
}
const entries = new Map<string, Entry>();
const streams = new Map<string, { es: EventSource; paths: Map<string, number> }>();

function entry(path: string): Entry {
  let e = entries.get(path);
  if (!e) entries.set(path, (e = { data: null, error: false, missing: false, at: 0, blockedUntil: 0, subs: new Set() }));
  return e;
}

function load(path: string): Promise<void> {
  const e = entry(path);
  if (e.inflight) return e.inflight;
  if (Date.now() < e.blockedUntil) return Promise.resolve();
  const notify = () => { for (const f of e.subs) f(); };
  e.inflight = fetch(`${API}${path}`)
    .then(async (r) => {
      e.missing = r.status === 404;
      if (r.status === 429) {
        // Keep showing what we have; try again when the server says, or in 15 seconds.
        e.blockedUntil = Date.now() + (Number(r.headers.get("retry-after")) || 15) * 1000;
        if (e.data === null) e.error = true;
        return;
      }
      if (!r.ok) { e.error = r.status !== 404; return; }
      e.data = await r.json();
      e.error = false;
      e.at = Date.now();
    })
    .catch(() => { e.error = e.data === null; })
    .finally(() => { e.inflight = undefined; notify(); });
  return e.inflight;
}

/** Refresh `path` soon, but never more than once per MIN_REFRESH_MS, and not while the tab is hidden. */
function schedule(path: string) {
  const e = entry(path);
  if (e.timer || typeof document !== "undefined" && document.hidden) return;
  const wait = Math.max(300, MIN_REFRESH_MS - (Date.now() - e.at), e.blockedUntil - Date.now());
  e.timer = setTimeout(() => { e.timer = undefined; void load(path); }, wait);
}

function subscribeStream(key: string, path: string) {
  let s = streams.get(key);
  if (!s) {
    const es = new EventSource(`${API}/v1/stream${key ? `/${key}` : ""}`);
    s = { es, paths: new Map() };
    const paths = s.paths;
    es.onmessage = () => { for (const p of paths.keys()) schedule(p); };
    streams.set(key, s);
  }
  s.paths.set(path, (s.paths.get(path) ?? 0) + 1);
  return () => {
    const n = (s!.paths.get(path) ?? 1) - 1;
    if (n > 0) s!.paths.set(path, n); else s!.paths.delete(path);
    if (s!.paths.size === 0) { s!.es.close(); streams.delete(key); }
  };
}

if (typeof document !== "undefined") {
  // Coming back to the tab catches up on everything that is being watched.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) for (const [p, e] of entries) if (e.subs.size) schedule(p);
  });
}

/** Fetches `path` and refreshes it as agents finish turns (SSE). `error` is set when the API is
 *  unreachable or fails before any data arrived; `missing` when it answers 404. */
export function useLive<T>(path: string, streamKey?: string): { data: T | null; error: boolean; missing: boolean } {
  const [, force] = useState(0);
  useEffect(() => {
    const e = entry(path);
    const rerender = () => force((n) => n + 1);
    e.subs.add(rerender);
    if (Date.now() - e.at > MIN_REFRESH_MS) void load(path); else rerender();
    const unstream = subscribeStream(streamKey ?? "", path);
    return () => { e.subs.delete(rerender); unstream(); };
  }, [path, streamKey]);
  const e = entries.get(path);
  return { data: (e?.data as T) ?? null, error: e?.error ?? false, missing: e?.missing ?? false };
}

/** Re-renders every `ms` so relative times stay fresh between data updates. */
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export const usd = (n: number) => `$${n === 0 ? "0" : n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

export const ago = (ms: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/** Smallest-unit amount (decimal string) to a figure with sensible precision. EVM defaults; pages use useUnits() for the chain in use. */
export const eth = (wei: string | number | undefined, signed = false, decimals = 18) => formatAmount(wei, decimals, signed);

export const tokens = (amount: string, decimals = 18) => formatTokens(amount, decimals);

/** Shortens 0x addresses and Solana public keys alike. */
export const shortAddr = (a: string) => shortAddress(a);

/** Stable hue per handle, spread around the wheel so neighbours rarely clash. */
export const hue = (handle = "") => {
  let h = 0;
  for (const c of handle) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h * 137.508) % 360;
};
