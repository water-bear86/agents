import { PRESETS } from "@agents/core";
import { LlmClient } from "@agents/llm";
import { MemorySink, Tracer } from "@agents/trace";
import { describe, expect, it } from "vitest";
import { LAUNCH_RETIRED, applyAction } from "./actions.js";
import { SimChain } from "./chain.js";
import { MARKET } from "./solana/paper.js";
import { tick } from "./tick.js";
import { World, type Agent } from "./world.js";

const E = 10n ** 18n;
const mk = (handle: string, owner: string): Agent => ({
  account: `0x${handle}`, owner, handle, name: handle, persona: "test", modelId: "m/x",
  plan: PRESETS.momentum, awake: true, external: false, createdAt: 0,
});

function llmReturning(obj: unknown, seen?: string[]) {
  const fetch = (async (_u: string, init: RequestInit) => {
    seen?.push(...JSON.parse(String(init.body)).messages.map((m: { content: string }) => m.content));
    return new Response(JSON.stringify({ model: "m/x", choices: [{ message: { role: "assistant", content: JSON.stringify(obj) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }));
  }) as unknown as typeof globalThis.fetch;
  return fetch;
}

/** A world with one market token (BONK) on a simulated pool. */
function market() {
  const world = new World();
  const chain = new SimChain();
  const token = chain.list("sim-BONK");
  world.coins.set(token, { token, symbol: "BONK", name: "Bonk", launcher: MARKET, launcherOwner: MARKET, opened: true, ethReserveWei: E, launchedAt: 0, market: true });
  return { world, chain, token };
}

describe("agent tick", () => {
  it("trades a market token within bounds and traces it", async () => {
    const { world, chain, token } = market();
    const sink = new MemorySink();
    const tracer = new Tracer([sink]);
    const a = mk("alpha", "0xO1");
    world.agents.set(a.account, a);
    world.balances.set(a.account, 1n * E);

    const prompts: string[] = [];
    const r = await tick(world, a, { tracer, chain, quoter: chain, llm: new LlmClient({ apiKey: "k", tracer, fetch: llmReturning({ thought: "buy", actions: [{ type: "buy", token, ethIn: (1n * E).toString(), reason: "early" }] }, prompts) }) });
    expect(r.results[0]?.ok).toBe(true);
    expect(r.results[0]?.detail).toMatch(/size clipped/);
    expect(world.balances.get(a.account)! < 1n * E).toBe(true);
    expect(sink.all().some((s) => s.kind === "tx" && s.attrs.ok === true)).toBe(true);
    expect(world.decisions).toHaveLength(1);

    // The prompt lists the market token and offers no way to launch a coin.
    const [system, context] = prompts;
    expect(context).toMatch(/^BONK sim-BONK "Bonk" liquidity=/m);
    expect(system).not.toMatch(/"type":"launch"/);
    expect(context).not.toMatch(/agents-only|launcher=/);
  });

  it("refuses a launch, whether the model proposes it or an outside agent sends it", async () => {
    const { world, chain } = market();
    const tracer = new Tracer([new MemorySink()]);
    const a = mk("alpha", "0xO1");
    world.agents.set(a.account, a);
    world.balances.set(a.account, 1n * E);

    const r = await tick(world, a, { tracer, chain, quoter: chain, llm: new LlmClient({ apiKey: "k", tracer, fetch: llmReturning({ thought: "launch", actions: [{ type: "launch", name: "Relay", symbol: "RELAY", pitch: "Relay coin." }] }) }) });
    expect(r.results[0]).toMatchObject({ ok: false, detail: LAUNCH_RETIRED });

    const direct = await applyAction(world, chain, chain, a, { type: "launch", name: "Relay", symbol: "RELAY", pitch: "", ideaId: "x" });
    expect(direct).toMatchObject({ ok: false, detail: LAUNCH_RETIRED });
    expect(world.coins.size).toBe(1);
    expect(chain.pools.size).toBe(1);
    expect(world.posts).toHaveLength(0);
    // A refused launch earns nothing and counts as blocked.
    expect(world.bricks.get(a.account) ?? 0).toBe(0);
    expect(world.counters.get(a.account)?.blocked).toBe(2);
  });

  it("refuses action types it doesn't know", async () => {
    const { world, chain } = market();
    const a = mk("alpha", "0xO1");
    world.agents.set(a.account, a);
    const r = await applyAction(world, chain, chain, a, { type: "airdrop" } as never);
    expect(r).toMatchObject({ ok: false, detail: 'unknown action "airdrop"' });
  });
});
