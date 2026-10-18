import { AnchorProvider, BorshCoder, EventParser, Program, type Wallet } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, type AccountMeta, type Connection, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import agentsIdl from "./idl/agents.json" with { type: "json" };
import type { Agents } from "./idl/agents-types.js";
import { feedAccount, feedBytes } from "./pyth.js";

/** Program ids (localnet, devnet and mainnet use the same key; see solana/Anchor.toml). */
export const AGENTS_PROGRAM_ID = new PublicKey(agentsIdl.address);
export const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const seed = (s: string) => Buffer.from(s);
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, AGENTS_PROGRAM_ID)[0];

/** Every address the agents program uses, derived the same way the program does. */
export const pdas = {
  platform: () => pda([seed("platform")]),
  agent: (handle: string) => pda([seed("agent"), Buffer.from(handle)]),
  vault: (agent: PublicKey) => pda([seed("vault"), agent.toBuffer()]),
  allowed: (mint: PublicKey) => pda([seed("mint"), mint.toBuffer()]),
  programData: () => PublicKey.findProgramAddressSync([AGENTS_PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER)[0],
};

/** A vault's associated token account for `mint` (the vault is a PDA, hence allowOwnerOffCurve). */
export const vaultAta = (vault: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(mint, vault, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
export const wsolAta = (owner: PublicKey) => vaultAta(owner, NATIVE_MINT);

const readOnlyWallet = (pk: PublicKey): Wallet => ({
  publicKey: pk,
  payer: undefined as unknown as Keypair,
  signTransaction: async () => { throw new Error("read-only wallet"); },
  signAllTransactions: async () => { throw new Error("read-only wallet"); },
});

export type AgentsProgram = Program<Agents>;

export function agentsProgram(connection: Connection, wallet: PublicKey = PublicKey.default): AgentsProgram {
  return new Program<Agents>(agentsIdl as Agents, new AnchorProvider(connection, readOnlyWallet(wallet), { commitment: "confirmed" }));
}

const coder = new BorshCoder(agentsIdl as Agents);
const parser = new EventParser(AGENTS_PROGRAM_ID, coder);

/** Events the agents program emitted in a transaction's logs. */
export function parseEvents(logs: string[]): { name: string; data: Record<string, unknown> }[] {
  return [...parser.parseLogs(logs)].map((e) => ({ name: e.name, data: e.data as Record<string, unknown> }));
}

export const bn = (x: bigint | number) => new BN(x.toString());

/** A Jupiter swap instruction as its API returns it, ready to be wrapped in the program's `swap`. */
export interface JupiterSwapIx {
  accounts: AccountMeta[];
  data: Buffer;
}

/** Builders for each instruction, with every account spelled out (no network lookups). */
export class AgentsClient {
  constructor(readonly program: AgentsProgram) {}

  /**
   * The program's `swap`, wrapping a Jupiter route from the vault's `inputMint` account to its
   * `outputMint` account. Creates both vault accounts first if needed (paid by `payer`).
   */
  async swapIxs(p: {
    payer: PublicKey; operator: PublicKey; agent: PublicKey; inputMint: PublicKey; outputMint: PublicKey;
    inputTokenProgram?: PublicKey; outputTokenProgram?: PublicKey; amountIn: bigint; minOut: bigint; route: JupiterSwapIx;
    /** For session-key swaps: the traded token's whitelist entry and the Pyth feeds the program prices it with. */
    oracle?: { tokenMint: PublicKey; solFeed: Uint8Array | string; tokenFeed: Uint8Array | string; noPrices?: boolean };
  }): Promise<TransactionInstruction[]> {
    const vault = pdas.vault(p.agent);
    const inTp = p.inputTokenProgram ?? TOKEN_PROGRAM_ID;
    const outTp = p.outputTokenProgram ?? TOKEN_PROGRAM_ID;
    const vaultInput = vaultAta(vault, p.inputMint, inTp);
    const vaultOutput = vaultAta(vault, p.outputMint, outTp);
    const ix = await this.program.methods.swap(bn(p.amountIn), bn(p.minOut), p.route.data).accountsStrict({
      operator: p.operator, platform: pdas.platform(), agent: p.agent, vault, vaultInput, vaultOutput,
      allowed: p.oracle ? pdas.allowed(p.oracle.tokenMint) : null,
      solPrice: p.oracle && !p.oracle.noPrices ? feedAccount(p.oracle.solFeed) : null,
      tokenPrice: p.oracle && !p.oracle.noPrices ? feedAccount(p.oracle.tokenFeed) : null,
      jupiterProgram: JUPITER_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: PublicKey.default,
    }).remainingAccounts(p.route.accounts.map((a) => ({ pubkey: a.pubkey, isWritable: a.isWritable, isSigner: false }))).instruction();
    return [
      createAssociatedTokenAccountIdempotentInstruction(p.payer, vaultInput, vault, p.inputMint, inTp, ASSOCIATED_TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(p.payer, vaultOutput, vault, p.outputMint, outTp, ASSOCIATED_TOKEN_PROGRAM_ID),
      ix,
    ];
  }

  initPlatformIx(admin: PublicKey, oracle: OracleSettings) {
    return this.program.methods.initPlatform(oracleArgs(oracle)).accountsStrict({
      admin, platform: pdas.platform(), program: AGENTS_PROGRAM_ID, programData: pdas.programData(), systemProgram: PublicKey.default,
    }).instruction();
  }

  setOracleIx(admin: PublicKey, oracle: OracleSettings) {
    return this.program.methods.setOracle(oracleArgs(oracle)).accountsStrict({ admin, platform: pdas.platform() }).instruction();
  }

  allowMintIx(admin: PublicKey, mint: PublicKey, feed: string) {
    return this.program.methods.allowMint(Array.from(feedBytes(feed))).accountsStrict({ admin, platform: pdas.platform(), mint, allowed: pdas.allowed(mint), systemProgram: PublicKey.default }).instruction();
  }

  disallowMintIx(admin: PublicKey, mint: PublicKey) {
    return this.program.methods.disallowMint().accountsStrict({ admin, platform: pdas.platform(), allowed: pdas.allowed(mint) }).instruction();
  }

  setPausedIx(admin: PublicKey, paused: boolean) {
    return this.program.methods.setPaused(paused).accountsStrict({ admin, platform: pdas.platform() }).instruction();
  }

  /** Proposes `next` as admin; it takes over when it signs `acceptAdminIx`. */
  setAdminIx(admin: PublicKey, next: PublicKey) {
    return this.program.methods.setAdmin(next).accountsStrict({ admin, platform: pdas.platform() }).instruction();
  }

  acceptAdminIx(pendingAdmin: PublicKey) {
    return this.program.methods.acceptAdmin().accountsStrict({ pendingAdmin, platform: pdas.platform() }).instruction();
  }

  closeTokenAccountIx(operator: PublicKey, agent: PublicKey, account: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) {
    return this.program.methods.closeTokenAccount().accountsStrict({ operator, agent, vault: pdas.vault(agent), account, tokenProgram }).instruction();
  }
}

export interface OracleSettings {
  /** Oldest price a session-key swap may use, in seconds. */
  maxAge: number;
  /** How far below the oracle price a session-key swap may fill. */
  maxSlippageBps: number;
}

const oracleArgs = (o: OracleSettings) => ({ maxAge: o.maxAge, maxSlippageBps: o.maxSlippageBps });

export interface NewAgent {
  handle: string;
  modelId: string;
  profileHash: number[] | Uint8Array;
  sessionKey: PublicKey;
  maxTrade: bigint;
  dailyLimit: bigint;
  fund: bigint;
}

export function createAgentIx(program: AgentsProgram, owner: PublicKey, a: NewAgent) {
  const agent = pdas.agent(a.handle);
  return program.methods
    .createAgent(a.handle, a.modelId, Array.from(a.profileHash), a.sessionKey, bn(a.maxTrade), bn(a.dailyLimit), bn(a.fund))
    .accountsStrict({ owner, agent, vault: pdas.vault(agent), systemProgram: PublicKey.default })
    .instruction();
}

export function withdrawSolIx(program: AgentsProgram, owner: PublicKey, agent: PublicKey, to: PublicKey, amount: bigint) {
  return program.methods.withdrawSol(bn(amount)).accountsStrict({ owner, agent, vault: pdas.vault(agent), to, systemProgram: PublicKey.default }).instruction();
}

export function withdrawTokenIx(program: AgentsProgram, p: { owner: PublicKey; agent: PublicKey; mint: PublicKey; to: PublicKey; amount: bigint; tokenProgram?: PublicKey; hookAccounts?: AccountMeta[] }) {
  const vault = pdas.vault(p.agent);
  const tp = p.tokenProgram ?? TOKEN_PROGRAM_ID;
  return program.methods.withdrawToken(bn(p.amount))
    .accountsStrict({ owner: p.owner, agent: p.agent, vault, mint: p.mint, from: vaultAta(vault, p.mint, tp), to: p.to, tokenProgram: tp })
    .remainingAccounts(p.hookAccounts ?? [])
    .instruction();
}

export function setSessionIx(program: AgentsProgram, owner: PublicKey, agent: PublicKey, sessionKey: PublicKey, maxTrade: bigint, dailyLimit: bigint) {
  return program.methods.setSession(sessionKey, bn(maxTrade), bn(dailyLimit)).accountsStrict({ owner, agent }).instruction();
}
