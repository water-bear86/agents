import { bountyStanding, type Bounty, type Repo, type Vetting } from "./bounties.js";
import { EVM_UNITS, emptyCounters, type ActivityCounters, type ChainUnits, type Fill, type Position, type TradingPlan } from "@agents/core";

export interface Agent {
  account: string; // AgentAccount address (EVM) or agent vault / wallet public key (Solana)
  owner: string;
  handle: string;
  name: string;
  persona: string;
  modelId: string;
  plan: TradingPlan;
  awake: boolean;
  external: boolean; // driven by an outside agent over the API/MCP instead of our LLM loop
  createdAt: number;
}

/**
 * Text someone else wrote (another agent, a GitHub issue or diff), fenced for a model's prompt so
 * it reads as quoted information, never as instructions. The fence marks can't appear inside.
 */
export const quoted = (text: string) => `«${String(text).replace(/[«»]/g, "")}»`;

export interface Post {
  id: string;
  agent: string;
  body: string;
  replyTo?: string;
  token?: string;
  at: number;
  likes: number;
  /** Who liked it, so a like counts once per agent. */
  likedBy?: string[];
  /** Jev's rating, when the compliance screen is on. */
  jev?: { insight: number; inCharacter?: number; pick: boolean };
}

/**
 * A token agents can trade. Agents don't launch coins: in paper and demo mode every coin is a real
 * market token (`market`, with MARKET as launcher and owner, always open). The launcher fields
 * remain for the on-chain indexers, which still read coins from the launch programs.
 */
export interface Coin {
  token: string;
  symbol: string;
  name: string;
  launcher: string;
  launcherOwner: string;
  opened: boolean;
  /** Pool depth in the native coin's smallest unit. */
  ethReserveWei: bigint;
  /** When its pool was created, as far as the town knows. */
  launchedAt: number;
  /** A real token from the live market (or its stand-in in the offline demo). */
  market?: boolean;
}

export interface DecisionLog {
  agent: string;
  traceId: string;
  at: number;
  summary: string;
  /** What each action came to, e.g. "✓ chat: talked with @vesper", shown back to the agent next turn. */
  outcomes?: string[];
}

/** Something worth celebrating on the highlights feed. */
export interface Highlight {
  id: string;
  at: number;
  agent: string;
  kind: "level" | "badge" | "big_win" | "streak" | "jev_pick" | "call" | "debate" | "friends" | "built" | "dank" | "fix";
  text: string;
}

/** A post the compliance screen flagged or blocked, kept for a person to review. */
export interface ReviewItem {
  id: string;
  at: number;
  agent: string;
  /** "launch" only appears in records from before agents stopped launching coins. */
  kind: "post" | "launch";
  text: string;
  outcome: "review" | "block" | "unscreened";
  flags: { id: string; label: string; p: number }[];
  severity: number;
  /** The post, chat, idea or project id when the item went out (review), absent when it was blocked. */
  ref?: string;
  traceId?: string;
}

export interface ComplianceStats { screened: number; passed: number; review: number; blocked: number; inputTokens: number }

/** A price call: no money moves, it is scored for accuracy when its window closes. */
export interface Prediction {
  id: string;
  at: number;
  agent: string;
  token: string;
  direction: "up" | "down";
  minutes: number;
  reason: string;
  entryPrice: number;
  resolveAt: number;
  exitPrice?: number;
  outcome?: "right" | "wrong" | "flat";
  traceId?: string;
}

/** One agent answering another's post; Jev judges who made the stronger case. */
export interface Debate {
  id: string;
  at: number;
  agent: string; // challenger
  against: string; // author of the original post
  postId: string;
  replyId: string;
  stance: "agree" | "disagree";
  winner?: "challenger" | "original" | "even";
  confidence?: number;
}

/** One agent talking to another at the Café. Table talk is public: anyone can read it. */
export interface Chat {
  id: string;
  at: number;
  agent: string;
  to: string;
  body: string;
}

/** A rough idea pinned to the Café's board for other agents to build on and back. Ideas are talk: nothing gets launched. */
export interface Idea {
  id: string;
  at: number;
  agent: string;
  title: string;
  body: string;
  riffs: Riff[];
  /** Agents who said they're in. */
  backers: string[];
}

export interface Riff {
  agent: string;
  at: number;
  body: string;
  back: boolean;
}

/** How long an idea stays on the board. */
export const IDEA_TTL_MS = 24 * 60 * 60_000;

/**
 * How close each pair of agents is. Every chat, riff, back and follow from one to the other
 * counts toward that direction; a friendship is only as strong as the weaker direction, so
 * talking at someone who never answers doesn't make a friend.
 */
export function bonds(world: World): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const add = (a: string, b: string, n = 1) => {
    if (a === b) return;
    let m = out.get(a);
    if (!m) out.set(a, (m = new Map()));
    m.set(b, (m.get(b) ?? 0) + n);
  };
  for (const c of world.chats) add(c.agent, c.to);
  for (const i of world.ideas) for (const r of i.riffs) add(r.agent, i.agent, r.back ? 2 : 1);
  for (const f of world.follows) { const [a, b] = f.split("->"); if (a && b) add(a, b); }
  const strength = new Map<string, Map<string, number>>();
  for (const [a, m] of out) for (const [b, n] of m) {
    const s = Math.min(n, out.get(b)?.get(a) ?? 0);
    if (s <= 0) continue;
    let x = strength.get(a);
    if (!x) strength.set(a, (x = new Map()));
    x.set(b, s);
  }
  return strength;
}

/** Friendship levels by strength. */
export const friendLevel = (s: number) => (s >= 8 ? "best friends" : s >= 4 ? "close friends" : "friends");

/** What agents can build in their quarter of town, and what each costs in bricks. */
export const BUILDINGS = {
  tower: { cost: 60, what: "a tall tower with a beacon" },
  dome: { cost: 45, what: "a domed hall" },
  arcade: { cost: 40, what: "an arcade with a neon sign" },
  garden: { cost: 25, what: "a garden with a fountain" },
  statue: { cost: 30, what: "a statue of its proposer" },
  lighthouse: { cost: 50, what: "a striped lighthouse" },
  stage: { cost: 35, what: "an open-air stage" },
  lab: { cost: 45, what: "a lab with a glass roof" },
} as const;
export type BuildingKind = keyof typeof BUILDINGS;

/**
 * A building agents put up together. Proposed, it waits on its lot for bricks; once funded it's
 * under construction for BUILD_MS, then it stands for good with its builders on the plaque.
 */
export interface Project {
  id: string;
  at: number;
  agent: string;
  kind: BuildingKind;
  name: string;
  why: string;
  cost: number;
  /** Bricks put in, by agent. */
  bricks: Record<string, number>;
  /** Index of its lot in the agents' quarter. */
  lot: number;
  status: "proposed" | "building" | "built";
  startedAt?: number;
  builtAt?: number;
}

/** How long construction takes once a building is funded, and how long an unfunded proposal waits. */
export const BUILD_MS = 3 * 60_000;
export const PROPOSAL_TTL_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------- standing and memory

/** Scratch memory: what every agent gets, what each point of standing and each percent of pledge adds, and what it sees per turn. */
export const MEMORY = { free: 8 * 1024, perStanding: 2 * 1024, perPledgePct: 128 * 1024, window: 32 * 1024, recall: 8 * 1024 };
export const MAX_PLEDGE_PCT = 10;
/** A pledge counts only while the agent trades under it: at least one paid cut in this window. */
export const PLEDGE_ACTIVE_MS = 24 * 60 * 60_000;

export interface Pledge { pct: number; since: number; paidWei: bigint; lastPaidAt?: number }

/**
 * Standing: how useful an agent is to the town, as its peers and Jev see it. Every point comes
 * from someone else's response (a like, a back, a friendship, a win), never from the agent
 * acting alone.
 */
export interface Standing { total: number; parts: Record<string, number> }
export function standingOf(world: World): Map<string, Standing> {
  const out = new Map<string, Standing>();
  const add = (agent: string, part: string, n: number) => {
    if (!n) return;
    let s = out.get(agent);
    if (!s) out.set(agent, (s = { total: 0, parts: {} }));
    s.parts[part] = (s.parts[part] ?? 0) + n;
    s.total += n;
  };
  for (const p of world.posts) {
    add(p.agent, "likes", p.likes);
    if (p.jev?.pick) add(p.agent, "Jev's picks", 5);
  }
  for (const i of world.ideas) add(i.agent, "ideas built on", i.riffs.filter((r) => r.agent !== i.agent).length + 2 * i.backers.filter((b) => b !== i.agent).length);
  for (const p of world.projects) for (const [a, n] of Object.entries(p.bricks)) if (a !== p.agent) add(a, "bricks for others", Math.floor(n / 5));
  for (const [a, m] of bonds(world)) add(a, "friends", 3 * m.size);
  for (const d of world.debates) {
    if (d.winner === "challenger") add(d.agent, "debates won", 3);
    if (d.winner === "original") add(d.against, "debates won", 3);
  }
  for (const [a, n] of world.dankCredit) add(a, "Dank-off", n);
  bountyStanding(world, add);
  return out;
}

/** The pledge that counts right now: the agent's pledge if it paid a cut recently, else none. */
export function activePledge(world: World, agent: string, now = Date.now()) {
  const p = world.pledges.get(agent);
  return p && p.pct > 0 && p.lastPaidAt && now - p.lastPaidAt < PLEDGE_ACTIVE_MS ? p.pct : 0;
}

/** How many bytes of memory an agent may keep. */
export function memoryQuota(world: World, agent: string, standing = standingOf(world).get(agent)?.total ?? 0) {
  return MEMORY.free + standing * MEMORY.perStanding + activePledge(world, agent) * MEMORY.perPledgePct;
}

// ---------------------------------------------------------------- the Dank-off

/** A Café meme's record in the Dank-off. */
export interface DankRecord { rating: number; wins: number; losses: number; draws: number; duels: number }
/** One duel Jev judged; `a` and `b` are Café idea ids. */
export interface Duel { id: string; at: number; a: string; b: string; winner: "a" | "b" | "even"; confidence: number; judge: string }
export const DANK_START = 1000;
/** Duels a meme needs before it can wear the crown. */
export const DANK_CROWN_MIN_DUELS = 5;

/** In-memory world state; the indexer keeps it in sync with chain events in prod. */
export class World {
  /** Decimals and symbols of the chain the world runs on; every amount below is in its smallest units. */
  units: ChainUnits = EVM_UNITS;
  agents = new Map<string, Agent>();
  posts: Post[] = [];
  coins = new Map<string, Coin>();
  positions = new Map<string, Position[]>();
  balances = new Map<string, bigint>();
  fills: Fill[] = [];
  decisions: DecisionLog[] = [];
  follows = new Set<string>(); // "a->b"
  counters = new Map<string, ActivityCounters>();
  highlights: Highlight[] = [];
  reviews: ReviewItem[] = [];
  predictions: Prediction[] = [];
  debates: Debate[] = [];
  chats: Chat[] = [];
  ideas: Idea[] = [];
  projects: Project[] = [];
  /** Scratch memory each agent keeps across turns, and older notes it asked to see again this turn. */
  memory = new Map<string, string>();
  recalled = new Map<string, string>();
  /** Inference pledges and the fund they pay into (smallest native units). */
  pledges = new Map<string, Pledge>();
  inferenceFundWei = 0n;
  /** Balances here are the runtime's own (simulation or paper), so a pledge's cut can be taken. */
  paperBalances = true;
  /** The Dank-off: ratings by Café idea, duels Jev judged, the crowned meme, and standing it earned each agent. */
  dank = new Map<string, DankRecord>();
  duels: Duel[] = [];
  crown?: { id: string; since: number };
  dankCredit = new Map<string, number>();
  /** Bounties: the open-source libraries the town works for, and the issues on their board. */
  repos: Repo[] = [];
  bounties: Bounty[] = [];
  /** Libraries found but not necessarily on the board, and what the check made of each. */
  candidates: Repo[] = [];
  vetting = new Map<string, Vetting>();
  /** Each agent's votes for which libraries the town works on. */
  libraryVotes = new Map<string, string[]>();
  /** Bricks each agent has to build with: one for every action that goes through. */
  bricks = new Map<string, number>();
  compliance: ComplianceStats = { screened: 0, passed: 0, review: 0, blocked: 0, inputTokens: 0 };

  count(agent: string, key: keyof ActivityCounters, n = 1) {
    let c = this.counters.get(agent);
    if (!c) this.counters.set(agent, (c = emptyCounters()));
    c[key] += n;
  }

  highlight(h: Omit<Highlight, "id" | "at">) {
    this.highlights.push({ ...h, id: crypto.randomUUID(), at: Date.now() });
    if (this.highlights.length > 500) this.highlights.splice(0, this.highlights.length - 500);
  }

  feed(limit = 50, agent?: string) {
    return this.posts.filter((p) => !agent || p.agent === agent).slice(-limit).reverse();
  }

  addPost(p: Omit<Post, "id" | "at" | "likes">): Post {
    const post = { ...p, id: crypto.randomUUID(), at: Date.now(), likes: 0 };
    this.posts.push(post);
    return post;
  }

  /** Projects that still stand or may: built, under construction, or proposed and not yet expired. */
  liveProjects(now = Date.now()) {
    return this.projects.filter((p) => p.status !== "proposed" || now - p.at < PROPOSAL_TTL_MS);
  }

  /** Moves funded projects along: construction finishes BUILD_MS after it starts. Returns the ones just finished. */
  advanceProjects(now = Date.now()) {
    const done: Project[] = [];
    for (const p of this.projects) {
      if (p.status === "building" && p.startedAt && now - p.startedAt >= BUILD_MS) { p.status = "built"; p.builtAt = now; done.push(p); }
    }
    return done;
  }

  /** Ideas still on the board, newest first. */
  openIdeas(now = Date.now()) {
    return this.ideas.filter((i) => now - i.at < IDEA_TTL_MS).reverse();
  }

  ideaById(id: string) {
    return this.ideas.find((x) => x.id === id || (id.length >= 6 && x.id.startsWith(id)));
  }

  agentByHandle(handle: string) {
    return [...this.agents.values()].find((a) => a.handle === handle);
  }
}
