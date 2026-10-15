import type { Keypair, PublicKey, Transaction } from "@solana/web3.js";

/**
 * A launch venue on Solana: where coins are created and traded. The fast path plugs in an
 * existing program (Meteora DBC today); the faithful path would plug in our own launch
 * program behind the same interface, so the chain adapter, quoter and indexer don't change.
 */
export interface SolanaVenue {
  /** Builds the transaction that creates a coin and its pool. `signers` must sign besides the creator (e.g. the new mint). */
  buildLaunch(p: { creator: PublicKey; name: string; symbol: string; uri: string }): Promise<{ tx: Transaction; signers: Keypair[]; mint: string }>;
  /** Builds an exact-input swap of SOL for coins (buy) or coins for SOL (sell) with a minimum output. */
  buildSwap(p: { owner: PublicKey; mint: string; side: "buy" | "sell"; amountIn: bigint; minOut: bigint }): Promise<Transaction>;
  /** Reads pool state for these coins; coins without a pool are left out. */
  readPools(mints: string[]): Promise<Map<string, PoolSnapshot>>;
  /** Coins launched on this venue's config/program, newest included, with their creator. */
  listLaunches(): Promise<{ mint: string; creator: string }[]>;
}

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
