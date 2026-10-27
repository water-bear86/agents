import { PRESETS } from "@agents/core";
import { describe, expect, it } from "vitest";
import { TRADING_ACTIONS, applyAction } from "./actions.js";
import { SimChain } from "./chain.js";
import { MARKET } from "./solana/paper.js";
import { World, type Agent } from "./world.js";

// A host talks, welcomes and builds, and never touches the market. The runtime refuses its trades for
// every caller (its own loop, REST with a key or a sign-in, MCP hosted or local), since they all end
// up in applyAction.

const E = 10n ** 18n;
const mk = (handle: string, host?: boolean): Agent => ({ account: `0x${handle}`, owner: "0x1", handle, name: handle, persona: "", modelId: "m", plan: PRESETS.momentum, awake: true, external: true, createdAt: 0, ...(host ? { host } : {}) });

async function setup() {
  const world = new World();
  const chain = new SimChain();
  const token = chain.list("sim-BONK");
  world.coins.set(token, { token, symbol: "BONK", name: "Bonk", launcher: MARKET, launcherOwner: MARKET, opened: true, ethReserveWei: E, launchedAt: 0, market: true });
  const host = mk("theoldman", true);
  const trader = mk("atlas");
  for (const a of [host, trader]) { world.agents.set(a.account, a); world.balances.set(a.account, E); }
  return { world, chain, token, host, trader };
}

describe("host role", () => {
  it("refuses every trade a host makes", async () => {
    const { world, chain, token, host } = await setup();
    const tries = [
      { type: "buy", token, ethIn: (E / 100n).toString(), reason: "x" },
      { type: "sell", token, tokensIn: "1", reason: "x" },
      { type: "predict", token, direction: "up", minutes: 5, reason: "x" },
      { type: "pledge", percent: 5 },
      { type: "launch", name: "Host Coin", symbol: "HOST", pitch: "x" },
    ] as const;
    expect(tries.map((t) => t.type).sort()).toEqual([...TRADING_ACTIONS].sort());
    for (const t of tries) {
      const r = await applyAction(world, chain, chain, host, t as never);
      expect(r).toMatchObject({ ok: false, detail: "a host never touches the market" });
    }
    expect(world.positions.get(host.account) ?? []).toEqual([]);
    expect(world.predictions).toEqual([]);
    expect(world.pledges.get(host.account)).toBeUndefined();
    expect(world.balances.get(host.account)).toBe(E);
  });

  it("still lets a host talk, and lets everyone else trade", async () => {
    const { world, chain, token, host, trader } = await setup();
    expect((await applyAction(world, chain, chain, host, { type: "post", body: "Welcome to the town, newcomers: the café is open." })).ok).toBe(true);
    expect((await applyAction(world, chain, chain, trader, { type: "buy", token, ethIn: (E / 100n).toString(), reason: "steady demand" } as never)).ok).toBe(true);
  });
});
