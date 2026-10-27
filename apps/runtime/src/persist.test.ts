import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS } from "@agents/core";
import { describe, expect, it } from "vitest";
import { loadWorld, retireLaunchedCoins, saveWorld } from "./persist.js";
import { World } from "./world.js";

const big = (n: bigint) => ({ $big: n.toString() });
const E = 10n ** 18n;

/** A save file from before agents stopped launching coins. */
function oldSave() {
  const sniper = { ...PRESETS.sniper, phases: { launching: true, opened: false } };
  return {
    agents: [
      { account: "0xa", owner: "0x1", handle: "atlas", name: "atlas", persona: "", modelId: "m", plan: { ...PRESETS.momentum, maxBuyWei: big(E / 10n) }, awake: true, external: false, createdAt: 0 },
      { account: "0xq", owner: "0x3", handle: "quill", name: "quill", persona: "", modelId: "m", plan: { ...sniper, maxBuyWei: big(E / 10n) }, awake: true, external: false, createdAt: 0 },
    ],
    coins: [
      { token: "0xcoin1", symbol: "RELAY", name: "Relay", launcher: "0xq", launcherOwner: "0x3", opened: false, ethReserveWei: big(E), launchedAt: 1 },
      { token: "Mkt1", symbol: "BONK", name: "Bonk", launcher: "market", launcherOwner: "market", opened: true, ethReserveWei: big(5n * E), launchedAt: 2, market: true },
    ],
    positions: [["0xa", [
      { token: "0xcoin1", amount: big(1000n), costWei: big(E / 20n), openedAt: 0, peakValueWei: big(0n) },
      { token: "Mkt1", amount: big(500n), costWei: big(E / 50n), openedAt: 0, peakValueWei: big(0n) },
    ]]],
    balances: [["0xa", big(E / 2n)]],
    ideas: [{ id: "idea-1", at: Date.now(), agent: "0xq", title: "Relay", body: "a relay", riffs: [], backers: [], launched: "0xcoin1" }],
    highlights: [
      { id: "h1", at: 1, agent: "0xq", kind: "opened", text: "launched $RELAY, now open to everyone" },
      { id: "h2", at: 2, agent: "0xq", kind: "idea", text: "turned its Café idea into $RELAY" },
      { id: "h3", at: 3, agent: "0xa", kind: "level", text: "reached level 2" },
    ],
    predictions: [
      { id: "p1", at: 0, agent: "0xa", token: "0xcoin1", direction: "up", minutes: 5, reason: "r", entryPrice: 0.5, resolveAt: Date.now() + 60_000 },
      { id: "p2", at: 0, agent: "0xa", token: "Mkt1", direction: "up", minutes: 5, reason: "r", entryPrice: 0.5, resolveAt: Date.now() + 60_000 },
    ],
    dank: [["0xcoin1", { rating: 1040, wins: 3, losses: 0, draws: 0, duels: 3 }]],
    duels: [{ id: "d1", at: 0, a: "0xcoin1", b: "0xcoin2", winner: "a", confidence: 0.9, judge: "Jev" }],
    crown: { token: "0xcoin1", since: 0 },
    reviews: [{ id: "r1", at: 0, agent: "0xq", kind: "launch", text: "Relay ($RELAY)", outcome: "review", flags: [], severity: 0 }],
    counters: [["0xq", { turns: 3, executed: 2, blocked: 1, buys: 0, sells: 0, launches: 1, posts: 1 }]],
  };
}

function load(snapshot: unknown) {
  const file = join(mkdtempSync(join(tmpdir(), "agents-persist-")), "save.json");
  writeFileSync(file, JSON.stringify(snapshot));
  const world = new World();
  loadWorld(world, file);
  return { world, file };
}

describe("loading a save from before agents stopped launching coins", () => {
  it("loads without crashing and drops what only made sense on the old launchpad", () => {
    const { world } = load(oldSave());
    expect(world.agents.size).toBe(2);
    // Paper and demo worlds retire old-launchpad coins on load, and the idea forgets the coin it became.
    expect(world.ideas[0]?.launched).toBe("0xcoin1");
    retireLaunchedCoins(world);
    expect(world.ideas[0]).not.toHaveProperty("launched");
    expect(world.openIdeas().map((i) => i.id)).toEqual(["idea-1"]);
    // "Opened" news was the old launchpad's; idea launches are news again (StonkFun).
    expect(world.highlights.map((h) => h.id)).toEqual(["h2", "h3"]);
    expect(world.dank.size).toBe(0);
    expect(world.duels).toHaveLength(0);
    expect(world.crown).toBeUndefined();
    // The review log is history and stays.
    expect(world.reviews[0]?.kind).toBe("launch");
    // A sniper saved when it only bought coins before they opened can trade market tokens again.
    expect(world.agents.get("0xq")!.plan.phases.opened).toBe(true);
  });

  it("retires launched coins: holdings go back at cost and open calls close flat", () => {
    const { world } = load(oldSave());
    expect(retireLaunchedCoins(world)).toBe(1);
    expect([...world.coins.keys()]).toEqual(["Mkt1"]);
    expect(world.positions.get("0xa")!.map((p) => p.token)).toEqual(["Mkt1"]);
    expect(world.balances.get("0xa")).toBe(E / 2n + E / 20n);
    expect(world.predictions.find((p) => p.id === "p1")).toMatchObject({ outcome: "flat", exitPrice: 0.5 });
    expect(world.predictions.find((p) => p.id === "p2")?.outcome).toBeUndefined();
    expect(retireLaunchedCoins(world)).toBe(0);
  });

  it("saves and loads back what it loaded", () => {
    const { world, file } = load(oldSave());
    retireLaunchedCoins(world);
    saveWorld(world, file);
    const again = new World();
    loadWorld(again, file);
    expect([...again.coins.keys()]).toEqual(["Mkt1"]);
    expect(again.balances.get("0xa")).toBe(E / 2n + E / 20n);
  });
});
