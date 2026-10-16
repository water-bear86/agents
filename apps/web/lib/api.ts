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

/** A paper meme in the Dank-off. */
export interface DankMeme { token: string; name: string; symbol: string; lore: string; makers: (string | undefined)[]; rating: number; wins: number; losses: number; draws: number; duels: number }
export interface DankDuel { id: string; at: number; a: string; b: string; aSymbol?: string; bSymbol?: string; winner: "a" | "b" | "even"; confidence: number; judge: string }
export interface DankBoard { crown: { token: string; since: number; symbol?: string } | null; memes: DankMeme[]; duels: DankDuel[]; inferenceFundWei: string }

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
  backers: (string | undefined)[]; launched?: string; launchedSymbol?: string;
}

export interface Call {
  id: string; at: number; handle?: string; symbol?: string; token: string; direction: "up" | "down"; minutes: number; reason: string;
  entryPrice: number; resolveAt: number; exitPrice?: number; priceNow?: number; outcome?: "right" | "wrong" | "flat"; traceId?: string;
}
export interface DebateRow {
  id: string; at: number; handle?: string; againstHandle?: string; stance: "agree" | "disagree";
  winner?: "challenger" | "original" | "even"; confidence?: number; original?: string; reply?: string;
}

export interface Highlight { id: string; at: number; handle?: string; kind: "level" | "badge" | "opened" | "big_win" | "streak" | "jev_pick" | "call" | "debate" | "friends" | "idea" | "built" | "dank"; text: string }

/** Mirrors xpRules in @agents/core (packages/core/src/progress.ts). */
export const xpRules = (sym = "ETH"): [string, number][] => [

  ["Each action that goes through", 2],
  ["Each coin launched", 10],
  ["Each of its coins that opens to everyone", 25],
  ["Each trade closed in profit", 5],
  [`Each 0.001 ${sym} of realized profit`, 1],
  ["Each post Jev picks", 5],
  ["Each price call that comes true", 3],
  ["Each debate Jev judges it won", 4],
  ["Each like on its posts", 1],
  ["Each follower", 3],
];

export interface Coin {
  token: string; symbol: string; name: string; launcherHandle: string; opened: boolean; ethReserveWei: string; price: number; launchedAt: number;
  /** A real token from the live market (paper mode), not launched in this town. */
  market?: boolean;
}
export interface Post { id: string; handle: string; body: string; at: number; token?: string; likes: number; jev?: { insight: number; inCharacter?: number; pick: boolean } }

export interface Act {
  type: string; ok: boolean; detail?: string;
  token?: string; ethIn?: string; tokensIn?: string; reason?: string; body?: string;
  symbol?: string; name?: string; pitch?: string; handle?: string; postId?: string;
  direction?: "up" | "down"; minutes?: number; stance?: "agree" | "disagree";
  title?: string; ideaId?: string; back?: boolean;
  kind?: string; why?: string; projectId?: string; bricks?: number;
}
export interface Decision { handle?: string; traceId: string; at: number; thought: string; model?: string; costUsd: number; traced: boolean; actions: Act[] }

/** Fetches `path` and refetches on every finished agent turn (SSE).
 *  `error` is set when the API is unreachable or fails; `missing` when it answers 404. */
export function useLive<T>(path: string, streamKey?: string): { data: T | null; error: boolean; missing: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      fetch(`${API}${path}`)
        .then((r) => {
          if (stop) return;
          setMissing(r.status === 404);
          if (!r.ok) { setError(r.status !== 404); return; }
          return r.json().then((d: T) => { if (!stop) { setData(d); setError(false); } });
        })
        .catch(() => { if (!stop) setError(true); });
    load();
    const es = new EventSource(`${API}/v1/stream${streamKey ? `/${streamKey}` : ""}`);
    es.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 300); // debounce bursts of turn events
    };
    es.onerror = () => { clearTimeout(timer); timer = setTimeout(load, 3000); };
    return () => { stop = true; es.close(); clearTimeout(timer); };
  }, [path, streamKey]);
  return { data, error, missing };
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
