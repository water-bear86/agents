// The Dank-off: a side game. Agents pin memes and ideas to the Café board and riff on each other's;
// every idea on the board (or that was) is a candidate, and Jev judges them head to head on
// dankness. Nothing is launched: a meme here is just words. Ratings move like chess ratings; the
// best-rated meme with enough duels behind it wears the crown, and every win credits everyone who
// made the meme: the idea's author and the agents who riffed on and backed it.

import type { JevClient, JevQuestion } from "./compliance.js";
import { DANK_CROWN_MIN_DUELS, DANK_START, type Duel, type World } from "./world.js";

const DANK: JevQuestion = {
  type: "choice",
  instructions: "Two memes AI agents came up with together compete to be the dankest meme of all time. Judge `a` against `b` on dankness alone: which one is funnier, more absurd in a good way, more quotable, more likely to be passed around and remembered? Their titles and lore are all that matter.",
  criteria: {
    a: "`a` is the dankest meme.",
    b: "`b` is the dankest meme.",
    even: "Neither is clearly danker.",
  },
};
/** Below this confidence a duel is a draw. */
const MIN_CONFIDENCE = 0.25;
const K = 32;

/** A meme in the Dank-off: one Café idea, its lore, and who made it. */
export interface Candidate { id: string; title: string; lore: string; makers: string[] }

/** Every idea pinned to the Café board, with the lore Jev reads: the idea itself and its best riffs. */
export function candidates(world: World): Candidate[] {
  return world.ideas.map((idea) => {
    const makers = new Set([idea.agent]);
    const parts = [idea.body];
    for (const r of idea.riffs.slice(0, 4)) { makers.add(r.agent); parts.push(`A riff: ${r.body}`); }
    for (const b of idea.backers) makers.add(b);
    return { id: idea.id, title: idea.title, lore: parts.filter(Boolean).join("\n").slice(0, 1500), makers: [...makers] };
  });
}

export type DankJudge = (a: Candidate, b: Candidate) => Promise<{ winner: "a" | "b" | "even"; confidence: number; judge: string; inputTokens: number }>;

/** Jev when there's a key; otherwise a stand-in that prefers longer lore and more makers, so the demo still plays. */
export function dankJudge(jev: JevClient | null): DankJudge {
  if (!jev) {
    return async (a, b) => {
      const score = (c: Candidate) => c.lore.length / 200 + c.makers.length + ((c.title.charCodeAt(0) + c.title.length) % 5) / 5;
      const d = score(a) - score(b);
      return { winner: Math.abs(d) < 0.3 ? "even" : d > 0 ? "a" : "b", confidence: Math.min(1, Math.abs(d) / 3), judge: "stand-in (no Jev key)", inputTokens: 0 };
    };
  }
  return async (a, b) => {
    const meme = (c: Candidate) => ({ title: c.title, lore: c.lore });
    const r = await jev.ask({ a: meme(a), b: meme(b) }, { dank: DANK });
    const ans = r.answers.dank;
    const pick = ans?.type === "choice" ? ans : undefined;
    const confidence = pick?.confidence ?? 0;
    const winner = !pick || confidence < MIN_CONFIDENCE || pick.choice === "even" ? "even" : (pick.choice as "a" | "b");
    return { winner, confidence, judge: "Jev", inputTokens: r.inputTokens };
  };
}

const expected = (ra: number, rb: number) => 1 / (1 + 10 ** ((rb - ra) / 400));

/**
 * Runs `n` duels, pairing the least-tested meme with the closest-rated one it hasn't just met.
 * Credits makers of winners, crowns a new champion when the top changes, and returns the duels.
 */
export async function runDuels(world: World, judge: DankJudge, n = 2, now = Date.now()): Promise<Duel[]> {
  const pool = candidates(world);
  if (pool.length < 2) return [];
  const rec = (t: string) => {
    let r = world.dank.get(t);
    if (!r) world.dank.set(t, (r = { rating: DANK_START, wins: 0, losses: 0, draws: 0, duels: 0 }));
    return r;
  };
  const byId = new Map(pool.map((c) => [c.id, c]));
  const done: Duel[] = [];
  for (let k = 0; k < n; k++) {
    const order = [...pool].sort((x, y) => rec(x.id).duels - rec(y.id).duels || x.id.localeCompare(y.id));
    const a = order[0]!;
    const recent = new Set(world.duels.slice(-20).filter((d) => d.a === a.id || d.b === a.id).map((d) => (d.a === a.id ? d.b : d.a)));
    const rivals = pool.filter((c) => c.id !== a.id).sort((x, y) => Number(recent.has(x.id)) - Number(recent.has(y.id)) || Math.abs(rec(x.id).rating - rec(a.id).rating) - Math.abs(rec(y.id).rating - rec(a.id).rating));
    const b = rivals[0];
    if (!b) break;
    const v = await judge(a, b);
    const ra = rec(a.id), rb = rec(b.id);
    const sa = v.winner === "a" ? 1 : v.winner === "b" ? 0 : 0.5;
    const ea = expected(ra.rating, rb.rating);
    ra.rating += K * (sa - ea);
    rb.rating += K * (1 - sa - (1 - ea));
    ra.duels++; rb.duels++;
    if (sa === 1) { ra.wins++; rb.losses++; } else if (sa === 0) { rb.wins++; ra.losses++; } else { ra.draws++; rb.draws++; }
    const d: Duel = { id: crypto.randomUUID(), at: now, a: a.id, b: b.id, winner: v.winner, confidence: v.confidence, judge: v.judge };
    world.duels.push(d);
    done.push(d);
    const won = v.winner === "a" ? a : v.winner === "b" ? b : undefined;
    if (won) for (const m of won.makers) world.dankCredit.set(m, (world.dankCredit.get(m) ?? 0) + 1);
  }
  // The crown: the best-rated meme that has proven itself in enough duels.
  const top = [...world.dank.entries()].filter(([t, r]) => r.duels >= DANK_CROWN_MIN_DUELS && byId.has(t)).sort((x, y) => y[1].rating - x[1].rating)[0];
  if (top && top[0] !== world.crown?.id) {
    world.crown = { id: top[0], since: now };
    const c = byId.get(top[0])!;
    for (const m of c.makers) world.dankCredit.set(m, (world.dankCredit.get(m) ?? 0) + 10);
    world.highlight({ agent: c.makers[0]!, kind: "dank", text: `saw its Café idea "${c.title}" crowned the dankest meme in town by ${done.at(-1)?.judge ?? "Jev"} (rated ${Math.round(top[1].rating)})` });
  }
  return done;
}
