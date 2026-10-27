import { PRESETS, type Order } from "@agents/core";
import { LlmClient } from "@agents/llm";
import { MemorySink, Tracer } from "@agents/trace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAction, type Quoter } from "./actions.js";
import type { Chain } from "./chain.js";
import { MARKET } from "./solana/paper.js";
import { tick } from "./tick.js";
import { ExitWatcher } from "./watcher.js";
import { World, type Agent } from "./world.js";

const E = 10n ** 18n;
const MIN = 60_000;
/** Wei per smallest token unit at the start. */
const P0 = 1_000_000n;

/** A market whose prices the test sets, read with a timestamp like the live one. */
class Market implements Chain, Quoter {
  readonly price = new Map<string, bigint>();
  readonly at = new Map<string, number>();
  readonly refreshed: string[][] = [];
  /** A price feed that has stopped answering. */
  frozen = false;
  failSells = false;
  quoteBuy(t: string, e: bigint) { const p = this.price.get(t); return p ? e / p : 0n; }
  quoteSell(t: string, n: bigint) { return n * (this.price.get(t) ?? 0n); }
  priceAt(t: string) { return this.at.get(t); }
  async refresh(tokens: string[]) {
    this.refreshed.push(tokens);
    if (!this.frozen) for (const t of tokens) this.at.set(t, Date.now());
  }
  async ensureFresh(tokens: string[], olderThanMs: number) {
    const due = tokens.filter((t) => Date.now() - (this.at.get(t) ?? 0) > olderThanMs);
    if (due.length) await this.refresh(due);
  }
  async execute(_a: string, o: Order) {
    if (o.kind === "sell" && this.failSells) throw new Error("no route on mainnet");
    const out = o.kind === "buy" ? this.quoteBuy(o.token, o.ethIn) : this.quoteSell(o.token, o.tokensIn);
    if (out < o.minOut) throw new Error("Slippage");
    return { txHash: "paper-x", out };
  }
  move(t: string, pct: bigint) { this.price.set(t, (P0 * pct) / 100n); }
}

const mk = (handle: string, external = false): Agent => ({
  account: `0x${handle}`, owner: `0xO${handle}`, handle, name: handle, persona: "test", modelId: "m/x",
  plan: PRESETS.momentum, awake: true, external, createdAt: 0,
});

function town() {
  const world = new World();
  const market = new Market();
  for (const [t, sym] of [["T", "BONK"], ["U", "WIF"]] as const) {
    world.coins.set(t, { token: t, symbol: sym, name: sym, launcher: MARKET, launcherOwner: MARKET, opened: true, ethReserveWei: E, launchedAt: 0, market: true });
    market.price.set(t, P0);
  }
  const sink = new MemorySink();
  const tracer = new Tracer([sink]);
  const watcher = new ExitWatcher(world, { chain: market, quoter: market, tracer, refresh: (t) => market.refresh(t) });
  const join = (a: Agent) => { world.agents.set(a.account, a); world.balances.set(a.account, 1n * E); return a; };
  const buy = (a: Agent, token = "T") => applyAction(world, market, market, a, { type: "buy", token, ethIn: (E / 20n).toString(), reason: "test" });
  const sellAll = (a: Agent, token = "T") => applyAction(world, market, market, a, { type: "sell", token, tokensIn: String(world.positions.get(a.account)?.find((p) => p.token === token)?.amount ?? 0n), reason: "test" });
  return { world, market, sink, tracer, watcher, join, buy, sellAll };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000_000_000); });
afterEach(() => vi.useRealTimers());
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("exit watcher", () => {
  it("sells a stop loss for an external agent without a model, as its own traced decision", async () => {
    const { world, market, sink, watcher, join, buy } = town();
    const ext = join(mk("ext", true));
    expect(await buy(ext)).toMatchObject({ ok: true });
    later(MIN); // inside the 10-minute minimum hold: a stop loss still fires
    market.move("T", 90n);
    const r = await watcher.run();
    expect(r).toMatchObject({ held: 1, stale: [] });
    expect(r!.exits).toMatchObject([{ ok: true, action: { type: "sell", reason: "plan: stop loss -10.0%" } }]);
    expect(world.positions.get(ext.account)).toEqual([]);
    // Only the held token's price was read.
    expect(market.refreshed.at(-1)).toEqual(["T"]);
    const d = world.decisions.at(-1)!;
    expect(d).toMatchObject({ agent: ext.account, summary: "Plan exit on $BONK: stop loss -10.0%", outcomes: [expect.stringMatching(/^✓ sell: sell filled/)] });
    const run = sink.all().find((s) => s.name === "exit @ext $BONK")!;
    expect(run).toMatchObject({ kind: "run", traceId: d.traceId, attrs: expect.objectContaining({ trigger: "stop_loss", external: true, ok: true }) });
    expect(sink.all().some((s) => s.kind === "tx" && s.traceId === d.traceId)).toBe(true);
    // The re-entry cooldown starts when the position closes.
    expect(world.lastExits.get(ext.account)?.T).toBe(Date.now());
    expect(await buy(ext)).toMatchObject({ ok: false, detail: expect.stringMatching(/^risk: re-entry cooldown/) });
    later(31 * MIN);
    expect(await buy(ext)).toMatchObject({ ok: true });
  });

  it("tracks each position's peak so the trailing stop fires", async () => {
    const { world, market, watcher, join, buy } = town();
    const a = join(mk("alpha"));
    await buy(a);
    const p = world.positions.get(a.account)![0]!;
    expect(p.peakValueWei).toBe(p.costWei);
    for (const pct of [104n, 108n, 106n]) {
      later(10_000);
      market.move("T", pct);
      expect((await watcher.run())!.exits).toEqual([]);
    }
    expect(p.peakValueWei).toBe((p.costWei * 108n) / 100n);
    later(10_000);
    market.move("T", 103n);
    expect((await watcher.run())!.exits).toMatchObject([{ ok: true, action: { reason: "plan: trailing stop, gave back 4.6% from the peak" } }]);
    expect(world.positions.get(a.account)).toEqual([]);
  });

  it("takes profit once and shrinks the peak with the position, so the rest isn't sold as a giveback", async () => {
    const { world, market, watcher, join, buy } = town();
    const a = join(mk("alpha"));
    await buy(a);
    const p = world.positions.get(a.account)![0]!;
    const amount = p.amount;
    later(10_000);
    market.move("T", 112n);
    expect((await watcher.run())!.exits).toMatchObject([{ ok: true, action: { reason: "plan: take profit 12.0%" } }]);
    expect(p).toMatchObject({ amount: amount / 2n, tookProfit: true });
    later(10_000);
    expect((await watcher.run())!.exits).toEqual([]);
  });

  it("waits for a fresh price before exiting, and says which prices are too old", async () => {
    const { world, market, watcher, join, buy } = town();
    const a = join(mk("alpha"));
    await buy(a);
    market.frozen = true;
    later(40_000);
    market.move("T", 80n);
    expect(await watcher.run()).toMatchObject({ exits: [], stale: ["T"] });
    expect(world.positions.get(a.account)).toHaveLength(1);
    // Agents can't trade on it either.
    expect(await buy(a)).toMatchObject({ ok: false, detail: "risk: price is 40s old (limit 15s), waiting for a fresh one" });
    market.frozen = false;
    expect((await watcher.run())!.exits).toMatchObject([{ ok: true }]);
  });

  it("runs one pass at a time", async () => {
    const { market, watcher, join, buy } = town();
    await buy(join(mk("alpha")));
    let release!: () => void;
    const slow = new ExitWatcher((watcher as unknown as { world: World }).world, { chain: market, quoter: market, tracer: new Tracer([]), refresh: () => new Promise<void>((r) => { release = r; }) });
    const first = slow.run();
    expect(slow.running).toBe(true);
    expect(await slow.run()).toBeNull();
    release();
    expect(await first).toMatchObject({ held: 1 });
    expect(slow.running).toBe(false);
  });

  it("backs off an exit that can't fill instead of retrying it every pass", async () => {
    const { world, market, watcher, join, buy } = town();
    const a = join(mk("alpha"));
    await buy(a);
    market.failSells = true;
    market.move("T", 80n);
    later(1_000);
    expect((await watcher.run())!.exits).toMatchObject([{ ok: false, detail: "no route on mainnet" }]);
    expect(world.decisions.at(-1)?.outcomes).toEqual(["✗ sell: no route on mainnet"]);
    later(10_000);
    expect((await watcher.run())!.exits).toEqual([]);
    market.failSells = false;
    later(60_000);
    expect((await watcher.run())!.exits).toMatchObject([{ ok: true }]);
  });
});

describe("trading rules on agents' own trades", () => {
  it("refuses a sell inside the minimum hold, then allows it", async () => {
    const { join, buy, sellAll } = town();
    const a = join(mk("alpha"));
    await buy(a);
    later(3 * MIN);
    expect(await sellAll(a)).toMatchObject({ ok: false, detail: expect.stringMatching(/^risk: minimum hold: held 3 of 10 min/) });
    later(8 * MIN);
    expect(await sellAll(a)).toMatchObject({ ok: true });
  });

  it("re-reads an old price before trading on it", async () => {
    const { market, join, buy } = town();
    const a = join(mk("alpha"));
    market.at.set("U", Date.now() - 60_000);
    expect(await buy(a, "U")).toMatchObject({ ok: true });
    expect(market.refreshed.at(-1)).toEqual(["U"]);
  });

  it("sells a position once when the watcher and the agent race for it", async () => {
    const { world, market, watcher, join, buy, sellAll } = town();
    const a = join(mk("alpha"));
    await buy(a);
    later(11 * MIN);
    market.move("T", 80n);
    const before = world.balances.get(a.account)!;
    const [own, w] = await Promise.all([sellAll(a), watcher.run()]);
    const sold = [own, ...w!.exits].filter((r) => r.ok);
    expect(sold).toHaveLength(1);
    expect(world.positions.get(a.account)).toEqual([]);
    // Credited once: 0.05 ETH of tokens at 80%.
    expect(world.balances.get(a.account)! - before).toBe((E / 20n) * 80n / 100n);
  });
});

describe("agent turn with the watcher on", () => {
  const llm = (tracer: Tracer, seen: string[]) => new LlmClient({ apiKey: "k", tracer, fetch: (async (_u: string, init: RequestInit) => {
    seen.push(...JSON.parse(String(init.body)).messages.map((m: { content: string }) => m.content));
    return new Response(JSON.stringify({ model: "m/x", choices: [{ message: { role: "assistant", content: JSON.stringify({ thought: "wait", actions: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as unknown as typeof fetch });

  it("leaves exits to the watcher and tells the model its timeframe and how old each price is", async () => {
    const { world, market, tracer, join, buy } = town();
    const a = join(mk("alpha"));
    await buy(a);
    later(2 * MIN);
    market.move("T", 80n);
    market.at.set("U", Date.now() - 4_000);
    const seen: string[] = [];
    const r = await tick(world, a, { llm: llm(tracer, seen), tracer, chain: market, quoter: market, exits: false });
    expect(r.results).toEqual([]);
    expect(world.positions.get(a.account)).toHaveLength(1);
    const [system, context] = seen;
    expect(system).toMatch(/aim to hold a trade about 60 min\. You can't sell a position in its first 10 min, or buy a coin back within 30 min of closing it\./);
    expect(system).toMatch(/Your exits are automatic: a watcher checks your positions every few seconds/);
    expect(system).toMatch(/stop loss at -5% \(sells it all\)/);
    expect(system).toMatch(/more than 15s old are refused/);
    // The prompt read stale prices first: U was 4s old (fine), T was 2 minutes old (re-read).
    expect(context).toMatch(/^BONK T .*\(price 0s old\)/m);
    expect(context).toMatch(/^WIF U .*\(price 4s old\)/m);
    expect(context).toMatch(/held 2 min of a 60 min target, sellable in 8 min/);
    expect(system).not.toMatch(/—/);
  });

  it("runs the exits itself when the watcher is off, recording one decision for the turn", async () => {
    const { world, market, tracer, join, buy } = town();
    const a = join(mk("alpha"));
    await buy(a);
    later(MIN);
    market.move("T", 80n);
    const decisions = world.decisions.length;
    const r = await tick(world, a, { llm: llm(tracer, []), tracer, chain: market, quoter: market });
    expect(r.results).toMatchObject([{ ok: true, action: { reason: "plan: stop loss -20.0%" } }]);
    expect(world.decisions).toHaveLength(decisions + 1);
  });
});
