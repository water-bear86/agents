import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { SOLANA_UNITS, planFor } from "@agents/core";
import { priceOf } from "../actions.js";
import { World } from "../world.js";
import { MeteoraDbcVenue } from "./dbc.js";
import { SolanaIndexer, SolanaQuoter, metadataAddress, parseMetadata } from "./indexer.js";
import type { PoolSnapshot, SolanaVenue } from "./venue.js";

type Acct = { address: string; owner: string; lamports: number; data: string };
const fx = JSON.parse(readFileSync(new URL("./fixtures/dbc-localnet.json", import.meta.url), "utf8")) as {
  mint: string; slot: number; blockTime: number; config: Acct; pool: Acct; metadata: Acct;
  expect: { quoteReserve: string; baseReserve: string; buy10mSol: string; sell1mTokens: string };
};
const info = (a: Acct) => ({ data: Buffer.from(a.data, "base64"), owner: new PublicKey(a.owner), lamports: a.lamports, executable: false, rentEpoch: 0 });

/** A Connection that serves only the recorded accounts: what the DBC SDK and Anchor ask for, nothing else. */
function recordedConnection() {
  const byKey = new Map([fx.config, fx.pool, fx.metadata].map((a) => [a.address, a]));
  const get = (k: PublicKey) => { const a = byKey.get(k.toBase58()); return a ? info(a) : null; };
  return {
    getAccountInfoAndContext: vi.fn(async (k: PublicKey) => ({ context: { slot: fx.slot }, value: get(k) })),
    getMultipleAccountsInfoAndContext: vi.fn(async (ks: PublicKey[]) => ({ context: { slot: fx.slot }, value: ks.map(get) })),
    getAccountInfo: vi.fn(async (k: PublicKey) => get(k)),
    getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => ks.map(get)),
    getSlot: vi.fn(async () => fx.slot),
    getBlockTime: vi.fn(async () => fx.blockTime),
    getBalance: vi.fn(async () => 0),
  };
}

describe("Metaplex metadata", () => {
  it("derives the metadata PDA and reads name and symbol from the account DBC created", () => {
    expect(metadataAddress(new PublicKey(fx.mint)).toBase58()).toBe(fx.metadata.address);
    expect(parseMetadata(Buffer.from(fx.metadata.data, "base64"))).toMatchObject({ name: expect.stringMatching(/^Smoke SMK/), symbol: expect.stringMatching(/^SMK/) });
  });

  it("rejects anything that isn't a metadata account", () => {
    expect(parseMetadata(new Uint8Array(10))).toBeNull();
    expect(parseMetadata(Uint8Array.from([4, ...new Array(64).fill(0), 255, 255, 255, 255]))).toBeNull();
  });
});

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

  it("quotes zero instead of throwing past the end of the curve", async () => {
    const p = (await venue().readPools([fx.mint])).get(fx.mint)!;
    expect(p.quote("buy", 10n ** 15n)).toBe(0n); // a million SOL completes the curve: the SDK throws, we return 0
    expect(p.quote("buy", 0n)).toBe(0n);
  });

  it("prices the coin in SOL per whole token through the shared priceOf", async () => {
    const q = new SolanaQuoter(venue());
    await q.refresh([fx.mint]);
    const price = priceOf(q, fx.mint, SOLANA_UNITS);
    // 10m lamports bought fx.buy10mSol base units: ~0.01 SOL / 6.2M tokens ≈ 1.6e-9 SOL per token
    expect(price).toBeGreaterThan(1e-10);
    expect(price).toBeLessThan(1e-8);
    expect(q.quoteBuy("unknown", 1n)).toBe(0n);
  });
});

describe("SolanaIndexer", () => {
  function setup() {
    const world = new World();
    world.units = SOLANA_UNITS;
    const agent = Keypair.generate().publicKey.toBase58();
    world.agents.set(agent, { account: agent, owner: "owner-a", handle: "atlas", name: "atlas", persona: "", modelId: "m", plan: planFor("momentum", SOLANA_UNITS), awake: true, external: false, createdAt: 0 });
    const snapshot = (m: string): PoolSnapshot => ({ mint: m, creator: agent, quoteReserve: 777n, baseReserve: 1n, open: true, migrated: false, quote: () => 0n });
    const venue: SolanaVenue = {
      buildLaunch: async () => { throw new Error("unused"); },
      buildSwap: async () => { throw new Error("unused"); },
      readPools: async (mints) => new Map(mints.map((m) => [m, snapshot(m)])),
      listLaunches: async () => [{ mint: fx.mint, creator: agent }, { mint: Keypair.generate().publicKey.toBase58(), creator: Keypair.generate().publicKey.toBase58() }],
    };
    const rpc = recordedConnection();
    rpc.getBalance.mockResolvedValue(123_000_000);
    return { world, agent, indexer: new SolanaIndexer(rpc as unknown as Connection, venue, world) };
  }

  it("picks up our agents' launches with their Metaplex name and ignores strangers' pools on our config", async () => {
    const { world, agent, indexer } = setup();
    expect(await indexer.pass()).toEqual({ discovered: 1 });
    expect(world.coins.size).toBe(1);
    expect(world.coins.get(fx.mint)).toMatchObject({ launcher: agent, launcherOwner: "owner-a", symbol: expect.stringMatching(/^SMK/), ethReserveWei: 777n, opened: true });
    expect(await indexer.pass()).toEqual({ discovered: 0 }); // idempotent
  });

  it("takes agent balances in lamports from the chain", async () => {
    const { world, agent, indexer } = setup();
    await indexer.syncBalances();
    expect(world.balances.get(agent)).toBe(123_000_000n);
  });
});
