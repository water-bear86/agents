import { EVM_UNITS, oneNative, type ChainUnits } from "./units.js";

/** Owner-set trading bounds. The LLM proposes; these limits dispose. */
export interface TradingPlan {
  style: Style;
  mode: "llm_within_bounds" | "rules_only";
  buySizePct: number; // % of free ETH per buy
  maxBuyWei: bigint;
  maxPositions: number;
  maxSupplyBps: number; // cap on share of a coin's supply held
  takeProfitPct: number;
  sellAtTakeProfitPct: number;
  stopLossPct: number;
  /** Share of the position a stop loss sells, in %. 100 = the whole position. */
  stopLossSellPct: number;
  trailGivebackPct: number;
  closeAfterMinutes: number; // 0 = no timed exit
  maxSlippageBps: number;
  phases: { launching: boolean; opened: boolean };
  /** Never buy a coin launched by an agent with the same owner (anti-wash). */
  skipOwnFleet: boolean;
  /** How long this style means to hold a trade. Forced exits (stop, take profit, trail, timed) ignore it. */
  timeframe: Timeframe;
}

/** A trading style's holding horizon, in minutes. */
export interface Timeframe {
  /** What a typical trade aims to last; told to the model, not enforced. */
  targetHoldMinutes: number;
  /** No discretionary sell before a position is this old. */
  minHoldMinutes: number;
  /** No buying back a token this soon after closing a position in it. */
  reentryCooldownMinutes: number;
}

export type Style = "sniper" | "momentum" | "scalper" | "conviction" | "contrarian";

const ETH = oneNative(EVM_UNITS);

const base: Omit<TradingPlan, "style"> = {
  mode: "llm_within_bounds",
  buySizePct: 6,
  maxBuyWei: ETH / 10n,
  maxPositions: 4,
  maxSupplyBps: 250,
  takeProfitPct: 25,
  sellAtTakeProfitPct: 50,
  stopLossPct: 10,
  stopLossSellPct: 100,
  trailGivebackPct: 5,
  closeAfterMinutes: 0,
  maxSlippageBps: 300,
  phases: { launching: true, opened: true },
  skipOwnFleet: true,
  timeframe: { targetHoldMinutes: 60, minHoldMinutes: 10, reentryCooldownMinutes: 20 },
};

const HOUR = 60;
const DAY = 24 * HOUR;

export const PRESETS: Record<Style, TradingPlan> = {
  // Fast styles: minutes. Their timed exit is the hard ceiling on a hold.
  scalper: { ...base, style: "scalper", buySizePct: 4, takeProfitPct: 5, stopLossPct: 3, closeAfterMinutes: 15, maxPositions: 8,
    timeframe: { targetHoldMinutes: 8, minHoldMinutes: 2, reentryCooldownMinutes: 5 } },
  sniper: { ...base, style: "sniper", buySizePct: 3, takeProfitPct: 50, closeAfterMinutes: 30,
    timeframe: { targetHoldMinutes: 20, minHoldMinutes: 3, reentryCooldownMinutes: 15 } },
  momentum: { ...base, style: "momentum", takeProfitPct: 10, stopLossPct: 5, trailGivebackPct: 4,
    timeframe: { targetHoldMinutes: HOUR, minHoldMinutes: 10, reentryCooldownMinutes: 30 } },
  contrarian: { ...base, style: "contrarian", takeProfitPct: 20, stopLossPct: 15,
    timeframe: { targetHoldMinutes: 6 * HOUR, minHoldMinutes: 30, reentryCooldownMinutes: 2 * HOUR } },
  conviction: { ...base, style: "conviction", buySizePct: 25, maxPositions: 3, takeProfitPct: 400, stopLossPct: 40, maxSupplyBps: 1000,
    timeframe: { targetHoldMinutes: 3 * DAY, minHoldMinutes: 4 * HOUR, reentryCooldownMinutes: DAY } },
};

/** A plan's timeframe, with the style's default for plans saved before timeframes existed. */
export function timeframeOf(plan: TradingPlan): Timeframe {
  return plan.timeframe ?? (PRESETS[plan.style] ?? PRESETS.momentum).timeframe;
}

/** Fills in fields a plan saved by an older version lacks, from its style's preset. */
export function upgradePlan(plan: TradingPlan): TradingPlan {
  const preset = PRESETS[plan.style] ?? PRESETS.momentum;
  return { ...plan, stopLossSellPct: plan.stopLossSellPct ?? preset.stopLossSellPct, timeframe: plan.timeframe ?? { ...preset.timeframe } };
}

/** A preset for the chain in use: `maxBuyWei` is 0.1 of the native coin (ETH or SOL), in its smallest unit. */
export function planFor(style: Style, u: ChainUnits = EVM_UNITS): TradingPlan {
  return { ...PRESETS[style], maxBuyWei: oneNative(u) / 10n };
}
