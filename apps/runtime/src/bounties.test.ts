import { PRESETS } from "@agents/core";
import { beforeEach, describe, expect, it } from "vitest";
import { applyAction } from "./actions.js";
import { APPROVALS_NEEDED, CLAIM_TTL_MS, STANDING, approveFix, boardText, intakeIssues, pickRepos, refusesAI, triage, triageJudge, upkeep, useGitHub, type Bounty, type GitHub } from "./bounties.js";
import { SimChain } from "./chain.js";
import { World, standingOf, type Agent } from "./world.js";

const mk = (handle: string, external = true): Agent => ({ account: `0x${handle}`, owner: "0xo", handle, name: handle, persona: "", modelId: "m", plan: PRESETS.momentum, awake: true, external, createdAt: 0 });

/** A fake GitHub: canned responses by path, and the pages that exist. */
function fakeGitHub(routes: Record<string, unknown>, pages: string[] = []): GitHub {
  return {
    async get<T>(path: string) {
      const key = Object.keys(routes).find((k) => path.startsWith(k));
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

  it("picks libraries that ask for help and passes over ones that refuse AI work", async () => {
    const repo = (full: string) => ({ full_name: full, description: "", language: "TypeScript", stargazers_count: 900, pushed_at: "", html_url: `https://github.com/${full}`, archived: false, fork: false });
    useGitHub(fakeGitHub({
      "/search/repositories": { items: [repo("good/lib"), repo("strict/lib")] },
      "/repos/strict/lib/contents/CONTRIBUTING.md": { content: b64("Please note: we do not accept AI-generated pull requests."), encoding: "base64" },
      "/repos/good/lib/contents/CONTRIBUTING.md": { content: b64("Run the tests before opening a PR. AI tools are fine if you review the output."), encoding: "base64" },
      "/search/issues": { items: [{ number: 3, title: "Typo in error", body: "b", html_url: "https://github.com/good/lib/issues/3", labels: [{ name: "good first issue" }], created_at: "", repository_url: "https://api.github.com/repos/good/lib" }] },
    }));
    expect(await refusesAI("strict/lib")).toBe(true);
    expect(await refusesAI("good/lib")).toBe(false);
    world.repos = await pickRepos(world, Date.now(), "");
    expect(world.repos.map((r) => r.full)).toEqual(["good/lib"]);
    const fresh = await intakeIssues(world);
    expect(fresh.map((b) => b.id)).toEqual(["good/lib#3"]);
    expect(await intakeIssues(world)).toEqual([]);
    await triage(world, triageJudge(null));
    expect(world.bounties.find((b) => b.id === "good/lib#3")?.triage?.fit).toBe(false);
  });

  it("shows agents the live board", async () => {
    await act(fixer, { type: "claim_bounty", id: "acme/lib#7" });
    expect(boardText(world, fixer)).toMatch(/\[claimed\] acme\/lib#7 .*@fixer \[yours\]/);
  });
});
