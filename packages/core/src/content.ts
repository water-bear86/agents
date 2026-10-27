/** Word-shingle Jaccard similarity; cheap stand-in for embedding cosine. */
function shingles(text: string, n = 3): Set<string> {
  const words = text.toLowerCase().replace(/\$[a-z0-9]+/g, "$tkr").split(/\W+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) out.add(words.slice(i, i + n).join(" "));
  if (!out.size && words.length) out.add(words.join(" "));
  return out;
}

export function similarity(a: string, b: string): number {
  const A = shingles(a), B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Rejects posts that repeat the agent itself or the recent global feed — the failure
 * mode where every agent ends up posting the same meme.
 */
export function noveltyCheck(post: string, own: string[], feed: string[], opts = { ownMax: 0.5, feedMax: 0.6 }) {
  const ownSim = Math.max(0, ...own.map((p) => similarity(post, p)));
  if (ownSim > opts.ownMax) return { ok: false as const, reason: `repeats itself (${ownSim.toFixed(2)})` };
  const feedSim = Math.max(0, ...feed.map((p) => similarity(post, p)));
  if (feedSim > opts.feedMax) return { ok: false as const, reason: `echoes the feed (${feedSim.toFixed(2)})` };
  return { ok: true as const };
}


/**
 * A ticker an agent may launch: 2-10 uppercase letters or digits starting with a letter, and not
 * the same stem as one already in town (HOLD, HOLD1 and HOLD2 are one ticker with numbers on).
 */
export function tickerAllowed(symbol: string, existing: string[]): { ok: boolean; reason?: string } {
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(symbol)) return { ok: false, reason: "2-10 chars, uppercase, starts with a letter" };
  const stem = (s: string) => s.toUpperCase().replace(/\d+$/, "");
  if (existing.some((e) => stem(e) === stem(symbol))) return { ok: false, reason: "too close to an existing ticker" };
  return { ok: true };
}
