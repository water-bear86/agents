import { describe, expect, it } from "vitest";
import { PRESETS, checkIntent, forcedExits, timeframeOf, updatePeaks, upgradePlan, type AgentState, type CoinView, type Position, type TradingPlan } from "./index.js";

const E = 10n ** 18n;
const MIN = 60_000;
const NOW = 1_000_000_000_000;
/** A coin worth `value` native units per whole position of 1000 tokens, priced `ageMs` ago (live when undefined). */
const coin = (value: () => bigint, ageMs?: number): CoinView => ({
  token: "T", launcherOwner: "x", opened: true, totalSupply: 1_000_000n,
  quoteBuy: (eth) => (eth * 1000n) / value(), quoteSell: (t) => (t * value()) / 1000n,
  ...(ageMs === undefined ? {} : { priceAt: NOW - ageMs }),
});
const pos = (over: Partial<Position> = {}): Position => ({ token: "T", amount: 1000n, costWei: E, openedAt: NOW - 60 * MIN, peakValueWei: E, ...over });
const agent = (positions: Position[] = [], over: Partial<AgentState> = {}): AgentState => ({ owner: "me", freeWei: 10n * E, positions, now: NOW, ...over });
const sell = (tokensIn = 1000n) => ({ kind: "sell" as const, token: "T", tokensIn, reason: "r" });
const buy = { kind: "buy" as const, token: "T", ethIn: E / 100n, reason: "r" };

describe("trading timeframe per style", () => {
  it("gives fast styles minutes and conviction days", () => {
    const tf = (s: keyof typeof PRESETS) => PRESETS[s].timeframe;
    expect(tf("scalper")).toMatchObject({ minHoldMinutes: 2 });
    expect(tf("scalper").targetHoldMinutes).toBeLessThanOrEqual(15);
    expect(tf("sniper").targetHoldMinutes).toBeLessThanOrEqual(30);
    expect(tf("momentum").targetHoldMinutes).toBe(60);
    expect(tf("conviction").targetHoldMinutes).toBeGreaterThanOrEqual(24 * 60);
    // The minimum hold never outlasts a style's own timed exit.
    for (const p of Object.values(PRESETS)) if (p.closeAfterMinutes) expect(p.timeframe.minHoldMinutes).toBeLessThan(p.closeAfterMinutes);
  });

  it("fills in what plans saved before timeframes lack", () => {
    const { timeframe: _t, stopLossSellPct: _s, ...old } = PRESETS.scalper;
    const up = upgradePlan(old as TradingPlan);
    expect(up.timeframe).toEqual(PRESETS.scalper.timeframe);
    expect(up.stopLossSellPct).toBe(100);
    expect(timeframeOf(old as TradingPlan)).toEqual(PRESETS.scalper.timeframe);
  });
});

describe("minimum hold", () => {
  const plan = PRESETS.momentum; // 10 min minimum hold
  const fresh = [pos({ openedAt: NOW - 3 * MIN })];

  it("refuses a discretionary sell before the minimum hold, with the reason", () => {
    const v = checkIntent(sell(), plan, agent(fresh), coin(() => E));
    expect(v).toMatchObject({ ok: false, reason: expect.stringMatching(/^minimum hold: held 3 of 10 min/) });
    expect(checkIntent(sell(), plan, agent([pos({ openedAt: NOW - 11 * MIN })]), coin(() => E)).ok).toBe(true);
  });

  it("never holds back a forced exit", () => {
    expect(checkIntent(sell(), plan, agent(fresh), coin(() => E), "wei", { forced: true }).ok).toBe(true);
    // A stop loss fires in the first minute.
    expect(forcedExits(plan, agent([pos({ openedAt: NOW - MIN })]), new Map([["T", coin(() => (E * 90n) / 100n)]]))[0]).toMatchObject({ trigger: "stop_loss" });
  });
});

describe("re-entry cooldown", () => {
  const plan = PRESETS.momentum; // 30 min cooldown

  it("refuses buying a coin back too soon after closing it", () => {
    const recent = agent([], { lastExits: { T: NOW - 5 * MIN } });
    expect(checkIntent(buy, plan, recent, coin(() => E))).toMatchObject({ ok: false, reason: expect.stringMatching(/^re-entry cooldown: closed this coin 5 min ago, a momentum waits 30 min/) });
    expect(checkIntent(buy, plan, agent([], { lastExits: { T: NOW - 31 * MIN } }), coin(() => E)).ok).toBe(true);
    // Other coins aren't affected.
    expect(checkIntent({ ...buy, token: "U" }, plan, recent, { ...coin(() => E), token: "U" }).ok).toBe(true);
  });
});

describe("price freshness", () => {
  const plan = PRESETS.momentum;
  const old = [pos({ costWei: 2n * E, peakValueWei: 2n * E })]; // deep in a stop loss

  it("refuses trades and exits on a stale price, with the reason", () => {
    expect(checkIntent(buy, plan, agent(), coin(() => E, 40_000), "wei", { maxPriceAgeMs: 15_000 })).toMatchObject({ ok: false, reason: "price is 40s old (limit 15s), waiting for a fresh one" });
    expect(checkIntent(sell(), plan, agent(old), coin(() => E, 40_000), "wei", { forced: true, maxPriceAgeMs: 15_000 }).ok).toBe(false);
    expect(forcedExits(plan, agent(old), new Map([["T", coin(() => E, 40_000)]]), { maxPriceAgeMs: 15_000 })).toEqual([]);
  });

  it("acts on fresh and live prices", () => {
    expect(checkIntent(buy, plan, agent(), coin(() => E, 3_000), "wei", { maxPriceAgeMs: 15_000 }).ok).toBe(true);
    expect(checkIntent(buy, plan, agent(), coin(() => E), "wei", { maxPriceAgeMs: 15_000 }).ok).toBe(true);
    expect(forcedExits(plan, agent(old), new Map([["T", coin(() => E, 3_000)]]), { maxPriceAgeMs: 15_000 })).toHaveLength(1);
  });
});

describe("peak tracking and the trailing stop", () => {
  // Take profit far away, so the trailing stop (4% giveback) is what protects the gain.
  const plan: TradingPlan = { ...PRESETS.momentum, takeProfitPct: 50 };

  it("follows the price up and sells when a winner gives back the trail", () => {
    let value = E;
    const c = new Map([["T", coin(() => value, 1_000)]]);
    const p = pos({ peakValueWei: E });
    for (const v of [105n, 108n, 106n]) {
      value = (E * v) / 100n;
      updatePeaks([p], c, NOW, 15_000);
    }
    expect(p.peakValueWei).toBe((E * 108n) / 100n);
    expect(forcedExits(plan, agent([p]), c)).toEqual([]); // 1.9% off the peak
    value = (E * 103n) / 100n; // 4.6% off the peak, still in profit
    expect(forcedExits(plan, agent([p]), c)).toMatchObject([{ trigger: "trailing_stop", tokensIn: 1000n, reason: expect.stringMatching(/gave back 4\.6%/) }]);
  });

  it("leaves the peak alone on a stale price", () => {
    const p = pos();
    updatePeaks([p], new Map([["T", coin(() => 2n * E, 60_000)]]), NOW, 15_000);
    expect(p.peakValueWei).toBe(E);
  });
});

describe("stop loss and take profit shares", () => {
  it("doesn't read a missing quote as a -100% loss", () => {
    // A dead price feed: the coin quotes nothing. That's no price, not a stop loss that can't fill.
    const noQuote = new Map([["T", { ...coin(() => E), quoteSell: () => 0n }]]);
    expect(forcedExits(PRESETS.momentum, agent([pos()]), noQuote)).toEqual([]);
    // Not even a timed exit, which couldn't fill either.
    expect(forcedExits(PRESETS.scalper, agent([pos({ openedAt: NOW - 600 * MIN })]), noQuote)).toEqual([]);
  });

  const down = new Map([["T", coin(() => (E * 80n) / 100n)]]);
  const up = new Map([["T", coin(() => (E * 120n) / 100n)]]);

  it("sells the whole position on a stop loss by default, or the configured share", () => {
    expect(forcedExits(PRESETS.momentum, agent([pos()]), down)[0]).toMatchObject({ trigger: "stop_loss", tokensIn: 1000n });
    expect(forcedExits({ ...PRESETS.momentum, stopLossSellPct: 50 }, agent([pos()]), down)[0]).toMatchObject({ tokensIn: 500n });
  });

  it("takes profit once, then leaves the rest to the trailing stop", () => {
    expect(forcedExits(PRESETS.momentum, agent([pos()]), up)[0]).toMatchObject({ trigger: "take_profit", tokensIn: 500n });
    expect(forcedExits(PRESETS.momentum, agent([pos({ tookProfit: true, peakValueWei: (E * 120n) / 100n })]), up)).toEqual([]);
  });
});
