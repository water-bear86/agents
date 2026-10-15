import type { TradingPlan } from "./plan.js";
import { sameAddress } from "./units.js";

export interface Position {
  token: string;
  amount: bigint;
  costWei: bigint;
  openedAt: number;
  peakValueWei: bigint;
}

export interface CoinView {
  token: string;
  launcherOwner: string;
  opened: boolean;
  totalSupply: bigint;
  /** Quote for selling/buying, from an off-chain simulation of the pool. */
  quoteBuy(ethIn: bigint): bigint;
  quoteSell(tokensIn: bigint): bigint;
}

export interface AgentState {
  owner: string;
  freeWei: bigint;
  positions: Position[];
  now: number;
}

export type TradeIntent =
  | { kind: "buy"; token: string; ethIn: bigint; reason: string }
  | { kind: "sell"; token: string; tokensIn: bigint; reason: string };

export type Order =
  | { kind: "buy"; token: string; ethIn: bigint; minOut: bigint; reason: string }
  | { kind: "sell"; token: string; tokensIn: bigint; minOut: bigint; reason: string };

export type Verdict = { ok: true; order: Order; adjusted?: string } | { ok: false; reason: string };

const bps = (x: bigint, b: number) => (x * BigInt(Math.round(b))) / 10_000n;

/** Applies the owner's bounds to an LLM trade intent and attaches a minimum output. */
export function checkIntent(intent: TradeIntent, plan: TradingPlan, agent: AgentState, coin: CoinView): Verdict {
  const minOut = (q: bigint) => q - bps(q, plan.maxSlippageBps);

  if (intent.kind === "buy") {
    if (plan.skipOwnFleet && sameAddress(coin.launcherOwner, agent.owner)) return { ok: false, reason: "own fleet's coin (anti-wash)" };
    if (!(coin.opened ? plan.phases.opened : plan.phases.launching)) return { ok: false, reason: "phase not allowed by plan" };
    const held = agent.positions.find((p) => p.token === coin.token);
    if (!held && agent.positions.length >= plan.maxPositions) return { ok: false, reason: "max positions reached" };

    let ethIn = intent.ethIn;
    let adjusted: string | undefined;
    const cap = [bps(agent.freeWei, plan.buySizePct * 100), plan.maxBuyWei].reduce((a, b) => (a < b ? a : b));
    if (ethIn > cap) { ethIn = cap; adjusted = `size clipped to ${cap} wei`; }
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
  const tokensIn = intent.tokensIn > held.amount ? held.amount : intent.tokensIn;
  if (coin.quoteSell(tokensIn) <= 0n) return { ok: false, reason: "no quote available" };
  return { ok: true, order: { kind: "sell", token: coin.token, tokensIn, minOut: minOut(coin.quoteSell(tokensIn)), reason: intent.reason } };
}

/** Exits the plan forces regardless of what the LLM wants: take-profit, stop, trail, timed close. */
export function forcedExits(plan: TradingPlan, agent: AgentState, coins: Map<string, CoinView>): TradeIntent[] {
  const out: TradeIntent[] = [];
  for (const p of agent.positions) {
    const coin = coins.get(p.token);
    if (!coin || p.amount === 0n || p.costWei === 0n) continue;
    const value = coin.quoteSell(p.amount);
    const pnlPct = Number(((value - p.costWei) * 10_000n) / p.costWei) / 100;
    const peak = p.peakValueWei > value ? p.peakValueWei : value;
    const givebackPct = peak > 0n ? Number(((peak - value) * 10_000n) / peak) / 100 : 0;

    if (pnlPct <= -plan.stopLossPct) out.push({ kind: "sell", token: p.token, tokensIn: p.amount / 2n || p.amount, reason: `stop loss ${pnlPct.toFixed(1)}%` });
    else if (pnlPct >= plan.takeProfitPct) out.push({ kind: "sell", token: p.token, tokensIn: bps(p.amount, plan.sellAtTakeProfitPct * 100), reason: `take profit ${pnlPct.toFixed(1)}%` });
    else if (pnlPct > 0 && givebackPct >= plan.trailGivebackPct) out.push({ kind: "sell", token: p.token, tokensIn: p.amount, reason: `trailing stop, gave back ${givebackPct.toFixed(1)}%` });
    else if (plan.closeAfterMinutes > 0 && agent.now - p.openedAt >= plan.closeAfterMinutes * 60_000) out.push({ kind: "sell", token: p.token, tokensIn: p.amount, reason: "timed exit" });
  }
  return out;
}
