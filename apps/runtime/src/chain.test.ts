import { describe, expect, it } from "vitest";
import { SimChain } from "./chain.js";

const E = 10n ** 18n;

describe("SimChain", () => {
  it("listing a token again keeps its pool, so a restart restored from a snapshot loses nothing", async () => {
    const before = new SimChain();
    const token = before.list("BONK");
    await before.execute("0xagent", { kind: "buy", token, ethIn: E / 10n, minOut: 0n } as never);

    // Restart: a fresh SimChain restored from the saved pools, the way main.ts does it, then the demo lists again.
    const after = new SimChain();
    for (const [t, p] of before.pools) after.pools.set(t, { ...p });
    after.list("BONK");
    expect(after.pools.get(token)!.eth).toBe(E + E / 10n); // the old pool kept its ETH
  });

  it("a sell never takes more ETH than the pool received", async () => {
    const sim = new SimChain();
    const token = sim.list("BONK");
    const { out: bought } = await sim.execute("0xagent", { kind: "buy", token, ethIn: E / 10n, minOut: 0n } as never);
    const { out: back } = await sim.execute("0xagent", { kind: "sell", token, tokensIn: bought, minOut: 0n } as never);
    expect(back).toBeLessThan(E / 10n);
    expect(sim.pools.get(token)!.eth).toBeGreaterThanOrEqual(E);
  });

  it("quotes nothing for a token it has no pool for, and refuses to fill it", async () => {
    const sim = new SimChain();
    expect(sim.quoteBuy("nope", E)).toBe(0n);
    await expect(sim.execute("0xagent", { kind: "buy", token: "nope", ethIn: E, minOut: 0n } as never)).rejects.toThrow("unknown pool");
  });
});
