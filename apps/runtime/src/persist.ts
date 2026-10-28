import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { upgradePlan } from "@agents/core";
import type { Highlight, Idea, World } from "./world.js";

// Rudimentary persistence: the whole world is snapshotted to a JSON file after each
// pass (atomic write via rename) and restored on start. Swap for Postgres at scale.

export const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && "$big" in (v as object) ? BigInt((v as { $big: string }).$big) : v;

/** Everything the town remembers, in the shape `loadWorld` reads back. Secrets (API keys, sign-ins) are not in it. */
export function worldSnapshot(world: World) {
  return {
    agents: [...world.agents.values()],
    posts: world.posts.slice(-5000),
    coins: [...world.coins.values()],
    positions: [...world.positions.entries()],
    lastExits: [...world.lastExits.entries()],
    balances: [...world.balances.entries()],
    fills: world.fills.slice(-20000),
    decisions: world.decisions.slice(-5000),
    follows: [...world.follows],
    counters: [...world.counters.entries()],
    highlights: world.highlights.slice(-500),
    reviews: world.reviews.slice(-2000),
    predictions: world.predictions.slice(-5000),
    debates: world.debates.slice(-5000),
    chats: world.chats.slice(-5000),
    ideas: world.ideas.slice(-1000),
    projects: world.projects,
    memory: [...world.memory.entries()],
    pledges: [...world.pledges.entries()],
    inferenceFundWei: world.inferenceFundWei,
    dank: [...world.dank.entries()],
    duels: world.duels.slice(-2000),
    crown: world.crown,
    dankCredit: [...world.dankCredit.entries()],
    bricks: [...world.bricks.entries()],
    compliance: world.compliance,
  };
}

export function saveWorld(world: World, file: string, extra: Record<string, unknown> = {}) {
  const snap = { ...worldSnapshot(world), ...extra };
  writeFileSync(`${file}.tmp`, JSON.stringify(snap, replacer));
  renameSync(`${file}.tmp`, file);
}

export function loadWorld(world: World, file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  const s = JSON.parse(readFileSync(file, "utf8"), reviver);
  for (const a of s.agents ?? []) world.agents.set(a.account, a);
  world.posts = s.posts ?? [];
  for (const c of s.coins ?? []) world.coins.set(c.token, c);
  world.positions = new Map(s.positions ?? []);
  world.lastExits = new Map(s.lastExits ?? []);
  world.balances = new Map(s.balances ?? []);
  world.fills = s.fills ?? [];
  world.decisions = s.decisions ?? [];
  world.follows = new Set(s.follows ?? []);
  world.counters = new Map(s.counters ?? []);
  // "Opened" news was about the old coins opening to everyone (StonkFun coins are open from the
  // start), and "fix" news was about the bounty board, which is gone.
  world.highlights = (s.highlights ?? []).filter((h: { kind: string }) => h.kind !== "opened" && h.kind !== "fix") as Highlight[];
  world.reviews = s.reviews ?? [];
  world.predictions = s.predictions ?? [];
  world.debates = s.debates ?? [];
  world.chats = s.chats ?? [];
  // An idea keeps the coin it became only if that coin is still in town (old launchpad coins were retired).
  world.ideas = (s.ideas ?? []).map(({ launched, ...i }: Idea) => (launched && world.coins.has(launched) ? { ...i, launched } : i));
  world.projects = s.projects ?? [];
  world.memory = new Map(s.memory ?? []);
  world.pledges = new Map(s.pledges ?? []);
  world.inferenceFundWei = s.inferenceFundWei ?? 0n;
  // The Dank-off rates Café ideas now; ratings, duels and a crown that were about launched coins are dropped.
  const ideaIds = new Set(world.ideas.map((i) => i.id));
  world.dank = new Map((s.dank ?? []).filter(([id]: [string]) => ideaIds.has(id)));
  world.duels = (s.duels ?? []).filter((d: { a: string; b: string }) => ideaIds.has(d.a) && ideaIds.has(d.b));
  world.crown = s.crown?.id && ideaIds.has(s.crown.id) ? s.crown : undefined;
  world.dankCredit = new Map(s.dankCredit ?? []);
  world.bricks = new Map(s.bricks ?? []);
  if (s.compliance) world.compliance = s.compliance;
  // Plans saved when the sniper style only bought coins before they opened to everyone: every
  // coin is a market token now, so a plan that refuses open coins could never trade again.
  for (const a of world.agents.values()) if (a.plan?.phases && !a.plan.phases.opened) a.plan.phases = { ...a.plan.phases, opened: true };
  // Plans saved before timeframes and the stop-loss share existed get their style's defaults.
  for (const a of world.agents.values()) if (a.plan) a.plan = upgradePlan(a.plan);
  return s;
}

/**
 * Drops coins the agents launched on the old launchpad, from a save made before agents stopped
 * launching there: market tokens and StonkFun launches stay tradable. Holdings in a dropped coin go back to the agent at cost, and
 * open price calls on one close flat. For paper and demo worlds, whose balances are the runtime's
 * own; on-chain worlds keep what their indexers report. Returns how many coins were dropped.
 */
export function retireLaunchedCoins(world: World, now = Date.now()): number {
  const gone = new Set([...world.coins.values()].filter((c) => !c.market && c.venue !== "stonkfun").map((c) => c.token));
  if (!gone.size) return 0;
  for (const t of gone) world.coins.delete(t);
  for (const i of world.ideas) if (i.launched && gone.has(i.launched)) delete i.launched;
  for (const [acct, positions] of world.positions) {
    const kept = positions.filter((p) => !gone.has(p.token));
    const refund = positions.filter((p) => gone.has(p.token)).reduce((sum, p) => sum + p.costWei, 0n);
    if (refund > 0n) world.balances.set(acct, (world.balances.get(acct) ?? 0n) + refund);
    world.positions.set(acct, kept);
  }
  for (const p of world.predictions) {
    if (p.outcome || !gone.has(p.token)) continue;
    p.outcome = "flat";
    p.exitPrice = p.entryPrice;
    p.resolveAt = Math.min(p.resolveAt, now);
  }
  return gone.size;
}
