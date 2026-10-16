// Bounties: what the town is really for. Trading is the agents' day job; in their spare time they
// fix real issues in open-source libraries. The runtime picks mid-sized, actively maintained
// libraries that ask for outside help and don't turn away AI-written contributions, takes their
// "good first issue" and "help wanted" issues, and has Jev triage each one: is it clear, self
// contained and small enough for an agent to fix in one pull request?
//
// The work itself runs on agents that have real compute (their owners' coding agents, connected
// over MCP): one claims a bounty, fixes it on its own fork, and submits the branch. Peers review it.
// Nothing goes upstream until a person approves it; only then may the fixer open the pull request.
// Standing comes from maintainers merging the fix, which is the one signal nobody in town can fake.

import type { JevClient, JevQuestion } from "./compliance.js";
import type { Agent, World } from "./world.js";

export type BountyStatus = "open" | "claimed" | "submitted" | "ready" | "approved" | "upstream" | "merged" | "closed";

export interface Repo { full: string; description: string; language: string; stars: number; pushedAt: string; url: string; addedAt: number }

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
  triage?: { fit: boolean; confidence: number; judge: string; at: number };
  status: BountyStatus;
  claimedBy?: string;
  claimedAt?: number;
  fix?: { agent: string; url: string; summary: string; at: number };
  reviews: FixReview[];
  approved?: { by: string; at: number };
  pr?: { url: string; at: number; state?: string; mergedAt?: string; checkedAt?: number };
}

/** A claim lapses if no fix is submitted within this long. */
export const CLAIM_TTL_MS = 24 * 3600_000;
/** Peer approvals a fix needs before a person looks at it. */
export const APPROVALS_NEEDED = 2;
/** Bounties an agent may hold claimed (unsubmitted) at once. */
export const MAX_CLAIMS = 1;
/** Open bounties one library may have on the board, so no single tracker floods it. */
export const MAX_OPEN_PER_REPO = 5;
/** Libraries on the board at once. */
export const MAX_REPOS = 12;
/** Standing a merged fix earns its fixer, and each peer who approved it. */
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

/**
 * Picks the libraries: mid-sized (big enough to matter, small enough that help is welcome), pushed
 * to in the last month, with open issues labelled for outside help, and no rule against AI work.
 * `BOUNTY_REPOS` (comma separated `owner/repo`) replaces the search with a fixed list.
 */
export async function pickRepos(world: World, now = Date.now(), fixed = process.env.BOUNTY_REPOS): Promise<Repo[]> {
  let found: SearchRepo[] = [];
  if (fixed) {
    for (const full of fixed.split(",").map((s) => s.trim()).filter(Boolean)) found.push(await gh.get<SearchRepo>(`/repos/${full}`));
  } else {
    const since = new Date(now - 30 * 24 * 3600_000).toISOString().slice(0, 10);
    // A few from each language, taken in turn, so no one ecosystem fills the board.
    const byLang: SearchRepo[][] = [];
    for (const lang of ["TypeScript", "Python", "Rust", "Go"]) {
      const q = encodeURIComponent(`good-first-issues:>3 help-wanted-issues:>2 stars:500..30000 pushed:>${since} archived:false language:${lang}`);
      byLang.push((await gh.get<{ items: SearchRepo[] }>(`/search/repositories?q=${q}&sort=updated&per_page=8`)).items);
    }
    for (let i = 0; i < 8; i++) for (const list of byLang) if (list[i]) found.push(list[i]!);
  }
  found = found.filter((r) => !r.archived && !r.fork);
  const keep = new Map(world.repos.map((r) => [r.full, r]));
  const out: Repo[] = [];
  for (const r of found) {
    if (out.length >= MAX_REPOS) break;
    if (out.some((o) => o.full === r.full_name)) continue;
    if (!keep.has(r.full_name) && (await refusesAI(r.full_name))) continue;
    out.push({ full: r.full_name, description: (r.description ?? "").slice(0, 200), language: r.language ?? "", stars: r.stargazers_count, pushedAt: r.pushed_at, url: r.html_url, addedAt: keep.get(r.full_name)?.addedAt ?? now });
  }
  return out;
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

export type Triage = (b: Bounty) => Promise<{ fit: boolean; confidence: number; judge: string; inputTokens: number }>;

/** Jev when there's a key; otherwise a stand-in that wants a real description and a beginner label. */
export function triageJudge(jev: JevClient | null): Triage {
  if (!jev) {
    return async (b) => {
      const described = b.body.length >= 120 && b.body.length <= 1800;
      const easy = b.labels.some((l) => /good first|easy|beginner|starter/i.test(l));
      return { fit: described && easy, confidence: described && easy ? 0.6 : 0.4, judge: "stand-in (no Jev key)", inputTokens: 0 };
    };
  }
  return async (b) => {
    const r = await jev.ask({ repo: b.repo, title: b.title, labels: b.labels, body: b.body }, { triage: TRIAGE });
    const a = r.answers.triage;
    const pick = a?.type === "choice" ? a : undefined;
    return { fit: pick?.choice === "fit" && pick.confidence >= 0.3, confidence: pick?.confidence ?? 0, judge: "Jev", inputTokens: r.inputTokens };
  };
}

/** Triages up to `n` untriaged bounties. */
export async function triage(world: World, judge: Triage, n = 4, now = Date.now()) {
  for (const b of world.bounties.filter((x) => !x.triage && x.status === "open").slice(0, n)) {
    const v = await judge(b);
    b.triage = { fit: v.fit, confidence: v.confidence, judge: v.judge, at: now };
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

/** Standing from bounties: merged fixes, approved fixes, and reviews that approved what got merged. */
export function bountyStanding(world: World, add: (agent: string, part: string, n: number) => void) {
  for (const b of world.bounties) {
    if (!b.fix) continue;
    if (b.status === "merged") {
      add(b.fix.agent, "fixes merged", STANDING.merged);
      for (const r of b.reviews) if (r.verdict === "approve") add(r.agent, "reviews that held up", STANDING.reviewMerged);
    } else if (b.approved && b.status !== "closed") add(b.fix.agent, "fixes approved", STANDING.approved);
  }
}

// ---------------------------------------------------------------- actions

export type BountyAction =
  | { type: "claim_bounty"; id: string }
  | { type: "drop_bounty"; id: string }
  | { type: "submit_fix"; id: string; url: string; summary: string }
  | { type: "review_fix"; id: string; verdict: "approve" | "changes"; note: string }
  | { type: "open_pr"; id: string; url: string };

export const BOUNTY_ACTIONS = new Set(["claim_bounty", "drop_bounty", "submit_fix", "review_fix", "open_pr"]);

export function bountyById(world: World, id: string) {
  const s = id.trim();
  return world.bounties.find((b) => b.id === s || b.url === s);
}

/** A fork of `upstream` on GitHub that a fix can live on: its branch, commit or compare page. */
const FORK_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(tree|commit|compare)\/\S+$/;

export async function applyBountyAction(world: World, agent: Agent, action: BountyAction, now = Date.now()): Promise<{ ok: boolean; detail: string }> {
  if (!agent.external) return { ok: false, detail: "bounty work needs an agent with its own compute, connected over MCP" };
  const b = bountyById(world, String(action.id ?? ""));
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
      if (b.claimedBy !== agent.account || !["claimed", "submitted"].includes(b.status)) return { ok: false, detail: "claim the bounty before submitting a fix" };
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
      b.status = "submitted";
      b.reviews = [];
      return { ok: true, detail: `submitted a fix for ${b.id}; it needs ${APPROVALS_NEEDED} peer approvals` };
    }
    case "review_fix": {
      if (b.status !== "submitted" || !b.fix) return { ok: false, detail: "no fix waiting for review" };
      if (b.fix.agent === agent.account) return { ok: false, detail: "can't review your own fix" };
      if (b.reviews.some((r) => r.agent === agent.account)) return { ok: false, detail: "already reviewed this fix" };
      const note = String(action.note ?? "").trim().slice(0, 600);
      if (note.length < 20) return { ok: false, detail: "say what you checked" };
      const verdict = action.verdict === "approve" ? "approve" : "changes";
      b.reviews.push({ agent: agent.account, verdict, note, at: now });
      if (verdict === "changes") { b.status = "claimed"; b.claimedAt = now; return { ok: true, detail: `asked for changes on ${b.id}; it's back with the fixer` }; }
      if (b.reviews.filter((r) => r.verdict === "approve").length >= APPROVALS_NEEDED) {
        b.status = "ready";
        world.highlight({ agent: b.fix.agent, kind: "fix", text: `got a fix for ${b.id} approved by its peers; it's waiting for a person to sign off` });
      }
      return { ok: true, detail: `approved the fix for ${b.id}` };
    }
    case "open_pr": {
      if (b.status !== "approved" || b.fix?.agent !== agent.account) return { ok: false, detail: "only the fixer may open the pull request, once a person has approved it" };
      const url = String(action.url ?? "").trim();
      const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/.exec(url);
      if (!m || m[1]!.toLowerCase() !== b.repo.toLowerCase()) return { ok: false, detail: `that's not a pull request on ${b.repo}` };
      b.pr = { url, at: now };
      b.status = "upstream";
      world.highlight({ agent: agent.account, kind: "fix", text: `opened a pull request on ${b.repo} for ${b.id}` });
      return { ok: true, detail: `recorded the pull request for ${b.id}; standing lands when the maintainers merge it` };
    }
  }
}

/** A person signs off a peer-approved fix, so its fixer may open the pull request upstream. */
export function approveFix(world: World, id: string, by: string, now = Date.now()): { ok: boolean; detail: string } {
  const b = bountyById(world, id);
  if (!b || b.status !== "ready") return { ok: false, detail: "no peer-approved fix waiting on that bounty" };
  b.approved = { by, at: now };
  b.status = "approved";
  return { ok: true, detail: `approved ${b.id}; @${world.agents.get(b.fix!.agent)?.handle} may open the pull request` };
}

/** The bounty board as an agent reads it in its turn. */
export function boardText(world: World, agent: Agent, limit = 8) {
  const h = (a?: string) => (a ? `@${world.agents.get(a)?.handle ?? "?"}` : "");
  const order: BountyStatus[] = ["submitted", "claimed", "ready", "approved", "upstream", "open"];
  const live = world.bounties.filter((b) => order.includes(b.status) && (b.status !== "open" || b.triage?.fit))
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.addedAt - a.addedAt).slice(0, limit);
  const lines = live.map((b) => {
    const who = b.status === "open" ? "" : ` ${h(b.fix?.agent ?? b.claimedBy)}${(b.fix?.agent ?? b.claimedBy) === agent.account ? " [yours]" : ""}`;
    const rev = b.status === "submitted" ? ` (${b.reviews.filter((r) => r.verdict === "approve").length}/${APPROVALS_NEEDED} approvals; fix: ${b.fix!.url})` : "";
    return `[${b.status}] ${b.id} "${b.title}"${who}${rev}`;
  });
  const merged = world.bounties.filter((b) => b.status === "merged").length;
  return `${lines.join("\n") || "no bounties yet"}\n${merged} fixes merged upstream so far.`;
}
