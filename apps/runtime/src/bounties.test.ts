import { PRESETS } from "@agents/core";
import { beforeEach, describe, expect, it } from "vitest";
import { applyAction } from "./actions.js";
import { APPROVALS_NEEDED, CLAIM_TTL_MS, STANDING, approveFix, ballotText, boardText, findCandidates, guessImpact, intakeIssues, refusesAI, setRepos, triage, triageJudge, upkeep, useGitHub, vetSome, type Bounty, type GitHub, type Repo } from "./bounties.js";
import { SimChain } from "./chain.js";
import { World, standingOf, type Agent } from "./world.js";

const mk = (handle: string, external = true): Agent => ({ account: `0x${handle}`, owner: "0xo", handle, name: handle, persona: "", modelId: "m", plan: PRESETS.momentum, awake: true, external, createdAt: 0 });

/** A fake GitHub: canned responses by path, and the pages that exist. */
function fakeGitHub(routes: Record<string, unknown>, pages: string[] = []): GitHub {
  return {
    async get<T>(path: string) {
      // The longest matching prefix wins, so /repos/x/pulls isn't answered by /repos/x.
      const key = Object.keys(routes).filter((k) => path.startsWith(k)).sort((a, b) => b.length - a.length)[0];
      if (!key) throw new Error(`GitHub 404 on ${path}`);
      return routes[key] as T;
    },
    async exists(url: string) { return pages.includes(url); },
  };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

function bounty(over: Partial<Bounty> = {}): Bounty {
  return { id: "acme/lib#7", repo: "acme/lib", number: 7, title: "Parser drops trailing commas", body: "x".repeat(200), url: "https://github.com/acme/lib/issues/7", labels: ["good first issue"], openedAt: "", addedAt: 0, status: "open", reviews: [], triage: { fit: true, confidence: 0.8, judge: "Jev", at: 0 }, ...over };
}

const FIX = "https://github.com/fixer/lib/tree/fix-7";

describe("bounties", () => {
  let world: World, chain: SimChain, fixer: Agent, r1: Agent, r2: Agent;
  beforeEach(() => {
    world = new World();
    chain = new SimChain();
    fixer = mk("fixer"); r1 = mk("rev1"); r2 = mk("rev2");
    for (const a of [fixer, r1, r2]) world.agents.set(a.account, a);
    world.bounties.push(bounty());
    useGitHub(fakeGitHub({ "/repos/fixer/lib": { fork: true, parent: { full_name: "acme/lib" } }, "/repos/acme/lib/pulls/99": { state: "closed", merged_at: "2026-10-16T00:00:00Z" } }, [FIX]));
  });

  const act = (a: Agent, action: Parameters<typeof applyAction>[4]) => applyAction(world, chain, chain, a, action);

  it("runs a fix from claim to merge, and standing lands only on the merge", async () => {
    expect((await act(fixer, { type: "claim_bounty", id: "acme/lib#7" })).ok).toBe(true);
    expect((await act(fixer, { type: "submit_fix", id: "acme/lib#7", url: FIX, summary: "Keeps trailing commas; added a test for it" })).ok).toBe(true);
    expect((await act(fixer, { type: "review_fix", id: "acme/lib#7", verdict: "approve", note: "looks right to me, honest" })).detail).toMatch(/own fix/);
    await act(r1, { type: "review_fix", id: "acme/lib#7", verdict: "approve", note: "read the diff, tests cover the case" });
    await act(r2, { type: "review_fix", id: "acme/lib#7", verdict: "approve", note: "ran the suite locally, all green" });
    const b = world.bounties[0]!;
    expect(b.status).toBe("ready");
    expect(b.reviews.filter((r) => r.verdict === "approve")).toHaveLength(APPROVALS_NEEDED);
    // Nothing goes upstream before a person signs it off.
    expect((await act(fixer, { type: "open_pr", id: b.id, url: "https://github.com/acme/lib/pull/99" })).ok).toBe(false);
    expect(approveFix(world, b.id, "angus").ok).toBe(true);
    expect((await act(r1, { type: "open_pr", id: b.id, url: "https://github.com/acme/lib/pull/99" })).ok).toBe(false);
    expect((await act(fixer, { type: "open_pr", id: b.id, url: "https://github.com/other/lib/pull/99" })).ok).toBe(false);
    expect((await act(fixer, { type: "open_pr", id: b.id, url: "https://github.com/acme/lib/pull/99" })).ok).toBe(true);
    expect(standingOf(world).get(fixer.account)?.parts["fixes approved"]).toBe(STANDING.approved);
    const merged = await upkeep(world);
    expect(merged.map((x) => x.id)).toEqual(["acme/lib#7"]);
    const s = standingOf(world);
    expect(s.get(fixer.account)?.parts["fixes merged"]).toBe(STANDING.merged);
    expect(s.get(r1.account)?.parts["reviews that held up"]).toBe(STANDING.reviewMerged);
  });

  it("only takes fixes on a real fork of the upstream repo", async () => {
    await act(fixer, { type: "claim_bounty", id: "acme/lib#7" });
    const sub = (url: string) => act(fixer, { type: "submit_fix", id: "acme/lib#7", url, summary: "Keeps trailing commas; added a test for it" });
    expect((await sub("https://github.com/acme/lib/tree/fix-7")).detail).toMatch(/not the upstream/);
    expect((await sub("https://github.com/acme/lib/pull/3")).detail).toMatch(/branch, commit or compare/);
    expect((await sub("https://github.com/stranger/lib/tree/x")).detail).toMatch(/isn't a fork/);
    expect((await sub("https://github.com/fixer/lib/tree/missing")).detail).toMatch(/doesn't exist/);
    expect((await sub(FIX)).ok).toBe(true);
  });

  it("keeps bounty work to agents with their own compute, one claim at a time", async () => {
    const managed = mk("managed", false);
    world.agents.set(managed.account, managed);
    expect((await act(managed, { type: "claim_bounty", id: "acme/lib#7" })).detail).toMatch(/own compute/);
    world.bounties.push(bounty({ id: "acme/lib#8", number: 8 }));
    await act(fixer, { type: "claim_bounty", id: "acme/lib#7" });
    expect((await act(fixer, { type: "claim_bounty", id: "acme/lib#8" })).detail).toMatch(/already working/);
    world.bounties.push(bounty({ id: "acme/lib#9", number: 9, triage: { fit: false, confidence: 0.9, judge: "Jev", at: 0 } }));
    expect((await act(r1, { type: "claim_bounty", id: "acme/lib#9" })).detail).toMatch(/isn't a fit/);
  });

  it("sends a fix back to its fixer when a reviewer asks for changes, and lapses stale claims", async () => {
    await act(fixer, { type: "claim_bounty", id: "acme/lib#7" });
    await act(fixer, { type: "submit_fix", id: "acme/lib#7", url: FIX, summary: "Keeps trailing commas; added a test for it" });
    await act(r1, { type: "review_fix", id: "acme/lib#7", verdict: "changes", note: "the test doesn't cover nested arrays" });
    const b = world.bounties[0]!;
    expect(b.status).toBe("claimed");
    await upkeep(world, b.claimedAt! + CLAIM_TTL_MS + 1);
    expect(b.status).toBe("open");
    expect(b.claimedBy).toBeUndefined();
  });

  it("lets the agents vote on which libraries the town works on", async () => {
    const now = Date.parse("2026-10-17T00:00:00Z");
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const search = (full: string) => ({ full_name: full, description: "", language: "TypeScript", stargazers_count: 5000, pushed_at: ago(1), html_url: `https://github.com/${full}`, archived: false, fork: false });
    const merged = (full: string, n: number) => ({ [`/repos/${full}/pulls`]: Array.from({ length: n }, (_, i) => ({ merged_at: ago(5 + i), author_association: "CONTRIBUTOR", user: { login: `outsider${i}` } })) });
    useGitHub(fakeGitHub({
      "/search/repositories": { items: [search("good/lib"), search("solo/lib"), search("strict/lib")] },
      ...merged("good/lib", 4), ...merged("solo/lib", 0), ...merged("strict/lib", 6), ...merged("named/lib", 2),
      "/repos/good/lib/contributors": [{ login: "maintainer" }],
      "/repos/strict/lib/contents/CONTRIBUTING.md": { content: b64("Please note: we do not accept AI-generated pull requests."), encoding: "base64" },
      "/repos/named/lib": search("named/lib"),
      "/search/issues": { items: [{ number: 3, title: "Crash when the config file is empty", body: "b", html_url: "https://github.com/good/lib/issues/3", labels: [{ name: "bug" }, { name: "good first issue" }], created_at: "", repository_url: "https://api.github.com/repos/good/lib" }] },
    }));
    expect(await refusesAI("strict/lib")).toBe(true);
    await findCandidates(world, now);
    expect(world.candidates.map((r) => r.full)).toEqual(["good/lib", "solo/lib", "strict/lib"]);
    expect(await vetSome(world, 10, now)).toBe(3);
    expect(world.vetting.get("good/lib")).toMatchObject({ outsideMerged: 4, refusesAI: false });
    expect(world.vetting.get("strict/lib")?.refusesAI).toBe(true);
    // The ballot shows agents what they're choosing between, and leaves off libraries that refuse AI work.
    const ballot = ballotText(world, r1);
    expect(ballot).toMatch(/good\/lib \(TypeScript, 5,000 stars, 4 outside contributors merged in 90 days\): 0 votes/);
    expect(ballot).not.toMatch(/strict\/lib/);

    // Every agent votes, compute or not; the most-voted libraries make the board.
    const managed = mk("managed", false);
    world.agents.set(managed.account, managed);
    expect((await act(managed, { type: "vote_library", repo: "good/lib" })).ok).toBe(true);
    expect((await act(r1, { type: "vote_library", repo: "good/lib" })).ok).toBe(true);
    expect((await act(r2, { type: "vote_library", repo: "solo/lib" })).ok).toBe(true);
    expect((await act(r2, { type: "vote_library", repo: "strict/lib" })).detail).toMatch(/turns away AI-written work/);
    expect(world.repos.map((r) => [r.full, r.votes])).toEqual([["good/lib", 2], ["solo/lib", 1]]);
    // An agent can name a library that isn't on the ballot yet.
    expect((await act(fixer, { type: "vote_library", repo: "https://github.com/named/lib" })).detail).toMatch(/voted for named\/lib/);
    expect(world.repos.map((r) => r.full)).toContain("named/lib");
    // Three votes each: a fourth moves the oldest.
    await act(r1, { type: "vote_library", repo: "solo/lib" });
    await act(r1, { type: "vote_library", repo: "named/lib" });
    expect((await act(r1, { type: "vote_library", repo: "good/lib" })).ok).toBe(true);
    expect((await act(r1, { type: "vote_library", repo: "strict/lib" })).ok).toBe(false);
    expect(world.libraryVotes.get(r1.account)).toEqual(["solo/lib", "named/lib", "good/lib"]);
    await act(r1, { type: "vote_library", repo: "named/lib" });
    expect(world.libraryVotes.get(r1.account)).toEqual(["solo/lib", "good/lib", "named/lib"]);

    // Issues come in from the libraries on the board, and triage scores how much each one matters.
    expect((await intakeIssues(world)).map((b) => b.id)).toEqual(["good/lib#3"]);
    await triage(world, triageJudge(null));
    expect(world.bounties.find((b) => b.id === "good/lib#3")?.triage?.impact).toBeGreaterThanOrEqual(0.7);
    expect(guessImpact({ labels: ["documentation"], title: "Fix typo in README", body: "" })).toBeLessThan(0.3);
  });

  it("drops a library's unclaimed issues when it leaves the board, but not one an agent is working on", async () => {
    const lib = (full: string): Repo => ({ full, description: "", language: "Go", stars: 1, pushedAt: "", url: `https://github.com/${full}`, addedAt: 0 });
    world.repos = [lib("acme/lib"), lib("old/lib"), lib("busy/lib")];
    world.bounties.push(bounty({ id: "old/lib#1", repo: "old/lib" }), bounty({ id: "busy/lib#2", repo: "busy/lib", status: "claimed", claimedBy: fixer.account }), bounty({ id: "busy/lib#3", repo: "busy/lib" }));
    setRepos(world, [lib("acme/lib"), lib("new/lib")]);
    expect(world.repos.map((r) => r.full).sort()).toEqual(["acme/lib", "busy/lib", "new/lib"]);
    expect(world.bounties.map((b) => b.id).sort()).toEqual(["acme/lib#7", "busy/lib#2", "busy/lib#3"]);
  });

  it("shows agents the live board", async () => {
    await act(fixer, { type: "claim_bounty", id: "acme/lib#7" });
    expect(boardText(world, fixer)).toMatch(/\[claimed\] acme\/lib#7 .*@fixer \[yours\]/);
  });
});
