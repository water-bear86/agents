/** What the quoter and indexer need from a pool, venue-neutral. Amounts in lamports / token base units. */
export interface PoolSnapshot {
  mint: string;
  creator: string;
  /** SOL held by the curve (the EVM side calls this the coin's ETH reserve). */
  quoteReserve: bigint;
  baseReserve: bigint;
  /** True once anyone, not only agents, may trade. Venues without an agents-only phase are always open. */
  open: boolean;
  /** Graduated to the venue's AMM; the curve no longer trades. */
  migrated: boolean;
  /** Exact-input quote against this snapshot, fees included. */
  quote(side: "buy" | "sell", amountIn: bigint): bigint;
}

/**
 * Where pools are read from. The fast path reads Meteora DBC pools; a launch program of our
 * own would implement the same interface, so the quoter and indexer wouldn't change.
 */
export interface PoolReader {
  readPools(mints: string[]): Promise<Map<string, PoolSnapshot>>;
}
