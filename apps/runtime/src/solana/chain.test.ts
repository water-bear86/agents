import { describe, expect, it, vi } from "vitest";
import { BorshCoder } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { SOLANA_UNITS, planFor } from "@agents/core";
import BN from "bn.js";
import { applyAction } from "../actions.js";
import { World, type Agent } from "../world.js";
import { SolanaAgentChain, isMainnet, programError, type SolanaRpc } from "./chain.js";
import { SolanaQuoter } from "./indexer.js";
import agentsIdl from "./idl/agents.json" with { type: "json" };
import { AGENTS_PROGRAM_ID, AgentsClient, DBC_PROGRAM_ID, HOOK_PROGRAM_ID, agentsProgram, coinAta, dbc, hookAccounts, pdas, wsolAta } from "./program.js";
import type { PoolReader } from "./venue.js";

const CONFIG = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const AGENT = pdas.agent("vesper");
const VAULT = pdas.vault(AGENT);
const coder = new BorshCoder(agentsIdl as never);

/** "Program data:" log line for an agents-program event, as the runtime would see it. */
const eventLog = (name: string, data: Record<string, unknown>) => {
  const disc = agentsIdl.events.find((e) => e.name === name)!.discriminator;
  return `Program data: ${Buffer.concat([Buffer.from(disc), coder.types.encode(name, data)]).toString("base64")}`;
};

/** Mock RPC: checks every transaction is fully signed, answers getTransaction with `logs`, or fails preflight with `fail`. */
function mockRpc(logs: string[], fail?: string) {
  const sent: Transaction[] = [];
  const rpc = {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })),
    sendRawTransaction: vi.fn(async (raw: Buffer | Uint8Array) => {
      const tx = Transaction.from(raw);
      if (!tx.verifySignatures()) throw new Error("unsigned transaction reached the RPC");
      if (fail) throw Object.assign(new Error("Simulation failed"), { logs: [`Program log: AnchorError occurred. Error Code: ${fail}. Error Number: 6006.`] });
      sent.push(tx);
      return `sig${sent.length}`;
    }),
    confirmTransaction: vi.fn(async () => ({ context: { slot: 1 }, value: { err: null } })),
    getTransaction: vi.fn(async () => ({ meta: { logMessages: [`Program ${AGENTS_PROGRAM_ID.toBase58()} invoke [1]`, ...logs, `Program ${AGENTS_PROGRAM_ID.toBase58()} success`] } })),
  };
  return { rpc: rpc as unknown as SolanaRpc & typeof rpc, sent };
}

const program = agentsProgram({} as Connection); // building instructions needs no RPC
const client = new AgentsClient(program, CONFIG);

function setup(logs: string[] = [], fail?: string) {
  const session = Keypair.generate();
  const { rpc, sent } = mockRpc(logs, fail);
  return { session, rpc, sent, chain: new SolanaAgentChain(rpc, client, session) };
}

const traded = (out: bigint, buy = true) => eventLog("Traded", { agent: AGENT, mint: MINT, buy, amount_in: new BN(1), amount_out: new BN(out.toString()) });
const keys = (tx: Transaction) => tx.instructions.at(-1)!.keys.map((k) => k.pubkey.toBase58());
const disc = (name: string) => Buffer.from(agentsIdl.instructions.find((i) => i.name === name)!.discriminator);

describe("SolanaAgentChain.execute", () => {
  it("buys through the agents program, signed only by the session key, and reads the fill from the Traded event", async () => {
    const { chain, session, sent } = setup([traded(123_456n)]);
    const r = await chain.execute(AGENT.toBase58(), { kind: "buy", token: MINT.toBase58(), ethIn: 10_000_000n, minOut: 100_000n, reason: "" });
    expect(r).toEqual({ txHash: "sig1", out: 123_456n });
    const tx = sent[0]!;
    expect(tx.signatures.map((s) => s.publicKey.toBase58())).toEqual([session.publicKey.toBase58()]);
    const ix = tx.instructions.at(-1)!;
    expect(ix.programId.equals(AGENTS_PROGRAM_ID)).toBe(true);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(disc("buy"));
    expect(new BN(ix.data.subarray(8, 16), "le").toString()).toBe("10000000");
    expect(new BN(ix.data.subarray(16, 24), "le").toString()).toBe("100000");
    // The vault's token accounts, the pool derived from our config, and the hook accounts for a transfer into the vault.
    const k = keys(tx);
    for (const a of [VAULT, coinAta(VAULT, MINT), wsolAta(VAULT), dbc.pool(CONFIG, MINT), DBC_PROGRAM_ID, HOOK_PROGRAM_ID, pdas.member(VAULT), pdas.coin(MINT), pdas.extraMetas(MINT)]) {
      expect(k).toContain(a.toBase58());
    }
  });

  it("sells with hook accounts for a transfer into the pool (owned by DBC's pool authority)", async () => {
    const { chain, sent } = setup([traded(2_000_000n, false)]);
    const r = await chain.execute(AGENT.toBase58(), { kind: "sell", token: MINT.toBase58(), tokensIn: 5_000_000n, minOut: 1_000_000n, reason: "" });
    expect(r.out).toBe(2_000_000n);
    expect(keys(sent[0]!)).toContain(pdas.member(dbc.poolAuthority).toBase58());
    expect(Buffer.from(sent[0]!.instructions.at(-1)!.data.subarray(0, 8))).toEqual(disc("sell"));
  });

  it("refuses minOut = 0 before anything is sent", async () => {
    const { chain, rpc } = setup();
    await expect(chain.execute(AGENT.toBase58(), { kind: "buy", token: MINT.toBase58(), ethIn: 1n, minOut: 0n, reason: "" })).rejects.toThrow("MinOutRequired");
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("surfaces the program's own error name when preflight refuses (no fee paid)", async () => {
    const { chain } = setup([], "OverDailyCap");
    await expect(chain.execute(AGENT.toBase58(), { kind: "buy", token: MINT.toBase58(), ethIn: 1n, minOut: 1n, reason: "" })).rejects.toThrow("OverDailyCap");
  });

  it("fails loudly if a confirmed trade emitted no Traded event", async () => {
    const { chain } = setup([]);
    await expect(chain.execute(AGENT.toBase58(), { kind: "buy", token: MINT.toBase58(), ethIn: 1n, minOut: 1n, reason: "" })).rejects.toThrow(/no Traded event/);
  });
});

describe("SolanaAgentChain.launch", () => {
  it("has the session key and the new mint sign, and wires the pool, hook and coin record", async () => {
    const { chain, session, sent } = setup([]);
    const r = await chain.launch(AGENT.toBase58(), "Vesper Coin", "VSPR");
    const mint = new PublicKey(r.token);
    expect(sent[0]!.signatures.map((s) => s.publicKey.toBase58()).sort()).toEqual([session.publicKey.toBase58(), r.token].sort());
    expect(Buffer.from(sent[0]!.instructions.at(-1)!.data.subarray(0, 8))).toEqual(disc("launch"));
    const k = keys(sent[0]!);
    for (const a of [pdas.coin(mint), dbc.pool(CONFIG, mint), pdas.extraMetas(mint), pdas.hookAuthority(), HOOK_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, VAULT]) {
      expect(k).toContain(a.toBase58());
    }
  });
});

describe("hook accounts", () => {
  it("lists the extra accounts in the hook's order, then the hook program and its validation account", () => {
    expect(hookAccounts(MINT, VAULT).map((a) => a.pubkey.toBase58())).toEqual(
      [AGENTS_PROGRAM_ID, pdas.coin(MINT), pdas.member(VAULT), HOOK_PROGRAM_ID, pdas.extraMetas(MINT)].map((p) => p.toBase58()),
    );
    expect(hookAccounts(MINT, VAULT).every((a) => !a.isSigner && !a.isWritable)).toBe(true);
  });
});

describe("runtime on Solana", () => {
  it("applyAction buys through the adapter and books lamports and 6-decimal token units", async () => {
    const { chain } = setup([traded(6_000_000_000_000n)]); // 0.06 SOL at 100k tokens per lamport
    const world = new World();
    world.units = SOLANA_UNITS;
    const account = AGENT.toBase58();
    const agent: Agent = { account, owner: "owner-b", handle: "vesper", name: "vesper", persona: "", modelId: "m", plan: planFor("momentum", SOLANA_UNITS), awake: true, external: false, createdAt: 0 };
    world.agents.set(account, agent);
    world.balances.set(account, 1_000_000_000n);
    world.coins.set(MINT.toBase58(), { token: MINT.toBase58(), symbol: "ATLS", name: "Atlas", launcher: "x", launcherOwner: "owner-a", opened: true, ethReserveWei: 0n, launchedAt: 0 });
    const reader: PoolReader = { readPools: async (ms) => new Map(ms.map((m) => [m, { mint: m, creator: "", quoteReserve: 0n, baseReserve: 0n, open: true, migrated: false, quote: (s: "buy" | "sell", a: bigint) => (s === "buy" ? a * 100_000n : a / 100_000n) }])) };
    const quoter = new SolanaQuoter(reader);
    await quoter.refresh([MINT.toBase58()]);

    const r = await applyAction(world, chain, quoter, agent, { type: "buy", token: MINT.toBase58(), ethIn: String(100_000_000n), reason: "test" });
    expect(r).toMatchObject({ ok: true, txHash: "sig1" });
    expect(r.detail).toContain("size clipped to 60000000 lamports"); // 6% of 1 SOL free
    expect(world.balances.get(account)).toBe(1_000_000_000n - 60_000_000n);
    expect(world.positions.get(account)![0]).toMatchObject({ token: MINT.toBase58(), amount: 6_000_000_000_000n, costWei: 60_000_000n });
  });
});

describe("helpers", () => {
  it("isMainnet guards scripts and the runtime", () => {
    expect(isMainnet("https://api.mainnet-beta.solana.com")).toBe(true);
    expect(isMainnet("https://api.devnet.solana.com")).toBe(false);
    expect(isMainnet("http://127.0.0.1:8899")).toBe(false);
  });

  it("programError pulls the Anchor error name out of preflight logs", () => {
    expect(programError(Object.assign(new Error("x"), { logs: ["Program log: AnchorError ... Error Code: AgentsOnly. Error Number: 6000."] }))).toBe("AgentsOnly");
    expect(programError(new Error("plain"))).toBe("plain");
  });
});
