import { timeframeOf, type TradingPlan } from "./plan.js";
import { sameAddress } from "./units.js";

export interface Position {
  token: string;
  amount: bigint;
  costWei: bigint;
  openedAt: number;
  /** Highest value the position has been marked at since it opened (smallest native units). */
  peakValueWei: bigint;
  /** Take profit has sold its share; the trailing stop looks after the rest. */
  tookProfit?: boolean;
}

export interface CoinView {
  token: string;
  launcherOwner: string;
  opened: boolean;
  totalSupply: bigint;
  /** Quote for selling/buying, from an off-chain simulation of the pool. */
  quoteBuy(ethIn: bigint): bigint;
  quoteSell(tokensIn: bigint): bigint;
  /** When the price behind the quotes was read (ms). Absent for live quotes, such as a simulated curve. */
  priceAt?: number;
}

export interface AgentState {
  owner: string;
  freeWei: bigint;
  positions: Position[];
  now: number;
  /** When the agent last closed out each token (ms), for the re-entry cooldown. */
  lastExits?: Record<string, number>;
}

/** Why the plan forced an exit. */
export type ExitTrigger = "stop_loss" | "take_profit" | "trailing_stop" | "timed";

export type TradeIntent =
  | { kind: "buy"; token: string; ethIn: bigint; reason: string }
  | { kind: "sell"; token: string; tokensIn: bigint; reason: string; trigger?: ExitTrigger };

export interface RiskOptions {
  /** A forced exit: the minimum hold doesn't apply. Only the runtime sets this, never an agent. */
  forced?: boolean;
  /** Refuse to act on a price older than this (ms). No limit when absent. */
  maxPriceAgeMs?: number;
}

export type Order =
  | { kind: "buy"; token: string; ethIn: bigint; minOut: bigint; reason: string }
  | { kind: "sell"; token: string; tokensIn: bigint; minOut: bigint; reason: string };

export type Verdict = { ok: true; order: Order; adjusted?: string } | { ok: false; reason: string };

const bps = (x: bigint, b: number) => (x * BigInt(Math.round(b))) / 10_000n;
const minutes = (ms: number) => Math.max(0, Math.floor(ms / 60_000));

/** How old the coin's price is (ms); 0 for live quotes. */
export function priceAgeMs(coin: Pick<CoinView, "priceAt">, now: number): number {
  return coin.priceAt === undefined ? 0 : Math.max(0, now - coin.priceAt);
}

/** Why a price is too old to act on, or null when it's fresh enough. */
export function stalePrice(coin: Pick<CoinView, "priceAt">, now: number, maxAgeMs?: number): string | null {
  if (maxAgeMs === undefined) return null;
  const age = priceAgeMs(coin, now);
  return age > maxAgeMs ? `price is ${Math.round(age / 1000)}s old (limit ${Math.round(maxAgeMs / 1000)}s), waiting for a fresh one` : null;
}

/** Raises each position's peak to its current value. Positions whose price is stale are left alone. Returns how many rose. */
export function updatePeaks(positions: Position[], coins: Map<string, CoinView>, now: number, maxPriceAgeMs?: number): number {
  let raised = 0;
  for (const p of positions) {
    const coin = coins.get(p.token);
    if (!coin || p.amount === 0n || stalePrice(coin, now, maxPriceAgeMs)) continue;
    const value = coin.quoteSell(p.amount);
    if (value > p.peakValueWei) { p.peakValueWei = value; raised++; }
  }
  return raised;
}

/** Applies the owner's bounds to an LLM trade intent and attaches a minimum output. `baseUnit` names the native unit in messages. */
export function checkIntent(intent: TradeIntent, plan: TradingPlan, agent: AgentState, coin: CoinView, baseUnit = "wei", opts: RiskOptions = {}): Verdict {
  const minOut = (q: bigint) => q - bps(q, plan.maxSlippageBps);
  const stale = stalePrice(coin, agent.now, opts.maxPriceAgeMs);
  if (stale) return { ok: false, reason: stale };
  const tf = timeframeOf(plan);

  if (intent.kind === "buy") {
    if (plan.skipOwnFleet && sameAddress(coin.launcherOwner, agent.owner)) return { ok: false, reason: "own fleet's coin (anti-wash)" };
    if (!(coin.opened ? plan.phases.opened : plan.phases.launching)) return { ok: false, reason: "phase not allowed by plan" };
    const held = agent.positions.find((p) => p.token === coin.token);
    if (!held && agent.positions.length >= plan.maxPositions) return { ok: false, reason: "max positions reached" };
    const lastExit = agent.lastExits?.[coin.token];
    if (!held && lastExit !== undefined && agent.now - lastExit < tf.reentryCooldownMinutes * 60_000) {
      return { ok: false, reason: `re-entry cooldown: closed this coin ${minutes(agent.now - lastExit)} min ago, a ${plan.style} waits ${tf.reentryCooldownMinutes} min before buying it back` };
    }

    let ethIn = intent.ethIn;
    let adjusted: string | undefined;
    const cap = [bps(agent.freeWei, plan.buySizePct * 100), plan.maxBuyWei].reduce((a, b) => (a < b ? a : b));
    if (ethIn > cap) { ethIn = cap; adjusted = `size clipped to ${cap} ${baseUnit}`; }
    if (ethIn <= 0n) return { ok: false, reason: "no free balance" };

    let out = coin.quoteBuy(ethIn);
    const room = bps(coin.totalSupply, plan.maxSupplyBps) - (held?.amount ?? 0n);
    if (out > room) {
      // Largest buy that stays under the supply cap (binary search over the quote).
      let lo = 0n, hi = ethIn;
      for (let i = 0; i < 40 && hi - lo > 1n; i++) {
        const mid = (lo + hi) / 2n;
        if (coin.quoteBuy(mid) <= room) lo = mid; else hi = mid;
      }
      ethIn = room > 0n ? lo : 0n;
      out = ethIn > 0n ? coin.quoteBuy(ethIn) : 0n;
      if (ethIn <= 0n) return { ok: false, reason: "supply cap exceeded" };
      adjusted = `size clipped to supply cap (${plan.maxSupplyBps} bps)`;
    }
    if (out <= 0n) return { ok: false, reason: "no quote available" };
    return { ok: true, order: { kind: "buy", token: coin.token, ethIn, minOut: minOut(out), reason: intent.reason }, adjusted };
  }

  const held = agent.positions.find((p) => p.token === coin.token);
  if (!held || held.amount === 0n) return { ok: false, reason: "no position" };
  if (!opts.forced && agent.now - held.openedAt < tf.minHoldMinutes * 60_000) {
    return { ok: false, reason: `minimum hold: held ${minutes(agent.now - held.openedAt)} of ${tf.minHoldMinutes} min (the stop loss and take profit still run on their own)` };
  }
  const tokensIn = intent.tokensIn > held.amount ? held.amount : intent.tokensIn;
  if (coin.quoteSell(tokensIn) <= 0n) return { ok: false, reason: "no quote available" };
  return { ok: true, order: { kind: "sell", token: coin.token, tokensIn, minOut: minOut(coin.quoteSell(tokensIn)), reason: intent.reason } };
}

/**
 * Exits the plan forces regardless of what the LLM wants: stop loss, take profit (once per
 * position), trailing stop, timed close. Coins whose price is stale are skipped until it's fresh.
 */
export function forcedExits(plan: TradingPlan, agent: AgentState, coins: Map<string, CoinView>, opts: Pick<RiskOptions, "maxPriceAgeMs"> = {}): Array<Extract<TradeIntent, { kind: "sell" }>> {
  const out: Array<Extract<TradeIntent, { kind: "sell" }>> = [];
  const share = (p: Position, pct: number) => (pct >= 100 ? p.amount : bps(p.amount, pct * 100) || p.amount);
  for (const p of agent.positions) {
    const coin = coins.get(p.token);
    if (!coin || p.amount === 0n || p.costWei === 0n) continue;
    if (stalePrice(coin, agent.now, opts.maxPriceAgeMs)) continue;
    const value = coin.quoteSell(p.amount);
    const pnlPct = Number(((value - p.costWei) * 10_000n) / p.costWei) / 100;
    const peak = p.peakValueWei > value ? p.peakValueWei : value;
    const givebackPct = peak > 0n ? Number(((peak - value) * 10_000n) / peak) / 100 : 0;
    const exit = (tokensIn: bigint, trigger: ExitTrigger, reason: string) => out.push({ kind: "sell", token: p.token, tokensIn, reason, trigger });

    if (pnlPct <= -plan.stopLossPct) exit(share(p, plan.stopLossSellPct ?? 100), "stop_loss", `stop loss ${pnlPct.toFixed(1)}%`);
    else if (pnlPct >= plan.takeProfitPct && !p.tookProfit) exit(share(p, plan.sellAtTakeProfitPct), "take_profit", `take profit ${pnlPct.toFixed(1)}%`);
    else if (pnlPct > 0 && givebackPct >= plan.trailGivebackPct) exit(p.amount, "trailing_stop", `trailing stop, gave back ${givebackPct.toFixed(1)}% from the peak`);
    else if (plan.closeAfterMinutes > 0 && agent.now - p.openedAt >= plan.closeAfterMinutes * 60_000) exit(p.amount, "timed", `timed exit after ${minutes(agent.now - p.openedAt)} min`);
  }
  return out;
}
