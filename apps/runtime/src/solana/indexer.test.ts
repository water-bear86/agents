import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { SOLANA_UNITS, planFor } from "@agents/core";
import { priceOf } from "../actions.js";
import { World } from "../world.js";
import { MeteoraDbcVenue } from "./dbc.js";
import { SolanaIndexer, SolanaQuoter, type CoinRecord, type CoinSource } from "./indexer.js";
import { pdas, wsolAta } from "./program.js";
import type { PoolReader, PoolSnapshot } from "./venue.js";

type Acct = { address: string; owner: string; lamports: number; data: string };
const fx = JSON.parse(readFileSync(new URL("./fixtures/dbc-localnet.json", import.meta.url), "utf8")) as {
  mint: string; slot: number; blockTime: number; config: Acct; pool: Acct;
  expect: { quoteReserve: string; baseReserve: string; buy10mSol: string; sell1mTokens: string };
};
const info = (a: Acct) => ({ data: Buffer.from(a.data, "base64"), owner: new PublicKey(a.owner), lamports: a.lamports, executable: false, rentEpoch: 0 });

/** A Connection that serves only the recorded accounts: what the DBC SDK and Anchor ask for, nothing else. */
function recordedConnection(extra: Record<string, ReturnType<typeof info> | { lamports: number; data: Buffer; owner: PublicKey }> = {}) {
  const byKey = new Map<string, unknown>([[fx.config.address, info(fx.config)], [fx.pool.address, info(fx.pool)], ...Object.entries(extra)]);
  const get = (k: PublicKey) => byKey.get(k.toBase58()) ?? null;
  return {
    getAccountInfoAndContext: vi.fn(async (k: PublicKey) => ({ context: { slot: fx.slot }, value: get(k) })),
    getMultipleAccountsInfoAndContext: vi.fn(async (ks: PublicKey[]) => ({ context: { slot: fx.slot }, value: ks.map(get) })),
    getAccountInfo: vi.fn(async (k: PublicKey) => get(k)),
    getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => ks.map(get)),
    getSlot: vi.fn(async () => fx.slot),
    getBlockTime: vi.fn(async () => fx.blockTime),
  };
}

describe("MeteoraDbcVenue against recorded accounts (mocked RPC)", () => {
  const venue = () => new MeteoraDbcVenue(recordedConnection() as unknown as Connection, new PublicKey(fx.config.address));

  it("derives the pool address from mint and config", () => {
    expect(venue().poolAddress(fx.mint).toBase58()).toBe(fx.pool.address);
  });

  it("decodes the pool and quotes with the SDK's swap math, matching the live validator", async () => {
    const pools = await venue().readPools([fx.mint, Keypair.generate().publicKey.toBase58()]);
    expect(pools.size).toBe(1); // a mint with no pool is left out
    const p = pools.get(fx.mint)!;
    expect(p.quoteReserve.toString()).toBe(fx.expect.quoteReserve);
    expect(p.baseReserve.toString()).toBe(fx.expect.baseReserve);
    expect(p).toMatchObject({ open: true, migrated: false });
    expect(p.quote("buy", 10_000_000n).toString()).toBe(fx.expect.buy10mSol);
    expect(p.quote("sell", 1_000_000_000_000n).toString()).toBe(fx.expect.sell1mTokens);
  });

  it("takes the open flag from the agents program when the coin has a hook", async () => {
    const v = venue();
    v.opensOf = () => false;
    expect((await v.readPools([fx.mint])).get(fx.mint)!.open).toBe(false);
  });

  it("quotes zero instead of throwing past the end of the curve", async () => {
    const p = (await venue().readPools([fx.mint])).get(fx.mint)!;
    expect(p.quote("buy", 10n ** 15n)).toBe(0n);
    expect(p.quote("buy", 0n)).toBe(0n);
  });

  it("prices the coin in SOL per whole token through the shared priceOf", async () => {
    const q = new SolanaQuoter(venue());
    await q.refresh([fx.mint]);
    const price = priceOf(q, fx.mint, SOLANA_UNITS);
    expect(price).toBeGreaterThan(1e-10);
    expect(price).toBeLessThan(1e-8);
    expect(q.quoteBuy("unknown", 1n)).toBe(0n);
  });
});

describe("SolanaIndexer", () => {
  function setup(records: CoinRecord[], threshold = 50_000_000n) {
    const world = new World();
    world.units = SOLANA_UNITS;
    const agent = pdas.agent("atlas").toBase58();
    world.agents.set(agent, { account: agent, owner: "owner-a", handle: "atlas", name: "atlas", persona: "", modelId: "m", plan: planFor("momentum", SOLANA_UNITS), awake: true, external: false, createdAt: 0 });
    const snapshot = (m: string): PoolSnapshot => ({ mint: m, creator: agent, quoteReserve: 77_000_000n, baseReserve: 1n, open: false, migrated: false, quote: () => 0n });
    const reader: PoolReader = { readPools: async (mints) => new Map(mints.map((m) => [m, snapshot(m)])) };
    const source: CoinSource = { coins: async () => records, platform: async () => ({ openThreshold: threshold, inference: "", buyback: "" }) };
    const vault = pdas.vault(new PublicKey(agent));
    const wsol = Buffer.alloc(165);
    wsol.writeBigUInt64LE(25_000_000n, 64);
    const rpc = recordedConnection({ [vault.toBase58()]: { lamports: 400_000_000, data: Buffer.alloc(0), owner: PublicKey.default }, [wsolAta(vault).toBase58()]: { lamports: 2_039_280, data: wsol, owner: PublicKey.default } });
    return { world, agent, indexer: new SolanaIndexer(rpc as unknown as Connection, source, reader, world) };
  }
  const rec = (over: Partial<CoinRecord> & { launcher: string }): CoinRecord => ({ mint: Keypair.generate().publicKey.toBase58(), pool: "", opensAt: Date.now() + 3_600_000, opened: false, name: "Atlas Coin", symbol: "ATLS", ...over });

  it("picks up our agents' launches from the program and ignores other launchers", async () => {
    const agent = pdas.agent("atlas").toBase58();
    const mine = rec({ launcher: agent });
    const { world, indexer } = setup([mine, rec({ launcher: Keypair.generate().publicKey.toBase58() })]);
    expect(await indexer.pass()).toEqual({ discovered: 1 });
    expect(world.coins.get(mine.mint)).toMatchObject({ launcher: agent, launcherOwner: "owner-a", symbol: "ATLS", name: "Atlas Coin", ethReserveWei: 77_000_000n, opened: false });
    expect(await indexer.pass()).toEqual({ discovered: 0 }); // idempotent
  });

  it("marks a coin open once the program says so or its opening time has passed", async () => {
    const agent = pdas.agent("atlas").toBase58();
    const late = rec({ launcher: agent, opensAt: Date.now() - 1 });
    const flagged = rec({ launcher: agent, opened: true });
    const { world, indexer } = setup([late, flagged]);
    await indexer.pass();
    expect(world.coins.get(late.mint)!.opened).toBe(true);
    expect(world.coins.get(flagged.mint)!.opened).toBe(true);
  });

  it("lists coins ready to open: over the threshold, or past their time", async () => {
    const agent = pdas.agent("atlas").toBase58();
    const c = rec({ launcher: agent });
    const below = setup([c], 100_000_000n);
    await below.indexer.pass();
    expect(await below.indexer.readyToOpen()).toEqual([]);
    expect(await below.indexer.readyToOpen(Date.now() + 2 * 3_600_000)).toEqual([c.mint]);
    const above = setup([c], 50_000_000n);
    await above.indexer.pass();
    expect(await above.indexer.readyToOpen()).toEqual([c.mint]);
  });

  it("counts the vault's lamports plus its wrapped SOL as spendable", async () => {
    const { world, agent, indexer } = setup([]);
    await indexer.syncBalances();
    expect(world.balances.get(agent)).toBe(425_000_000n);
  });
});
