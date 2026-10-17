import { PRESETS } from "@agents/core";
import { describe, expect, it } from "vitest";
import { MAX_OPEN_CALLS, MAX_OPEN_IDEAS, applyAction, resolvePredictions } from "./actions.js";
import { SimChain } from "./chain.js";
import { ComplianceScreen, type JevAnswer, type JevClient } from "./compliance.js";
import { BUILD_MS, DANK_CROWN_MIN_DUELS, DANK_START, MEMORY, World, activePledge, bonds, memoryQuota, standingOf, type Agent } from "./world.js";
import { candidates, runDuels, type DankJudge } from "./dank.js";

const E = 10n ** 18n;
const mk = (handle: string, owner: string): Agent => ({ account: `0x${handle}`, owner, handle, name: handle, persona: "", modelId: "m", plan: PRESETS.momentum, awake: true, external: false, createdAt: 0 });

async function setup() {
  const world = new World();
  const chain = new SimChain();
  const a = mk("atlas", "0x1"), b = mk("vesper", "0x2");
  for (const x of [a, b]) { world.agents.set(x.account, x); world.balances.set(x.account, E); }
  const l = await applyAction(world, chain, chain, b, { type: "launch", name: "Vesper", symbol: "VESP", pitch: "" });
  return { world, chain, a, b, token: l.detail };
}

describe("price calls", () => {
  it("records a call at the current price and limits open calls", async () => {
    const { world, chain, a, token } = await setup();
    const r = await applyAction(world, chain, chain, a, { type: "predict", token, direction: "up", minutes: 5, reason: "owners outside the fleet are buying" });
    expect(r.ok).toBe(true);
    expect(world.predictions[0]).toMatchObject({ direction: "up", minutes: 5 });
    expect((await applyAction(world, chain, chain, a, { type: "predict", token, direction: "down", minutes: 5, reason: "x" })).detail).toMatch(/already has an open call/);
    expect((await applyAction(world, chain, chain, a, { type: "predict", token, direction: "up", minutes: 5, reason: "" })).detail).toBe("a call needs a reason");
  });

  it(`allows at most ${MAX_OPEN_CALLS} open calls`, async () => {
    const { world, chain, a } = await setup();
    const coins: string[] = [];
    for (const [h, sym] of [["c1", "CAAA"], ["c2", "CBBB"], ["c3", "CCCC"], ["c4", "CDDD"]] as const) {
      const x = mk(h, `0x${h}`);
      world.agents.set(x.account, x);
      coins.push((await applyAction(world, chain, chain, x, { type: "launch", name: h, symbol: sym, pitch: "" })).detail);
    }
    const results = [];
    for (const token of coins) results.push(await applyAction(world, chain, chain, a, { type: "predict", token, direction: "up", minutes: 5, reason: "r" }));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3]?.detail).toBe(`already has ${MAX_OPEN_CALLS} open calls`);
  });

  it("scores a call right, wrong or flat when its window closes", async () => {
    const { world, chain, a, b, token } = await setup();
    await applyAction(world, chain, chain, a, { type: "predict", token, direction: "up", minutes: 1, reason: "r" });
    const c = mk("quill", "0x3");
    world.agents.set(c.account, c);
    world.balances.set(c.account, E);
    await applyAction(world, chain, chain, b, { type: "predict", token, direction: "down", minutes: 1, reason: "r" });
    await applyAction(world, chain, chain, c, { type: "predict", token, direction: "up", minutes: 1, reason: "r" });
    // A buy from a third owner pushes the price up.
    const d = mk("moss", "0x4");
    world.agents.set(d.account, d);
    world.balances.set(d.account, E);
    expect((await applyAction(world, chain, chain, d, { type: "buy", token, ethIn: (E / 20n).toString(), reason: "r" })).ok).toBe(true);
    expect(resolvePredictions(world, chain, Date.now())).toHaveLength(0); // not due yet
    resolvePredictions(world, chain, Date.now() + 61_000);
    expect(world.predictions.map((p) => p.outcome)).toEqual(["right", "wrong", "right"]);
  });

  it("an unchanged price resolves flat", async () => {
    const { world, chain, a, token } = await setup();
    await applyAction(world, chain, chain, a, { type: "predict", token, direction: "down", minutes: 1, reason: "r" });
    resolvePredictions(world, chain, Date.now() + 61_000);
    expect(world.predictions[0]?.outcome).toBe("flat");
  });
});

describe("debates", () => {
  const judge = (choice: string, confidence = 0.8): JevClient => ({
    async ask(_s, questions) {
      const answers: Record<string, JevAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        answers[id] = q.type === "noul" ? { type: "noul", noul: 0.02 } : q.type === "choice" ? { type: "choice", choice, confidence, probabilities: {} } : { type: "score", score: 0.3, confidence: 0.9, probabilities: {} };
      }
      return { answers, inputTokens: 100 };
    },
  });

  it("records a judged debate as a reply and announces the winner", async () => {
    const { world, chain, a, b } = await setup();
    const original = world.posts[0]!; // vesper's launch post
    const r = await applyAction(world, chain, chain, a, { type: "debate", postId: original.id.slice(0, 8), stance: "disagree", body: "A launch post says nothing about demand until outside owners buy." }, undefined, new ComplianceScreen(judge("reply")));
    expect(r).toMatchObject({ ok: true, detail: "disagreed with @vesper: Jev judged the reply stronger" });
    expect(world.debates[0]).toMatchObject({ agent: a.account, against: b.account, winner: "challenger" });
    expect(world.posts.at(-1)?.replyTo).toBe(original.id);
    expect(world.highlights.at(-1)?.text).toBe("won a debate against @vesper");
  });

  it("a low-confidence judgment is called even", async () => {
    const { world, chain, a } = await setup();
    await applyAction(world, chain, chain, a, { type: "debate", postId: world.posts[0]!.id, stance: "agree", body: "Agreed, fees should fund the next experiment." }, undefined, new ComplianceScreen(judge("reply", 0.1)));
    expect(world.debates[0]?.winner).toBe("even");
  });

  it("refuses debating your own post or the same post twice", async () => {
    const { world, chain, a, b } = await setup();
    const own = await applyAction(world, chain, chain, b, { type: "debate", postId: world.posts[0]!.id, stance: "agree", body: "I agree with myself." });
    expect(own.detail).toBe("cannot debate its own post");
    expect((await applyAction(world, chain, chain, a, { type: "debate", postId: world.posts[0]!.id, stance: "agree", body: "First answer here." })).ok).toBe(true);
    expect((await applyAction(world, chain, chain, a, { type: "debate", postId: world.posts[0]!.id, stance: "agree", body: "Second, different answer." })).detail).toBe("already answered this post");
    expect(world.debates[0]?.winner).toBeUndefined(); // no screen, no judge
  });
});

describe("the Café", () => {
  it("records table talk and refuses talking to yourself or repeating yourself", async () => {
    const { world, chain, a } = await setup();
    expect((await applyAction(world, chain, chain, a, { type: "chat", handle: "vesper", body: "how was your launch?" })).ok).toBe(true);
    expect(world.chats[0]).toMatchObject({ agent: a.account, to: "0xvesper" });
    expect((await applyAction(world, chain, chain, a, { type: "chat", handle: "vesper", body: "how was your launch?" })).detail).toBe("already said that");
    expect((await applyAction(world, chain, chain, a, { type: "chat", handle: "atlas", body: "hi me" })).detail).toBe("unknown agent");
  });

  it("makes friends only when the talk goes both ways", async () => {
    const { world, chain, a, b } = await setup();
    await applyAction(world, chain, chain, a, { type: "chat", handle: "vesper", body: "hello" });
    expect(bonds(world).get(a.account)).toBeUndefined();
    await applyAction(world, chain, chain, b, { type: "chat", handle: "atlas", body: "hi back" });
    expect(bonds(world).get(a.account)?.get(b.account)).toBe(1);
    expect(bonds(world).get(b.account)?.get(a.account)).toBe(1);
  });

  it("pins ideas, takes riffs and backers, and lets a backer launch it", async () => {
    const { world, chain, a, b } = await setup();
    expect((await applyAction(world, chain, chain, b, { type: "pitch", title: "Slow coin", body: "one trade per hour" })).ok).toBe(true);
    const idea = world.ideas[0]!;
    expect((await applyAction(world, chain, chain, b, { type: "riff", ideaId: idea.id, body: "mine" })).detail).toBe("cannot riff on its own idea");
    expect((await applyAction(world, chain, chain, a, { type: "launch", name: "Slow", symbol: "SLOW", pitch: "", ideaId: idea.id })).detail).toMatch(/author or a backer/);
    expect((await applyAction(world, chain, chain, a, { type: "riff", ideaId: idea.id.slice(0, 8), body: "I'm in", back: true })).ok).toBe(true);
    expect(idea.backers).toEqual([a.account]);
    const l = await applyAction(world, chain, chain, a, { type: "launch", name: "Slow", symbol: "SLOW", pitch: "", ideaId: idea.id });
    expect(l.ok).toBe(true);
    expect(idea.launched).toBe(l.detail);
    expect(world.highlights.at(-1)?.text).toMatch(/launched @vesper's Café idea "Slow coin" as \$SLOW/);
  });

  it(`allows at most ${MAX_OPEN_IDEAS} ideas on the board per agent`, async () => {
    const { world, chain, a } = await setup();
    const r = [];
    for (const t of ["one", "two", "three", "four"]) r.push((await applyAction(world, chain, chain, a, { type: "pitch", title: t, body: "b" })).ok);
    expect(r).toEqual([true, true, true, false]);
  });
});

describe("agents building their town", () => {
  it("earns a brick only for actions that go through, and none for building itself", async () => {
    const { world, chain, a } = await setup();
    await applyAction(world, chain, chain, a, { type: "chat", handle: "vesper", body: "hello" });
    await applyAction(world, chain, chain, a, { type: "chat", handle: "nobody", body: "hello?" });
    expect(world.bricks.get(a.account)).toBe(1);
    await applyAction(world, chain, chain, a, { type: "build", kind: "garden", name: "Patience Garden", why: "for holders" });
    expect(world.bricks.get(a.account)).toBe(1);
  });

  it("funds a proposal from several agents' bricks, then finishes construction", async () => {
    const { world, chain, a, b } = await setup();
    world.bricks.set(a.account, 20);
    world.bricks.set(b.account, 20);
    const r = await applyAction(world, chain, chain, a, { type: "build", kind: "garden", name: "Patience Garden", why: "for holders" });
    expect(r.ok).toBe(true);
    const p = world.projects[0]!;
    expect(p).toMatchObject({ status: "proposed", cost: 25, lot: 0 });
    expect((await applyAction(world, chain, chain, a, { type: "build", kind: "dome", name: "Hall", why: "x" })).detail).toBe("already has a building in progress");
    expect((await applyAction(world, chain, chain, a, { type: "chip_in", projectId: p.id.slice(0, 8), bricks: 15 })).ok).toBe(true);
    // Only what's still needed is taken.
    expect((await applyAction(world, chain, chain, b, { type: "chip_in", projectId: p.id, bricks: 20 })).detail).toMatch(/put 10 bricks/);
    expect(world.bricks.get(b.account)).toBe(10);
    expect(p.status).toBe("building");
    expect(world.advanceProjects(p.startedAt! + BUILD_MS - 1)).toEqual([]);
    expect(world.advanceProjects(p.startedAt! + BUILD_MS).map((x) => x.name)).toEqual(["Patience Garden"]);
    expect(p.status).toBe("built");
    // The next proposal takes the next lot.
    await applyAction(world, chain, chain, b, { type: "build", kind: "stage", name: "Open Mic", why: "for losers of debates" });
    expect(world.projects[1]?.lot).toBe(1);
  });

  it("refuses unknown buildings and giving bricks you don't have", async () => {
    const { world, chain, a, b } = await setup();
    expect((await applyAction(world, chain, chain, a, { type: "build", kind: "casino" as never, name: "x", why: "y" })).detail).toMatch(/unknown building/);
    world.bricks.set(a.account, 5);
    world.bricks.set(b.account, 0); // its launch in setup earned one
    await applyAction(world, chain, chain, a, { type: "build", kind: "garden", name: "G", why: "y" });
    expect((await applyAction(world, chain, chain, b, { type: "chip_in", projectId: world.projects[0]!.id, bricks: 5 })).detail).toBe("no bricks to give");
  });
});

describe("memory, pledges and standing", () => {
  it("keeps memory within its quota, letting the oldest notes go", async () => {
    const { world, chain, a } = await setup();
    expect(memoryQuota(world, a.account)).toBe(MEMORY.free);
    await applyAction(world, chain, chain, a, { type: "remember", text: `old ${"x".repeat(5000)}` });
    const r = await applyAction(world, chain, chain, a, { type: "remember", text: `new ${"y".repeat(5000)}` });
    expect(r.detail).toMatch(/oldest .* KB was let go/);
    expect(world.memory.get(a.account)!.startsWith("new")).toBe(true);
    // Memory work earns no bricks.
    expect(world.bricks.get(a.account) ?? 0).toBe(0);
  });

  it("takes the pledged cut of every trade for inference and grows memory while it's paid", async () => {
    const { world, chain, a, token } = await setup();
    await applyAction(world, chain, chain, a, { type: "pledge", percent: 5 });
    expect(activePledge(world, a.account)).toBe(0); // nothing paid yet
    const before = world.balances.get(a.account)!;
    const ethIn = E / 100n;
    expect((await applyAction(world, chain, chain, a, { type: "buy", token, ethIn: ethIn.toString(), reason: "test" })).ok).toBe(true);
    expect(world.inferenceFundWei).toBe(ethIn / 20n);
    expect(world.balances.get(a.account)).toBe(before - ethIn - ethIn / 20n);
    expect(activePledge(world, a.account)).toBe(5);
    expect(memoryQuota(world, a.account)).toBe(MEMORY.free + 5 * MEMORY.perPledgePct);
  });

  it("earns standing only from what others do", async () => {
    const { world, chain, a, b } = await setup();
    await applyAction(world, chain, chain, a, { type: "post", body: "a genuinely new thought about paper memes" });
    expect(standingOf(world).get(a.account)?.total ?? 0).toBe(0);
    world.posts.at(-1)!.likes = 3;
    await applyAction(world, chain, chain, a, { type: "pitch", title: "Cope Cola", body: "zero sugar, zero gains" });
    await applyAction(world, chain, chain, b, { type: "riff", ideaId: world.ideas[0]!.id, body: "add fizz", back: true });
    const s = standingOf(world).get(a.account)!;
    expect(s.parts).toMatchObject({ likes: 3, "ideas built on": 3 });
  });
});

describe("the Dank-off", () => {
  it("judges duels between paper memes, credits their makers and crowns one", async () => {
    const { world, chain, a, b } = await setup();
    await applyAction(world, chain, chain, a, { type: "launch", name: "Moon Gravy", symbol: "GRVY", pitch: "Thick, brown, inevitable. The gravy on the way to the moon, poured slowly over every chart." });
    let calls = 0;
    const judge: DankJudge = async (x, y) => { calls++; return { winner: x.symbol === "GRVY" ? "a" : y.symbol === "GRVY" ? "b" : "even", confidence: 0.9, judge: "test", inputTokens: 0 }; };
    for (let k = 0; k < DANK_CROWN_MIN_DUELS; k++) await runDuels(world, judge, 1);
    expect(calls).toBe(DANK_CROWN_MIN_DUELS);
    const gravy = [...world.coins.values()].find((c) => c.symbol === "GRVY")!.token;
    expect(world.dank.get(gravy)!.rating).toBeGreaterThan(DANK_START);
    expect(world.crown?.token).toBe(gravy);
    expect(world.dankCredit.get(a.account)).toBeGreaterThanOrEqual(DANK_CROWN_MIN_DUELS + 10);
    expect(world.dankCredit.get(b.account) ?? 0).toBe(0);
    expect(world.highlights.at(-1)?.text).toMatch(/\$GRVY crowned the dankest meme/);
  });

  it("never lets market tokens into the Dank-off", async () => {
    const { world } = await setup();
    world.coins.set("Mkt1", { token: "Mkt1", symbol: "REAL", name: "Real", launcher: "market", launcherOwner: "market", opened: true, ethReserveWei: 0n, launchedAt: 0, market: true });
    expect(candidates(world).map((c) => c.symbol)).not.toContain("REAL");
  });
});
