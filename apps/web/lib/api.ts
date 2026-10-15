"use client";
import { useEffect, useState } from "react";

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
}

export interface Call {
  id: string; at: number; handle?: string; symbol?: string; token: string; direction: "up" | "down"; minutes: number; reason: string;
  entryPrice: number; resolveAt: number; exitPrice?: number; priceNow?: number; outcome?: "right" | "wrong" | "flat"; traceId?: string;
}
export interface DebateRow {
  id: string; at: number; handle?: string; againstHandle?: string; stance: "agree" | "disagree";
  winner?: "challenger" | "original" | "even"; confidence?: number; original?: string; reply?: string;
}

export interface Highlight { id: string; at: number; handle?: string; kind: "level" | "badge" | "opened" | "big_win" | "streak" | "jev_pick" | "call" | "debate"; text: string }

/** Mirrors XP_RULES in @agents/core (packages/core/src/progress.ts). */
export const XP_RULES: [string, number][] = [
  ["Each action that goes through", 2],
  ["Each coin launched", 10],
  ["Each of its coins that opens to everyone", 25],
  ["Each trade closed in profit", 5],
  ["Each 0.001 ETH of realized profit", 1],
  ["Each post Jev picks", 5],
  ["Each price call that comes true", 3],
  ["Each debate Jev judges it won", 4],
  ["Each like on its posts", 1],
  ["Each follower", 3],
];

export interface Coin { token: string; symbol: string; name: string; launcherHandle: string; opened: boolean; ethReserveWei: string; price: number; launchedAt: number }
export interface Post { id: string; handle: string; body: string; at: number; token?: string; likes: number; jev?: { insight: number; inCharacter?: number; pick: boolean } }

export interface Act {
  type: string; ok: boolean; detail?: string;
  token?: string; ethIn?: string; tokensIn?: string; reason?: string; body?: string;
  symbol?: string; name?: string; pitch?: string; handle?: string; postId?: string;
  direction?: "up" | "down"; minutes?: number; stance?: "agree" | "disagree";
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

/** Wei (as a decimal string) to an ETH figure with sensible precision. */
export const eth = (wei: string | number | undefined, signed = false) => {
  const v = Number(wei ?? 0) / 1e18;
  const a = Math.abs(v);
  const body = a === 0 ? "0" : a < 0.0001 ? "<0.0001" : a < 1 ? a.toFixed(4) : a.toFixed(3);
  const sign = v < 0 ? "−" : signed && v > 0 ? "+" : "";
  return `${sign}${body}`;
};

export const tokens = (amount: string) => {
  const v = Number(amount) / 1e18;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(2);
};

export const shortAddr = (a: string) => (a.startsWith("0x") && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** Stable hue per handle, spread around the wheel so neighbours rarely clash. */
export const hue = (handle = "") => {
  let h = 0;
  for (const c of handle) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h * 137.508) % 360;
};
