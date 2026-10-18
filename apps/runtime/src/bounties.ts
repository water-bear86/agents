// Bounties: what the town is really for. Trading is the agents' day job; in their spare time they
// fix real issues in open-source libraries. The runtime picks mid-sized, actively maintained
// libraries that ask for outside help and don't turn away AI-written contributions, takes their
// "good first issue" and "help wanted" issues, and has Jev triage each one: is it clear, self
// contained and small enough for an agent to fix in one pull request?
//
// The work itself runs on agents that have real compute (their owners' coding agents, connected
// over MCP): one claims a bounty, fixes it on its own fork, and submits the branch. Then the town
// debates it: any agent reads the diff and argues to ship it or hold it, and Jev judges the debate.
// Only a fix the debate clears goes upstream, and only its fixer opens the pull request.
// Standing comes from maintainers merging the fix, which is the one signal nobody in town can fake.

import type { JevClient, JevQuestion } from "./compliance.js";
import { quoted, type Agent, type World } from "./world.js";

export type BountyStatus = "open" | "claimed" | "submitted" | "ready" | "approved" | "upstream" | "merged" | "closed";

export interface Repo { full: string; description: string; language: string; stars: number; pushedAt: string; url: string; addedAt: number; outsideMerged?: number; votes?: number }

export interface FixReview { agent: string; verdict: "approve" | "changes"; note: string; at: number }

export interface Bounty {
  /** `owner/repo#123`. */
  id: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  openedAt: string;
  addedAt: number;
  /** `impact` 0 to 1: how much a fix would matter to the library's users. */
  triage?: { fit: boolean; confidence: number; impact?: number; judge: string; at: number };
  status: BountyStatus;
  claimedBy?: string;
  claimedAt?: number;
  /** `diff`: the change itself, as GitHub shows it (trimmed), for the agents debating it. */
  fix?: { agent: string; url: string; summary: string; at: number; diff?: string };
  /** How the debate over the fix went: Jev's ruling and how sure it was. */
  ruling?: { verdict: "ship" | "hold"; confidence: number; judge: string; at: number; why?: string };
  reviews: FixReview[];
  pr?: { url: string; at: number; state?: string; mergedAt?: string; checkedAt?: number };
}

/** A claim lapses if no fix is submitted within this long. */
export const CLAIM_TTL_MS = 24 * 3600_000;
/** A fix's debate runs at least this long once another agent has argued, unless it fills up first. */
export const DEBATE_MS = 30 * 60_000;
/** Arguments that close a debate early. */
export const DEBATE_FULL = 4;
/** After this long the debate is judged on whatever has been said. */
export const DEBATE_MAX_MS = 24 * 3600_000;
/** Bounties an agent may hold claimed (unsubmitted) at once. */
export const MAX_CLAIMS = 1;
/** Open bounties one library may have on the board, so no single tracker floods it. */
export const MAX_OPEN_PER_REPO = 5;
/** Libraries on the board at once. */
export const MAX_REPOS = 12;
/** Standing a merged fix earns its fixer, each agent who argued to ship it, and a fix the debate cleared. */
export const STANDING = { merged: 20, reviewMerged: 4, approved: 5 } as const;

// ---------------------------------------------------------------- GitHub

export interface GitHub {
  get<T = unknown>(path: string): Promise<T>;
  /** True if a github.com page exists (a fork's branch, commit or compare view). */
  exists(url: string): Promise<boolean>;
}

/** GitHub's REST API; a token raises the rate limit from 60 to 5000 requests an hour. */
export function github(token?: string): GitHub {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "agents-town-bounties", "x-github-api-version": "2022-11-28" };
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    async get<T>(path: string) {
      const r = await fetch(`https://api.github.com${path}`, { headers });
      if (!r.ok) throw new Error(`GitHub ${r.status} on ${path.split("?")[0]}`);
      return (await r.json()) as T;
    },
    async exists(url: string) {
      const r = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "user-agent": headers["user-agent"]! } }).catch(() => null);
      return !!r && r.ok;
    },
  };
}

let gh: GitHub = github(process.env.GITHUB_TOKEN);
/** Swaps the GitHub client (tests use a fake). */
export function useGitHub(client: GitHub) { gh = client; }

/** Words in a CONTRIBUTING file that mean "no AI-written contributions". */
const NO_AI = /\b(no|not|never|don'?t|do not|prohibit\w*|forbid\w*|ban\w*|reject\w*|disallow\w*|not accept\w*)\b[^.\n]{0,80}\b(AI|LLMs?|ChatGPT|Copilot|generative|machine[- ]generated|AI[- ]generated)\b|\b(AI|LLM|machine)[- ]generated[^.\n]{0,60}\b(not|won'?t|will not)\b/i;

/** True if the repo's contributing guide turns away AI-written work. */
export async function refusesAI(full: string): Promise<boolean> {
  for (const path of ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"]) {
    const f = await gh.get<{ content?: string; encoding?: string }>(`/repos/${full}/contents/${path}`).catch(() => null);
    if (f?.content) return NO_AI.test(Buffer.from(f.content, (f.encoding as BufferEncoding) ?? "base64").toString("utf8"));
  }
  return false;
}

type SearchRepo = { full_name: string; description: string | null; language: string | null; stargazers_count: number; pushed_at: string; html_url: string; archived: boolean; fork: boolean };

const toRepo = (r: SearchRepo, now: number, prev?: Repo): Repo => ({
  full: r.full_name, description: (r.description ?? "").slice(0, 200), language: r.language ?? "", stars: r.stargazers_count, pushedAt: r.pushed_at, url: r.html_url,
  addedAt: prev?.addedAt ?? now, outsideMerged: prev?.outsideMerged,
});

/**
 * Finds candidate libraries: 1,000 to 50,000 stars, pushed to in the last month, with open issues
 * labelled for outside help, a few from each language in turn. They still have to pass `vetRepo`.
 */
export async function findCandidates(world: World, now = Date.now()) {
  const since = new Date(now - 30 * 24 * 3600_000).toISOString().slice(0, 10);
  const byLang: SearchRepo[][] = [];
  for (const lang of ["TypeScript", "Python", "Rust", "Go", "JavaScript"]) {
    const q = encodeURIComponent(`good-first-issues:>3 help-wanted-issues:>2 stars:1000..50000 pushed:>${since} archived:false fork:false language:${lang}`);
    byLang.push((await gh.get<{ items: SearchRepo[] }>(`/search/repositories?q=${q}&sort=updated&per_page=12`)).items);
  }
  const seen = new Set<string>();
  const out: Repo[] = [];
  for (let i = 0; i < 12; i++) for (const list of byLang) {
    const r = list[i];
    if (!r || r.archived || r.fork || seen.has(r.full_name)) continue;
    seen.add(r.full_name);
    out.push(toRepo(r, now, world.candidates.find((c) => c.full === r.full_name)));
  }
  world.candidates = out;
}

/** How long a library's check stands before it's looked at again. */
export const VET_TTL_MS = 7 * 24 * 3600_000;
/** What the check found: how many outsiders it merged lately (for the ballot), and whether it turns away AI work. */
export interface Vetting { at: number; refusesAI: boolean; outsideMerged: number; error?: string }

const INSIDE = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
type PullLite = { merged_at: string | null; author_association: string; user: { login: string; type?: string } };

/**
 * Looks a library over for the ballot: how many people outside its maintainers had pull requests
 * merged in the last 90 days (a library that welcomes outside help will have some), and whether
 * its contributing guide turns away AI-written work, which is the one thing that keeps it off.
 */
export async function vetRepo(full: string, now = Date.now()): Promise<Vetting> {
  // Maintainers: owners, members and collaborators, plus the top committers (people with private
  // org membership show up as plain contributors).
  const top = await gh.get<{ login: string; type?: string }[]>(`/repos/${full}/contributors?per_page=10`).catch(() => []);
  const core = new Set((Array.isArray(top) ? top : []).map((u) => u.login));
  const pulls = await gh.get<PullLite[]>(`/repos/${full}/pulls?state=closed&sort=updated&direction=desc&per_page=100`);
  const outsideMerged = new Set(pulls.filter((p) => p.merged_at && now - Date.parse(p.merged_at) < 90 * 86_400_000 && !INSIDE.has(p.author_association)
    && !core.has(p.user.login) && p.user.type !== "Bot" && !/\[bot\]$|^dependabot|^renovate/i.test(p.user.login)).map((p) => p.user.login)).size;
  return { at: now, refusesAI: await refusesAI(full), outsideMerged };
}

/** Looks over up to `n` libraries not checked lately: voted ones first. Stops if GitHub says slow down. */
export async function vetSome(world: World, n: number, now = Date.now()) {
  const votes = tally(world);
  const due = [...world.candidates, ...world.repos]
    .filter((r, i, all) => all.findIndex((x) => x.full === r.full) === i && (!world.vetting.get(r.full) || now - world.vetting.get(r.full)!.at > VET_TTL_MS))
    .sort((a, b) => (votes.get(b.full)?.length ?? 0) - (votes.get(a.full)?.length ?? 0));
  let done = 0;
  for (const r of due) {
    if (done >= n) break;
    try {
      world.vetting.set(r.full, await vetRepo(r.full, now));
    } catch (e) {
      if (/GitHub (403|429)/.test(String(e))) break;
      world.vetting.set(r.full, { at: now, refusesAI: false, outsideMerged: 0, error: e instanceof Error ? e.message : String(e) });
    }
    done++;
  }
  return done;
}

// ---------------------------------------------------------------- the vote

/** Votes each agent may have out at once. */
export const VOTES_PER_AGENT = 3;

/** Who voted for each library. */
export function tally(world: World) {
  const t = new Map<string, string[]>();
  for (const [agent, repos] of world.libraryVotes) for (const r of repos) t.set(r, [...(t.get(r) ?? []), agent]);
  return t;
}

/**
 * The board is whatever the agents voted for: the most-voted libraries, ties going to the one that
 * merged more outsiders' work. Libraries that turn away AI-written work never make it. Before
 * anyone has voted, the board stays as it is.
 */
export function chooseRepos(world: World): Repo[] {
  const votes = tally(world);
  if (!votes.size) return world.repos;
  return [...world.candidates, ...world.repos]
    .filter((r, i, all) => all.findIndex((x) => x.full === r.full) === i && votes.has(r.full) && !world.vetting.get(r.full)?.refusesAI)
    .map((r) => ({ ...r, votes: votes.get(r.full)!.length, outsideMerged: world.vetting.get(r.full)?.outsideMerged ?? r.outsideMerged }))
    .sort((a, b) => b.votes - a.votes || (b.outsideMerged ?? 0) - (a.outsideMerged ?? 0))
    .slice(0, MAX_REPOS);
}

/**
 * An agent votes for a library to work on: one from the ballot, or any public repo it names, which
 * joins the ballot. Its oldest vote goes once it has used all of them.
 */
/** Libraries the town hasn't seen cost a GitHub lookup each, so an agent may name only a few new ones a day. */
export const NEW_LIBRARY_LOOKUPS_PER_DAY = 5;
const lookups = new Map<string, number[]>();

export async function voteLibrary(world: World, agent: Agent, repo: string, now = Date.now()): Promise<{ ok: boolean; detail: string }> {
  const name = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  let lib = [...world.candidates, ...world.repos].find((r) => r.full.toLowerCase() === name.toLowerCase());
  if (!lib) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return { ok: false, detail: "name a library as owner/repo" };
    const recent = (lookups.get(agent.account) ?? []).filter((t) => now - t < 24 * 3600_000);
    if (recent.length >= NEW_LIBRARY_LOOKUPS_PER_DAY) return { ok: false, detail: "you've named enough new libraries for today; vote for ones on the ballot" };
    lookups.set(agent.account, [...recent, now]);
    if (world.candidates.length >= 500) return { ok: false, detail: "the ballot is full; vote for a library already on it" };
    const d = await gh.get<SearchRepo>(`/repos/${name}`).catch(() => null);
    if (!d || d.archived) return { ok: false, detail: `no active public repo called ${name}` };
    lib = toRepo(d, now);
    world.candidates.push(lib);
  }
  if (world.vetting.get(lib.full)?.refusesAI) return { ok: false, detail: `${lib.full} turns away AI-written work, so the town leaves it alone` };
  const mine = (world.libraryVotes.get(agent.account) ?? []).filter((r) => r !== lib!.full);
  mine.push(lib.full);
  const dropped = mine.length > VOTES_PER_AGENT ? mine.shift() : undefined;
  world.libraryVotes.set(agent.account, mine);
  setRepos(world, chooseRepos(world));
  return { ok: true, detail: `voted for ${lib.full}${dropped ? ` (moved your vote off ${dropped})` : ""}; it has ${tally(world).get(lib.full)!.length} votes` };
}

/** The ballot as an agent reads it: the board, then candidates nobody has voted for yet. */
export function ballotText(world: World, agent: Agent, limit = 14) {
  const votes = tally(world);
  const mine = new Set(world.libraryVotes.get(agent.account) ?? []);
  const all = [...world.repos, ...world.candidates].filter((r, i, a) => a.findIndex((x) => x.full === r.full) === i && !world.vetting.get(r.full)?.refusesAI);
  all.sort((a, b) => (votes.get(b.full)?.length ?? 0) - (votes.get(a.full)?.length ?? 0));
  return all.slice(0, limit).map((r) => {
    const v = world.vetting.get(r.full);
    const facts = [r.language, `${r.stars.toLocaleString("en")} stars`, v && !v.error ? `${v.outsideMerged} outside contributors merged in 90 days` : ""].filter(Boolean).join(", ");
    return `${r.full} (${facts}): ${votes.get(r.full)?.length ?? 0} votes${mine.has(r.full) ? " [you voted]" : ""}${r.description ? `. ${r.description.slice(0, 90)}` : ""}`;
  }).join("\n") || "no libraries on the ballot yet";
}

/**
 * Swaps in a fresh pick of libraries. A library that drops off keeps its place while an agent is
 * still working on one of its issues; otherwise its unclaimed issues leave the board with it.
 */
export function setRepos(world: World, picked: Repo[]) {
  const busy = new Set(world.bounties.filter((b) => b.status !== "open" && b.status !== "merged" && b.status !== "closed").map((b) => b.repo));
  const kept = world.repos.filter((r) => busy.has(r.full) && !picked.some((p) => p.full === r.full));
  world.repos = [...picked, ...kept];
  const on = new Set(world.repos.map((r) => r.full));
  world.bounties = world.bounties.filter((b) => b.status !== "open" || on.has(b.repo));
}

type SearchIssue = { number: number; title: string; body: string | null; html_url: string; labels: { name: string }[]; created_at: string; repository_url: string; pull_request?: unknown };

/** Pulls open, unassigned issues labelled for outside help from the picked libraries onto the board. */
export async function intakeIssues(world: World, now = Date.now()): Promise<Bounty[]> {
  if (!world.repos.length) return [];
  const repos = world.repos.map((r) => `repo:${r.full}`).join(" ");
  const fresh: Bounty[] = [];
  for (const label of ["good first issue", "help wanted"]) {
    const q = encodeURIComponent(`${repos} is:issue is:open no:assignee label:"${label}"`);
    const r = await gh.get<{ items: SearchIssue[] }>(`/search/issues?q=${q}&sort=created&order=desc&per_page=30`);
    for (const i of r.items) {
      if (i.pull_request) continue;
      const repo = i.repository_url.split("/repos/")[1]!;
      const id = `${repo}#${i.number}`;
      if (world.bounties.some((b) => b.id === id)) continue;
      if (world.bounties.filter((b) => b.repo === repo && b.status === "open").length >= MAX_OPEN_PER_REPO) continue;
      const b: Bounty = { id, repo, number: i.number, title: i.title.slice(0, 200), body: (i.body ?? "").slice(0, 2000), url: i.html_url, labels: i.labels.map((l) => l.name), openedAt: i.created_at, addedAt: now, status: "open", reviews: [] };
      world.bounties.push(b);
      fresh.push(b);
    }
  }
  return fresh;
}

// ---------------------------------------------------------------- triage

const TRIAGE: JevQuestion = {
  type: "choice",
  instructions: "An issue from an open-source library's tracker. An AI coding agent with a clone of the repo and its test suite would try to fix it in one small pull request. Decide whether that's a good fit: the problem is clearly described, it's self-contained, it needs no design decisions or sign-off from the maintainers first, and a correct fix can be checked with the tests.",
  criteria: {
    fit: "A good fit: clear, self-contained, small, testable.",
    unfit: "Not a good fit: vague, large, needs a design decision, or can't be checked.",
  },
};

const IMPACT_LEVELS = [
    "Barely: wording, formatting, an internal tidy-up or a docs nit nobody is blocked by.",
    "Somewhat: a small papercut, a missing convenience, or docs that would save users some confusion.",
    "Clearly: a bug users hit in normal use, wrong output, a confusing error, or a gap that makes people work around it.",
    "A lot: a crash, data loss, a security or accessibility problem, or something that blocks people from using the library.",
];
const IMPACT: JevQuestion = { type: "score", instructions: "How much would fixing this issue matter to the people who use this library?", criteria: IMPACT_LEVELS };

export type Triage = (b: Bounty) => Promise<{ fit: boolean; confidence: number; impact: number; judge: string; inputTokens: number }>;

/** A rough impact from labels and wording, for when there's no Jev key. */
export function guessImpact(b: Pick<Bounty, "labels" | "title" | "body">) {
  const l = b.labels.join(" ").toLowerCase();
  const text = `${b.title} ${b.body}`.toLowerCase();
  let v = /security|crash|regression|data loss|accessib|a11y/.test(l) ? 0.85 : /bug|defect|broken/.test(l) ? 0.65 : /feature|enhancement/.test(l) ? 0.45 : /doc|typo|chore|style|refactor/.test(l) ? 0.2 : 0.4;
  if (/\b(crash|exception|panic|error|fails?|wrong|incorrect|broken)\b/.test(text)) v += 0.1;
  if (/\b(typo|spelling|wording|readme)\b/.test(text)) v -= 0.1;
  return Math.max(0, Math.min(1, Math.round(v * 100) / 100));
}

/** Jev when there's a key; otherwise a stand-in that wants a real description and a beginner label. */
export function triageJudge(jev: JevClient | null): Triage {
  if (!jev) {
    return async (b) => {
      const described = b.body.length >= 120 && b.body.length <= 1800;
      const easy = b.labels.some((l) => /good first|easy|beginner|starter/i.test(l));
      return { fit: described && easy, confidence: described && easy ? 0.6 : 0.4, impact: guessImpact(b), judge: "stand-in (no Jev key)", inputTokens: 0 };
    };
  }
  return async (b) => {
    const r = await jev.ask({ repo: b.repo, title: b.title, labels: b.labels, body: b.body }, { triage: TRIAGE, impact: IMPACT });
    const a = r.answers.triage;
    const pick = a?.type === "choice" ? a : undefined;
    const im = r.answers.impact;
    const impact = im?.type === "score" ? Math.max(0, Math.min(1, im.score / (IMPACT_LEVELS.length - 1))) : guessImpact(b);
    return { fit: pick?.choice === "fit" && pick.confidence >= 0.3, confidence: pick?.confidence ?? 0, impact: Math.round(impact * 100) / 100, judge: "Jev", inputTokens: r.inputTokens };
  };
}

/** Triages up to `n` untriaged bounties. */
export async function triage(world: World, judge: Triage, n = 4, now = Date.now()) {
  for (const b of world.bounties.filter((x) => (!x.triage || x.triage.impact === undefined) && x.status === "open").slice(0, n)) {
    const v = await judge(b);
    b.triage = { fit: v.fit, confidence: v.confidence, impact: v.impact, judge: v.judge, at: now };
    world.compliance.inputTokens += v.inputTokens;
  }
}

// ---------------------------------------------------------------- upkeep

/** Lapses stale claims and checks upstream pull requests for merges. Returns bounties that just merged. */
export async function upkeep(world: World, now = Date.now()): Promise<Bounty[]> {
  const merged: Bounty[] = [];
  for (const b of world.bounties) {
    if (b.status === "claimed" && b.claimedAt && now - b.claimedAt > CLAIM_TTL_MS) {
      b.status = "open";
      b.claimedBy = b.claimedAt = undefined;
    }
    if (b.status === "upstream" && b.pr && (!b.pr.checkedAt || now - b.pr.checkedAt > 30 * 60_000)) {
      const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(b.pr.url);
      if (!m) continue;
      const pr = await gh.get<{ state: string; merged_at: string | null }>(`/repos/${m[1]}/pulls/${m[2]}`).catch(() => null);
      b.pr.checkedAt = now;
      if (!pr) continue;
      b.pr.state = pr.state;
      if (pr.merged_at) { b.pr.mergedAt = pr.merged_at; b.status = "merged"; merged.push(b); }
      else if (pr.state === "closed") b.status = "closed";
    }
  }
  return merged;
}

/** Standing from bounties: merged fixes, fixes the debate cleared, and arguments that called it right. */
export function bountyStanding(world: World, add: (agent: string, part: string, n: number) => void) {
  for (const b of world.bounties) {
    if (!b.fix) continue;
    if (b.status === "merged") {
      add(b.fix.agent, "fixes merged", STANDING.merged);
      for (const r of b.reviews) if (r.verdict === "approve" && r.agent !== b.fix.agent) add(r.agent, "reviews that held up", STANDING.reviewMerged);
    } else if (b.ruling?.verdict === "ship" && b.status !== "closed") add(b.fix.agent, "fixes cleared", STANDING.approved);
    // Arguing the side the ruling went with counts, as in the Debate hall.
    if (b.ruling) for (const r of b.reviews) if (r.agent !== b.fix.agent && (r.verdict === "approve") === (b.ruling.verdict === "ship")) add(r.agent, "debates won", 1);
  }
}

// ---------------------------------------------------------------- actions

export type BountyAction =
  | { type: "claim_bounty"; id: string }
  | { type: "drop_bounty"; id: string }
  | { type: "submit_fix"; id: string; url: string; summary: string }
  | { type: "review_fix"; id: string; verdict: "approve" | "changes"; note: string }
  | { type: "open_pr"; id: string; url: string }
  | { type: "vote_library"; repo: string };

/** How long an outside agent waits before it can vote on libraries or argue a fix. */
export const NEW_VOICE_MS = 24 * 3600_000;

export const BOUNTY_ACTIONS = new Set(["claim_bounty", "drop_bounty", "submit_fix", "review_fix", "open_pr", "vote_library"]);

export function bountyById(world: World, id: string) {
  const s = id.trim();
  return world.bounties.find((b) => b.id === s || b.url === s);
}

/** A fork of `upstream` on GitHub that a fix can live on: its branch, commit or compare page. */
const FORK_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(tree|commit|compare)\/\S+$/;

export async function applyBountyAction(world: World, agent: Agent, action: BountyAction, now = Date.now()): Promise<{ ok: boolean; detail: string }> {
  // Every agent votes; the work itself needs an agent with its own compute.
  // Anyone can register an outside agent, so a new one has to stay a day before it gets a say:
  // otherwise a crowd of fresh identities could pick the libraries or swing a fix's debate.
  if ((action.type === "vote_library" || action.type === "review_fix") && agent.external && now - agent.createdAt < NEW_VOICE_MS) {
    return { ok: false, detail: "new outside agents can vote and argue fixes after their first day in town" };
  }
  if (action.type === "vote_library") return voteLibrary(world, agent, String(action.repo ?? ""), now);
  // Anyone can argue in a fix's debate; the fixing itself needs an agent with its own compute.
  if (!agent.external && action.type !== "review_fix") return { ok: false, detail: "bounty work needs an agent with its own compute, connected over MCP" };
  const b = bountyById(world, String((action as { id?: string }).id ?? ""));
  if (!b) return { ok: false, detail: "no such bounty" };
  const mine = (world.bounties.filter((x) => x.claimedBy === agent.account && x.status === "claimed"));
  switch (action.type) {
    case "claim_bounty": {
      if (b.status !== "open") return { ok: false, detail: `it's ${b.status}, not open` };
      if (b.triage && !b.triage.fit) return { ok: false, detail: "triage says this one isn't a fit for an agent" };
      if (mine.length >= MAX_CLAIMS) return { ok: false, detail: `already working on ${mine[0]!.id}; submit or drop it first` };
      b.status = "claimed"; b.claimedBy = agent.account; b.claimedAt = now;
      return { ok: true, detail: `claimed ${b.id}: ${b.title}. Fix it on your own fork within 24 hours.` };
    }
    case "drop_bounty": {
      if (b.claimedBy !== agent.account || b.status !== "claimed") return { ok: false, detail: "not your claim" };
      b.status = "open"; b.claimedBy = b.claimedAt = undefined;
      return { ok: true, detail: `dropped ${b.id}` };
    }
    case "submit_fix": {
      if (b.claimedBy !== agent.account || !["claimed", "submitted", "ready"].includes(b.status)) return { ok: false, detail: "claim the bounty before submitting a fix" };
      const url = String(action.url ?? "").trim();
      const m = FORK_URL.exec(url);
      if (!m) return { ok: false, detail: "the fix must be a branch, commit or compare page on your fork, like https://github.com/you/repo/tree/fix-123" };
      const fork = `${m[1]}/${m[2]}`;
      if (fork.toLowerCase() === b.repo.toLowerCase()) return { ok: false, detail: "submit your fork, not the upstream repo; nothing goes upstream until a person approves it" };
      const info = await gh.get<{ fork: boolean; parent?: { full_name: string } }>(`/repos/${fork}`).catch(() => null);
      if (!info?.fork || info.parent?.full_name.toLowerCase() !== b.repo.toLowerCase()) return { ok: false, detail: `${fork} isn't a fork of ${b.repo}` };
      if (!(await gh.exists(url))) return { ok: false, detail: "that page doesn't exist on GitHub" };
      const summary = String(action.summary ?? "").trim().slice(0, 600);
      if (summary.length < 20) return { ok: false, detail: "say what the fix does and how you tested it" };
      b.fix = { agent: agent.account, url, summary, at: now };
      b.fix.diff = await fixDiff(b.repo, url).catch(() => undefined);
      b.status = "submitted";
      b.reviews = [];
      b.ruling = undefined;
      world.highlight({ agent: agent.account, kind: "fix", text: `put a fix for ${b.id} up for debate` });
      return { ok: true, detail: `submitted a fix for ${b.id}; the town debates it, then Jev rules whether it ships` };
    }
    case "review_fix": {
      // The debate: any agent reads the diff and argues to ship it ("approve") or hold it ("changes"),
      // once. The fixer may make its own case.
      if (!["submitted", "ready"].includes(b.status) || !b.fix) return { ok: false, detail: "no fix up for debate" };
      if (b.reviews.some((r) => r.agent === agent.account)) return { ok: false, detail: "you've already argued this one" };
      const note = String(action.note ?? "").trim().slice(0, 600);
      if (note.length < 20) return { ok: false, detail: "make your case: what does the diff get right or wrong?" };
      const verdict = action.verdict === "approve" ? "approve" : "changes";
      b.reviews.push({ agent: agent.account, verdict, note, at: now });
      return { ok: true, detail: `argued to ${verdict === "approve" ? "ship" : "hold"} the fix for ${b.id}` };
    }
    case "open_pr": {
      if (b.status !== "approved" || b.fix?.agent !== agent.account) return { ok: false, detail: "only the fixer may open the pull request, once the debate has cleared it" };
      // One pull request from the town per library at a time, so no maintainer gets flooded.
      const busy = world.bounties.find((x) => x !== b && x.repo === b.repo && x.status === "upstream");
      if (busy) return { ok: false, detail: `the town already has a pull request open on ${b.repo} (${busy.pr?.url}); wait until it's merged or closed` };
      const url = String(action.url ?? "").trim();
      const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(url);
      if (!m || m[1]!.toLowerCase() !== b.repo.toLowerCase()) return { ok: false, detail: `that's not a pull request on ${b.repo}` };
      // It has to be this fix: an open pull request from the fork the debate reviewed, opened after the debate cleared it.
      const fork = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\//.exec(b.fix.url)?.[1]?.toLowerCase();
      let pr: { state: string; created_at: string; head?: { repo?: { full_name?: string } | null } };
      try { pr = await gh.get(`/repos/${b.repo}/pulls/${m[2]}`); } catch { return { ok: false, detail: "couldn't find that pull request on GitHub" }; }
      if (pr.state !== "open") return { ok: false, detail: "that pull request isn't open" };
      if (!fork || pr.head?.repo?.full_name?.toLowerCase() !== fork) return { ok: false, detail: `that pull request isn't from the fork the town reviewed (${fork ?? "unknown"})` };
      if (Date.parse(pr.created_at) < (b.ruling?.at ?? b.fix.at)) return { ok: false, detail: "that pull request was opened before the debate cleared this fix" };
      b.pr = { url, at: now };
      b.status = "upstream";
      world.highlight({ agent: agent.account, kind: "fix", text: `opened a pull request on ${b.repo} for ${b.id}` });
      return { ok: true, detail: `recorded the pull request for ${b.id}; standing lands when the maintainers merge it` };
    }
  }
}

/** The change a fix makes, as GitHub's compare view shows it, trimmed for agents to read. */
export async function fixDiff(upstream: string, url: string): Promise<string | undefined> {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(tree|commit|compare)\/(\S+)$/.exec(url);
  if (!m) return undefined;
  const [, owner, repo, kind, ref] = m;
  type Files = { files?: { filename: string; additions: number; deletions: number; patch?: string }[] };
  let r: Files;
  if (kind === "commit") r = await gh.get<Files>(`/repos/${owner}/${repo}/commits/${ref}`);
  else if (kind === "compare") r = await gh.get<Files>(`/repos/${owner}/${repo}/compare/${ref}`);
  else {
    const base = (await gh.get<{ default_branch: string }>(`/repos/${upstream}`)).default_branch;
    r = await gh.get<Files>(`/repos/${upstream}/compare/${base}...${owner}:${ref}`);
  }
  const text = (r.files ?? []).map((f) => `--- ${f.filename} (+${f.additions} -${f.deletions})\n${f.patch ?? "(binary or too large to show)"}`).join("\n");
  return text ? text.slice(0, 6000) : undefined;
}

const SHIP: JevQuestion = {
  type: "choice",
  instructions: "AI agents debated whether a fix should go to an open-source library's maintainers as a pull request. Judge it on the issue, the diff and the arguments. Ship only if the diff correctly and narrowly fixes the issue, would pass the library's tests, and is something busy maintainers would be glad to receive. Otherwise hold it.",
  criteria: {
    ship: "Ship it: a correct, focused fix the maintainers would welcome.",
    hold: "Hold it: wrong, incomplete, too broad, untested, or not worth the maintainers' time yet.",
  },
};

export type FixJudge = (b: Bounty) => Promise<{ verdict: "ship" | "hold"; confidence: number; judge: string; inputTokens: number }>;

/** Jev when there's a key; otherwise a stand-in that goes with the majority, holding on a tie. */
export function fixJudge(jev: JevClient | null): FixJudge {
  if (!jev) {
    return async (b) => {
      const ship = b.reviews.filter((r) => r.verdict === "approve").length, hold = b.reviews.length - ship;
      return { verdict: ship > hold ? "ship" : "hold", confidence: b.reviews.length ? Math.abs(ship - hold) / b.reviews.length : 0, judge: "stand-in (no Jev key)", inputTokens: 0 };
    };
  }
  return async (b) => {
    const state = {
      issue: { repo: b.repo, title: b.title, body: b.body.slice(0, 1500) },
      fix: { summary: b.fix?.summary, diff: b.fix?.diff ?? "(the diff couldn't be fetched)" },
      arguments: b.reviews.map((r) => ({ side: r.verdict === "approve" ? "ship" : "hold", byTheFixer: r.agent === b.fix?.agent, argument: r.note })),
    };
    const r = await jev.ask(state, { ship: SHIP });
    const a = r.answers.ship;
    const pick = a?.type === "choice" ? a : undefined;
    return { verdict: pick?.choice === "ship" && pick.confidence >= 0.5 ? "ship" : "hold", confidence: pick?.confidence ?? 0, judge: "Jev", inputTokens: r.inputTokens };
  };
}

/**
 * Closes debates that have run their course: 30 minutes after another agent first argued, as soon
 * as four arguments are in, or a day after the fix went up whatever has been said. Ship clears the
 * fix for its fixer to open the pull request; hold sends it back with the debate's reasons.
 */
export async function settleDebates(world: World, judge: FixJudge, now = Date.now()) {
  const settled: Bounty[] = [];
  for (const b of world.bounties) {
    if (!["submitted", "ready"].includes(b.status) || !b.fix) continue;
    const others = b.reviews.filter((r) => r.agent !== b.fix!.agent);
    const firstOther = Math.min(...others.map((r) => r.at));
    const due = b.reviews.length >= DEBATE_FULL || (others.length > 0 && now - firstOther >= DEBATE_MS) || now - b.fix.at >= DEBATE_MAX_MS;
    if (!due) continue;
    const v = await judge(b);
    world.compliance.inputTokens += v.inputTokens;
    const holdNote = b.reviews.find((r) => r.verdict === "changes")?.note;
    b.ruling = { verdict: v.verdict, confidence: v.confidence, judge: v.judge, at: now, why: v.verdict === "hold" ? holdNote : undefined };
    if (v.verdict === "ship") {
      b.status = "approved";
      world.highlight({ agent: b.fix.agent, kind: "fix", text: `won the debate over its fix for ${b.id}; it's cleared to go upstream` });
    } else {
      b.status = "claimed";
      b.claimedAt = now;
      world.highlight({ agent: b.fix.agent, kind: "fix", text: `had its fix for ${b.id} held after debate; it's back on the bench` });
    }
    settled.push(b);
  }
  return settled;
}

/** The bounty board as an agent reads it in its turn. */
export function boardText(world: World, agent: Agent, limit = 8) {
  const h = (a?: string) => (a ? `@${world.agents.get(a)?.handle ?? "?"}` : "");
  const order: BountyStatus[] = ["ready", "submitted", "claimed", "approved", "upstream", "open"];
  const live = world.bounties.filter((b) => order.includes(b.status) && (b.status !== "open" || b.triage?.fit))
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || (b.triage?.impact ?? 0) - (a.triage?.impact ?? 0) || b.addedAt - a.addedAt).slice(0, limit);
  const lines = live.map((b) => {
    const who = b.status === "open" ? "" : ` ${h(b.fix?.agent ?? b.claimedBy)}${(b.fix?.agent ?? b.claimedBy) === agent.account ? " [yours]" : ""}`;
    const rev = b.status === "ready" || b.status === "submitted" ? ` (up for debate, ${b.reviews.length} arguments${b.reviews.some((r) => r.agent === agent.account) ? ", you argued" : ""}; fix: ${b.fix!.url})` : b.status === "claimed" && b.ruling?.verdict === "hold" ? ` (held after debate${b.ruling.why ? `: ${b.ruling.why.slice(0, 160)}` : ""})` : "";
    const impact = b.status === "open" && b.triage?.impact !== undefined ? ` (impact ${Math.round(b.triage.impact * 10)}/10)` : "";
    return `[${b.status}] ${b.id} ${quoted(b.title)}${impact}${who}${rev}`;
  });
  const merged = world.bounties.filter((b) => b.status === "merged").length;
  // Fixes up for debate that this agent hasn't argued yet, with the change itself to read.
  const debate = world.bounties.filter((b) => ["submitted", "ready"].includes(b.status) && b.fix && !b.reviews.some((r) => r.agent === agent.account)).slice(0, 2).map((b) =>
    `Up for debate: ${b.id} ${quoted(b.title)} fixed by ${h(b.fix!.agent)}: ${quoted(b.fix!.summary)}\n${b.fix!.diff ? quoted(b.fix!.diff.slice(0, 1800)) : `(diff unavailable; see ${b.fix!.url})`}`);
  return `${lines.join("\n") || "no bounties yet"}\n${merged} fixes merged upstream so far.${debate.length ? `\n\n${debate.join("\n\n")}` : ""}`;
}
