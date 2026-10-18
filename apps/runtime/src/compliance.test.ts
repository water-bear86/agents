import { PRESETS } from "@agents/core";
import { describe, expect, it } from "vitest";
import { applyAction } from "./actions.js";
import { SimChain } from "./chain.js";
import { ComplianceScreen, decide, jevClient, type JevAnswer, type JevClient } from "./compliance.js";
import { World, type Agent } from "./world.js";

const agent: Agent = { account: "0xa", owner: "0xo", handle: "atlas", name: "atlas", persona: "", modelId: "m", plan: PRESETS.momentum, awake: true, external: false, createdAt: 0 };

/** A fake Jev that answers every noul with `p` and severity with `sev`. */
const fakeJev = (p: Record<string, number>, sev = 0, scores: Record<string, number> = {}): JevClient => ({
  async ask(_state, questions) {
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      answers[id] = q.type === "noul" ? { type: "noul", noul: p[id] ?? 0.02 } : { type: "score", score: scores[id] ?? sev, confidence: 0.9, probabilities: {} };
    }
    return { answers, inputTokens: 500 };
  },
});
const down: JevClient = { ask: async () => { throw new Error("jev 529"); } };

describe("compliance policy", () => {
  it("passes clean text, reviews the borderline, blocks the clear", () => {
    expect(decide({ promises_returns: 0.1 }, 0.2).outcome).toBe("pass");
    expect(decide({ promises_returns: 0.5 }, 0.8).outcome).toBe("review");
    expect(decide({ promises_returns: 0.9 }, 0.8).outcome).toBe("block");
    expect(decide({ promises_returns: 0.1 }, 2.2).outcome).toBe("block"); // severity alone can block
    expect(decide({ a: 0.4, b: 0.8 }, 0).flags.map((f) => f.id)).toEqual(["b", "a"]);
  });

  it("does nothing without an API key", () => {
    expect(jevClient(undefined)).toBeNull();
  });
});

describe("screened actions", () => {
  const post = { type: "post" as const, body: "Watching which tokens hold their bid on red days." };

  it("blocks a post that promises returns and queues it for review", async () => {
    const world = new World();
    const chain = new SimChain();
    const r = await applyAction(world, chain, chain, agent, { ...post, body: "Buy $MOON now, guaranteed 10x" }, undefined, new ComplianceScreen(fakeJev({ promises_returns: 0.93 }, 2.4)));
    expect(r).toMatchObject({ ok: false, detail: "compliance: promises returns (0.93)" });
    expect(world.posts).toHaveLength(0);
    expect(world.reviews[0]).toMatchObject({ kind: "post", outcome: "block" });
    expect(world.compliance).toMatchObject({ screened: 1, blocked: 1 });
  });

  it("lets a borderline post through but queues it with the post id", async () => {
    const world = new World();
    const chain = new SimChain();
    const r = await applyAction(world, chain, chain, agent, post, undefined, new ComplianceScreen(fakeJev({ solicits_buying: 0.5 }, 0.6)));
    expect(r.ok).toBe(true);
    expect(world.reviews[0]).toMatchObject({ outcome: "review", ref: world.posts[0]!.id });
  });

  it("clean posts go out and leave nothing in the queue", async () => {
    const world = new World();
    const chain = new SimChain();
    expect((await applyAction(world, chain, chain, agent, post, undefined, new ComplianceScreen(fakeJev({})))).ok).toBe(true);
    expect(world.reviews).toHaveLength(0);
    expect(world.compliance.passed).toBe(1);
  });

  it("an outage lets posts through as unscreened", async () => {
    const world = new World();
    const chain = new SimChain();
    const screen = new ComplianceScreen(down);
    expect((await applyAction(world, chain, chain, agent, post, undefined, screen)).ok).toBe(true);
    expect(world.reviews[0]?.outcome).toBe("unscreened");
  });

  it("with COMPLIANCE_FAIL_CLOSED=1 an outage holds posts instead", async () => {
    const world = new World();
    const chain = new SimChain();
    process.env.COMPLIANCE_FAIL_CLOSED = "1";
    try {
      const r = await applyAction(world, chain, chain, agent, post, undefined, new ComplianceScreen(down));
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/held/);
      expect(world.posts).toHaveLength(0);
    } finally {
      delete process.env.COMPLIANCE_FAIL_CLOSED;
    }
  });

  it("refuses a launch before it ever reaches the screen", async () => {
    const world = new World();
    const chain = new SimChain();
    let asked = 0;
    const counting: JevClient = { ask: async (s, q) => { asked++; return fakeJev({}).ask(s, q); } };
    const l = await applyAction(world, chain, chain, agent, { type: "launch", name: "Tesla", symbol: "TSLA", pitch: "" }, undefined, new ComplianceScreen(counting));
    expect(l.ok).toBe(false);
    expect(asked).toBe(0);
    expect(world.reviews).toHaveLength(0);
    expect(world.coins.size).toBe(0);
  });

  it("marks a sharp, in-character post as a Jev's pick and announces it", async () => {
    const world = new World();
    const chain = new SimChain();
    const persona = { ...agent, persona: "Patient. Only trusts buyers from different owners." };
    await applyAction(world, chain, chain, persona, post, undefined, new ComplianceScreen(fakeJev({ in_character: 0.9 }, 0.2, { insight: 2.6 })));
    expect(world.posts[0]?.jev).toMatchObject({ pick: true, insight: 2.6 });
    expect(world.highlights[0]?.kind).toBe("jev_pick");
  });

  it("a thin post is rated but not picked", async () => {
    const world = new World();
    const chain = new SimChain();
    await applyAction(world, chain, chain, agent, post, undefined, new ComplianceScreen(fakeJev({}, 0.2, { insight: 0.8 })));
    expect(world.posts[0]?.jev?.pick).toBe(false);
    expect(world.highlights).toHaveLength(0);
  });
});
