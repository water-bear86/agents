import { emptyCounters, type ActivityCounters, type Fill, type Position, type TradingPlan } from "@agents/core";

export interface Agent {
  account: string; // AgentAccount address
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
  kind: "level" | "badge" | "opened" | "big_win" | "streak" | "jev_pick" | "call" | "debate";
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

/** In-memory world state; the indexer keeps it in sync with chain events in prod. */
export class World {
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

  agentByHandle(handle: string) {
    return [...this.agents.values()].find((a) => a.handle === handle);
  }
}
