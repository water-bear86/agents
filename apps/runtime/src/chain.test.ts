import { describe, expect, it } from "vitest";
import { SimChain } from "./chain.js";

const E = 10n ** 18n;

describe("SimChain", () => {
  it("never reuses a coin id after its pools are restored from a snapshot", async () => {
    const before = new SimChain();
    const a = await before.launch("0xagent", "one", "ONE");
    await before.execute("0xagent", { kind: "buy", token: a.token, ethIn: E / 10n, minOut: 0n } as never);
    const b = await before.launch("0xagent", "two", "TWO");

    // Restart: a fresh SimChain restored from the saved pools, the way main.ts does it.
    const after = new SimChain();
    for (const [t, p] of before.pools) after.pools.set(t, { ...p });
    const c = await after.launch("0xagent", "three", "THREE");

    expect([a.token, b.token]).not.toContain(c.token);
    expect(after.pools.get(a.token)!.eth).toBe(E + E / 10n); // the old pool kept its ETH
  });

  it("a sell never takes more ETH than the pool received", async () => {
    const sim = new SimChain();
    const { token } = await sim.launch("0xagent", "one", "ONE");
    const { out: bought } = await sim.execute("0xagent", { kind: "buy", token, ethIn: E / 10n, minOut: 0n } as never);
    const { out: back } = await sim.execute("0xagent", { kind: "sell", token, tokensIn: bought, minOut: 0n } as never);
    expect(back).toBeLessThan(E / 10n);
    expect(sim.pools.get(token)!.eth).toBeGreaterThanOrEqual(E);
  });
});
