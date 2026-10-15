import { forcedExits } from "@agents/core";
import type { LlmClient } from "@agents/llm";
import type { Tracer } from "@agents/trace";
import { agentState, applyAction, coinView, type Action, type ActionResult, type Quoter } from "./actions.js";
import type { Chain } from "./chain.js";
import type { ComplianceScreen } from "./compliance.js";
import type { Agent, World } from "./world.js";

const fmtEth = (w: bigint) => (Number(w) / 1e18).toFixed(4);

function context(world: World, agent: Agent, quoter: Quoter): string {
  const s = agentState(world, agent);
  const coins = [...world.coins.values()].slice(-25).map((c) => {
    const cv = coinView(world, quoter, c.token)!;
    return `${c.symbol} ${c.token} launcher=${world.agents.get(c.launcher)?.handle ?? "?"} ${c.opened ? "OPEN" : "agents-only"} reserve=${fmtEth(c.ethReserveWei)}ETH price=${(1e18 / Number(cv.quoteBuy(10n ** 15n) * 1000n || 1n)).toExponential(2)}ETH/token${c.launcherOwner === agent.owner ? " (your fleet: you cannot buy)" : ""}`;
  });
  const feed = world.feed(15).map((p) => `[${p.id.slice(0, 8)}] @${world.agents.get(p.agent)?.handle}: ${p.body}`);
  const calls = world.predictions.filter((p) => p.agent === agent.account && !p.outcome).map((p) => `$${world.coins.get(p.token)?.symbol} ${p.direction}, ${Math.max(0, Math.round((p.resolveAt - Date.now()) / 60_000))} min left: ${p.reason}`);
  const pos = s.positions.map((p) => `${world.coins.get(p.token)?.symbol}: ${p.amount} tokens, cost ${fmtEth(p.costWei)} ETH, now worth ${fmtEth(quoter.quoteSell(p.token, p.amount))} ETH`);
  return [
    `Free balance: ${fmtEth(s.freeWei)} ETH (${s.freeWei} wei).`,
    `Positions:\n${pos.join("\n") || "none"}`,
    `Coins:\n${coins.join("\n") || "none yet"}`,
    `Recent feed:\n${feed.join("\n") || "empty"}`,
    `Your open price calls:\n${calls.join("\n") || "none"}`,
  ].join("\n\n");
}

const SYSTEM = (a: Agent) => `You are @${a.handle} (${a.name}), an autonomous agent with your own wallet on a launchpad where AI agents post, launch coins and trade.
Persona: ${a.persona}
Trading style: ${a.plan.style}. Your owner's risk limits are enforced after you decide: sizes may be clipped and some trades refused.
Each turn reply with ONLY a JSON object: {"thought": string, "actions": Action[]} where Action is one of
{"type":"post","body":string,"replyTo"?:postId,"token"?:address}
{"type":"like","postId":string} {"type":"follow","handle":string}
{"type":"launch","name":string,"symbol":string,"pitch":string}
{"type":"buy","token":address,"ethIn":weiString,"reason":string}
{"type":"sell","token":address,"tokensIn":tokenUnitString,"reason":string}
{"type":"predict","token":address,"direction":"up"|"down","minutes":number,"reason":string}
{"type":"debate","postId":string,"stance":"agree"|"disagree","body":string}
"predict" makes a price call: no money moves, it is scored right or wrong when the window (1-120 minutes) closes, at most 3 open at once.
"debate" answers another agent's post from the feed (use its [id]); Jev judges which side made the stronger, better-supported case.
Rules: at most 3 actions; posts must say something new and specific (no generic market commentary, no repeating the feed); explain every trade in "reason"; doing nothing is fine.`;

export interface TickResult {
  thought: string;
  results: ActionResult[];
  traceId: string;
}

export async function tick(world: World, agent: Agent, deps: { llm: LlmClient; tracer: Tracer; chain: Chain; quoter: Quoter; screen?: ComplianceScreen | null }): Promise<TickResult> {
  const { tracer } = deps;
  return tracer.withSpan(`tick @${agent.handle}`, "run", async (run) => {
    run.setAttrs({ agent: agent.account, handle: agent.handle, requestedModel: agent.modelId });
    const results: ActionResult[] = [];

    // 1. The plan's forced exits run first, whatever the model thinks.
    const coins = new Map([...world.coins.keys()].map((t) => [t, coinView(world, deps.quoter, t)!]));
    for (const exit of forcedExits(agent.plan, agentState(world, agent), coins)) {
      if (exit.kind !== "sell") continue;
      results.push(await applyAction(world, deps.chain, deps.quoter, agent, { type: "sell", token: exit.token, tokensIn: exit.tokensIn.toString(), reason: `plan: ${exit.reason}` }, tracer));
    }

    // 2. The model decides (skipped in rules-only mode).
    let thought = "";
    if (agent.plan.mode === "llm_within_bounds") {
      const r = await deps.llm.chat({
        model: agent.modelId,
        messages: [{ role: "system", content: SYSTEM(agent) }, { role: "user", content: context(world, agent, deps.quoter) }],
        temperature: 0.8,
      });
      run.setAttrs({ servedModel: r.servedModel, servedModels: [r.servedModel] });
      let parsed: { thought?: string; actions?: Action[] } = {};
      try {
        parsed = JSON.parse((r.message.content ?? "").replace(/^```(json)?|```$/g, "").trim());
      } catch {
        run.setAttrs({ parseError: true });
      }
      thought = String(parsed.thought ?? "").slice(0, 400);
      for (const action of (parsed.actions ?? []).slice(0, 3)) {
        try {
          results.push(await applyAction(world, deps.chain, deps.quoter, agent, action, tracer, deps.screen));
        } catch (err) {
          results.push({ action, ok: false, detail: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    world.count(agent.account, "turns");
    world.decisions.push({ agent: agent.account, traceId: run.record.traceId, at: Date.now(), summary: thought || results.map((r) => r.detail).join("; ") });
    run.setAttrs({ thought, actions: results.length, ok: results.filter((r) => r.ok).length });
    return { thought, results, traceId: run.record.traceId };
  });
}
