import { PRESETS } from "@agents/core";
import { beforeEach, describe, expect, it } from "vitest";
import { applyAction } from "./actions.js";
import { APPROVALS_NEEDED, CLAIM_TTL_MS, STANDING, approveFix, boardText, chooseRepos, findCandidates, guessImpact, intakeIssues, nominate, refusesAI, setRepos, triage, triageJudge, unnominate, upkeep, useGitHub, vetSome, type Bounty, type GitHub, type Repo } from "./bounties.js";
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

  it("only puts real, living communities on the board, and lets a person nominate one", async () => {
    const now = Date.parse("2026-10-17T00:00:00Z");
    const ago = (days: number, hours = 0) => new Date(now - days * 86_400_000 + hours * 3_600_000).toISOString();
    const search = (full: string) => ({ full_name: full, description: "", language: "TypeScript", stargazers_count: 5000, pushed_at: ago(1), html_url: `https://github.com/${full}`, archived: false, fork: false });
    /** A library with a real community: old, watched, merging outsiders' work, answering outsiders' issues. */
    const community = (full: string) => ({
      [`/repos/${full}/contributors`]: [{ login: "maintainer" }],
      [`/repos/${full}/pulls`]: ["ann", "bo", "cy", "dee"].map((u, i) => ({ merged_at: ago(5 + i), author_association: "CONTRIBUTOR", user: { login: u } })),
      [`/search/issues?q=${encodeURIComponent(`repo:${full} is:issue`)}`]: { items: Array.from({ length: 12 }, (_, i) => ({ number: i + 1, created_at: ago(5 + i), author_association: i % 4 === 3 ? "MEMBER" : "NONE", user: { login: `u${i}` } })) },
      [`/repos/${full}/issues/`]: [{ created_at: ago(5, 5), author_association: "MEMBER", user: { type: "User" } }],
      [`/repos/${full}`]: { ...search(full), created_at: ago(1200), subscribers_count: 40, forks_count: 300, owner: { login: full.split("/")[0] } },
    });
    useGitHub(fakeGitHub({
      "/search/repositories": { items: [search("good/lib"), search("solo/lib"), search("strict/lib")] },
      ...community("good/lib"),
      ...community("strict/lib"),
      "/repos/strict/lib/contents/CONTRIBUTING.md": { content: b64("Please note: we do not accept AI-generated pull requests."), encoding: "base64" },
      "/repos/good/lib/contents/CONTRIBUTING.md": { content: b64("Run the tests before opening a PR. AI tools are fine if you review the output."), encoding: "base64" },
      // One person's project: new, unwatched, filing its own "good first issues".
      "/repos/solo/lib/contributors": [{ login: "solo" }],
      "/repos/solo/lib/pulls": [],
      [`/search/issues?q=${encodeURIComponent("repo:solo/lib is:issue")}`]: { items: Array.from({ length: 12 }, (_, i) => ({ number: i + 1, created_at: ago(5 + i), author_association: "OWNER", user: { login: "solo" } })) },
      "/repos/solo/lib": { ...search("solo/lib"), created_at: ago(90), subscribers_count: 2, forks_count: 1, owner: { login: "solo" } },
      "/repos/nom/lib": { ...search("nom/lib"), created_at: ago(40), subscribers_count: 1, forks_count: 0, owner: { login: "nom" } },
      [`/search/issues?q=${encodeURIComponent("repo:good/lib is:issue is:open")}`]: { items: [{ number: 3, title: "Crash when the config file is empty", body: "b", html_url: "https://github.com/good/lib/issues/3", labels: [{ name: "bug" }, { name: "good first issue" }], created_at: "", repository_url: "https://api.github.com/repos/good/lib" }] },
    }));
    expect(await refusesAI("strict/lib")).toBe(true);
    await findCandidates(world, now);
    expect(world.candidates.map((r) => r.full)).toEqual(["good/lib", "solo/lib", "strict/lib"]);
    expect(await vetSome(world, 10, now)).toBe(3);
    const good = world.vetting.get("good/lib")!;
    expect(good.ok).toBe(true);
    expect(good.signals).toMatchObject({ outsideMerged: 4, outsideIssues: 9, answered: 1 });
    expect(good.signals!.replyHours).toBeLessThan(7 * 24);
    expect(world.vetting.get("solo/lib")!.why.join("; ")).toMatch(/under a year old.*watchers.*0 outside contributors.*maintainers/);
    expect(world.vetting.get("strict/lib")!.why).toEqual(["its contributing guide turns away AI-written work"]);
    setRepos(world, chooseRepos(world, now));
    expect(world.repos.map((r) => r.full)).toEqual(["good/lib"]);
    expect(world.repos[0]!.signals?.outsideMerged).toBe(4);

    // A person can put a library on the board directly, but not one that refuses AI-written work.
    expect((await nominate(world, "https://github.com/nom/lib", now)).ok).toBe(true);
    expect((await nominate(world, "strict/lib", now)).detail).toMatch(/turns away AI-written work/);
    expect(world.repos.map((r) => [r.full, !!r.nominated])).toEqual([["nom/lib", true], ["good/lib", false]]);
    expect(unnominate(world, "nom/lib", now).ok).toBe(true);
    expect(world.repos.map((r) => r.full)).toEqual(["good/lib"]);

    // Issues come in, and triage scores how much each one matters.
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
