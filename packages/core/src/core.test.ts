import { describe, expect, it } from "vitest";
import { PRESETS, checkIntent, forcedExits, noveltyCheck, realizedPnl, type AgentState, type CoinView } from "./index.js";

const E = 10n ** 18n;
const coin = (over: Partial<CoinView> = {}): CoinView => ({
  token: "0xT", launcherOwner: "0xOTHER", opened: false, totalSupply: 1_000_000_000n * E,
  quoteBuy: (eth) => eth * 300_000_000n, quoteSell: (t) => t / 300_000_000n, ...over,
});
const agent = (over: Partial<AgentState> = {}): AgentState => ({ owner: "0xME", freeWei: 1n * E, positions: [], now: Date.now(), ...over });

describe("risk engine", () => {
  const plan = PRESETS.momentum;

  it("clips size to the plan and attaches minOut with slippage", () => {
    const v = checkIntent({ kind: "buy", token: "0xT", ethIn: 1n * E, reason: "x" }, plan, agent(), coin());
    expect(v.ok).toBe(true);
    if (!v.ok || v.order.kind !== "buy") return;
    expect(v.order.ethIn).toBe((1n * E * 6n) / 100n);
    expect(v.order.minOut).toBe((v.order.ethIn * 300_000_000n * 9_700n) / 10_000n);
    expect(v.adjusted).toBeDefined();
  });

  it("refuses own-fleet coins, too many positions, supply cap", () => {
    expect(checkIntent({ kind: "buy", token: "0xT", ethIn: E / 100n, reason: "" }, plan, agent(), coin({ launcherOwner: "0xme" })).ok).toBe(false);
    const full = agent({ positions: Array.from({ length: 4 }, (_, i) => ({ token: `0x${i}`, amount: 1n, costWei: 1n, openedAt: 0, peakValueWei: 1n })) });
    expect(checkIntent({ kind: "buy", token: "0xT", ethIn: E / 100n, reason: "" }, plan, full, coin()).ok).toBe(false);
    const whale = agent({ freeWei: 1000n * E });
    expect(checkIntent({ kind: "buy", token: "0xT", ethIn: E / 10n, reason: "" }, { ...plan, maxSupplyBps: 1 }, whale, coin())).toMatchObject({ ok: true, adjusted: expect.stringMatching(/supply cap/) });
    const capped = agent({ positions: [{ token: "0xT", amount: 100_000n * E, costWei: 1n, openedAt: 0, peakValueWei: 0n }] });
    expect(checkIntent({ kind: "buy", token: "0xT", ethIn: E / 100n, reason: "" }, { ...plan, maxSupplyBps: 1 }, capped, coin())).toMatchObject({ ok: false, reason: "supply cap exceeded" });
  });

  it("forces stop-loss and take-profit exits", () => {
    const pos = (cost: bigint) => ({ token: "0xT", amount: 300_000_000n * E, costWei: cost, openedAt: 0, peakValueWei: 0n });
    const m = new Map([["0xT", coin()]]);
    expect(forcedExits(plan, agent({ positions: [pos(2n * E)] }), m)[0]?.reason).toMatch(/stop loss/);
    expect(forcedExits(plan, agent({ positions: [pos(E / 2n)] }), m)[0]?.reason).toMatch(/take profit/);
  });
});

describe("content rules", () => {
  it("blocks repeated posts", () => {
    const meme = "same crew rotating bags, no stranger lifted an ask, I'm $FLAT";
    expect(noveltyCheck("same crew rotating bags, no stranger lifted an ask, I'm $HOLD", [], [meme]).ok).toBe(false);
    expect(noveltyCheck("First real buyer from outside the fleet just took 2% of $RELAY.", [], [meme]).ok).toBe(true);
  });
});

describe("leaderboard", () => {
  it("excludes own-fleet round trips from PnL", () => {
    const pnl = realizedPnl([
      { agent: "a", owner: "o1", token: "t", side: "buy", ethWei: 100n, tokens: 10n },
      { agent: "a", owner: "o1", token: "t", side: "sell", ethWei: 150n, tokens: 10n },
      { agent: "b", owner: "o2", token: "t", side: "buy", ethWei: 100n, tokens: 10n, counterpartyOwner: "o2" },
      { agent: "b", owner: "o2", token: "t", side: "sell", ethWei: 500n, tokens: 10n, counterpartyOwner: "o2" },
    ]);
    expect(pnl.get("a")?.realizedWei).toBe(50n);
    expect(pnl.get("b")?.realizedWei).toBe(0n);
    expect(pnl.get("b")?.excludedWei).toBe(600n);
  });
});
