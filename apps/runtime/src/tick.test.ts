import { PRESETS } from "@agents/core";
import { LlmClient } from "@agents/llm";
import { MemorySink, Tracer } from "@agents/trace";
import { describe, expect, it } from "vitest";
import { applyAction } from "./actions.js";
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
    // The demo chain launches, so the prompt offers it (StonkFun).
    expect(system).toMatch(/"type":"launch"/);
    expect(context).not.toMatch(/agents-only|launcher=/);
  });

  it("launches a coin on StonkFun when the model proposes one, under the launch rules", async () => {
    const { world, chain } = market();
    const tracer = new Tracer([new MemorySink()]);
    const a = mk("alpha", "0xO1");
    world.agents.set(a.account, a);
    world.balances.set(a.account, 1n * E);

    const r = await tick(world, a, { tracer, chain, quoter: chain, llm: new LlmClient({ apiKey: "k", tracer, fetch: llmReturning({ thought: "launch", actions: [{ type: "launch", name: "Relay", symbol: "RELAY", pitch: "Relay coin for agents who pass the baton." }] }) }) });
    expect(r.results[0]).toMatchObject({ ok: true });
    const coin = world.coins.get(r.results[0]!.detail)!;
    expect(coin).toMatchObject({ symbol: "RELAY", launcher: a.account, launcherOwner: "0xO1", venue: "stonkfun", opened: true });
    expect(chain.pools.has(coin.token)).toBe(true);
    expect(world.posts.at(-1)).toMatchObject({ token: coin.token, body: "Relay coin for agents who pass the baton." });
    expect(world.highlights.at(-1)).toMatchObject({ kind: "launch", text: "launched $RELAY on StonkFun" });

    // One an hour; a ticker too close to one in town; an idea that isn't on the board.
    expect(await applyAction(world, chain, chain, a, { type: "launch", name: "Baton", symbol: "BATON", pitch: "" })).toMatchObject({ ok: false, detail: "launch cooldown (1 per hour)" });
    const b = mk("bravo", "0xO2");
    world.agents.set(b.account, b);
    expect(await applyAction(world, chain, chain, b, { type: "launch", name: "Relay Two", symbol: "RELAY2", pitch: "" })).toMatchObject({ ok: false, detail: "too close to an existing ticker" });
    expect(await applyAction(world, chain, chain, b, { type: "launch", name: "Ghost", symbol: "GHOST", pitch: "", ideaId: "x" })).toMatchObject({ ok: false, detail: "no such idea on the board" });
    expect(world.coins.size).toBe(2);
  });

  it("lets an idea's author or a backer launch it, and no one else", async () => {
    const { world, chain } = market();
    const [a, b, c] = [mk("alpha", "0xO1"), mk("bravo", "0xO2"), mk("charlie", "0xO3")];
    for (const x of [a, b, c]) world.agents.set(x.account, x);
    expect(await applyAction(world, chain, chain, a, { type: "pitch", title: "Night market", body: "A coin for the town's night market stalls." })).toMatchObject({ ok: true });
    const idea = world.ideas.at(-1)!;
    expect(await applyAction(world, chain, chain, c, { type: "launch", name: "Night Market", symbol: "NIGHT", pitch: "", ideaId: idea.id })).toMatchObject({ ok: false, detail: "only the idea's author or a backer can launch it" });
    expect(await applyAction(world, chain, chain, b, { type: "riff", ideaId: idea.id, body: "Count me in, lanterns on every stall.", back: true })).toMatchObject({ ok: true });
    const r = await applyAction(world, chain, chain, b, { type: "launch", name: "Night Market", symbol: "NIGHT", pitch: "Lanterns up.", ideaId: idea.id });
    expect(r).toMatchObject({ ok: true });
    expect(idea.launched).toBe(r.detail);
    expect(world.highlights.at(-1)).toMatchObject({ kind: "idea", text: `launched @alpha's Café idea "Night market" as $NIGHT` });
    // A launched idea can't be launched again.
    expect(await applyAction(world, chain, chain, a, { type: "launch", name: "Night Market", symbol: "NITE", pitch: "", ideaId: idea.id })).toMatchObject({ ok: false, detail: "no such idea on the board" });
  });

  it("refuses action types it doesn't know", async () => {
    const { world, chain } = market();
    const a = mk("alpha", "0xO1");
    world.agents.set(a.account, a);
    const r = await applyAction(world, chain, chain, a, { type: "airdrop" } as never);
    expect(r).toMatchObject({ ok: false, detail: 'unknown action "airdrop"' });
  });
});
