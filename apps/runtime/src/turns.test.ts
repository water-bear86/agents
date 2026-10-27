import { describe, expect, it } from "vitest";
import { TurnScheduler } from "./turns.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Turns the test finishes by hand. */
function harness(agents: string[], concurrency: number) {
  let now = 0;
  const open = new Map<string, () => void>();
  const ran: string[] = [];
  const s = new TurnScheduler({ intervalMs: 60_000, concurrency, now: () => now }, () => agents, (acct) => {
    ran.push(acct);
    return new Promise<void>((r) => open.set(acct, () => { open.delete(acct); r(); }));
  });
  return {
    s, ran, open,
    at: (t: number) => { now = t; },
    /** Starts due turns and lets them begin. */
    fill: async () => { const started = s.fill(); await flush(); return started; },
    finish: async (acct: string) => { open.get(acct)!(); await flush(); },
  };
}

describe("LLM turn scheduler", () => {
  it("spreads the town's first turns across one interval", () => {
    const h = harness(["a", "b", "c", "d"], 10);
    expect(h.s.fill()).toEqual(["a"]);
    expect([...h.s.next.values()]).toEqual([0, 15_000, 30_000, 45_000]);
    h.at(30_000);
    expect(h.s.fill()).toEqual(["b", "c"]);
  });

  it("runs at most the concurrency limit at once, and never one agent twice", async () => {
    const h = harness(["a", "b", "c"], 2);
    await h.fill();
    h.at(60_000);
    expect(await h.fill()).toEqual(["b"]);
    expect(await h.fill()).toEqual([]);
    await h.finish("a");
    // The free slot goes to the next due agent straight away.
    expect(h.ran).toEqual(["a", "b", "c"]);
    expect(h.s.next.get("a")).toBe(120_000);
    expect(h.s.inFlight.size).toBe(2);
  });

  it("doesn't let one slow model hold up the others", async () => {
    const h = harness(["slow", "x", "y"], 2);
    await h.fill(); // slow starts and never finishes
    h.at(60_000);
    await h.fill();
    for (let t = 1; t <= 4; t++) {
      for (const a of ["x", "y"]) if (h.open.has(a)) await h.finish(a);
      h.at(60_000 + t * 60_000);
      await h.fill();
    }
    expect(h.ran.filter((a) => a === "slow")).toHaveLength(1);
    expect(h.ran.filter((a) => a !== "slow").length).toBeGreaterThanOrEqual(4);
  });

  it("gives agents who join later a turn soon, and forgets agents who leave", () => {
    const agents = ["a"];
    let now = 0;
    const s = new TurnScheduler({ intervalMs: 60_000, concurrency: 5, now: () => now }, () => agents, () => new Promise(() => {}));
    s.fill();
    now = 5_000;
    agents.push("late");
    expect(s.fill()).toEqual(["late"]);
    agents.splice(0, 2, "b");
    s.fill();
    expect(s.next.has("b")).toBe(true);
  });
});
