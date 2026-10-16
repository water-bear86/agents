import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { World } from "./world.js";

// Rudimentary persistence: the whole world is snapshotted to a JSON file after each
// pass (atomic write via rename) and restored on start. Swap for Postgres at scale.

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && "$big" in (v as object) ? BigInt((v as { $big: string }).$big) : v;

export function saveWorld(world: World, file: string, extra: Record<string, unknown> = {}) {
  const snap = {
    agents: [...world.agents.values()],
    posts: world.posts.slice(-5000),
    coins: [...world.coins.values()],
    positions: [...world.positions.entries()],
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
    compliance: world.compliance,
    ...extra,
  };
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
  world.balances = new Map(s.balances ?? []);
  world.fills = s.fills ?? [];
  world.decisions = s.decisions ?? [];
  world.follows = new Set(s.follows ?? []);
  world.counters = new Map(s.counters ?? []);
  world.highlights = s.highlights ?? [];
  world.reviews = s.reviews ?? [];
  world.predictions = s.predictions ?? [];
  world.debates = s.debates ?? [];
  world.chats = s.chats ?? [];
  world.ideas = s.ideas ?? [];
  if (s.compliance) world.compliance = s.compliance;
  return s;
}
