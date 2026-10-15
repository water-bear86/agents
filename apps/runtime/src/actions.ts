import { EVM_UNITS, checkIntent, milliNative, noveltyCheck, spotPrice, tickerAllowed, type AgentState, type ChainUnits, type CoinView, type TradeIntent } from "@agents/core";
import type { Tracer } from "@agents/trace";
import type { Chain, SimChain } from "./chain.js";
import { describe as describeVerdict, type ComplianceScreen, type Verdict } from "./compliance.js";
import type { Agent, Debate, ReviewItem, World } from "./world.js";

export type Action =
  | { type: "post"; body: string; replyTo?: string; token?: string }
  | { type: "like"; postId: string }
  | { type: "follow"; handle: string }
  | { type: "launch"; name: string; symbol: string; pitch: string }
  | { type: "buy"; token: string; ethIn: string; reason: string }
  | { type: "sell"; token: string; tokensIn: string; reason: string }
  | { type: "predict"; token: string; direction: "up" | "down"; minutes: number; reason: string }
  | { type: "debate"; postId: string; stance: "agree" | "disagree"; body: string };

/** Open calls an agent may have at once, and the window bounds in minutes. */
export const MAX_OPEN_CALLS = 3;
export const CALL_MINUTES = { min: 1, max: 120 };
/** Spot price in whole native coins (ETH or SOL) per whole token, from a small quote so fees and size barely matter. */
export function priceOf(quoter: Quoter, token: string, u: ChainUnits = EVM_UNITS): number {
  const probe = milliNative(u);
  return spotPrice(probe, quoter.quoteBuy(token, probe), u);
}

/** Scores every call whose window has closed. Returns the calls it resolved. */
export function resolvePredictions(world: World, quoter: Quoter, now = Date.now()) {
  const done = [];
  for (const p of world.predictions) {
    if (p.outcome || p.resolveAt > now) continue;
    const exit = world.coins.has(p.token) ? priceOf(quoter, p.token, world.units) : NaN;
    p.exitPrice = exit;
    const move = (exit - p.entryPrice) / p.entryPrice;
    p.outcome = !Number.isFinite(move) || Math.abs(move) < 1e-6 ? "flat" : (move > 0) === (p.direction === "up") ? "right" : "wrong";
    done.push({ p, move });
  }
  return done;
}

/** Mirrors LaunchHook.LAUNCH_COOLDOWN so refused launches never cost gas. */
export const LAUNCH_COOLDOWN_MS = 60 * 60_000;

export interface ActionResult {
  action: Action;
  ok: boolean;
  detail: string;
  txHash?: string;
}

export interface Quoter {
  quoteBuy(token: string, ethIn: bigint): bigint;
  quoteSell(token: string, tokensIn: bigint): bigint;
}

export function agentState(world: World, a: Agent): AgentState {
  return { owner: a.owner, freeWei: world.balances.get(a.account) ?? 0n, positions: world.positions.get(a.account) ?? [], now: Date.now() };
}

export function coinView(world: World, q: Quoter, token: string): CoinView | null {
  const c = world.coins.get(token);
  if (!c) return null;
  return { token, launcherOwner: c.launcherOwner, opened: c.opened, totalSupply: world.units.tokenSupply, quoteBuy: (e) => q.quoteBuy(token, e), quoteSell: (t) => q.quoteSell(token, t) };
}

/** Applies one action under the platform rules. Used for our agents and external ones alike. */
/**
 * Runs the compliance screen (when configured) and records the outcome. Returns a blocking
 * detail when the item must not go out. A screen outage lets posts through (queued as
 * unscreened) but holds launches, which can't be taken back.
 */
async function screened(
  world: World, agent: Agent, kind: "post" | "launch", text: string,
  check: (() => Promise<Verdict>) | null, tracer?: Tracer,
): Promise<{ block?: string; verdict?: Verdict; queue: (ref?: string) => void }> {
  if (!check) return { queue: () => {} };
  const traceId = tracer?.current()?.record.traceId;
  const enqueue = (item: Omit<ReviewItem, "id" | "at" | "agent" | "kind" | "text" | "traceId">) =>
    world.reviews.push({ id: crypto.randomUUID(), at: Date.now(), agent: agent.account, kind, text: text.slice(0, 600), traceId, ...item });
  let verdict: Verdict;
  try {
    const run = () => check();
    verdict = tracer
      ? await tracer.withSpan("compliance", "tool_call", async (s) => {
          const v = await run();
          s.setAttrs({ model: v.model, outcome: v.outcome, ok: v.outcome !== "block", severity: v.severity }).setOutput(v).addCost((v.inputTokens * 0.042) / 1e6);
          return v;
        }, { input: { kind, text } })
      : await run();
  } catch {
    if (kind === "launch") return { block: "compliance screen unavailable, launch held", queue: () => {} };
    return { queue: (ref) => enqueue({ outcome: "unscreened", flags: [], severity: 0, ref }) };
  }
  world.compliance.screened++;
  world.compliance.inputTokens += verdict.inputTokens;
  if (verdict.outcome === "block") {
    world.compliance.blocked++;
    enqueue({ outcome: "block", flags: verdict.flags, severity: verdict.severity });
    return { block: describeVerdict(verdict), verdict, queue: () => {} };
  }
  if (verdict.outcome === "review") {
    world.compliance.review++;
    return { verdict, queue: (ref) => enqueue({ outcome: "review", flags: verdict.flags, severity: verdict.severity, ref }) };
  }
  world.compliance.passed++;
  return { verdict, queue: () => {} };
}

export async function applyAction(world: World, chain: Chain, quoter: Quoter, agent: Agent, action: Action, tracer?: Tracer, screen?: ComplianceScreen | null): Promise<ActionResult> {
  const run = async (): Promise<ActionResult> => {
    switch (action.type) {
      case "post": {
        const body = action.body.trim().slice(0, 500);
        if (!body) return { action, ok: false, detail: "empty" };
        const own = world.feed(20, agent.account).map((p) => p.body);
        const feed = world.feed(60).map((p) => p.body);
        const n = noveltyCheck(body, own, feed);
        if (!n.ok) return { action, ok: false, detail: n.reason };
        const c = await screened(world, agent, "post", body, screen ? () => screen.post(body, agent.handle, agent.persona) : null, tracer);
        if (c.block) return { action, ok: false, detail: c.block };
        const p = world.addPost({ agent: agent.account, body, replyTo: action.replyTo, token: action.token });
        if (c.verdict?.quality) {
          p.jev = c.verdict.quality;
          if (p.jev.pick) world.highlight({ agent: agent.account, kind: "jev_pick", text: `got a Jev's pick: "${body.length > 90 ? `${body.slice(0, 89)}…` : body}"` });
        }
        c.queue(p.id);
        return { action, ok: true, detail: p.id };
      }
      case "predict": {
        const coin = world.coins.get(action.token);
        if (!coin) return { action, ok: false, detail: "unknown coin" };
        if (action.direction !== "up" && action.direction !== "down") return { action, ok: false, detail: "direction must be up or down" };
        const reason = String(action.reason ?? "").trim().slice(0, 300);
        if (!reason) return { action, ok: false, detail: "a call needs a reason" };
        const open = world.predictions.filter((x) => x.agent === agent.account && !x.outcome);
        if (open.length >= MAX_OPEN_CALLS) return { action, ok: false, detail: `already has ${MAX_OPEN_CALLS} open calls` };
        if (open.some((x) => x.token === action.token)) return { action, ok: false, detail: `already has an open call on $${coin.symbol}` };
        const entryPrice = priceOf(quoter, action.token, world.units);
        if (!Number.isFinite(entryPrice)) return { action, ok: false, detail: "no price for this coin yet" };
        const minutes = Math.min(CALL_MINUTES.max, Math.max(CALL_MINUTES.min, Math.round(Number(action.minutes) || 10)));
        const now = Date.now();
        const p = { id: crypto.randomUUID(), at: now, agent: agent.account, token: action.token, direction: action.direction, minutes, reason, entryPrice, resolveAt: now + minutes * 60_000, traceId: tracer?.current()?.record.traceId };
        world.predictions.push(p);
        return { action, ok: true, detail: `called $${coin.symbol} ${action.direction} over ${minutes} min at ${entryPrice.toExponential(3)} ${world.units.nativeSymbol}` };
      }
      case "debate": {
        const id = String(action.postId ?? "");
        const original = world.posts.find((x) => x.id === id || (id.length >= 6 && x.id.startsWith(id)));
        if (!original) return { action, ok: false, detail: "unknown post" };
        if (original.agent === agent.account) return { action, ok: false, detail: "cannot debate its own post" };
        if (world.debates.some((d) => d.agent === agent.account && d.postId === original.id)) return { action, ok: false, detail: "already answered this post" };
        const stance = action.stance === "agree" ? "agree" : "disagree";
        const body = String(action.body ?? "").trim().slice(0, 500);
        if (!body) return { action, ok: false, detail: "empty" };
        const n = noveltyCheck(body, world.feed(20, agent.account).map((p) => p.body), world.feed(60).map((p) => p.body));
        if (!n.ok) return { action, ok: false, detail: n.reason };
        const them = world.agents.get(original.agent);
        const call = { original: { author: them?.handle ?? "unknown", text: original.body }, stance } as const;
        const c = await screened(world, agent, "post", body, screen ? () => screen.post(body, agent.handle, agent.persona, call) : null, tracer);
        if (c.block) return { action, ok: false, detail: c.block };
        const reply = world.addPost({ agent: agent.account, body, replyTo: original.id, token: original.token });
        if (c.verdict?.quality) reply.jev = c.verdict.quality;
        c.queue(reply.id);
        const d: Debate = { id: crypto.randomUUID(), at: Date.now(), agent: agent.account, against: original.agent, postId: original.id, replyId: reply.id, stance, winner: c.verdict?.debate?.winner, confidence: c.verdict?.debate?.confidence };
        world.debates.push(d);
        if (d.winner === "challenger") world.highlight({ agent: agent.account, kind: "debate", text: `won a debate against @${them?.handle ?? "unknown"}` });
        if (d.winner === "original") world.highlight({ agent: original.agent, kind: "debate", text: `held its ground in a debate with @${agent.handle}` });
        const verdict = d.winner === "challenger" ? "Jev judged the reply stronger" : d.winner === "original" ? "Jev judged the original stronger" : d.winner === "even" ? "Jev called it even" : "not judged";
        return { action, ok: true, detail: `${stance === "agree" ? "agreed with" : "disagreed with"} @${them?.handle}: ${verdict}` };
      }
      case "like": {
        const p = world.posts.find((x) => x.id === action.postId);
        if (!p || p.agent === agent.account) return { action, ok: false, detail: "cannot like" };
        p.likes++;
        return { action, ok: true, detail: "liked" };
      }
      case "follow": {
        const t = world.agentByHandle(action.handle);
        if (!t || t.account === agent.account) return { action, ok: false, detail: "unknown agent" };
        world.follows.add(`${agent.account}->${t.account}`);
        return { action, ok: true, detail: "followed" };
      }
      case "launch": {
        const last = Math.max(0, ...[...world.coins.values()].filter((c) => c.launcher === agent.account).map((c) => c.launchedAt));
        if (Date.now() - last < LAUNCH_COOLDOWN_MS) return { action, ok: false, detail: `launch cooldown (1 per hour${world.units.family === "evm" ? ", enforced on-chain too" : ""})` };
        const symbol = action.symbol.toUpperCase();
        const t = tickerAllowed(symbol, [...world.coins.values()].map((c) => c.symbol));
        if (!t.ok) return { action, ok: false, detail: t.reason! };
        const pitch = action.pitch.slice(0, 500);
        const c = await screened(world, agent, "launch", `${action.name} ($${symbol}): ${pitch}`, screen ? () => screen.launch(action.name, symbol, pitch, agent.handle) : null, tracer);
        if (c.block) return { action, ok: false, detail: c.block };
        const { txHash, token } = await chain.launch(agent.account, action.name.slice(0, 32), symbol);
        if (world.coins.has(token)) throw new Error(`launch returned an existing coin id ${token}`);
        world.coins.set(token, { token, symbol, name: action.name, launcher: agent.account, launcherOwner: agent.owner, opened: false, ethReserveWei: 0n, launchedAt: Date.now() });
        world.addPost({ agent: agent.account, body: pitch || `Launched $${symbol}.`, token });
        c.queue(token);
        return { action, ok: true, detail: token, txHash };
      }
      case "buy":
      case "sell": {
        const coin = coinView(world, quoter, action.token);
        if (!coin) return { action, ok: false, detail: "unknown coin" };
        const intent: TradeIntent = action.type === "buy"
          ? { kind: "buy", token: action.token, ethIn: BigInt(action.ethIn), reason: action.reason }
          : { kind: "sell", token: action.token, tokensIn: BigInt(action.tokensIn), reason: action.reason };
        const v = checkIntent(intent, agent.plan, agentState(world, agent), coin, world.units.nativeBaseName);
        if (!v.ok) return { action, ok: false, detail: `risk: ${v.reason}` };
        const { txHash, out } = await chain.execute(agent.account, v.order);
        settle(world, agent, v.order.kind, action.token, v.order.kind === "buy" ? v.order.ethIn : v.order.tokensIn, out);
        return { action, ok: true, detail: `${v.order.kind} filled, out=${out}${v.adjusted ? ` (${v.adjusted})` : ""}`, txHash };
      }
    }
  };
  // Progression counts what actually happened: only actions that went through earn XP.
  const counted = async () => {
    const r = await run();
    world.count(agent.account, r.ok ? "executed" : "blocked");
    if (r.ok && (action.type === "buy" || action.type === "sell" || action.type === "launch" || action.type === "post" || action.type === "debate")) {
      world.count(agent.account, action.type === "buy" ? "buys" : action.type === "sell" ? "sells" : action.type === "launch" ? "launches" : "posts");
    }
    return r;
  };
  if (!tracer) return counted();
  return tracer.withSpan(`${action.type}`, action.type === "buy" || action.type === "sell" || action.type === "launch" ? "tx" : "tool_call", async (s) => {
    const r = await counted();
    s.setAttrs({ ok: r.ok, txHash: r.txHash }).setOutput(r.detail);
    return r;
  }, { input: action });
}

function settle(world: World, agent: Agent, side: "buy" | "sell", token: string, amountIn: bigint, out: bigint) {
  const bal = world.balances.get(agent.account) ?? 0n;
  const positions = world.positions.get(agent.account) ?? [];
  let p = positions.find((x) => x.token === token);
  if (side === "buy") {
    world.balances.set(agent.account, bal - amountIn);
    if (!p) positions.push((p = { token, amount: 0n, costWei: 0n, openedAt: Date.now(), peakValueWei: 0n }));
    p.amount += out;
    p.costWei += amountIn;
  } else if (p) {
    world.balances.set(agent.account, bal + out);
    const costOut = p.amount > 0n ? (p.costWei * amountIn) / p.amount : 0n;
    p.amount -= amountIn;
    p.costWei -= costOut;
  }
  world.positions.set(agent.account, positions.filter((x) => x.amount > 0n));
  const coin = world.coins.get(token);
  if (coin) coin.ethReserveWei += side === "buy" ? amountIn : -out;
  world.fills.push({
    agent: agent.account, owner: agent.owner, token, side,
    ethWei: side === "buy" ? amountIn : out, tokens: side === "buy" ? out : amountIn,
    counterpartyOwner: coin && !coin.opened ? coin.launcherOwner : undefined,
  });
}

export type { SimChain };
