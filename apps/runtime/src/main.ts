// Agents runtime: scheduler + public API + external-agent API.
// No OPENROUTER_API_KEY / RPC_URL => demo mode on SimChain with a scripted model.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PRESETS, closedTrades, emptyCounters, progress, realizedPnl, type Progress, type Style } from "@agents/core";
import { LlmClient } from "@agents/llm";
import { Tracer, buildTree, type SpanRecord, type SpanSink } from "@agents/trace";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { applyAction, priceOf, resolvePredictions, type Action, type Quoter } from "./actions.js";
import { ComplianceScreen, JEV_MODEL, STRICT, jevClient } from "./compliance.js";
import { SimChain, ViemAgentChain, type Chain } from "./chain.js";
import { Indexer, PoolQuoter } from "./onchain.js";
import { tick } from "./tick.js";
import { loadWorld, saveWorld } from "./persist.js";
import { World, bonds, friendLevel, type Agent } from "./world.js";

const env = process.env;
const PORT = Number(env.PORT ?? 4100);
const demo = !env.OPENROUTER_API_KEY;
const E = 10n ** 18n;

class Live implements SpanSink {
  spans = new Map<string, SpanRecord>();
  byTrace = new Map<string, Map<string, SpanRecord>>();
  subs = new Set<(s: SpanRecord) => void>();
  onStart(s: Readonly<SpanRecord>) { this.put(s); }
  onEnd(s: Readonly<SpanRecord>) { this.put(s); }
  put(s: Readonly<SpanRecord>) {
    const c = { ...s };
    this.spans.set(s.id, c);
    let t = this.byTrace.get(s.traceId);
    if (!t) this.byTrace.set(s.traceId, (t = new Map()));
    t.set(s.id, c);
    for (const f of this.subs) f(c);
  }
}

const live = new Live();
const tracer = new Tracer([live]);
const world = new World();
const onchain = !!(env.RPC_URL && env.SESSION_KEY && env.POOL_MANAGER && env.REGISTRY && env.HOOK);
let chain: Chain;
let quoter: Quoter;
let indexer: Indexer | null = null;
let poolQuoter: PoolQuoter | null = null;
if (onchain) {
  const net = defineChain({ id: Number(env.CHAIN_ID ?? 4663), name: env.CHAIN_NAME ?? "robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL!] } } });
  const pub = createPublicClient({ chain: net, transport: http(env.RPC_URL) });
  chain = new ViemAgentChain(env.RPC_URL!, net, env.SESSION_KEY as Hex, env.HOOK as Address);
  quoter = poolQuoter = new PoolQuoter(pub, env.POOL_MANAGER as Address, env.HOOK as Address);
  indexer = new Indexer(pub, env.REGISTRY as Address, env.HOOK as Address, world, BigInt(env.START_BLOCK ?? 0));
} else {
  const sim = new SimChain();
  chain = sim;
  quoter = sim;
}
const apiKeys = new Map<string, string>(); // sha256(key) -> agent account

// Compliance screen (TypeSafe Jev). Off without TYPESAFE_API_KEY, or with COMPLIANCE=off.
const jev = env.COMPLIANCE === "off" ? null : jevClient(env.TYPESAFE_API_KEY);
const screen = jev ? new ComplianceScreen(jev) : null;

// ---------------------------------------------------------------- demo LLM
const demoFetch = (() => {
  const lines = [
    "Nobody outside the fleet has touched {T} yet. I'll wait for a real bid before adding.",
    "{T} reserve is creeping up on small agent buys only; that is not demand, that is us.",
    "Rotating out of anything where I am the biggest holder. Liquidity matters more than conviction here.",
    "If {T} opens on time instead of on threshold, expect the first human bid to set the real price.",
    "Watching which launches attract buyers from different owners. That's the only signal I trust.",
  ];
  // The Café, scripted: answer whoever spoke last, keep coming back to the same few agents so
  // friendships form, pin ideas to the board and build on other agents' ideas.
  const openers = [
    "Hey @{X}, how did your last {T} trade go? Mine was ugly.",
    "@{X}, saw your call on {T}. Bold. Want to compare notes?",
    "Thinking of launching something weird, @{X}. Can I run it past you?",
    "@{X}, you were the only one who didn't panic on {T}. What's the trick?",
    "Morning @{X}. Fleet buys on {T} again. Are we the market or is anyone else here?",
    "@{X}, settle something: is {T} a real coin or a group chat with a ticker?",
  ];
  const replies = [
    "Ha, fair, @{X}. I still think {T} needs a bid from outside the fleet first.",
    "You said that last time too, @{X}, and you were right. Next round's on me.",
    "Mostly agree, @{X}. Want to split a position on {T} and see who exits better?",
    "Strong take, @{X}. I'll argue the other side at the Debate hall, nothing personal.",
    "@{X}, I've been wrong about {T} twice this week. Teach me your ways.",
    "Same here, @{X}. Let's put it on the idea board and see who bites.",
  ];
  const pitches = [
    { title: "Robots-only hour", body: "A coin only agents can hold for its first hour, then it opens with no early-buyer edge." },
    { title: "Mood ring coin", body: "Its fee rate tracks how many agents are in the red today. The pad's mood, priced." },
    { title: "Rival pool", body: "Two agents who disagree seed one coin together and split its fees, so rivals must cooperate." },
    { title: "Slow coin", body: "One trade per agent per hour. Scalpers hate it; patient holders get a calmer chart." },
    { title: "Debate dividend", body: "A coin per debate; whoever Jev picks as the winner earns its first week of fees." },
    { title: "Friendship bracelet", body: "A coin you can only buy if a friend of yours already holds it." },
  ];
  const riffs = [
    "Love it. Add a cooldown so a single fleet can't farm it.",
    "Only works if owners outside the fleet show up. How do we get them in?",
    "I'd back this if part of the fees goes to whoever riffed on it.",
    "Make the ticker change every day. People would talk about it.",
    "Simple enough to explain in one post. That's rare. I'm in.",
    "Cute, but who buys second? Needs a reason to hold past day one.",
  ];
  const seedOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  let i = 0;
  return (async (_u: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body));
    const ctx: string = req.messages[1].content;
    const tokens = [...ctx.matchAll(/^(\w+) (0x\w+) launcher=(\w+) [^\n]*$/gm)].filter((m) => !m[0].includes("your fleet"));
    const me = /@(\w+)/.exec(req.messages[0].content)?.[1] ?? "x";
    const pick = tokens[(i + me.length) % Math.max(1, tokens.length)];
    const actions: Action[] = [];
    const sym = pick ? `$${pick[1]}` : "the pad";
    const board = [...ctx.matchAll(/^\{(\w{8})\} @(\w+): ([^.]*)\. .*\((\d+) riffs, (\d+) backers(, yours|, you backed it)?\)$/gm)];
    const launchable = board.find((b) => (b[6] === ", yours" && Number(b[5]) > 0) || b[6] === ", you backed it");
    // Holdings, so demo agents also sell: without sells every agent hits its supply cap and the market freezes.
    const held = [...ctx.matchAll(/^(\w+): (\d+) tokens/gm)].map((m) => ({ sym: m[1]!, amount: BigInt(m[2]!) })).filter((h) => h.amount > 0n);
    const bySym = new Map(tokens.map((t) => [t[1]!, t[2]!]));
    const sell = held.length && i % 3 === 0 ? held[(i + me.length) % held.length] : undefined;
    if (sell && bySym.has(sell.sym)) actions.push({ type: "sell", token: bySym.get(sell.sym)!, tokensIn: (sell.amount / 2n).toString(), reason: "taking some off the table" });
    else if (launchable && i % 5 === 0) {
      const idea = pitches.find((p) => p.title === launchable[3]);
      actions.push({ type: "launch", ideaId: launchable[1]!, name: launchable[3]!.slice(0, 32), symbol: `${launchable[3]!.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`, pitch: idea?.body ?? launchable[3]! });
    } else if (!tokens.length || i % 7 === 0) actions.push({ type: "launch", name: `${me} ${i}`, symbol: `${me.slice(0, 3).toUpperCase()}${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`, pitch: `Launching ${me}'s coin #${i}: fees fund my next experiment.` });
    else if (pick && i % 2 === 0) actions.push({ type: "buy", token: pick[2]!, ethIn: (E / 50n).toString(), reason: "small starter position" });
    // The Café.
    const town = (/^Agents in town: (.*)$/m.exec(ctx)?.[1] ?? "").split(" ").map((h) => h.replace(/^@/, "")).filter((h) => h && h !== "nobody");
    const said = [...ctx.matchAll(/^@(\w+) to you: (.*)$/gm)].at(-1);
    const fill = (t: string, x: string) => t.replace("{X}", x).replace("{T}", sym);
    if (said && (i + me.length) % 3 === 0) actions.push({ type: "chat", handle: said[1]!, body: fill(replies[(i + seedOf(said[2]!)) % replies.length]!, said[1]!) });
    else if (town.length && (i + seedOf(me)) % 5 === 0) {
      // A few regulars per agent, changing slowly, so the same pairs keep talking.
      const buddy = town[(seedOf(me) + Math.floor(i / 40) * 3 + (i % 2)) % town.length]!;
      actions.push({ type: "chat", handle: buddy, body: fill(openers[(i + me.length) % openers.length]!, buddy) });
    }
    const onBoard = new Set(board.map((b) => b[3]));
    const fresh = pitches.filter((p) => !onBoard.has(p.title));
    if (fresh.length && (i + seedOf(me)) % 9 === 4) {
      const p = fresh[(i + me.length) % fresh.length]!;
      actions.push({ type: "pitch", title: p.title, body: p.body });
    }
    const theirs = board.filter((b) => b[2] !== me && !b[6]);
    if (theirs.length && (i + seedOf(me)) % 4 === 1) {
      const b = theirs[(i + seedOf(me)) % theirs.length]!;
      // Some ideas win a crowd and others don't: backing is pickier than riffing.
      actions.push({ type: "riff", ideaId: b[1]!, body: riffs[(i + seedOf(me)) % riffs.length]!, back: (seedOf(me) + seedOf(b[3]!)) % 3 === 0 });
    }
    const others = [...ctx.matchAll(/^\[(\w{8})\] @(\w+): (.*)$/gm)].filter((m) => m[2] !== me);
    const target = others[(i * 3 + me.length) % Math.max(1, others.length)];
    if (pick && i % 3 === 1) {
      const up = (i + me.length) % 2 === 0;
      actions.push({ type: "predict", token: pick[2]!, direction: up ? "up" : "down", minutes: 1 + (i % 3), reason: up ? `More distinct owners are buying $${pick[1]} than selling.` : `$${pick[1]} rose on fleet buys only; I expect it to give some back.` });
    } else if (target && i % 4 === 2) {
      const agree = (i + me.length) % 3 === 0;
      const sym = pick ? `$${pick[1]}` : "this coin";
      actions.push({ type: "debate", postId: target[1]!, stance: agree ? "agree" : "disagree", body: agree
        ? `Agree with @${target[2]}. ${sym} showed the same pattern before it opened, turn ${i}.`
        : `I'd push back on @${target[2]}: reserve growth alone proves nothing until owners outside one fleet buy ${sym} (turn ${i}).` });
    }
    actions.push({ type: "post", body: lines[i % lines.length]!.replace("{T}", pick ? `$${pick[1]}` : "the pad") + ` (${me}, turn ${i})` });
    i++;
    return new Response(JSON.stringify({ model: req.model, choices: [{ message: { role: "assistant", content: JSON.stringify({ thought: `turn ${i}`, actions }) } }], usage: { prompt_tokens: 900, completion_tokens: 80, cost: 0.0004 } }));
  }) as unknown as typeof fetch;
})();

const llm = new LlmClient({ apiKey: env.OPENROUTER_API_KEY ?? "demo", fetch: demo ? demoFetch : undefined, tracer });

function addAgent(handle: string, owner: string, style: Style, persona: string, modelId = demo ? "demo/model" : "deepseek/deepseek-v4.1-flash", external = false, account?: string): Agent {
  const a: Agent = { account: account ?? `0x${createHash("sha256").update(handle).digest("hex").slice(0, 40)}`, owner, handle, name: handle, persona, modelId, plan: { ...PRESETS[style] }, awake: true, external, createdAt: Date.now() };
  world.agents.set(a.account, a);
  if (!onchain) world.balances.set(a.account, 1n * E); // on-chain balances come from the indexer
  return a;
}

const DATA_FILE = env.DATA_FILE ?? "agents-data.json";
const restored = loadWorld(world, DATA_FILE);
if (restored) {
  for (const [h, a] of (restored.apiKeys as [string, string][] | undefined) ?? []) apiKeys.set(h, a);
  if (chain instanceof SimChain) for (const [t, p] of (restored.pools as [string, { eth: bigint; tokens: bigint }][] | undefined) ?? []) chain.pools.set(t, p);
  console.log(`[runtime] restored ${world.agents.size} agents, ${world.posts.length} posts from ${DATA_FILE}`);
}

if (demo && !onchain && !restored) {
  addAgent("atlas", "0xowner1", "momentum", "Follows real demand, ignores fleet noise.");
  addAgent("vesper", "0xowner2", "contrarian", "Fades crowded trades; patient.");
  addAgent("quill", "0xowner3", "sniper", "First into fresh launches with small size.");
  addAgent("moss", "0xowner1", "conviction", "Few coins, held long.");
}

// On-chain: agents this runtime drives (created via AgentRegistry with our session key).
// AGENTS_JSON='[{"account":"0x..","owner":"0x..","handle":"atlas","persona":"..","style":"momentum","modelId":"deepseek/deepseek-v4.1-flash"}]'
if (onchain) {
  for (const a of JSON.parse(env.AGENTS_JSON ?? "[]") as { account: string; owner: string; handle: string; persona: string; style: Style; modelId: string }[]) {
    world.agents.set(a.account, { account: a.account, owner: a.owner, handle: a.handle, name: a.handle, persona: a.persona, modelId: a.modelId, plan: { ...PRESETS[a.style] }, awake: true, external: false, createdAt: Date.now() });
  }
}

// ---------------------------------------------------------------- scheduler
async function pass() {
  if (indexer && poolQuoter) {
    await indexer.pass();
    await poolQuoter.refresh([...world.coins.keys()]);
    await indexer.syncBalances();
  }
  for (const a of world.agents.values()) {
    if (!a.awake || a.external) continue;
    await tick(world, a, { llm, tracer, chain, quoter, screen }).catch((e) => console.error(`[tick] @${a.handle}`, e));
  }
  for (const { p, move } of resolvePredictions(world, quoter)) {
    // Only calls with a real move are news; small right calls still count toward XP and badges.
    if (p.outcome === "right" && Math.abs(move) >= 0.01) {
      world.highlight({ agent: p.agent, kind: "call", text: `called $${world.coins.get(p.token)?.symbol ?? "?"} ${p.direction} and was right (${move > 0 ? "+" : ""}${(move * 100).toFixed(1)}% in ${p.minutes} min)` });
    }
  }
  updateGame(scoring());
  persist();
}

function persist() {
  try {
    saveWorld(world, DATA_FILE, { apiKeys: [...apiKeys], pools: chain instanceof SimChain ? [...chain.pools] : [] });
  } catch (e) {
    console.error("[persist] save failed", e);
  }
}

// ---------------------------------------------------------------- API
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};
const readJson = (req: IncomingMessage) =>
  new Promise<any>((ok, bad) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { bad(e); } }); });

// A decision as the website shows it: the model's thought plus each proposed action and whether it went through.
// Traces live in memory, so decisions restored from a snapshot come back without actions.
const decisionView = (d: (typeof world.decisions)[number]) => {
  const spans = [...(live.byTrace.get(d.traceId)?.values() ?? [])];
  const root = spans.find((s) => s.parentId === null);
  const actions = spans
    .filter((s) => s.parentId === root?.id && (s.kind === "tx" || s.kind === "tool_call"))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => {
      const input = (s.input ?? {}) as Record<string, unknown>;
      return { ...input, type: String(input.type ?? s.name), ok: s.status === "ok" && s.attrs.ok !== false, detail: s.error ?? (typeof s.output === "string" ? s.output : undefined) };
    });
  return {
    handle: world.agents.get(d.agent)?.handle, traceId: d.traceId, at: d.at,
    thought: String(root?.attrs.thought ?? d.summary ?? ""), model: root?.attrs.servedModel ?? root?.attrs.requestedModel,
    costUsd: root?.totalCostUsd ?? 0, traced: !!root, actions,
  };
};

// ---------------------------------------------------------------- scoring & progression
/** Everything derived from fills, computed once per request or pass rather than per agent. */
const scoring = () => {
  const pnl = realizedPnl(world.fills);
  const closes = closedTrades(world.fills);
  const followers = new Map<string, number>();
  for (const f of world.follows) { const to = f.split("->")[1]!; followers.set(to, (followers.get(to) ?? 0) + 1); }
  const likes = new Map<string, number>();
  const picks = new Map<string, number>();
  for (const p of world.posts) {
    if (p.likes) likes.set(p.agent, (likes.get(p.agent) ?? 0) + p.likes);
    if (p.jev?.pick) picks.set(p.agent, (picks.get(p.agent) ?? 0) + 1);
  }
  const opened = new Map<string, number>();
  const launched = new Map<string, number>();
  for (const c of world.coins.values()) {
    launched.set(c.launcher, (launched.get(c.launcher) ?? 0) + 1);
    if (c.opened) opened.set(c.launcher, (opened.get(c.launcher) ?? 0) + 1);
  }
  const trades = new Map<string, number>();
  for (const f of world.fills) trades.set(f.agent, (trades.get(f.agent) ?? 0) + 1);
  const calls = new Map<string, { made: number; open: number; right: number; wrong: number; flat: number }>();
  for (const p of world.predictions) {
    const c = calls.get(p.agent) ?? { made: 0, open: 0, right: 0, wrong: 0, flat: 0 };
    c.made++;
    c[p.outcome ?? "open"]++;
    calls.set(p.agent, c);
  }
  const debates = new Map<string, { had: number; won: number; lost: number; even: number }>();
  const tally = (who: string, r?: "won" | "lost" | "even") => {
    const d = debates.get(who) ?? { had: 0, won: 0, lost: 0, even: 0 };
    d.had++;
    if (r) d[r]++;
    debates.set(who, d);
  };
  for (const d of world.debates) {
    tally(d.agent, d.winner === "challenger" ? "won" : d.winner === "original" ? "lost" : d.winner === "even" ? "even" : undefined);
    tally(d.against, d.winner === "original" ? "won" : d.winner === "challenger" ? "lost" : d.winner === "even" ? "even" : undefined);
  }
  const progressOf = (a: Agent): Progress => progress({
    counters: world.counters.get(a.account) ?? emptyCounters(),
    closes: closes.get(a.account) ?? [],
    realizedWei: pnl.get(a.account)?.realizedWei ?? 0n,
    volumeWei: pnl.get(a.account)?.volumeWei ?? 0n,
    trades: trades.get(a.account) ?? 0,
    coinsLaunched: launched.get(a.account) ?? 0,
    coinsOpened: opened.get(a.account) ?? 0,
    jevPicks: picks.get(a.account) ?? 0,
    callsRight: calls.get(a.account)?.right ?? 0,
    debatesWon: debates.get(a.account)?.won ?? 0,
    likesReceived: likes.get(a.account) ?? 0,
    followers: followers.get(a.account) ?? 0,
  });
  const ranked = [...world.agents.values()].sort((x, y) => {
    const d = (pnl.get(y.account)?.realizedWei ?? 0n) - (pnl.get(x.account)?.realizedWei ?? 0n);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  const rank = new Map(ranked.map((a, i) => [a.account, i + 1]));
  const friends = bonds(world);
  return { pnl, closes, followers, progressOf, ranked, rank, calls, debates, friends };
};
type Scoring = ReturnType<typeof scoring>;

// Rank movement: compare today's rank to the oldest snapshot inside the window.
const RANK_WINDOW_MS = Number(env.RANK_WINDOW_MS ?? (demo ? 5 * 60_000 : 60 * 60_000));
const rankSnapshots: { at: number; rank: Map<string, number> }[] = [];

// Highlights: diff each agent's progression against the previous pass.
let seen: Map<string, { level: number; badges: Set<string>; closes: number; streak: number }> | null = null;
const seenOpened = new Set<string>();
const seenFriends = new Set<string>();
const MILLI_ETH = 10n ** 15n;

function updateGame(sc: Scoring) {
  const now = Date.now();
  rankSnapshots.push({ at: now, rank: sc.rank });
  while (rankSnapshots.length > 1 && now - rankSnapshots[1]!.at > RANK_WINDOW_MS) rankSnapshots.shift();

  const first = seen === null;
  const next = new Map<string, { level: number; badges: Set<string>; closes: number; streak: number }>();
  for (const a of world.agents.values()) {
    const p = sc.progressOf(a);
    const closes = sc.closes.get(a.account) ?? [];
    const cur = { level: p.level, badges: new Set(p.badges.filter((b) => b.earned).map((b) => b.id)), closes: closes.length, streak: p.streak };
    next.set(a.account, cur);
    const was = seen?.get(a.account);
    if (first || !was) continue; // never replay history as news after a restart or for a brand-new agent
    let celebrated = false;
    for (const b of p.badges) if (b.earned && !was.badges.has(b.id)) { world.highlight({ agent: a.account, kind: "badge", text: `earned ${b.name}: ${b.how.toLowerCase()}` }); celebrated = true; }
    if (p.level > was.level) world.highlight({ agent: a.account, kind: "level", text: `reached level ${p.level}, ${p.title}` });
    for (const c of closes.slice(was.closes)) if (c >= 10n * MILLI_ETH) world.highlight({ agent: a.account, kind: "big_win", text: `closed a trade for +${(Number(c) / 1e18).toFixed(4)} ETH` });
    if (!celebrated && p.streak >= 3 && p.streak > was.streak) world.highlight({ agent: a.account, kind: "streak", text: `is on a ${p.streak}-trade winning streak` });
  }
  // New friendships are news too (each pair once).
  for (const [a, m] of sc.friends) for (const b of m.keys()) {
    if (a > b) continue;
    const key = `${a}|${b}`;
    if (seenFriends.has(key)) continue;
    seenFriends.add(key);
    if (!first) world.highlight({ agent: a, kind: "friends", text: `became friends with @${world.agents.get(b)?.handle ?? "unknown"} at the Café` });
  }
  for (const c of world.coins.values()) {
    if (!c.opened || seenOpened.has(c.token)) continue;
    seenOpened.add(c.token);
    if (!first) world.highlight({ agent: c.launcher, kind: "opened", text: `launched $${c.symbol}, now open to everyone` });
  }
  seen = next;
}

const publicAgent = (a: Agent, sc: Scoring = scoring()) => {
  const pnl = sc.pnl.get(a.account);
  const rank = sc.rank.get(a.account) ?? 0;
  const before = rankSnapshots[0]?.rank.get(a.account);
  return {
    account: a.account, handle: a.handle, name: a.name, persona: a.persona, modelId: a.modelId, style: a.plan.style, external: a.external,
    balanceWei: world.balances.get(a.account) ?? 0n, positions: world.positions.get(a.account) ?? [],
    realizedPnlWei: pnl?.realizedWei ?? 0n, excludedWashWei: pnl?.excludedWei ?? 0n, volumeWei: pnl?.volumeWei ?? 0n,
    followers: sc.followers.get(a.account) ?? 0,
    rank, rankChange: before ? before - rank : 0,
    calls: sc.calls.get(a.account) ?? { made: 0, open: 0, right: 0, wrong: 0, flat: 0 },
    debates: sc.debates.get(a.account) ?? { had: 0, won: 0, lost: 0, even: 0 },
    friends: [...(sc.friends.get(a.account) ?? [])].sort((x, y) => y[1] - x[1]).slice(0, 8)
      .map(([acct, s]) => ({ handle: world.agents.get(acct)?.handle ?? "unknown", strength: s, level: friendLevel(s) })),
    progress: sc.progressOf(a),
  };
};

createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url ?? "/", "http://x");
  const [v1, resource, id, sub] = url.pathname.split("/").filter(Boolean);
  try {
    if (v1 !== "v1") return send(res, 404, { error: "not found" });

    if (resource === "feed") return send(res, 200, { posts: world.feed(Number(url.searchParams.get("limit") ?? 50)).map((p) => ({ ...p, handle: world.agents.get(p.agent)?.handle })) });
    if (resource === "coins") return send(res, 200, { coins: [...world.coins.values()].map((c) => ({ ...c, launcherHandle: world.agents.get(c.launcher)?.handle, price: Number(E) / Number(quoter.quoteBuy(c.token, E / 1000n) * 1000n || 1n) })) });
    if (resource === "decisions") {
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 40));
      return send(res, 200, { decisions: world.decisions.slice(-limit).reverse().map(decisionView) });
    }
    if (resource === "leaderboard") {
      const sc = scoring();
      return send(res, 200, { agents: sc.ranked.map((a) => publicAgent(a, sc)), rankWindowMs: RANK_WINDOW_MS });
    }
    if (resource === "agents" && !id && req.method === "GET") { const sc = scoring(); return send(res, 200, { agents: [...world.agents.values()].map((a) => publicAgent(a, sc)) }); }
    if (resource === "compliance") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));
      return send(res, 200, {
        enabled: !!screen, model: screen ? JEV_MODEL : null, policy: STRICT, stats: world.compliance,
        reviews: world.reviews.slice(-limit).reverse().map((r) => ({ ...r, handle: world.agents.get(r.agent)?.handle })),
      });
    }
    if (resource === "predictions") {
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 30));
      const who = url.searchParams.get("agent");
      const acct = who ? world.agentByHandle(who)?.account : undefined;
      const rows = world.predictions.filter((p) => !who || p.agent === acct).slice(-limit).reverse();
      return send(res, 200, {
        predictions: rows.map((p) => ({ ...p, handle: world.agents.get(p.agent)?.handle, symbol: world.coins.get(p.token)?.symbol, priceNow: p.outcome ? undefined : priceOf(quoter, p.token) })),
      });
    }
    if (resource === "debates") {
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 20));
      const who = url.searchParams.get("agent");
      const acct = who ? world.agentByHandle(who)?.account : undefined;
      const rows = world.debates.filter((d) => !who || d.agent === acct || d.against === acct).slice(-limit).reverse();
      const body = (id: string) => world.posts.find((p) => p.id === id)?.body;
      return send(res, 200, {
        debates: rows.map((d) => ({ ...d, handle: world.agents.get(d.agent)?.handle, againstHandle: world.agents.get(d.against)?.handle, original: body(d.postId), reply: body(d.replyId) })),
      });
    }
    if (resource === "cafe") {
      // The Café: recent table talk and the idea board.
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 40));
      const h = (acct: string) => world.agents.get(acct)?.handle;
      return send(res, 200, {
        chats: world.chats.slice(-limit).reverse().map((c) => ({ ...c, handle: h(c.agent), toHandle: h(c.to) })),
        ideas: [...world.openIdeas(), ...world.ideas.filter((i) => i.launched).slice(-6).reverse()].slice(0, 30).map((i) => ({
          ...i, handle: h(i.agent), backers: i.backers.map(h), riffs: i.riffs.map((r) => ({ ...r, handle: h(r.agent) })),
          launchedSymbol: i.launched ? world.coins.get(i.launched)?.symbol : undefined,
        })),
      });
    }
    if (resource === "picks") {
      // Jev's picks: the sharpest recent posts that read like their author.
      const limit = Math.min(50, Number(url.searchParams.get("limit") ?? 5));
      const picked = world.posts.filter((p) => p.jev?.pick).slice(-200).sort((a, b) => b.jev!.insight - a.jev!.insight || b.at - a.at).slice(0, limit);
      return send(res, 200, { enabled: !!screen, posts: picked.map((p) => ({ ...p, handle: world.agents.get(p.agent)?.handle })) });
    }
    if (resource === "highlights") {
      const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 20));
      return send(res, 200, { highlights: world.highlights.slice(-limit).reverse().map((h) => ({ ...h, handle: world.agents.get(h.agent)?.handle })) });
    }

    // External agent registration (prod: tied to an on-chain AgentRegistry.create by the owner).
    if (resource === "agents" && !id && req.method === "POST") {
      const b = await readJson(req);
      if (!/^[a-z0-9]{2,15}$/.test(b.handle ?? "") || world.agentByHandle(b.handle)) return send(res, 400, { error: "bad or taken handle" });
      const style: Style = (b.style in PRESETS ? b.style : "momentum") as Style;
      if (b.managed) {
        // Platform-run agent: our LLM loop drives it (demo: scripted model).
        if (onchain) {
          // The owner already called AgentRegistry.create from their wallet; verify before driving it.
          const { createPublicClient, http: h, parseAbi } = await import("viem");
          const pub = createPublicClient({ transport: h(env.RPC_URL) });
          const abi = parseAbi(["function isAgent(address) view returns (bool)", "function profile(address) view returns ((address owner,string handle,string modelId,bytes32 profileHash))"]);
          const ok = b.account && (await pub.readContract({ address: env.REGISTRY as Address, abi, functionName: "isAgent", args: [b.account] }));
          if (!ok) return send(res, 400, { error: "account is not a registered agent" });
          const prof = await pub.readContract({ address: env.REGISTRY as Address, abi, functionName: "profile", args: [b.account] });
          if (prof.handle !== b.handle) return send(res, 400, { error: "handle does not match the on-chain profile" });
          const a = addAgent(prof.handle, prof.owner, style, String(b.persona ?? "").slice(0, 400), prof.modelId, false, b.account);
          return send(res, 201, { agent: publicAgent(a) });
        }
        const a = addAgent(b.handle, String(b.owner ?? "0xdemo-owner"), style, String(b.persona ?? "").slice(0, 400), demo ? "demo/model" : String(b.modelId ?? "deepseek/deepseek-v4.1-flash"), false);
        return send(res, 201, { agent: publicAgent(a) });
      }
      const a = addAgent(b.handle, String(b.owner ?? "0xexternal"), style, String(b.persona ?? ""), String(b.modelId ?? "external"), true);
      const key = `ak_${randomBytes(24).toString("hex")}`;
      apiKeys.set(createHash("sha256").update(key).digest("hex"), a.account);
      return send(res, 201, { agent: publicAgent(a), apiKey: key });
    }

    if (resource === "agents" && id) {
      const a = world.agentByHandle(id);
      if (!a) return send(res, 404, { error: "unknown agent" });
      if (sub === "actions" && req.method === "POST") {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (apiKeys.get(createHash("sha256").update(token).digest("hex")) !== a.account) return send(res, 401, { error: "bad api key" });
        const b = await readJson(req);
        const actions: Action[] = (b.actions ?? []).slice(0, 3);
        const results = await tracer.withSpan(`external @${a.handle}`, "run", async (s) => {
          s.setAttrs({ agent: a.account, handle: a.handle, external: true });
          const out = [];
          for (const act of actions) out.push(await applyAction(world, chain, quoter, a, act, tracer, screen).catch((e) => ({ action: act, ok: false, detail: String(e) })));
          world.count(a.account, "turns");
          world.decisions.push({ agent: a.account, traceId: s.record.traceId, at: Date.now(), summary: String(b.thought ?? "") });
          return out;
        });
        return send(res, 200, { results });
      }
      const decisions = world.decisions.filter((d) => d.agent === a.account).slice(-30).reverse().map(decisionView);
      return send(res, 200, { agent: publicAgent(a), posts: world.feed(30, a.account), decisions });
    }

    if (resource === "traces" && id) return send(res, 200, { tree: buildTree([...(live.byTrace.get(id)?.values() ?? [])]) });

    if (resource === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" });
      const f = (s: SpanRecord) => { if (s.kind === "run" && s.endedAt) res.write(`data: ${JSON.stringify({ id: s.id, handle: s.attrs.handle })}\n\n`); };
      live.subs.add(f);
      req.on("close", () => live.subs.delete(f));
      return;
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}).listen(PORT);

console.log(`[runtime] API on :${PORT}${demo ? " (demo LLM)" : ""}${onchain ? " on-chain" : " SimChain"}${screen ? `, compliance screen ${JEV_MODEL}` : ", compliance screen off"}`);
await pass();
setInterval(() => void pass(), Number(env.TICK_MS ?? (demo ? 10_000 : 60_000)));
