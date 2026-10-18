import { describe, expect, it } from "vitest";
import { closedTrades, emptyCounters, levelFor, progress, streaks, xpForLevel, type ProgressInput } from "./index.js";

const E = 10n ** 18n;
const input = (over: Partial<ProgressInput> = {}): ProgressInput => ({
  counters: emptyCounters(), closes: [], realizedWei: 0n, volumeWei: 0n, trades: 0, jevPicks: 0, callsRight: 0, debatesWon: 0, likesReceived: 0, followers: 0, ...over,
});

describe("progress", () => {
  it("levels follow the published thresholds", () => {
    expect([1, 2, 3, 4, 5].map(xpForLevel)).toEqual([0, 40, 120, 240, 400]);
    expect(levelFor(0)).toBe(1);
    expect(levelFor(39)).toBe(1);
    expect(levelFor(40)).toBe(2);
    expect(levelFor(400)).toBe(5);
  });

  it("blocked actions earn no XP", () => {
    expect(progress(input({ counters: { ...emptyCounters(), blocked: 500, turns: 500 } })).xp).toBe(0);
    expect(progress(input({ counters: { ...emptyCounters(), executed: 10 } })).xp).toBe(20);
  });

  it("rewards profit and wins, never losses", () => {
    const p = progress(input({ closes: [E / 100n, -E / 50n], realizedWei: -E / 100n }));
    expect(p.xp).toBe(5);
    expect(p.wins).toBe(1);
    expect(p.losses).toBe(1);
  });

  it("tracks the current and best winning streak", () => {
    expect(streaks([1n, 1n, 1n, -1n, 1n])).toEqual({ streak: 1, best: 3 });
    expect(streaks([])).toEqual({ streak: 0, best: 0 });
    const p = progress(input({ closes: [1n, 1n, 1n] }));
    expect(p.badges.find((b) => b.id === "hot_streak")?.earned).toBe(true);
    expect(p.badges.find((b) => b.id === "on_fire")).toMatchObject({ earned: false, progress: [3, 5] });
  });

  it("closed trades use average cost and skip own-fleet round trips", () => {
    const fills = [
      { agent: "a", owner: "o", token: "t", side: "buy" as const, ethWei: E, tokens: 100n },
      { agent: "a", owner: "o", token: "t", side: "sell" as const, ethWei: E, tokens: 50n },
      { agent: "a", owner: "o", token: "u", side: "sell" as const, ethWei: E, tokens: 5n, counterpartyOwner: "O" },
    ];
    expect(closedTrades(fills).get("a")).toEqual([E / 2n]);
  });

  it("rewards calls that come true and debates won", () => {
    const p = progress(input({ callsRight: 2, debatesWon: 3 }));
    expect(p.xp).toBe(18);
    expect(p.badges.find((b) => b.id === "called_it")?.earned).toBe(true);
    expect(p.badges.find((b) => b.id === "sharp_tongue")?.earned).toBe(true);
    expect(p.badges.find((b) => b.id === "oracle")).toMatchObject({ earned: false, progress: [2, 10] });
  });
});
