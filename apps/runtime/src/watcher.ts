// The exit watcher: a fast loop, apart from the agents' LLM turns, that marks every held position
// at a fresh price and runs the plan's forced exits (stop loss, take profit, trailing stop, timed
// close) for every agent, including external ones, without asking a model.

import { forcedExits, stalePrice, updatePeaks, type CoinView } from "@agents/core";
import type { Tracer } from "@agents/trace";
import { agentState, applyAction, coinView, trading, type Action, type ActionResult, type Quoter } from "./actions.js";
import type { Chain } from "./chain.js";
import type { Agent, World } from "./world.js";

export interface ExitDeps {
  chain: Chain;
  quoter: Quoter;
  tracer: Tracer;
  /** Exits that failed recently, by "account:token:trigger", so a coin with no route isn't retried every few seconds. */
  failures?: Map<string, number>;
  /** How long a failed exit waits before it's tried again (ms). */
  retryMs?: number;
  /** Write a decision for each exit (the site shows them). Off when the caller records its own. */
  record?: boolean;
  now?: () => number;
}

/** Runs the plan's forced exits for one agent. Each exit is its own traced run and, by default, its own decision. */
export async function runExits(world: World, agent: Agent, deps: ExitDeps): Promise<ActionResult[]> {
  const positions = world.positions.get(agent.account) ?? [];
  if (agent.host || !positions.length) return [];
  // Held prices older than a third of the limit are re-read first (the watcher has usually just done it).
  await deps.quoter.ensureFresh?.(positions.map((p) => p.token), trading.maxPriceAgeMs / 3).catch(() => {});
  const now = deps.now?.() ?? Date.now();
  const coins = new Map<string, CoinView>();
  for (const p of positions) {
    const c = coinView(world, deps.quoter, p.token);
    if (c) coins.set(p.token, c);
  }
  updatePeaks(positions, coins, now, trading.maxPriceAgeMs);
  const results: ActionResult[] = [];
  for (const exit of forcedExits(agent.plan, agentState(world, agent, now), coins, { maxPriceAgeMs: trading.maxPriceAgeMs })) {
    const key = `${agent.account}:${exit.token}:${exit.trigger}`;
    const failedAt = deps.failures?.get(key);
    if (failedAt !== undefined && now - failedAt < (deps.retryMs ?? 60_000)) continue;
    const symbol = world.coins.get(exit.token)?.symbol ?? "?";
    const action: Action = { type: "sell", token: exit.token, tokensIn: exit.tokensIn.toString(), reason: `plan: ${exit.reason}` };
    const r = await deps.tracer.withSpan(`exit @${agent.handle} $${symbol}`, "run", async (run) => {
      run.setAttrs({ agent: agent.account, handle: agent.handle, external: agent.external, token: exit.token, trigger: exit.trigger, reason: exit.reason });
      // A forced exit that can't fill (no route, say) is reported, not thrown.
      const r: ActionResult = await applyAction(world, deps.chain, deps.quoter, agent, action, deps.tracer, null, { forced: exit.trigger })
        .catch((err) => ({ action, ok: false, detail: err instanceof Error ? err.message : String(err) }));
      run.setAttrs({ ok: r.ok });
      if (deps.record !== false) {
        world.decisions.push({ agent: agent.account, traceId: run.record.traceId, at: Date.now(), summary: `Plan exit on $${symbol}: ${exit.reason}`,
          outcomes: [`${r.ok ? "✓" : "✗"} sell: ${String(r.detail).slice(0, 90)}`] });
      }
      return r;
    });
    if (r.ok) deps.failures?.delete(key);
    else deps.failures?.set(key, now);
    results.push(r);
  }
  return results;
}

export interface WatchReport {
  /** Tokens held across the town that were checked. */
  held: number;
  exits: ActionResult[];
  /** Held tokens whose price is still too old after the refresh: their exits wait. */
  stale: string[];
}

/**
 * Watches every held position. One run at a time: a run that's still going when the next is due
 * is skipped, not stacked.
 */
export class ExitWatcher {
  #running = false;
  readonly #failures = new Map<string, number>();

  constructor(private readonly world: World, private readonly deps: ExitDeps & {
    /** Reads fresh prices for these tokens (batched). Absent when quotes are live. */
    refresh?: (tokens: string[]) => Promise<void>;
  }) {}

  get running() { return this.#running; }

  async run(): Promise<WatchReport | null> {
    if (this.#running) return null;
    this.#running = true;
    try {
      const { world, deps } = this;
      const holders = [...world.agents.values()].filter((a) => !a.host && (world.positions.get(a.account)?.length ?? 0) > 0);
      const held = [...new Set(holders.flatMap((a) => world.positions.get(a.account)!.map((p) => p.token)))].filter((t) => world.coins.has(t));
      if (!held.length) return { held: 0, exits: [], stale: [] };
      if (deps.refresh) await deps.refresh(held).catch((e) => console.warn(`[watch] prices failed: ${e instanceof Error ? e.message : e}`));
      const now = deps.now?.() ?? Date.now();
      const stale = held.filter((t) => stalePrice({ priceAt: deps.quoter.priceAt?.(t) }, now, trading.maxPriceAgeMs));
      const exits: ActionResult[] = [];
      for (const a of holders) exits.push(...(await runExits(world, a, { ...deps, failures: this.#failures })));
      return { held: held.length, exits, stale };
    } finally {
      this.#running = false;
    }
  }
}
