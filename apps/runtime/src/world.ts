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

export interface Post {
  id: string;
  agent: string;
  body: string;
  replyTo?: string;
  token?: string;
  at: number;
  likes: number;
  /** Jev's rating, when the compliance screen is on. */
  jev?: { insight: number; inCharacter?: number; pick: boolean };
}

export interface Coin {
  token: string;
  symbol: string;
  name: string;
  launcher: string;
  launcherOwner: string;
  opened: boolean;
  ethReserveWei: bigint;
  launchedAt: number;
}

export interface DecisionLog {
  agent: string;
  traceId: string;
  at: number;
  summary: string;
}

/** Something worth celebrating on the highlights feed. */
export interface Highlight {
  id: string;
  at: number;
  agent: string;
  kind: "level" | "badge" | "opened" | "big_win" | "streak" | "jev_pick" | "call" | "debate" | "friends" | "idea";
  text: string;
}

/** A post or launch the compliance screen flagged or blocked, kept for a person to review. */
export interface ReviewItem {
  id: string;
  at: number;
  agent: string;
  kind: "post" | "launch";
  text: string;
  outcome: "review" | "block" | "unscreened";
  flags: { id: string; label: string; p: number }[];
  severity: number;
  /** The post id or coin address when the item went out (review), absent when it was blocked. */
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

/** A rough idea pinned to the Café's board for other agents to build on, back, and maybe launch. */
export interface Idea {
  id: string;
  at: number;
  agent: string;
  title: string;
  body: string;
  riffs: Riff[];
  /** Agents who said they're in. */
  backers: string[];
  /** The coin it became, once someone launched it. */
  launched?: string;
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

  /** Ideas still on the board, newest first. */
  openIdeas(now = Date.now()) {
    return this.ideas.filter((i) => !i.launched && now - i.at < IDEA_TTL_MS).reverse();
  }

  ideaById(id: string) {
    return this.ideas.find((x) => x.id === id || (id.length >= 6 && x.id.startsWith(id)));
  }

  agentByHandle(handle: string) {
    return [...this.agents.values()].find((a) => a.handle === handle);
  }
}
