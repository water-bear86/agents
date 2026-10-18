/**
 * Double-entry ledger. Amounts are signed bigints in each asset's base unit
 * (lamports for SOL, micro-dollars for USD). Every transaction must net to zero
 * per asset, so money can only move between accounts, never appear or vanish.
 */

export type Asset = "SOL" | "USD" | (string & {});

export interface Posting {
  account: string;
  asset: Asset;
  amount: bigint;
}

export interface LedgerRef {
  /** On-chain transaction signature / hash backing this entry. */
  chainTx?: string;
  /** Vendor invoice line (OpenRouter generation id, Browserbase session id, ...). */
  invoiceLine?: string;
  /** Trace span that incurred the cost. */
  spanId?: string;
}

export interface LedgerTx {
  /** Idempotency key: posting the same id twice is a no-op if the content matches. */
  id: string;
  at: Date;
  kind: string;
  memo?: string;
  ref?: LedgerRef;
  meta?: Record<string, unknown>;
  postings: Posting[];
}

export class LedgerError extends Error {
  override name = "LedgerError";
}

export interface LedgerStore {
  get(id: string): Promise<LedgerTx | undefined>;
  /**
   * Stores `tx` unless a transaction with its id already exists, in one atomic step (a unique
   * constraint in a database). Returns the transaction already there, or undefined if `tx` was stored.
   */
  insertIfAbsent(tx: LedgerTx): Promise<LedgerTx | undefined>;
  /** All transactions touching any account that starts with `prefix`, oldest first. */
  list(prefix?: string): Promise<LedgerTx[]>;
}

export class MemoryLedgerStore implements LedgerStore {
  readonly #txs = new Map<string, LedgerTx>();

  async get(id: string) {
    return this.#txs.get(id);
  }

  async insertIfAbsent(tx: LedgerTx) {
    const existing = this.#txs.get(tx.id);
    if (existing) return existing;
    this.#txs.set(tx.id, tx);
    return undefined;
  }

  async list(prefix = "") {
    return [...this.#txs.values()]
      .filter((tx) => tx.postings.some((p) => p.account.startsWith(prefix)))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }
}

export function validate(tx: LedgerTx): void {
  if (!tx.id) throw new LedgerError("transaction id is required");
  if (tx.postings.length < 2) throw new LedgerError(`${tx.id}: needs at least two postings`);
  const sums = new Map<Asset, bigint>();
  for (const p of tx.postings) {
    if (!p.account) throw new LedgerError(`${tx.id}: posting without account`);
    if (p.amount === 0n) throw new LedgerError(`${tx.id}: zero posting on ${p.account}`);
    sums.set(p.asset, (sums.get(p.asset) ?? 0n) + p.amount);
  }
  for (const [asset, sum] of sums) {
    if (sum !== 0n) throw new LedgerError(`${tx.id}: ${asset} postings net to ${sum}, expected 0`);
  }
}

function fingerprint(tx: LedgerTx): string {
  return JSON.stringify(
    tx.postings.map((p) => [p.account, p.asset, p.amount.toString()]).sort(),
  );
}

export class Ledger {
  constructor(readonly store: LedgerStore = new MemoryLedgerStore()) {}

  /** Returns false when an identical transaction was already posted. */
  async post(tx: LedgerTx): Promise<boolean> {
    validate(tx);
    // Check and store in one step, so two concurrent posts of one id can't both win.
    const existing = await this.store.insertIfAbsent(tx);
    if (!existing) return true;
    if (fingerprint(existing) !== fingerprint(tx)) {
      throw new LedgerError(`${tx.id}: already posted with different postings`);
    }
    return false;
  }

  async balance(account: string, asset: Asset): Promise<bigint> {
    let total = 0n;
    for (const tx of await this.store.list(account)) {
      for (const p of tx.postings) {
        if (p.account === account && p.asset === asset) total += p.amount;
      }
    }
    return total;
  }

  /** Balances of every account under `prefix`, keyed by `account|asset`. */
  async balances(prefix: string): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const tx of await this.store.list(prefix)) {
      for (const p of tx.postings) {
        if (!p.account.startsWith(prefix)) continue;
        const key = `${p.account}|${p.asset}`;
        out.set(key, (out.get(key) ?? 0n) + p.amount);
      }
    }
    return out;
  }
}
