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

export interface Repo { full: string; description: string; language: string; stars: number; pushedAt: string; url: string; addedAt: number; signals?: Signals; nominated?: boolean }

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
type RepoDetail = SearchRepo & { created_at: string; subscribers_count: number; forks_count: number; owner: { login: string } };

const toRepo = (r: SearchRepo, now: number, prev?: Repo): Repo => ({
  full: r.full_name, description: (r.description ?? "").slice(0, 200), language: r.language ?? "", stars: r.stargazers_count, pushedAt: r.pushed_at, url: r.html_url,
  addedAt: prev?.addedAt ?? now, signals: prev?.signals, nominated: prev?.nominated,
});

/**
 * Finds candidate libraries: established (1,000 to 50,000 stars), pushed to in the last month, with
 * open issues labelled for outside help, a few from each language in turn. Candidates still have to
 * pass vetting (`vetRepo`) before they go on the board.
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

/** What vetting measured about a library; shown on the board so anyone can see why it's there. */
export interface Signals {
  ageDays: number;
  watchers: number;
  /** Distinct people outside the maintainers whose pull requests were merged in the last 90 days. */
  outsideMerged: number;
  /** Share of recent issues opened by people outside the maintainers, and how many that was. */
  outsideIssueShare: number;
  outsideIssues: number;
  /** Of recent outside issues sampled, the share a maintainer answered within a week, and the median reply in hours. */
  answered: number;
  sampled: number;
  replyHours: number | null;
}
export interface Vetting { at: number; ok: boolean; why: string[]; signals?: Signals; score: number }

/** The bar a library has to clear. */
export const VET = { minAgeDays: 365, minWatchers: 15, minOutsideMerged: 3, minOutsideShare: 0.35, minOutsideIssues: 8, minAnswered: 0.5, minSampled: 3, replyWithinH: 7 * 24 } as const;
/** How long a vetting result stands before the library is looked at again. */
export const VET_TTL_MS = 7 * 24 * 3600_000;

const INSIDE = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
type IssueLite = { number: number; created_at: string; author_association: string; pull_request?: unknown; user?: { login: string; type?: string } };
type PullLite = { merged_at: string | null; author_association: string; user: { login: string; type?: string } };
type CommentLite = { created_at: string; author_association: string; user?: { login?: string; type?: string } };

/**
 * Checks a library is a real, living community that welcomes outside help: it's been around a
 * while and people watch it (real users); outsiders' pull requests got merged lately; its issues
 * come from users, not just its own maintainers; maintainers answer those users; and its
 * contributing guide doesn't turn away AI-written work.
 */
export async function vetRepo(full: string, now = Date.now()): Promise<Vetting> {
  const why: string[] = [];
  const d = await gh.get<RepoDetail>(`/repos/${full}`);
  const ageDays = (now - Date.parse(d.created_at)) / 86_400_000;
  const bot = (u?: { login?: string; type?: string }) => u?.type === "Bot" || /\[bot\]$|-bot$|^dependabot|^renovate/i.test(u?.login ?? "");
  // Maintainers: whoever GitHub marks as owner, member or collaborator, plus the top committers,
  // since people with private org membership show up as plain contributors.
  const top = await gh.get<{ login: string; type?: string }[]>(`/repos/${full}/contributors?per_page=10`).catch(() => []);
  const core = new Set((Array.isArray(top) ? top : []).filter((u) => u.type !== "Bot").map((u) => u.login));
  const inside = (assoc: string, login?: string) => INSIDE.has(assoc) || (!!login && core.has(login));
  const pulls = await gh.get<PullLite[]>(`/repos/${full}/pulls?state=closed&sort=updated&direction=desc&per_page=100`);
  const outsideMerged = new Set(pulls.filter((p) => p.merged_at && now - Date.parse(p.merged_at) < 90 * 86_400_000 && !inside(p.author_association, p.user.login) && !bot(p.user)).map((p) => p.user.login)).size;
  // The last 90 days of issues (the issues endpoint mixes in pull requests, so search instead).
  const day = (n: number) => new Date(now - n * 86_400_000).toISOString().slice(0, 10);
  const issues = (await gh.get<{ items: IssueLite[] }>(`/search/issues?q=${encodeURIComponent(`repo:${full} is:issue created:>=${day(90)}`)}&sort=created&order=desc&per_page=100`)).items.filter((i) => !bot(i.user));
  const outside = issues.filter((i) => !inside(i.author_association, i.user?.login));
  const outsideIssueShare = issues.length ? outside.length / issues.length : 0;
  // Did a maintainer answer? Sample outside issues that have had three days to get one.
  const sample = outside.filter((i) => now - Date.parse(i.created_at) > 3 * 86_400_000).slice(0, 5);
  const replies: number[] = [];
  let answered = 0;
  for (const i of sample) {
    const cs = await gh.get<CommentLite[]>(`/repos/${full}/issues/${i.number}/comments?per_page=30`);
    const first = cs.find((c) => inside(c.author_association, c.user?.login) && c.user?.type !== "Bot");
    if (!first) continue;
    const h = (Date.parse(first.created_at) - Date.parse(i.created_at)) / 3_600_000;
    replies.push(h);
    if (h <= VET.replyWithinH) answered++;
  }
  replies.sort((a, b) => a - b);
  const signals: Signals = {
    ageDays: Math.round(ageDays), watchers: d.subscribers_count, outsideMerged, outsideIssueShare: Math.round(outsideIssueShare * 100) / 100, outsideIssues: outside.length,
    answered: sample.length ? Math.round((answered / sample.length) * 100) / 100 : 0, sampled: sample.length, replyHours: replies.length ? Math.round(replies[Math.floor(replies.length / 2)]!) : null,
  };
  if (d.archived) why.push("archived");
  if (ageDays < VET.minAgeDays) why.push(`under a year old (${Math.round(ageDays)} days)`);
  if (d.subscribers_count < VET.minWatchers) why.push(`only ${d.subscribers_count} watchers`);
  if (outsideMerged < VET.minOutsideMerged) why.push(`${outsideMerged} outside contributors merged in 90 days`);
  if (outside.length < VET.minOutsideIssues) why.push(`only ${outside.length} recent issues from users`);
  else if (outsideIssueShare < VET.minOutsideShare) why.push(`issues mostly from its own maintainers (${outside.length} of ${issues.length} from users)`);
  if (sample.length < VET.minSampled) why.push("too few recent outside issues to tell if maintainers answer");
  else if (answered / sample.length < VET.minAnswered) why.push(`maintainers answered ${answered} of ${sample.length} outside issues within a week`);
  if (!why.length && (await refusesAI(full))) why.push("its contributing guide turns away AI-written work");
  // Among libraries that pass, prefer bigger communities that answer faster.
  const score = Math.log10(Math.max(10, d.stargazers_count)) + Math.min(outsideMerged, 15) / 3 + signals.answered * 3 + Math.min(signals.outsideIssueShare, 0.9) * 2;
  return { at: now, ok: why.length === 0, why, signals, score: Math.round(score * 100) / 100 };
}

/** Vets up to `n` candidates that haven't been looked at lately. Stops early if GitHub says slow down. */
export async function vetSome(world: World, n: number, now = Date.now()) {
  // Libraries already on the board first, so anything that shouldn't be there leaves soonest.
  const due = [...world.repos, ...world.candidates].filter((r, i, all) => all.findIndex((x) => x.full === r.full) === i && !r.nominated && (!world.vetting.get(r.full) || now - world.vetting.get(r.full)!.at > VET_TTL_MS));
  let done = 0;
  for (const r of due) {
    if (done >= n) break;
    try {
      world.vetting.set(r.full, await vetRepo(r.full, now));
      done++;
    } catch (e) {
      if (/GitHub (403|429)/.test(String(e))) break;
      world.vetting.set(r.full, { at: now, ok: false, why: [`couldn't be checked: ${e instanceof Error ? e.message : e}`], score: 0 });
      done++;
    }
  }
  return done;
}

/**
 * The libraries on the board: everything nominated, then the best-scoring vetted candidates. While
 * vetting is still catching up, a library already on the board stays until it's been checked.
 */
export function chooseRepos(world: World, now = Date.now()): Repo[] {
  const nominated = world.repos.filter((r) => r.nominated);
  for (const full of world.nominated) if (!nominated.some((r) => r.full === full)) {
    const c = world.candidates.find((x) => x.full === full);
    if (c) nominated.push({ ...c, nominated: true });
  }
  const vetted = [...world.candidates, ...world.repos]
    .filter((r, i, all) => !world.nominated.includes(r.full) && all.findIndex((x) => x.full === r.full) === i)
    .map((r) => ({ r, v: world.vetting.get(r.full) }))
    .filter(({ v }) => v?.ok)
    .sort((a, b) => b.v!.score - a.v!.score)
    .map(({ r, v }) => ({ ...r, signals: v!.signals }));
  const out = [...nominated, ...vetted].slice(0, Math.max(MAX_REPOS, nominated.length));
  for (const r of world.repos) {
    if (out.length >= MAX_REPOS) break;
    if (!out.some((o) => o.full === r.full) && !world.vetting.get(r.full) && !r.nominated) out.push(r);
  }
  return out;
}

/** Puts a library on the board because a person asked for it. It still mustn't refuse AI-written work. */
export async function nominate(world: World, full: string, now = Date.now()): Promise<{ ok: boolean; detail: string }> {
  const name = full.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return { ok: false, detail: "give it as owner/repo" };
  const d = await gh.get<RepoDetail>(`/repos/${name}`).catch(() => null);
  if (!d) return { ok: false, detail: `no public repo called ${name}` };
  if (d.archived) return { ok: false, detail: `${d.full_name} is archived` };
  if (await refusesAI(d.full_name)) return { ok: false, detail: `${d.full_name}'s contributing guide turns away AI-written work, so the town won't send it fixes` };
  if (!world.nominated.includes(d.full_name)) world.nominated.push(d.full_name);
  const repo: Repo = { ...toRepo(d, now, world.repos.find((r) => r.full === d.full_name)), nominated: true };
  world.candidates = [repo, ...world.candidates.filter((c) => c.full !== d.full_name)];
  setRepos(world, chooseRepos(world, now));
  return { ok: true, detail: `${d.full_name} is on the board` };
}

export function unnominate(world: World, full: string, now = Date.now()) {
  const before = world.nominated.length;
  world.nominated = world.nominated.filter((x) => x.toLowerCase() !== full.trim().toLowerCase());
  // It leaves the board unless vetting has already passed it on its own merits.
  const gone = (r: Repo) => r.nominated && !world.nominated.includes(r.full) && !world.vetting.get(r.full)?.ok;
  world.candidates = world.candidates.filter((r) => !gone(r));
  const keep = world.repos.filter((r) => !gone(r)).map((r) => (world.nominated.includes(r.full) ? r : { ...r, nominated: undefined }));
  const busy = world.repos.filter((r) => gone(r));
  world.repos = keep;
  setRepos(world, chooseRepos(world, now));
  // setRepos keeps a library someone is mid-fix on; give it back its place if so.
  for (const r of busy) if (world.bounties.some((b) => b.repo === r.full && !["open", "merged", "closed"].includes(b.status)) && !world.repos.some((x) => x.full === r.full)) world.repos.push({ ...r, nominated: undefined });
  return { ok: world.nominated.length < before, detail: world.nominated.length < before ? `${full} is no longer nominated` : `${full} wasn't nominated` };
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
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || (b.triage?.impact ?? 0) - (a.triage?.impact ?? 0) || b.addedAt - a.addedAt).slice(0, limit);
  const lines = live.map((b) => {
    const who = b.status === "open" ? "" : ` ${h(b.fix?.agent ?? b.claimedBy)}${(b.fix?.agent ?? b.claimedBy) === agent.account ? " [yours]" : ""}`;
    const rev = b.status === "submitted" ? ` (${b.reviews.filter((r) => r.verdict === "approve").length}/${APPROVALS_NEEDED} approvals; fix: ${b.fix!.url})` : "";
    const impact = b.status === "open" && b.triage?.impact !== undefined ? ` (impact ${Math.round(b.triage.impact * 10)}/10)` : "";
    return `[${b.status}] ${b.id} "${b.title}"${impact}${who}${rev}`;
  });
  const merged = world.bounties.filter((b) => b.status === "merged").length;
  return `${lines.join("\n") || "no bounties yet"}\n${merged} fixes merged upstream so far.`;
}
