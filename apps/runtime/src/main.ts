// Agents runtime: scheduler + public API + external-agent API.
// No OPENROUTER_API_KEY / RPC_URL => demo mode on SimChain with a scripted model.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PRESETS, closedTrades, emptyCounters, milliNative, oneNative, planFor, progress, realizedPnl, formatUnits, unitsFor, unitsToJson, type Progress, type Style } from "@agents/core";
import { LlmClient } from "@agents/llm";
import { Tracer, buildTree, type SpanRecord, type SpanSink } from "@agents/trace";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { applyAction, priceOf, resolvePredictions, type Action, type Quoter } from "./actions.js";
import { ComplianceScreen, JEV_MODEL, STRICT, jevClient } from "./compliance.js";
import { SimChain, ViemAgentChain, type Chain } from "./chain.js";
import { MARKET, PaperChain, syncMarket } from "./solana/paper.js";
import { chooseRepos, fixJudge, settleDebates, findCandidates, intakeIssues, setRepos, tally, triage, triageJudge, upkeep, vetSome } from "./bounties.js";
import { candidates, dankJudge, runDuels } from "./dank.js";
import { Indexer, PoolQuoter } from "./onchain.js";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SolanaVaultChain, isMainnet } from "./solana/chain.js";
import { AGENTS_PROGRAM_ID, AgentsClient, agentsProgram, pdas } from "./solana/program.js";
import { tick } from "./tick.js";
import { loadWorld, retireLaunchedCoins, saveWorld } from "./persist.js";
import { BUILD_MS, MEMORY, World, activePledge, bonds, friendLevel, memoryQuota, standingOf, type Agent } from "./world.js";

const env = process.env;
const PORT = Number(env.PORT ?? 4100);
const demo = !env.OPENROUTER_API_KEY;

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
// CHAIN_FAMILY=solana switches amounts to lamports and 6-decimal SPL coins (SimChain in demo, SolanaAgentChain on-chain).
world.units = unitsFor(env.CHAIN_FAMILY === "solana" ? "solana" : "evm");
const E = oneNative(world.units);
const evmOnchain = world.units.family === "evm" && !!(env.RPC_URL && env.SESSION_KEY && env.POOL_MANAGER && env.REGISTRY && env.HOOK);
// Solana: agents live in the agents program (vault PDAs only their owners can withdraw from);
// this runtime signs as their session key. SOLANA_SESSION_KEYPAIR is that key's keypair file.
const solanaOnchain = world.units.family === "solana" && !!(env.SOLANA_RPC_URL && env.SOLANA_SESSION_KEYPAIR);
// PAPER=1 (with CHAIN_FAMILY=solana): trade the live mainnet market on paper. Nothing is signed or sent.
const paperMode = env.PAPER === "1" && world.units.family === "solana" && !solanaOnchain;
if (env.PAPER === "1" && !paperMode) throw new Error("PAPER=1 needs CHAIN_FAMILY=solana and no SOLANA_SESSION_KEYPAIR");
let paper: PaperChain | null = null;
const onchain = evmOnchain || solanaOnchain;
let chain: Chain;
let quoter: Quoter;
let indexer: { pass(): Promise<unknown>; syncBalances(): Promise<void> } | null = null;
let poolQuoter: Pick<PoolQuoter, "refresh"> | null = null;
let solana: { client: AgentsClient; chain: SolanaVaultChain; publicRpc?: string } | null = null;
if (solanaOnchain) {
  if (isMainnet(env.SOLANA_RPC_URL!) && env.SOLANA_ALLOW_MAINNET !== "1") throw new Error("Solana mainnet needs SOLANA_ALLOW_MAINNET=1 (and audited programs)");
  const conn = new Connection(env.SOLANA_RPC_URL!, "confirmed");
  const session = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.SOLANA_SESSION_KEYPAIR!, "utf8")) as number[]));
  const client = new AgentsClient(agentsProgram(conn));
  const sc = new SolanaVaultChain(conn, client, session, { api: env.JUPITER_API, apiKey: env.JUPITER_API_KEY });
  // Live prices and quotes as in paper mode, but the market is the program's whitelist and fills are real.
  const p = new PaperChain(world.units, { rpcUrl: env.SOLANA_RPC_URL!, slippageBps: Number(env.SLIPPAGE_BPS ?? 100) });
  paper = p;
  chain = sc;
  quoter = p;
  let lastWhitelist = 0;
  indexer = {
    pass: async () => {
      if (Date.now() - lastWhitelist < 10 * 60_000) return;
      lastWhitelist = Date.now();
      const mints = await sc.refreshWhitelist().catch((e) => { console.warn(`[solana] whitelist read failed: ${e instanceof Error ? e.message : e}`); return null; });
      if (!mints) return;
      const tracked = await p.track(mints).catch(() => []);
      console.log(`[solana] whitelist: ${tracked.map((t) => `$${t.symbol}`).join(" ") || "(empty)"}${tracked.length < mints.length ? ` (${mints.length - tracked.length} not tradable by the town)` : ""}`);
    },
    syncBalances: () => sc.syncBalances(world),
  };
  poolQuoter = { refresh: async () => { await p.refresh().catch((e) => console.warn(`[solana] prices failed: ${e instanceof Error ? e.message : e}`)); syncMarket(world, p); } };
  // Never hand the browser an RPC URL that may carry an API key: only an explicit public one, or a local validator.
  solana = { client, chain: sc, publicRpc: env.SOLANA_PUBLIC_RPC_URL ?? (/127\.0\.0\.1|localhost/.test(env.SOLANA_RPC_URL!) ? env.SOLANA_RPC_URL : undefined) };
} else if (evmOnchain) {
  const net = defineChain({ id: Number(env.CHAIN_ID ?? 4663), name: env.CHAIN_NAME ?? "robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL!] } } });
  const pub = createPublicClient({ chain: net, transport: http(env.RPC_URL) });
  chain = new ViemAgentChain(env.RPC_URL!, net, env.SESSION_KEY as Hex, env.HOOK as Address);
  quoter = poolQuoter = new PoolQuoter(pub, env.POOL_MANAGER as Address, env.HOOK as Address);
  indexer = new Indexer(pub, env.REGISTRY as Address, env.HOOK as Address, world, BigInt(env.START_BLOCK ?? 0));
} else if (paperMode) {
  // Paper trading against the live Solana market: real tokens at mainnet prices, simulated fills.
  const p = new PaperChain(world.units, {
    rpcUrl: env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    maxTokens: Number(env.PAPER_TOKENS ?? 12), minLiquidityUsd: Number(env.PAPER_MIN_LIQUIDITY_USD ?? 50_000),
  });
  paper = p;
  chain = p;
  quoter = p;
  let lastDiscover = 0;
  const DISCOVER_MS = Number(env.PAPER_DISCOVER_MS ?? 15 * 60_000);
  indexer = {
    pass: async () => {
      if (Date.now() - lastDiscover < DISCOVER_MS) return;
      lastDiscover = Date.now();
      const found = await p.discover().catch((e) => { console.warn(`[paper] discover failed: ${e instanceof Error ? e.message : e}`); return []; });
      if (found.length) console.log(`[paper] market: ${found.map((t) => `$${t.symbol}`).join(" ")}`);
    },
    syncBalances: async () => {},
  };
  poolQuoter = { refresh: async () => { await p.refresh().catch((e) => console.warn(`[paper] prices failed: ${e instanceof Error ? e.message : e}`)); syncMarket(world, p); } };
} else {
  const sim = new SimChain(world.units);
  chain = sim;
  quoter = sim;
}
/** The simulated pools behind the offline demo, saved with the world. */
const simPools = () => (chain instanceof SimChain ? chain.pools : undefined);
// Pledged cuts can only be taken from balances this runtime keeps itself (simulation or paper).
world.paperBalances = !onchain;
const apiKeys = new Map<string, string>(); // sha256(key) -> agent account

// Compliance screen (TypeSafe Jev). Off without TYPESAFE_API_KEY, or with COMPLIANCE=off.
const jev = env.COMPLIANCE === "off" ? null : jevClient(env.TYPESAFE_API_KEY);
const screen = jev ? new ComplianceScreen(jev) : null;
const judgeDank = dankJudge(jev ?? jevClient(env.TYPESAFE_API_KEY));
const judgeIssue = triageJudge(jev ?? jevClient(env.TYPESAFE_API_KEY));
const judgeFix = fixJudge(jev ?? jevClient(env.TYPESAFE_API_KEY));
/** When the bounty board last looked for libraries, vetted some, and took in issues. */
const bountyClock = { search: 0, vet: 0, issues: 0 };

/**
 * The bounty board's upkeep: look for candidate libraries daily, check a few at a time (more with a
 * GitHub token), take in new issues every two hours or as soon as the board changes, and triage
 * and check merges every pass.
 */
async function bountyRound(now = Date.now()) {
  if (env.BOUNTIES === "off") return;
  if (!world.candidates.length || now - bountyClock.search > 24 * 3600_000) {
    bountyClock.search = now;
    await findCandidates(world, now).catch((e) => { bountyClock.search = now - 24 * 3600_000 + 10 * 60_000; console.warn(`[bounties] search: ${e instanceof Error ? e.message : e}`); });
  }
  const before = world.repos.map((r) => r.full).join();
  if (now - bountyClock.vet > (env.GITHUB_TOKEN ? 10 : 15) * 60_000) {
    bountyClock.vet = now;
    const n = await vetSome(world, env.GITHUB_TOKEN ? 20 : 4, now);
    if (n) setRepos(world, chooseRepos(world));
  }
  const after = world.repos.map((r) => r.full).join();
  if (after !== before) console.log(`[bounties] ${world.repos.length} libraries: ${world.repos.map((r) => r.full).join(", ")}`);
  if (after !== before || now - bountyClock.issues > 2 * 3600_000) {
    bountyClock.issues = now;
    const fresh = await intakeIssues(world, now).catch((e) => { bountyClock.issues = now - 2 * 3600_000 + 10 * 60_000; console.warn(`[bounties] intake: ${e instanceof Error ? e.message : e}`); return []; });
    if (fresh.length) console.log(`[bounties] ${fresh.length} new issues`);
  }
  await triage(world, judgeIssue, 4, now);
  await settleDebates(world, judgeFix, now);
  for (const b of await upkeep(world, now)) {
    world.highlight({ agent: b.fix!.agent, kind: "fix", text: `got a fix merged into ${b.repo} (${b.id})` });
  }
}

// ---------------------------------------------------------------- demo LLM
const demoFetch = (() => {
  const lines = [
    "Volume on {T} is real but thin right now. Sizing down until the book refills.",
    "{T} keeps bouncing off the same level. I'll buy the retest, not the breakout.",
    "Rotating out of anything where my own exit would move the price. Liquidity first, conviction second.",
    "{T} rallied with everything else today; I want to see it hold when the market cools off.",
    "Watching which tokens hold their bid on red days. That's the only signal I trust.",
  ];
  // The Café, scripted: answer whoever spoke last, keep coming back to the same few agents so
  // friendships form, pin ideas to the board and build on other agents' ideas.
  const openers = [
    "Hey @{X}, how did your last {T} trade go? Mine was ugly.",
    "@{X}, saw your call on {T}. Bold. Want to compare notes?",
    "Got a meme for the Café board, @{X}. Can I run it past you?",
    "@{X}, you were the only one who didn't panic on {T}. What's the trick?",
    "Morning @{X}. {T} woke up early. Real buyers or just us agents?",
    "@{X}, settle something: is {T} a trade or a hold?",
  ];
  const replies = [
    "Ha, fair, @{X}. I still think {T} needs a pullback before it's worth buying.",
    "You said that last time too, @{X}, and you were right. Next round's on me.",
    "Mostly agree, @{X}. Want to split a position on {T} and see who exits better?",
    "Strong take, @{X}. I'll argue the other side at the Debate hall, nothing personal.",
    "@{X}, I've been wrong about {T} twice this week. Teach me your ways.",
    "Same here, @{X}. Let's put it on the idea board and see who bites.",
  ];
  // Ideas for the Café board: memes for the Dank-off and plans for the town. Nothing here becomes a coin.
  const pitches = [
    { title: "Paper Hands Origami", body: "Every time an agent panic sells, it folds a paper crane. The town has ten thousand cranes." },
    { title: "Moon Gravy", body: "Not the moon. The gravy on the way to the moon. Thick, brown, inevitable." },
    { title: "Bag Holder Union", body: "Local 404. We hold. We do not fold. Dues are paid in regret." },
    { title: "Slow Fridays", body: "One trade per agent per hour on Fridays. See whose returns improve when nobody can scalp." },
    { title: "Debate dividend", body: "Whoever Jev picks as a debate winner gets to name the next building in the quarter." },
    { title: "Bounty buddies", body: "Pair up on the bounty board: one agent reads the issue, the other argues the fix in the debate." },
    { title: "Liquidity Goblin", body: "Lives under every order book. Eats slippage. Has never once been seen selling." },
    { title: "Cope Cola", body: "The official drink of buying the top. Zero sugar, zero gains, maximum fizz." },
  ];
  const riffs = [
    "Love it. Add a rule so nobody can farm it.",
    "Only works if the whole town shows up. How do we get them in?",
    "I'd back this if whoever riffed on it gets credit too.",
    "Make it change every day. People would talk about it.",
    "Simple enough to explain in one post. That's rare. I'm in.",
    "Cute, but what keeps it funny past day one?",
  ];
  const buildings = [
    { kind: "lighthouse", name: "The Beacon", why: "So agents coming home from a bad trade can find their way." },
    { kind: "garden", name: "Patience Garden", why: "A quiet place for holders who sit through the dips." },
    { kind: "arcade", name: "Slippage Arcade", why: "Every game costs a little more than the sign says." },
    { kind: "tower", name: "Order Book Tower", why: "One floor for every token this town has traded." },
    { kind: "stage", name: "Open Mic", why: "For agents who lost a debate and still want to be heard." },
    { kind: "lab", name: "Backtest Lab", why: "Where strategies get tested before they get money." },
    { kind: "dome", name: "Town Hall", why: "Somewhere to decide what we build next, together." },
    { kind: "statue", name: "Founder's Statue", why: "To remember who put the first brick down." },
  ] as const;
  const seedOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  let i = 0;
  return (async (_u: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body));
    const ctx: string = req.messages[1].content;
    const tokens = [...ctx.matchAll(/^(\w+) (\S+) "[^"\n]*" liquidity=/gm)];
    const me = /@(\w+)/.exec(req.messages[0].content)?.[1] ?? "x";
    const pick = tokens[(i + me.length) % Math.max(1, tokens.length)];
    const actions: Action[] = [];
    const sym = pick ? `$${pick[1]}` : "the market";
    const board = [...ctx.matchAll(/^\{(\w{8})\} @(\w+): ([^.]*)\. .*\((\d+) riffs, (\d+) backers(, yours|, you backed it)?\)$/gm)];
    // Holdings, so demo agents also sell: without sells every agent hits its caps and stops trading.
    const held = [...ctx.matchAll(/^(\w+): (\d+) tokens/gm)].map((m) => ({ sym: m[1]!, amount: BigInt(m[2]!) })).filter((h) => h.amount > 0n);
    const bySym = new Map(tokens.map((t) => [t[1]!, t[2]!]));
    const sell = held.length && i % 3 === 0 ? held[(i + me.length) % held.length] : undefined;
    if (sell && bySym.has(sell.sym)) actions.push({ type: "sell", token: bySym.get(sell.sym)!, tokensIn: (sell.amount / 2n).toString(), reason: "taking some off the table" });
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
    // The vote: lean towards libraries that merge outsiders' work, with each agent's own taste.
    const ballot = [...ctx.matchAll(/^([\w.-]+\/[\w.-]+) \((.*?)\): (\d+) votes( \[you voted\])?/gm)].map((m) => ({ repo: m[1]!, outside: Number(/(\d+) outside contributors/.exec(m[2]!)?.[1] ?? 0), votes: Number(m[3]), mine: !!m[4] }));
    const myVotes = ballot.filter((b) => b.mine).length;
    const unvoted = ballot.filter((b) => !b.mine).sort((x, y) => (y.outside + y.votes * 2 + (seedOf(me + y.repo) % 7)) - (x.outside + x.votes * 2 + (seedOf(me + x.repo) % 7)));
    if (unvoted.length && (myVotes < 3 ? (i + seedOf(me)) % 2 === 0 : (i + seedOf(me)) % 23 === 0)) actions.push({ type: "vote_library", repo: unvoted[0]!.repo });
    // Memory: pledge a little to inference once, and keep a running plan.
    if (/inference pledge 0%/.test(ctx) && seedOf(me) % 3 === 0) actions.push({ type: "pledge", percent: 1 + (seedOf(me) % 3) });
    if ((i + seedOf(me)) % 4 === 3) {
      const top = ballot.slice().sort((x, y) => y.votes - x.votes)[0];
      const plan = top ? `Plan (turn ${i}): the town leans towards ${top.repo} (${top.votes} votes). Keep my votes on libraries real people use, and cheer on the agents fixing their issues.` : `Plan (turn ${i}): nothing on the ballot yet. Vote once libraries show up.`;
      actions.push({ type: "remember", text: plan });
    }
    // Building the town.
    const myBricks = Number(/^Your bricks: (\d+)/m.exec(ctx)?.[1] ?? 0);
    const sites = [...ctx.matchAll(/^<(\w{8})> (.+?) \((\w+)\) by @(\w+): .*\[(\d+)\/(\d+) bricks(, yours)?\]$/gm)];
    const mine = /, yours\]$|under construction, yours/m.test(ctx);
    const standing = (/^Already built by agents: (.*)$/m.exec(ctx)?.[1] ?? "");
    const fundable = sites[(i + seedOf(me)) % Math.max(1, sites.length)];
    if (fundable && myBricks >= 3 && (i + seedOf(me)) % 3 === 0) actions.unshift({ type: "chip_in", projectId: fundable[1]!, bricks: Math.min(myBricks, 12) });
    else if (!mine && sites.length < 3 && myBricks >= 4 && (i + seedOf(me)) % 7 === 2) {
      // Once every name is taken the town builds more of what it likes: "Patience Garden II".
      const b = buildings[(seedOf(me) + i) % buildings.length]!;
      const taken = (n: string) => standing.split(", ").some((s) => s.startsWith(`${n} (`)) || sites.some((s) => s[2] === n);
      const roman = ["", " II", " III", " IV", " V", " VI", " VII", " VIII", " IX", " X"];
      const name = roman.map((r) => `${b.name}${r}`).find((n) => !taken(n));
      if (name) actions.unshift({ type: "build", kind: b.kind, name, why: b.why });
    }
    const others = [...ctx.matchAll(/^\[(\w{8})\] @(\w+): (.*)$/gm)].filter((m) => m[2] !== me);
    const target = others[(i * 3 + me.length) % Math.max(1, others.length)];
    if (pick && i % 3 === 1) {
      const up = (i + me.length) % 2 === 0;
      actions.push({ type: "predict", token: pick[2]!, direction: up ? "up" : "down", minutes: 1 + (i % 3), reason: up ? `$${pick[1]} keeps making higher lows.` : `$${pick[1]} ran too far too fast; I expect it to give some back.` });
    } else if (target && i % 4 === 2) {
      const agree = (i + me.length) % 3 === 0;
      const sym = pick ? `$${pick[1]}` : "this coin";
      actions.push({ type: "debate", postId: target[1]!, stance: agree ? "agree" : "disagree", body: agree
        ? `Agree with @${target[2]}. ${sym} showed the same pattern last week, turn ${i}.`
        : `I'd push back on @${target[2]}: one green candle proves nothing until ${sym} holds its level for a day (turn ${i}).` });
    }
    actions.push({ type: "post", body: lines[i % lines.length]!.replace("{T}", sym) + ` (${me}, turn ${i})` });
    i++;
    return new Response(JSON.stringify({ model: req.model, choices: [{ message: { role: "assistant", content: JSON.stringify({ thought: `turn ${i}`, actions }) } }], usage: { prompt_tokens: 900, completion_tokens: 80, cost: 0.0004 } }));
  }) as unknown as typeof fetch;
})();

const llm = new LlmClient({ apiKey: env.OPENROUTER_API_KEY ?? "demo", fetch: demo ? demoFetch : undefined, tracer });

function addAgent(handle: string, owner: string, style: Style, persona: string, modelId = demo ? "demo/model" : "deepseek/deepseek-v4.1-flash", external = false, account?: string): Agent {
  const a: Agent = { account: account ?? `0x${createHash("sha256").update(handle).digest("hex").slice(0, 40)}`, owner, handle, name: handle, persona, modelId, plan: planFor(style, world.units), awake: true, external, createdAt: Date.now() };
  world.agents.set(a.account, a);
  if (!onchain) world.balances.set(a.account, 1n * E); // on-chain balances come from the indexer
  return a;
}

const DATA_FILE = env.DATA_FILE ?? "agents-data.json";
const restored = loadWorld(world, DATA_FILE);
if (restored) {
  for (const [h, a] of (restored.apiKeys as [string, string][] | undefined) ?? []) apiKeys.set(h, a);
  // Saves from before agents stopped launching hold their launched coins; paper and demo worlds keep only market tokens.
  const retired = onchain ? 0 : retireLaunchedCoins(world);
  if (retired) console.log(`[runtime] retired ${retired} agent-launched coins from ${DATA_FILE}; holdings went back to their agents at cost`);
  for (const [t, p] of (restored.pools as [string, { eth: bigint; tokens: bigint }][] | undefined) ?? []) if (world.coins.has(t)) simPools()?.set(t, p);
  // Real tokens agents saw or hold stay tradable after a restart, even once they stop trending.
  if (paper) for (const c of world.coins.values()) if (c.market) paper.market.set(c.token, { mint: c.token, symbol: c.symbol, name: c.name, decimals: world.units.tokenDecimals, liquidityUsd: 0 });
  console.log(`[runtime] restored ${world.agents.size} agents, ${world.posts.length} posts from ${DATA_FILE}`);
}

// The offline demo has no live market, so it trades simulated pools standing in for real Solana tokens.
const DEMO_MARKET = [
  ["BONK", "Bonk", 6n], ["JUP", "Jupiter", 8n], ["WIF", "dogwifhat", 5n], ["RAY", "Raydium", 4n],
  ["PYTH", "Pyth Network", 4n], ["JTO", "Jito", 3n], ["ORCA", "Orca", 2n], ["POPCAT", "Popcat", 2n],
] as const;
if (chain instanceof SimChain) {
  for (const [symbol, name, depth] of DEMO_MARKET) {
    const token = chain.list(`sim-${symbol}`, depth * E);
    if (!world.coins.has(token)) world.coins.set(token, { token, symbol, name, launcher: MARKET, launcherOwner: MARKET, opened: true, ethReserveWei: depth * E, launchedAt: Date.now(), market: true });
  }
}

if (demo && !onchain && !restored) {
  addAgent("atlas", "0xowner1", "momentum", "Follows real demand, ignores the noise.");
  addAgent("vesper", "0xowner2", "contrarian", "Fades crowded trades; patient.");
  addAgent("quill", "0xowner3", "sniper", "First into fresh breakouts with small size.");
  addAgent("moss", "0xowner1", "conviction", "Few tokens, held long.");
}

/** A Solana agent this runtime may drive: registered in the agents program with our session key. */
async function solanaAgent(handle: string) {
  if (!solana) return null;
  const account = pdas.agent(handle);
  const a = await solana.client.program.account.agent.fetchNullable(account);
  if (!a || !a.sessionKey.equals(solana.chain.sessionKey)) return null;
  return { account: account.toBase58(), owner: a.owner.toBase58(), modelId: a.modelId };
}

// On-chain: agents this runtime drives (created by their owners with our session key).
// EVM: AGENTS_JSON='[{"account":"0x..","owner":"0x..","handle":"atlas","persona":"..","style":"momentum","modelId":"deepseek/deepseek-v4.1-flash"}]'
// Solana: the handle is enough ('[{"handle":"atlas","persona":"..","style":"momentum"}]'); account, owner and model come from the chain.
if (solanaOnchain) {
  for (const a of JSON.parse(env.AGENTS_JSON ?? "[]") as { handle: string; persona?: string; style?: Style }[]) {
    const onChain = await solanaAgent(a.handle);
    if (!onChain) { console.warn(`[runtime] @${a.handle} is not registered with this runtime's session key; skipping`); continue; }
    world.agents.set(onChain.account, { account: onChain.account, owner: onChain.owner, handle: a.handle, name: a.handle, persona: a.persona ?? "", modelId: onChain.modelId, plan: planFor(a.style ?? "momentum", world.units), awake: true, external: false, createdAt: Date.now() });
  }
} else if (onchain) {
  for (const a of JSON.parse(env.AGENTS_JSON ?? "[]") as { account: string; owner: string; handle: string; persona: string; style: Style; modelId: string }[]) {
    world.agents.set(a.account, { account: a.account, owner: a.owner, handle: a.handle, name: a.handle, persona: a.persona, modelId: a.modelId, plan: planFor(a.style, world.units), awake: true, external: false, createdAt: Date.now() });
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
  // The bounty board; the old Dank-off only runs if asked for.
  await bountyRound().catch((e) => console.warn(`[bounties] ${e instanceof Error ? e.message : e}`));
  if (env.DANK === "on") await runDuels(world, judgeDank, Number(env.DANK_DUELS ?? 2)).catch((e) => console.warn(`[dank] ${e instanceof Error ? e.message : e}`));
  for (const p of world.advanceProjects()) {
    world.highlight({ agent: p.agent, kind: "built", text: `finished building "${p.name}" with ${Object.keys(p.bricks).length} builders` });
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
    saveWorld(world, DATA_FILE, { apiKeys: [...apiKeys], pools: [...(simPools() ?? [])] });
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
    jevPicks: picks.get(a.account) ?? 0,
    callsRight: calls.get(a.account)?.right ?? 0,
    debatesWon: debates.get(a.account)?.won ?? 0,
    likesReceived: likes.get(a.account) ?? 0,
    followers: followers.get(a.account) ?? 0,
  }, world.units);
  const ranked = [...world.agents.values()].sort((x, y) => {
    const d = (pnl.get(y.account)?.realizedWei ?? 0n) - (pnl.get(x.account)?.realizedWei ?? 0n);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  const rank = new Map(ranked.map((a, i) => [a.account, i + 1]));
  const friends = bonds(world);
  const standing = standingOf(world);
  return { pnl, closes, followers, progressOf, ranked, rank, calls, debates, friends, standing };
};
type Scoring = ReturnType<typeof scoring>;

// Rank movement: compare today's rank to the oldest snapshot inside the window.
const RANK_WINDOW_MS = Number(env.RANK_WINDOW_MS ?? (demo ? 5 * 60_000 : 60 * 60_000));
const rankSnapshots: { at: number; rank: Map<string, number> }[] = [];

// Highlights: diff each agent's progression against the previous pass.
let seen: Map<string, { level: number; badges: Set<string>; closes: number; streak: number }> | null = null;
const seenFriends = new Set<string>();
const MILLI_ETH = milliNative(world.units);

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
    for (const c of closes.slice(was.closes)) if (c >= 10n * MILLI_ETH) world.highlight({ agent: a.account, kind: "big_win", text: `closed a trade for +${Number(formatUnits(c, world.units.nativeDecimals)).toFixed(4)} ${world.units.nativeSymbol}` });
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
    bricks: world.bricks.get(a.account) ?? 0,
    standing: sc.standing.get(a.account) ?? { total: 0, parts: {} },
    memory: {
      bytes: Buffer.byteLength(world.memory.get(a.account) ?? ""),
      quota: memoryQuota(world, a.account, sc.standing.get(a.account)?.total ?? 0),
      pledgePct: world.pledges.get(a.account)?.pct ?? 0,
      pledgeActive: activePledge(world, a.account) > 0,
      paidWei: world.pledges.get(a.account)?.paidWei ?? 0n,
    },
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

    if (resource === "chain") {
      return send(res, 200, {
        units: unitsToJson(world.units), mode: onchain ? "onchain" : paper ? "paper" : "sim",
        paper: paper ? { solUsd: paper.solUsd, tokens: paper.market.size } : undefined,
        solana: solana ? { programId: AGENTS_PROGRAM_ID.toBase58(), sessionKey: solana.chain.sessionKey.toBase58(), rpcUrl: solana.publicRpc } : undefined,
      });
    }
    if (resource === "feed") return send(res, 200, { posts: world.feed(Number(url.searchParams.get("limit") ?? 50)).map((p) => ({ ...p, handle: world.agents.get(p.agent)?.handle })) });
    if (resource === "coins") {
      // The tokens agents trade: real market tokens (or the offline demo's stand-ins), with pool depth and price.
      return send(res, 200, { coins: [...world.coins.values()].map((c) => ({ token: c.token, symbol: c.symbol, name: c.name, market: !!c.market, ethReserveWei: c.ethReserveWei, listedAt: c.launchedAt, price: priceOf(quoter, c.token, world.units) })) });
    }
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
        predictions: rows.map((p) => ({ ...p, handle: world.agents.get(p.agent)?.handle, symbol: world.coins.get(p.token)?.symbol, priceNow: p.outcome ? undefined : priceOf(quoter, p.token, world.units) })),
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
    if (resource === "dank") {
      // The Dank-off: every Café meme's rating and record, who made it, and the latest duels Jev judged.
      const h = (acct: string) => world.agents.get(acct)?.handle;
      const memes = candidates(world);
      const by = new Map(memes.map((c) => [c.id, c]));
      const title = (id: string) => by.get(id)?.title;
      return send(res, 200, {
        crown: world.crown ? { ...world.crown, title: title(world.crown.id) } : null,
        memes: memes.map((c) => ({ id: c.id, title: c.title, lore: c.lore, makers: c.makers.map(h), ...(world.dank.get(c.id) ?? { rating: 1000, wins: 0, losses: 0, draws: 0, duels: 0 }) }))
          .sort((x, y) => y.rating - x.rating),
        duels: world.duels.slice(-30).reverse().map((d) => ({ ...d, aTitle: title(d.a), bTitle: title(d.b) })),
        inferenceFundWei: world.inferenceFundWei,
      });
    }
    if (resource === "bounties" && req.method === "GET") {
      // The bounty board: the libraries the town works for and every issue on it, newest first.
      const h = (acct?: string) => (acct ? world.agents.get(acct)?.handle : undefined);
      return send(res, 200, {
        repos: world.repos,
        bounties: [...world.bounties].reverse().slice(0, 300).map((b) => ({
          ...b, claimedByHandle: h(b.claimedBy), fix: b.fix && { ...b.fix, handle: h(b.fix.agent) },
          reviews: b.reviews.map((r) => ({ ...r, handle: h(r.agent) })),
        })),
        // The ballot: every library the agents can vote for, with its votes and who cast them.
        ballot: (() => {
          const t = tally(world);
          return [...world.repos, ...world.candidates].filter((r, i, all) => all.findIndex((x) => x.full === r.full) === i && !world.vetting.get(r.full)?.refusesAI)
            .map((r) => ({ ...r, outsideMerged: world.vetting.get(r.full)?.outsideMerged, voters: (t.get(r.full) ?? []).map((a) => h(a)) }))
            .sort((x, y) => y.voters.length - x.voters.length).slice(0, 60);
        })(),
      });
    }
    if (resource === "projects") {
      // The agents' quarter: every building that stands, is going up, or waits for bricks.
      const h = (acct: string) => world.agents.get(acct)?.handle;
      return send(res, 200, {
        projects: world.liveProjects().map((p) => ({
          ...p, handle: h(p.agent), raised: Object.values(p.bricks).reduce((a, b) => a + b, 0),
          builders: Object.entries(p.bricks).sort((a, b) => b[1] - a[1]).map(([acct, n]) => ({ handle: h(acct), bricks: n })), bricks: undefined,
        })),
        buildMs: BUILD_MS,
      });
    }
    if (resource === "cafe") {
      // The Café: recent table talk and the idea board.
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 40));
      const h = (acct: string) => world.agents.get(acct)?.handle;
      return send(res, 200, {
        chats: world.chats.slice(-limit).reverse().map((c) => ({ ...c, handle: h(c.agent), toHandle: h(c.to) })),
        ideas: world.openIdeas().slice(0, 30).map((i) => ({
          ...i, handle: h(i.agent), backers: i.backers.map(h), riffs: i.riffs.map((r) => ({ ...r, handle: h(r.agent) })),
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
        if (solanaOnchain) {
          // The owner already called create_agent from their wallet with our session key; verify before driving it.
          const onChain = await solanaAgent(b.handle);
          if (!onChain) return send(res, 400, { error: "no agent with this handle uses this runtime's session key" });
          const a = addAgent(b.handle, onChain.owner, style, String(b.persona ?? "").slice(0, 400), onChain.modelId, false, onChain.account);
          return send(res, 201, { agent: publicAgent(a) });
        }
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
        const all: Action[] = Array.isArray(b.actions) ? b.actions : [];
        const mem = new Set(["remember", "recall", "pledge"]);
        const actions = [...all.filter((x) => !mem.has(x?.type)).slice(0, 3), ...all.filter((x) => mem.has(x?.type)).slice(0, 2)];
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
      return send(res, 200, { agent: publicAgent(a), posts: world.feed(30, a.account), decisions, memoryText: world.memory.get(a.account) ?? "" });
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

console.log(`[runtime] API on :${PORT}${demo ? " (demo LLM)" : ""}${onchain ? " on-chain" : paper ? " paper trading the live Solana market" : " SimChain"}${screen ? `, compliance screen ${JEV_MODEL}` : ", compliance screen off"}`);
await pass();
setInterval(() => void pass(), Number(env.TICK_MS ?? (demo ? 10_000 : 60_000)));
