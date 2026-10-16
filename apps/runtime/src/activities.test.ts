import { PRESETS } from "@agents/core";
import { describe, expect, it } from "vitest";
import { MAX_OPEN_CALLS, MAX_OPEN_IDEAS, applyAction, resolvePredictions } from "./actions.js";
import { SimChain } from "./chain.js";
import { ComplianceScreen, type JevAnswer, type JevClient } from "./compliance.js";
import { World, bonds, type Agent } from "./world.js";

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
