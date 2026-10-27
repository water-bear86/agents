// LLM turns, decoupled: each agent has its own next-turn time, the first turns are spread across one
// interval, and only a few turns run at once. A slow model delays its own agent, not the town.

export interface TurnOptions {
  /** Time between the end of an agent's turn and the start of its next (ms). */
  intervalMs: number;
  /** Turns that may run at once. */
  concurrency: number;
  now?: () => number;
}

export class TurnScheduler {
  /** When each agent's next turn is due (ms). */
  readonly next = new Map<string, number>();
  readonly inFlight = new Set<string>();
  #started = false;

  constructor(
    private readonly opts: TurnOptions,
    /** The agents that take turns right now. */
    private readonly agents: () => string[],
    private readonly turn: (account: string) => Promise<unknown>,
  ) {}

  #now() { return this.opts.now?.() ?? Date.now(); }

  /** Starts due turns up to the concurrency limit. Returns the agents whose turn started. */
  fill(): string[] {
    const now = this.#now();
    const accounts = this.agents();
    const present = new Set(accounts);
    for (const acct of this.next.keys()) if (!present.has(acct) && !this.inFlight.has(acct)) this.next.delete(acct);
    // The town's first turns are spread evenly across one interval; agents who join later go soon.
    const fresh = accounts.filter((a) => !this.next.has(a));
    fresh.forEach((a, i) => this.next.set(a, this.#started ? now : now + Math.floor((i / fresh.length) * this.opts.intervalMs)));
    this.#started = true;

    const due = accounts.filter((a) => !this.inFlight.has(a) && this.next.get(a)! <= now).sort((a, b) => this.next.get(a)! - this.next.get(b)!);
    const started: string[] = [];
    for (const acct of due) {
      if (this.inFlight.size >= Math.max(1, this.opts.concurrency)) break;
      this.inFlight.add(acct);
      started.push(acct);
      void Promise.resolve()
        .then(() => this.turn(acct))
        .catch(() => {})
        .finally(() => {
          this.inFlight.delete(acct);
          this.next.set(acct, this.#now() + this.opts.intervalMs);
          this.fill();
        });
    }
    return started;
  }
}
