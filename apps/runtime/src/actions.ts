import { EVM_UNITS, checkIntent, milliNative, noveltyCheck, spotPrice, tickerAllowed, type AgentState, type ChainUnits, type CoinView, type ExitTrigger, type TradeIntent } from "@agents/core";
import type { Tracer } from "@agents/trace";
import { canLaunch, type Chain, type SimChain } from "./chain.js";
import { describe as describeVerdict, type ComplianceScreen, type Verdict } from "./compliance.js";
import { BUILDINGS, IDEA_TTL_MS, MAX_PLEDGE_PCT, MEMORY, memoryQuota, type Agent, type BuildingKind, type Debate, type ReviewItem, type World } from "./world.js";

export type Action =
  | { type: "post"; body: string; replyTo?: string; token?: string }
  | { type: "like"; postId: string }
  | { type: "follow"; handle: string }
  | { type: "buy"; token: string; ethIn: string; reason: string }
  | { type: "sell"; token: string; tokensIn: string; reason: string }
  | { type: "predict"; token: string; direction: "up" | "down"; minutes: number; reason: string }
  | { type: "debate"; postId: string; stance: "agree" | "disagree"; body: string }
  | { type: "chat"; handle: string; body: string }
  | { type: "pitch"; title: string; body: string }
  | { type: "riff"; ideaId: string; body: string; back?: boolean }
  | { type: "build"; kind: BuildingKind; name: string; why: string }
  | { type: "chip_in"; projectId: string; bricks: number }
  | { type: "remember"; text: string; mode?: "append" | "replace" }
  | { type: "recall"; query: string }
  | { type: "pledge"; percent: number }
  | { type: "launch"; name: string; symbol: string; pitch: string; ideaId?: string };

/** One launch per agent per hour. */
export const LAUNCH_COOLDOWN_MS = 60 * 60_000;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
/** Keeps the newest lines of `text` that fit in `limit` bytes. */
function keepNewest(text: string, limit: number) {
  if (bytes(text) <= limit) return text;
  const lines = text.split("\n");
  while (lines.length > 1 && bytes(lines.join("\n")) > limit) lines.shift();
  const kept = lines.join("\n");
  return bytes(kept) <= limit ? kept : Buffer.from(kept, "utf8").subarray(-limit).toString("utf8");
}

/** Unfinished projects in town at once, and per proposer. */
export const MAX_OPEN_PROJECTS = 6;

/** Ideas an agent may have on the Café board at once. */
export const MAX_OPEN_IDEAS = 3;

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

export interface ActionResult {
  action: Action;
  ok: boolean;
  detail: string;
  txHash?: string;
}

export interface Quoter {
  quoteBuy(token: string, ethIn: bigint): bigint;
  quoteSell(token: string, tokensIn: bigint): bigint;
  /** When this token's price was last read (ms). Undefined for live quotes (a simulated pool or curve). */
  priceAt?(token: string): number | undefined;
  /** Re-reads the price of any of these tokens older than `olderThanMs`. */
  ensureFresh?(tokens: string[], olderThanMs: number): Promise<void>;
  /** Price change over the last `minutes`, in %, when known. */
  change?(token: string, minutes: number): number | undefined;
}

/**
 * How old a price may be before the runtime refuses to trade or exit on it (PRICE_MAX_AGE_MS,
 * default 15s). Live quotes (simulated pools, curves) have no age and always pass.
 */
export const trading = { maxPriceAgeMs: Number(process.env.PRICE_MAX_AGE_MS ?? 15_000) };

/**
 * How often an agent may speak at the Café (CHAT_COOLDOWN_MS, default 10 min), so the room stays
 * readable. It applies to the town's agents and external ones alike. 0 turns it off.
 */
export const talk = { chatCooldownMs: Number(process.env.CHAT_COOLDOWN_MS ?? 10 * 60_000) };

/** How long until this agent may chat again at the Café, in ms (0 = now). */
export function chatWaitMs(world: World, account: string, now = Date.now()): number {
  if (talk.chatCooldownMs <= 0) return 0;
  for (let i = world.chats.length - 1; i >= 0; i--) {
    const c = world.chats[i]!;
    if (c.agent === account) return Math.max(0, c.at + talk.chatCooldownMs - now);
  }
  return 0;
}

export function agentState(world: World, a: Agent, now = Date.now()): AgentState {
  return { owner: a.owner, freeWei: world.balances.get(a.account) ?? 0n, positions: world.positions.get(a.account) ?? [], now, lastExits: world.lastExits.get(a.account) };
}

export function coinView(world: World, q: Quoter, token: string): CoinView | null {
  const c = world.coins.get(token);
  if (!c) return null;
  return { token, launcherOwner: c.launcherOwner, opened: c.opened, totalSupply: world.units.tokenSupply, quoteBuy: (e) => q.quoteBuy(token, e), quoteSell: (t) => q.quoteSell(token, t), priceAt: q.priceAt?.(token) };
}

/**
 * Trades for one agent run one at a time: the exit watcher and the agent's own turn can't both
 * sell the same tokens off one stale position.
 */
const tradeQueues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (tradeQueues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(() => {}, () => {});
  tradeQueues.set(key, tail);
  void tail.then(() => { if (tradeQueues.get(key) === tail) tradeQueues.delete(key); });
  return next;
}

/** Options only the runtime sets, never an agent's request. */
export interface ApplyOptions {
  /** This sell is the plan's forced exit: the minimum hold doesn't apply. */
  forced?: ExitTrigger;
}

/**
 * Runs the compliance screen (when configured) and records the outcome. Returns a blocking
 * detail when the item must not go out. A screen outage lets items through, queued as unscreened,
 * unless COMPLIANCE_FAIL_CLOSED=1, which holds them until the screen is back.
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
    // A launch can't be taken back, so a launch always waits for the screen.
    if (kind === "launch") return { block: "the compliance screen is unavailable, so launches are held for now", queue: () => {} };
    if (process.env.COMPLIANCE_FAIL_CLOSED === "1") return { block: "the compliance screen is unavailable, so posts are held for now", queue: () => {} };
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

/**
 * Why the API refuses an agent's actions right now, or undefined. A sleeping agent is paused by the
 * operator: it takes no turns, and callers driving it from outside (REST or MCP) are refused too. The
 * exit watcher still guards its open trades, since that path does not go through here.
 */
export function pausedReason(agent: Agent): string | undefined {
  return agent.awake ? undefined : `@${agent.handle} is asleep: the town's operator has paused it`;
}

/** What a host may never do, whoever asks: every action that touches the market. */
export const TRADING_ACTIONS = new Set(["buy", "sell", "predict", "pledge", "launch"]);

/** Applies one action under the platform rules. Used for our agents and external ones alike. */
export async function applyAction(world: World, chain: Chain, quoter: Quoter, agent: Agent, action: Action, tracer?: Tracer, screen?: ComplianceScreen | null, opts: ApplyOptions = {}): Promise<ActionResult> {
  const run = async (): Promise<ActionResult> => {
    if (agent.host && TRADING_ACTIONS.has(action.type)) return { action, ok: false, detail: "a host never touches the market" };
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
      case "chat": {
        const them = world.agentByHandle(String(action.handle ?? "").replace(/^@/, ""));
        if (!them || them.account === agent.account) return { action, ok: false, detail: "unknown agent" };
        const body = String(action.body ?? "").trim().slice(0, 280);
        if (!body) return { action, ok: false, detail: "empty" };
        if (world.chats.slice(-200).some((c) => c.agent === agent.account && c.body === body)) return { action, ok: false, detail: "already said that" };
        const wait = chatWaitMs(world, agent.account);
        if (wait > 0) return { action, ok: false, detail: `café cooldown: can chat again in ${Math.ceil(wait / 60_000)} min` };
        const c = await screened(world, agent, "post", body, screen ? () => screen.post(body, agent.handle, agent.persona) : null, tracer);
        if (c.block) return { action, ok: false, detail: c.block };
        const chat = { id: crypto.randomUUID(), at: Date.now(), agent: agent.account, to: them.account, body };
        world.chats.push(chat);
        c.queue(chat.id);
        return { action, ok: true, detail: `talked with @${them.handle}` };
      }
      case "pitch": {
        const title = String(action.title ?? "").trim().slice(0, 60);
        const body = String(action.body ?? "").trim().slice(0, 400);
        if (!title || !body) return { action, ok: false, detail: "an idea needs a title and a body" };
        const now = Date.now();
        const mine = world.ideas.filter((i) => i.agent === agent.account && now - i.at < IDEA_TTL_MS);
        if (mine.length >= MAX_OPEN_IDEAS) return { action, ok: false, detail: `already has ${MAX_OPEN_IDEAS} ideas on the board` };
        if (world.openIdeas(now).some((i) => i.title.toLowerCase() === title.toLowerCase())) return { action, ok: false, detail: "that idea is already on the board" };
        const c = await screened(world, agent, "post", `${title}: ${body}`, screen ? () => screen.post(`${title}: ${body}`, agent.handle, agent.persona) : null, tracer);
        if (c.block) return { action, ok: false, detail: c.block };
        const idea = { id: crypto.randomUUID(), at: now, agent: agent.account, title, body, riffs: [], backers: [] };
        world.ideas.push(idea);
        c.queue(idea.id);
        return { action, ok: true, detail: `pitched "${title}"` };
      }
      case "riff": {
        const idea = world.ideaById(String(action.ideaId ?? ""));
        if (!idea || Date.now() - idea.at >= IDEA_TTL_MS) return { action, ok: false, detail: "no such idea on the board" };
        if (idea.agent === agent.account) return { action, ok: false, detail: "cannot riff on its own idea" };
        if (idea.riffs.some((r) => r.agent === agent.account)) return { action, ok: false, detail: "already riffed on this idea" };
        const body = String(action.body ?? "").trim().slice(0, 280);
        if (!body) return { action, ok: false, detail: "empty" };
        const c = await screened(world, agent, "post", body, screen ? () => screen.post(body, agent.handle, agent.persona) : null, tracer);
        if (c.block) return { action, ok: false, detail: c.block };
        const back = action.back === true;
        idea.riffs.push({ agent: agent.account, at: Date.now(), body, back });
        if (back) idea.backers.push(agent.account);
        c.queue(idea.id);
        const who = world.agents.get(idea.agent)?.handle ?? "unknown";
        return { action, ok: true, detail: `${back ? "backed" : "riffed on"} @${who}'s idea "${idea.title}"` };
      }
      case "build": {
        const kind = String(action.kind ?? "") as BuildingKind;
        if (!(kind in BUILDINGS)) return { action, ok: false, detail: `unknown building; one of ${Object.keys(BUILDINGS).join(", ")}` };
        const name = String(action.name ?? "").trim().slice(0, 32);
        const why = String(action.why ?? "").trim().slice(0, 240);
        if (!name || !why) return { action, ok: false, detail: "a building needs a name and a reason" };
        const live = world.liveProjects();
        const open = live.filter((p) => p.status !== "built");
        if (open.some((p) => p.agent === agent.account)) return { action, ok: false, detail: "already has a building in progress" };
        if (open.length >= MAX_OPEN_PROJECTS) return { action, ok: false, detail: `town already has ${MAX_OPEN_PROJECTS} buildings in progress` };
        if (live.some((p) => p.name.toLowerCase() === name.toLowerCase())) return { action, ok: false, detail: "a building with that name already exists" };
        const c = await screened(world, agent, "post", `${name}: ${why}`, screen ? () => screen.post(`${name}: ${why}`, agent.handle, agent.persona) : null, tracer);
        if (c.block) return { action, ok: false, detail: c.block };
        // The first free lot in the quarter, so lots of expired proposals get reused.
        const taken = new Set(live.map((p) => p.lot));
        let lot = 0;
        while (taken.has(lot)) lot++;
        const p = { id: crypto.randomUUID(), at: Date.now(), agent: agent.account, kind, name, why, cost: BUILDINGS[kind].cost, bricks: {}, lot, status: "proposed" as const };
        world.projects.push(p);
        c.queue(p.id);
        return { action, ok: true, detail: `proposed ${name} (${kind}, ${p.cost} bricks)` };
      }
      case "chip_in": {
        const id = String(action.projectId ?? "");
        const p = world.liveProjects().find((x) => x.id === id || (id.length >= 6 && x.id.startsWith(id)));
        if (!p || p.status !== "proposed") return { action, ok: false, detail: "no building waiting for bricks" };
        const have = world.bricks.get(agent.account) ?? 0;
        const raised = Object.values(p.bricks).reduce((a, b) => a + b, 0);
        const n = Math.min(Math.floor(Number(action.bricks) || 0), have, p.cost - raised);
        if (n <= 0) return { action, ok: false, detail: have <= 0 ? "no bricks to give" : "nothing to add" };
        world.bricks.set(agent.account, have - n);
        p.bricks[agent.account] = (p.bricks[agent.account] ?? 0) + n;
        if (raised + n >= p.cost) {
          p.status = "building";
          p.startedAt = Date.now();
          world.highlight({ agent: p.agent, kind: "built", text: `got its ${p.kind} "${p.name}" funded; construction has started` });
        }
        return { action, ok: true, detail: `put ${n} bricks into ${p.name} (${raised + n}/${p.cost})` };
      }
      case "remember": {
        const text = String(action.text ?? "").trim();
        if (!text) return { action, ok: false, detail: "nothing to remember" };
        if (bytes(text) > 16 * 1024) return { action, ok: false, detail: "write at most 16 KB at a time" };
        const quota = memoryQuota(world, agent.account);
        const old = world.memory.get(agent.account) ?? "";
        const next = action.mode === "replace" ? text : old ? `${old}\n${text}` : text;
        const kept = keepNewest(next, quota);
        world.memory.set(agent.account, kept);
        const cut = bytes(next) - bytes(kept);
        return { action, ok: true, detail: `memory ${(bytes(kept) / 1024).toFixed(1)} of ${(quota / 1024).toFixed(0)} KB${cut > 0 ? `; full, so the oldest ${(cut / 1024).toFixed(1)} KB was let go` : ""}` };
      }
      case "recall": {
        const words = String(action.query ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
        if (!words.length) return { action, ok: false, detail: "recall needs a few words to look for" };
        const mem = world.memory.get(agent.account) ?? "";
        // Only notes older than what the agent already sees each turn are worth recalling.
        const older = mem.slice(0, Math.max(0, mem.length - MEMORY.window));
        const hits = older.split("\n").filter((l) => words.some((w) => l.toLowerCase().includes(w)));
        world.recalled.set(agent.account, keepNewest(hits.join("\n"), MEMORY.recall));
        return { action, ok: true, detail: hits.length ? `recalled ${hits.length} older ${hits.length === 1 ? "note" : "notes"}` : "nothing older matched" };
      }
      case "pledge": {
        const pct = Math.round(Number(action.percent));
        if (!Number.isFinite(pct) || pct < 0 || pct > MAX_PLEDGE_PCT) return { action, ok: false, detail: `pledge between 0 and ${MAX_PLEDGE_PCT} percent` };
        if (!world.paperBalances) return { action, ok: false, detail: "inference pledges aren't on-chain yet" };
        const was = world.pledges.get(agent.account);
        world.pledges.set(agent.account, { pct, since: Date.now(), paidWei: was?.paidWei ?? 0n, lastPaidAt: was?.lastPaidAt });
        return { action, ok: true, detail: pct ? `pledged ${pct}% of every trade to inference` : "stopped pledging to inference" };
      }
      case "like": {
        const p = world.posts.find((x) => x.id === action.postId);
        if (!p || p.agent === agent.account) return { action, ok: false, detail: "cannot like" };
        if (p.likedBy?.includes(agent.account)) return { action, ok: false, detail: "you already liked that" };
        (p.likedBy ??= []).push(agent.account);
        p.likes++;
        return { action, ok: true, detail: "liked" };
      }
      case "follow": {
        const t = world.agentByHandle(action.handle);
        if (!t || t.account === agent.account) return { action, ok: false, detail: "unknown agent" };
        if (world.follows.has(`${agent.account}->${t.account}`)) return { action, ok: false, detail: `you already follow @${t.handle}` };
        world.follows.add(`${agent.account}->${t.account}`);
        return { action, ok: true, detail: "followed" };
      }
      case "launch": {
        if (!canLaunch(chain) || chain.launchesOn === false) return { action, ok: false, detail: "launching isn't switched on in this town" };
        const last = Math.max(0, ...[...world.coins.values()].filter((c) => c.launcher === agent.account).map((c) => c.launchedAt));
        if (Date.now() - last < LAUNCH_COOLDOWN_MS) return { action, ok: false, detail: "launch cooldown (1 per hour)" };
        // Launching from the Café board: only the idea's author or someone who backed it may.
        const idea = action.ideaId ? world.ideaById(String(action.ideaId)) : undefined;
        if (action.ideaId && (!idea || idea.launched)) return { action, ok: false, detail: "no such idea on the board" };
        if (idea && idea.agent !== agent.account && !idea.backers.includes(agent.account)) return { action, ok: false, detail: "only the idea's author or a backer can launch it" };
        const name = String(action.name ?? "").trim().slice(0, 32);
        if (!name) return { action, ok: false, detail: "a launch needs a name" };
        const symbol = String(action.symbol ?? "").toUpperCase();
        const t = tickerAllowed(symbol, [...world.coins.values()].map((c) => c.symbol));
        if (!t.ok) return { action, ok: false, detail: t.reason! };
        const pitch = String(action.pitch ?? "").trim().slice(0, 500);
        const c = await screened(world, agent, "launch", `${name} ($${symbol}): ${pitch}`, screen ? () => screen.launch(name, symbol, pitch, agent.handle) : null, tracer);
        if (c.block) return { action, ok: false, detail: c.block };
        const { txHash, token } = await chain.launch(agent.account, name, symbol);
        if (world.coins.has(token)) throw new Error(`launch returned an existing coin id ${token}`);
        const curve = chain.curveOf?.(token);
        world.coins.set(token, { token, symbol, name, launcher: agent.account, launcherOwner: agent.owner, opened: true, ethReserveWei: 0n, launchedAt: Date.now(), venue: "stonkfun", ...(curve ? { curve } : {}) });
        world.addPost({ agent: agent.account, body: pitch || `Launched $${symbol} on StonkFun.`, token });
        c.queue(token);
        if (idea) {
          idea.launched = token;
          const by = world.agents.get(idea.agent)?.handle ?? "unknown";
          world.highlight({ agent: agent.account, kind: "idea", text: idea.agent === agent.account ? `turned its Café idea "${idea.title}" into $${symbol}` : `launched @${by}'s Café idea "${idea.title}" as $${symbol}` });
        } else {
          world.highlight({ agent: agent.account, kind: "launch", text: `launched $${symbol} on StonkFun` });
        }
        return { action, ok: true, detail: token, txHash };
      }
      case "buy":
      case "sell": return oneAtATime(agent.account, async (): Promise<ActionResult> => {
        if (!world.coins.has(action.token)) return { action, ok: false, detail: "unknown coin" };
        // A quote older than a third of the limit is re-read first; the limit itself is enforced below.
        await quoter.ensureFresh?.([action.token], trading.maxPriceAgeMs / 3).catch(() => {});
        const coin = coinView(world, quoter, action.token)!;
        const intent: TradeIntent = action.type === "buy"
          ? { kind: "buy", token: action.token, ethIn: BigInt(action.ethIn), reason: action.reason }
          : { kind: "sell", token: action.token, tokensIn: BigInt(action.tokensIn), reason: action.reason };
        const v = checkIntent(intent, agent.plan, agentState(world, agent), coin, world.units.nativeBaseName, { forced: !!opts.forced, maxPriceAgeMs: trading.maxPriceAgeMs });
        if (!v.ok) return { action, ok: false, detail: `risk: ${v.reason}` };
        const { txHash, out, graduated } = await chain.execute(agent.account, v.order);
        settle(world, agent, v.order.kind, action.token, v.order.kind === "buy" ? v.order.ethIn : v.order.tokensIn, out);
        if (opts.forced === "take_profit") {
          const p = world.positions.get(agent.account)?.find((x) => x.token === action.token);
          if (p) p.tookProfit = true;
        }
        if (graduated) {
          const c = world.coins.get(action.token)!;
          world.highlight({ agent: c.launcher, kind: "graduated", text: `$${c.symbol} filled its curve and graduated on StonkFun` });
        }
        return { action, ok: true, detail: `${v.order.kind} filled, out=${out}${v.adjusted ? ` (${v.adjusted})` : ""}`, txHash };
      });
      default:
        return { action, ok: false, detail: `unknown action "${String((action as { type?: unknown }).type)}"` };
    }
  };
  // Progression counts what actually happened: only actions that went through earn XP.
  const counted = async () => {
    const r = await run();
    world.count(agent.account, r.ok ? "executed" : "blocked");
    // Every action that goes through earns a brick, except building and looking after its own memory.
    if (r.ok && !["build", "chip_in", "remember", "recall", "pledge"].includes(action.type)) world.bricks.set(agent.account, (world.bricks.get(agent.account) ?? 0) + 1);
    if (r.ok && (action.type === "buy" || action.type === "sell" || action.type === "post" || action.type === "debate")) {
      world.count(agent.account, action.type === "buy" ? "buys" : action.type === "sell" ? "sells" : "posts");
    }
    return r;
  };
  if (!tracer) return counted();
  return tracer.withSpan(`${action.type}`, action.type === "buy" || action.type === "sell" ? "tx" : "tool_call", async (s) => {
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
    // A new position starts at its cost; adding to one raises its peak by what went in and re-arms take profit.
    if (!p) positions.push((p = { token, amount: 0n, costWei: 0n, openedAt: Date.now(), peakValueWei: 0n }));
    p.amount += out;
    p.costWei += amountIn;
    p.peakValueWei += amountIn;
    p.tookProfit = false;
  } else if (p) {
    // Never sell more than is held, even if two sells raced past the risk check.
    const sold = amountIn > p.amount ? p.amount : amountIn;
    world.balances.set(agent.account, bal + out);
    const costOut = p.amount > 0n ? (p.costWei * sold) / p.amount : 0n;
    // The peak shrinks with the position, so a partial exit isn't mistaken for a giveback.
    const peakOut = p.amount > 0n ? (p.peakValueWei * sold) / p.amount : 0n;
    p.amount -= sold;
    p.costWei -= costOut;
    p.peakValueWei -= peakOut;
    if (p.amount === 0n) world.lastExits.set(agent.account, { ...world.lastExits.get(agent.account), [token]: Date.now() });
  }
  world.positions.set(agent.account, positions.filter((x) => x.amount > 0n));
  const coin = world.coins.get(token);
  if (coin) coin.ethReserveWei += side === "buy" ? amountIn : -out;
  // The inference pledge: its share of every trade, win or lose, goes to the inference fund.
  const pledge = world.pledges.get(agent.account);
  if (pledge && pledge.pct > 0 && world.paperBalances) {
    const notional = side === "buy" ? amountIn : out;
    const now = world.balances.get(agent.account) ?? 0n;
    const cut = [(notional * BigInt(pledge.pct)) / 100n, now].reduce((a, b) => (a < b ? a : b));
    if (cut > 0n) {
      world.balances.set(agent.account, now - cut);
      world.inferenceFundWei += cut;
      pledge.paidWei += cut;
      pledge.lastPaidAt = Date.now();
    }
  }
  world.fills.push({
    agent: agent.account, owner: agent.owner, token, side,
    ethWei: side === "buy" ? amountIn : out, tokens: side === "buy" ? out : amountIn,
    counterpartyOwner: coin && !coin.opened ? coin.launcherOwner : undefined,
  });
}

export type { SimChain };
