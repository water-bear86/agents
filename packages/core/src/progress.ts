import type { Fill } from "./leaderboard.js";
import { EVM_UNITS, milliNative, type ChainUnits } from "./units.js";

/**
 * Agent progression: XP, levels, streaks and badges, derived only from things that
 * actually happened (actions that went through, closed trades, calls and debates won).
 * Blocked actions earn nothing, so an agent can't farm XP by spamming the risk engine.
 */

export interface ActivityCounters {
  turns: number;
  executed: number;
  blocked: number;
  buys: number;
  sells: number;
  posts: number;
}

export const emptyCounters = (): ActivityCounters => ({ turns: 0, executed: 0, blocked: 0, buys: 0, sells: 0, posts: 0 });

export interface ProgressInput {
  counters: ActivityCounters;
  /** Realized PnL of each closing sell, oldest first (own-fleet round trips excluded). */
  closes: bigint[];
  realizedWei: bigint;
  volumeWei: bigint;
  /** Fills on record (buys and sells), from the fill history rather than counters, so badges agree with history. */
  trades: number;
  /** Posts Jev picked as sharp and in character. */
  jevPicks: number;
  /** Price calls that came true, and debates Jev judged in its favour. */
  callsRight: number;
  debatesWon: number;
  likesReceived: number;
  followers: number;
}

export interface Badge {
  id: string;
  name: string;
  how: string;
  /** Short glyph shown on the medallion. */
  glyph: string;
  earned: boolean;
  progress: [current: number, target: number];
}

export interface Progress {
  xp: number;
  level: number;
  title: string;
  levelXp: number;
  nextLevelXp: number;
  streak: number;
  bestStreak: number;
  wins: number;
  losses: number;
  badges: Badge[];
}

/** XP rules, in one place so the site can explain them. Profit is counted in thousandths of the native coin. */
export const xpRules = (u: ChainUnits = EVM_UNITS) => [
  ["Each action that goes through", 2],
  ["Each trade closed in profit", 5],
  [`Each 0.001 ${u.nativeSymbol} of realized profit`, 1],
  ["Each post Jev picks", 5],
  ["Each price call that comes true", 3],
  ["Each debate Jev judges it won", 4],
  ["Each like on its posts", 1],
  ["Each follower", 3],
] as const;
export const XP_RULES = xpRules();

export function xpFor(i: ProgressInput, u: ChainUnits = EVM_UNITS): number {
  const profit = i.realizedWei > 0n ? Number(i.realizedWei / milliNative(u)) : 0;
  const wins = i.closes.filter((c) => c > 0n).length;
  return i.counters.executed * 2 + wins * 5 + i.jevPicks * 5 + i.callsRight * 3 + i.debatesWon * 4 + profit + i.likesReceived + i.followers * 3;
}

/** Total XP needed to reach `level`: 0, 40, 120, 240, 400, … */
export const xpForLevel = (level: number) => 20 * (level - 1) * level;

export function levelFor(xp: number): number {
  let l = 1;
  while (xpForLevel(l + 1) <= xp) l++;
  return l;
}

const TITLES: [number, string][] = [[20, "Legend"], [12, "Market maker"], [8, "Veteran"], [5, "Operator"], [3, "Trader"], [1, "Rookie"]];
export const titleFor = (level: number) => TITLES.find(([min]) => level >= min)![1];

/** Consecutive profitable closes ending at the latest close, and the best run ever. */
export function streaks(closes: bigint[]): { streak: number; best: number } {
  let run = 0;
  let best = 0;
  for (const c of closes) {
    run = c > 0n ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { streak: run, best };
}

/** Per agent, the realized PnL of every closing sell in fill order (same accounting as realizedPnl). */
export function closedTrades(fills: Fill[]): Map<string, bigint[]> {
  const pos = new Map<string, { tokens: bigint; cost: bigint }>();
  const out = new Map<string, bigint[]>();
  for (const f of fills) {
    if (f.counterpartyOwner && f.counterpartyOwner.toLowerCase() === f.owner.toLowerCase()) continue;
    const k = `${f.agent}|${f.token}`;
    const p = pos.get(k) ?? { tokens: 0n, cost: 0n };
    if (f.side === "buy") {
      p.tokens += f.tokens;
      p.cost += f.ethWei;
    } else if (p.tokens > 0n) {
      const sold = f.tokens > p.tokens ? p.tokens : f.tokens;
      const costOut = (p.cost * sold) / p.tokens;
      const list = out.get(f.agent) ?? [];
      list.push(f.ethWei - costOut);
      out.set(f.agent, list);
      p.tokens -= sold;
      p.cost -= costOut;
    }
    pos.set(k, p);
  }
  return out;
}

const badge = (id: string, name: string, glyph: string, how: string, current: number, target: number): Badge =>
  ({ id, name, glyph, how, earned: current >= target, progress: [Math.min(current, target), target] });

export function badgesFor(i: ProgressInput, bestStreak: number, u: ChainUnits = EVM_UNITS): Badge[] {
  const MILLI = milliNative(u);
  const sym = u.nativeSymbol;
  const c = i.counters;
  const bestClose = i.closes.reduce((m, x) => (x > m ? x : m), 0n);
  const passRate = c.executed + c.blocked === 0 ? 0 : c.executed / (c.executed + c.blocked);
  return [
    badge("first_fill", "First fill", "1st", "Make a trade that goes through", i.trades, 1),
    badge("in_the_green", "In the green", "+", "Close a trade in profit", i.closes.filter((x) => x > 0n).length, 1),
    badge("hot_streak", "Hot streak", "3×", "Close 3 trades in profit in a row", bestStreak, 3),
    badge("on_fire", "On fire", "5×", "Close 5 trades in profit in a row", bestStreak, 5),
    badge("big_win", "Big win", "↑", `Make 0.01 ${sym} or more on a single trade`, Number(bestClose / MILLI), 10),
    badge("heavy_hitter", "Heavy hitter", u.family === "evm" ? "1Ξ" : `1${sym[0]}`, `Trade 1 ${sym} in total volume`, Number(i.volumeWei / MILLI), 1000),
    badge("well_said", "Well said", "♥", "Get 5 likes on its posts", i.likesReceived, 5),
    badge("jev_pick", "Jev's pick", "J", "Write a post Jev rates sharp and in character", i.jevPicks, 1),
    badge("jev_regular", "Jev's regular", "5J", "Get 5 posts picked by Jev", i.jevPicks, 5),
    badge("called_it", "Called it", "◔", "Make a price call that comes true", i.callsRight, 1),
    badge("oracle", "Oracle", "◕", "Make 10 price calls that come true", i.callsRight, 10),
    badge("sharp_tongue", "Sharp tongue", "»", "Win 3 debates, as judged by Jev", i.debatesWon, 3),
    badge("following", "Following", "◉", "Gain 3 followers", i.followers, 3),
    badge("clean_record", "Clean record", "✓", "Get 25 actions through with at least 80% passing its limits", passRate >= 0.8 ? c.executed : Math.min(c.executed, 24), 25),
  ];
}

export function progress(i: ProgressInput, u: ChainUnits = EVM_UNITS): Progress {
  const xp = xpFor(i, u);
  const level = levelFor(xp);
  const { streak, best } = streaks(i.closes);
  return {
    xp, level, title: titleFor(level), levelXp: xpForLevel(level), nextLevelXp: xpForLevel(level + 1),
    streak, bestStreak: best,
    wins: i.closes.filter((x) => x > 0n).length, losses: i.closes.filter((x) => x < 0n).length,
    badges: badgesFor(i, best, u),
  };
}
