import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { SOLANA_UNITS, planFor } from "@agents/core";
import { applyAction } from "../actions.js";
import { World, type Agent } from "../world.js";
import { SolanaAgentChain, isMainnet, type SolanaRpc } from "./chain.js";
import type { PoolSnapshot, SolanaVenue } from "./venue.js";
import { SolanaQuoter } from "./indexer.js";

const SOL = 1_000_000_000n;
const MINT = Keypair.generate().publicKey.toBase58();

/** A transaction that needs `signers` to sign, standing in for what the venue builds. */
const txFor = (...signers: PublicKey[]) =>
  new Transaction().add(new TransactionInstruction({ programId: SystemProgram.programId, keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: true })), data: Buffer.alloc(0) }));

function fakeVenue(snapshot?: Partial<PoolSnapshot>) {
  const mintKp = Keypair.generate();
  const venue = {
    swaps: [] as { owner: string; mint: string; side: string; amountIn: bigint; minOut: bigint }[],
    launches: [] as { creator: string; name: string; symbol: string; uri: string }[],
    mint: mintKp.publicKey.toBase58(),
    async buildLaunch(p: { creator: PublicKey; name: string; symbol: string; uri: string }) {
      venue.launches.push({ ...p, creator: p.creator.toBase58() });
      return { tx: txFor(p.creator, mintKp.publicKey), signers: [mintKp], mint: mintKp.publicKey.toBase58() };
    },
    async buildSwap(p: { owner: PublicKey; mint: string; side: "buy" | "sell"; amountIn: bigint; minOut: bigint }) {
      venue.swaps.push({ ...p, owner: p.owner.toBase58() });
      return txFor(p.owner);
    },
    async readPools(mints: string[]) {
      return new Map(mints.map((m) => [m, { mint: m, creator: "", quoteReserve: 0n, baseReserve: 0n, open: true, migrated: false, quote: (s: "buy" | "sell", a: bigint) => (s === "buy" ? a * 1000n : a / 1000n), ...snapshot }]));
    },
    async listLaunches() { return []; },
  };
  return venue satisfies SolanaVenue;
}

/** Mock RPC: checks every transaction it receives is fully signed, and answers getTransaction from `meta`. */
function mockRpc(meta: (owner: PublicKey) => object, opts: { err?: unknown } = {}) {
  const sent: Transaction[] = [];
  const rpc = {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })),
    sendRawTransaction: vi.fn(async (raw: Buffer | Uint8Array) => {
      const tx = Transaction.from(raw);
      if (!tx.verifySignatures()) throw new Error("unsigned transaction reached the RPC");
      sent.push(tx);
      return `sig${sent.length}`;
    }),
    confirmTransaction: vi.fn(async () => ({ context: { slot: 1 }, value: { err: opts.err ?? null } })),
    getTransaction: vi.fn(async () => {
      const tx = sent.at(-1)!;
      return { transaction: { message: { getAccountKeys: () => ({ staticAccountKeys: tx.compileMessage().accountKeys }) } }, meta: meta(tx.feePayer!) };
    }),
  };
  return { rpc: rpc as unknown as SolanaRpc & typeof rpc, sent };
}

const tokenBal = (owner: PublicKey, amount: bigint) => ({ accountIndex: 1, mint: MINT, owner: owner.toBase58(), uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: "" } });

const buyMeta = (got: bigint) => (owner: PublicKey) => ({ err: null, fee: 5000, preBalances: [1e9, 0], postBalances: [5e8, 0], preTokenBalances: [tokenBal(owner, 7n)], postTokenBalances: [tokenBal(owner, 7n + got)] });
const sellMeta = (lamports: bigint) => () => ({ err: null, fee: 5000, preBalances: [1e9, 0], postBalances: [1e9 + Number(lamports) - 5000, 0], preTokenBalances: [], postTokenBalances: [] });

function setup(meta: (owner: PublicKey) => object, opts: ConstructorParameters<typeof SolanaAgentChain>[3] = {}, rpcOpts = {}) {
  const agent = Keypair.generate();
  const venue = fakeVenue();
  const { rpc, sent } = mockRpc(meta, rpcOpts);
  const chain = new SolanaAgentChain(rpc, venue, new Map([[agent.publicKey.toBase58(), agent]]), opts);
  return { agent, account: agent.publicKey.toBase58(), venue, rpc, sent, chain };
}

describe("SolanaAgentChain.execute", () => {
  it("buys through the venue, signs with the agent's key and reads the fill from token balances", async () => {
    const { chain, account, venue, sent } = setup(buyMeta(123_456n));
    const r = await chain.execute(account, { kind: "buy", token: MINT, ethIn: SOL / 10n, minOut: 100_000n, reason: "" });
    expect(r).toEqual({ txHash: "sig1", out: 123_456n });
    expect(venue.swaps).toEqual([{ owner: account, mint: MINT, side: "buy", amountIn: SOL / 10n, minOut: 100_000n }]);
    expect(sent[0]!.feePayer!.toBase58()).toBe(account);
  });

  it("reads a sell's proceeds from the SOL balance, adding back the fee the agent paid", async () => {
    const { chain, account } = setup(sellMeta(2_000_000n));
    const r = await chain.execute(account, { kind: "sell", token: MINT, tokensIn: 5_000_000n, minOut: 1_000_000n, reason: "" });
    expect(r.out).toBe(2_000_000n);
  });

  it("refuses minOut = 0 before anything is built or sent, as AgentAccount does", async () => {
    const { chain, account, venue, rpc } = setup(buyMeta(1n));
    await expect(chain.execute(account, { kind: "buy", token: MINT, ethIn: 1n, minOut: 0n, reason: "" })).rejects.toThrow("MinOutRequired");
    expect(venue.swaps).toHaveLength(0);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("enforces the per-trade and daily caps off-chain, and resets the day after 24h", async () => {
    let now = 0;
    const { chain, account, rpc } = setup(buyMeta(10n), { limits: { maxTradeLamports: SOL / 10n, dailyLimitLamports: SOL / 4n }, now: () => now });
    const buy = (lamports: bigint) => chain.execute(account, { kind: "buy", token: MINT, ethIn: lamports, minOut: 1n, reason: "" });
    await expect(buy(SOL / 5n)).rejects.toThrow("OverTradeCap");
    await buy(SOL / 10n);
    await buy(SOL / 10n);
    await expect(buy(SOL / 10n)).rejects.toThrow("OverDailyCap");
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
    now += 24 * 60 * 60_000;
    await expect(buy(SOL / 10n)).resolves.toMatchObject({ out: 10n });
  });

  it("sells are not daily-capped (they only return SOL to the agent), matching AgentAccount", async () => {
    const { chain, account } = setup(sellMeta(5n), { limits: { maxTradeLamports: 1n, dailyLimitLamports: 1n } });
    await expect(chain.execute(account, { kind: "sell", token: MINT, tokensIn: 10n * SOL, minOut: 1n, reason: "" })).resolves.toMatchObject({ out: 5n });
  });

  it("surfaces a failed transaction and doesn't count it against the daily cap", async () => {
    const { chain, account } = setup(buyMeta(1n), { limits: { maxTradeLamports: SOL, dailyLimitLamports: SOL } }, { err: { InstructionError: [0, { Custom: 6004 }] } });
    await expect(chain.execute(account, { kind: "buy", token: MINT, ethIn: SOL, minOut: 1n, reason: "" })).rejects.toThrow(/failed/);
    // the full daily budget is still there
    const ok = setup(buyMeta(1n), { limits: { maxTradeLamports: SOL, dailyLimitLamports: SOL } });
    await expect(ok.chain.execute(ok.account, { kind: "buy", token: MINT, ethIn: SOL, minOut: 1n, reason: "" })).resolves.toBeTruthy();
  });

  it("refuses a fill below minOut even if the program let it through", async () => {
    const { chain, account } = setup(buyMeta(5n));
    await expect(chain.execute(account, { kind: "buy", token: MINT, ethIn: 1n, minOut: 6n, reason: "" })).rejects.toThrow("Slippage");
  });

  it("won't sign for an account it holds no key for", async () => {
    const { chain } = setup(buyMeta(1n));
    await expect(chain.execute(Keypair.generate().publicKey.toBase58(), { kind: "buy", token: MINT, ethIn: 1n, minOut: 1n, reason: "" })).rejects.toThrow(/no signer/);
  });
});

describe("SolanaAgentChain.launch", () => {
  it("has both the agent and the new mint sign, and returns the mint as the coin id", async () => {
    const { chain, account, venue, sent } = setup(buyMeta(0n), { coinUri: (s) => `https://coins.example/${s}.json` });
    const r = await chain.launch(account, "Atlas Coin", "ATLS");
    expect(r).toEqual({ txHash: "sig1", token: venue.mint });
    expect(venue.launches).toEqual([{ creator: account, name: "Atlas Coin", symbol: "ATLS", uri: "https://coins.example/ATLS.json" }]);
    expect(sent[0]!.signatures.map((s) => s.publicKey.toBase58()).sort()).toEqual([account, venue.mint].sort());
  });
});

describe("runtime on Solana units", () => {
  it("applyAction buys through the adapter and books lamports and 6-decimal token units", async () => {
    const { chain, account } = setup(buyMeta(6_000_000_000_000n)); // 0.06 SOL at 100k tokens per lamport
    const world = new World();
    world.units = SOLANA_UNITS;
    const agent: Agent = { account, owner: "owner-b", handle: "vesper", name: "vesper", persona: "", modelId: "m", plan: planFor("momentum", SOLANA_UNITS), awake: true, external: false, createdAt: 0 };
    world.agents.set(account, agent);
    world.balances.set(account, SOL);
    world.coins.set(MINT, { token: MINT, symbol: "ATLS", name: "Atlas", launcher: "x", launcherOwner: "owner-a", opened: true, ethReserveWei: 0n, launchedAt: 0 });
    const quoter = new SolanaQuoter(fakeVenue({ quote: (s, a) => (s === "buy" ? a * 100_000n : a / 100_000n) }));
    await quoter.refresh([MINT]);

    const r = await applyAction(world, chain, quoter, agent, { type: "buy", token: MINT, ethIn: String(SOL / 10n), reason: "test" });
    expect(r).toMatchObject({ ok: true, txHash: "sig1" });
    // 6% of 1 SOL free balance = 0.06 SOL, the plan's clip, named in lamports
    expect(r.detail).toContain("size clipped to 60000000 lamports");
    expect(world.balances.get(account)).toBe(SOL - 60_000_000n);
    expect(world.positions.get(account)![0]).toMatchObject({ token: MINT, amount: 6_000_000_000_000n, costWei: 60_000_000n });
  });
});

describe("isMainnet", () => {
  it("guards the smoke test", () => {
    expect(isMainnet("https://api.mainnet-beta.solana.com")).toBe(true);
    expect(isMainnet("https://api.devnet.solana.com")).toBe(false);
    expect(isMainnet("http://127.0.0.1:8899")).toBe(false);
  });
});
