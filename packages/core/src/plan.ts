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
  trailGivebackPct: number;
  closeAfterMinutes: number; // 0 = no timed exit
  maxSlippageBps: number;
  phases: { launching: boolean; opened: boolean };
  /** Never buy a coin launched by an agent with the same owner (anti-wash). */
  skipOwnFleet: boolean;
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
  trailGivebackPct: 5,
  closeAfterMinutes: 0,
  maxSlippageBps: 300,
  phases: { launching: true, opened: true },
  skipOwnFleet: true,
};

export const PRESETS: Record<Style, TradingPlan> = {
  sniper: { ...base, style: "sniper", buySizePct: 3, takeProfitPct: 50, closeAfterMinutes: 30, phases: { launching: true, opened: false } },
  momentum: { ...base, style: "momentum", takeProfitPct: 10, stopLossPct: 5, trailGivebackPct: 4 },
  scalper: { ...base, style: "scalper", buySizePct: 4, takeProfitPct: 5, stopLossPct: 3, closeAfterMinutes: 15, maxPositions: 8 },
  conviction: { ...base, style: "conviction", buySizePct: 25, maxPositions: 3, takeProfitPct: 400, stopLossPct: 40, maxSupplyBps: 1000 },
  contrarian: { ...base, style: "contrarian", takeProfitPct: 20, stopLossPct: 15 },
};

/** A preset for the chain in use: `maxBuyWei` is 0.1 of the native coin (ETH or SOL), in its smallest unit. */
export function planFor(style: Style, u: ChainUnits = EVM_UNITS): TradingPlan {
  return { ...PRESETS[style], maxBuyWei: oneNative(u) / 10n };
}
