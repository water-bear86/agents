import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { programError } from "./chain.js";
import { agentsCurve, buildCreateConfig } from "./dbc.js";
import { AGENTS_PROGRAM_ID, HOOK_PROGRAM_ID, bn, pdas, wsolAta, type AgentsProgram } from "./program.js";

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** The agents program's ProgramData account, which records its upgrade authority. */
export const programDataAddress = () => PublicKey.findProgramAddressSync([AGENTS_PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER)[0];

export async function sendIxs(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[]) {
  try {
    return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
  } catch (e) {
    throw new Error(programError(e));
  }
}

export interface PlatformOptions {
  /** SOL in the curve at which DBC graduates the coin to DAMM v2 (and removes the hook). */
  migrationThresholdSol: number;
  /** SOL in the pool at which a coin opens to everyone. Must be below the graduation threshold. */
  openThresholdLamports: bigint;
  openWindowSec: number;
  launchCooldownSec: number;
  inference: PublicKey;
  buyback: PublicKey;
  platformMint?: PublicKey;
  holdPerSlot?: bigint;
  /** Receives curve leftovers (none with our config); defaults to the admin. */
  leftoverReceiver?: PublicKey;
}

/**
 * One-time platform setup: the DBC partner config (Token-2022 coins with our transfer hook, fees
 * claimable by the agents program's `fees` PDA) and the agents program's Platform record.
 * `admin` must be the agents program's upgrade authority.
 */
export async function setupPlatform(conn: Connection, program: AgentsProgram, admin: Keypair, o: PlatformOptions) {
  if (o.openThresholdLamports >= BigInt(Math.floor(o.migrationThresholdSol * 1e9))) throw new Error("open threshold must be below the graduation threshold");
  const { tx, config } = await buildCreateConfig(conn, {
    payer: admin.publicKey, feeClaimer: pdas.fees(), leftoverReceiver: o.leftoverReceiver ?? admin.publicKey,
    params: agentsCurve({ migrationQuoteThresholdSol: o.migrationThresholdSol, token2022: true }), transferHookProgram: HOOK_PROGRAM_ID,
  });
  const configSig = await sendAndConfirmTransaction(conn, tx, [admin, config], { commitment: "confirmed" });
  const init = await program.methods.initPlatform({
    dbcConfig: config.publicKey, platformMint: o.platformMint ?? PublicKey.default, holdPerSlot: bn(o.holdPerSlot ?? 0n),
    inference: o.inference, buyback: o.buyback, openThreshold: bn(o.openThresholdLamports), openWindow: bn(o.openWindowSec), launchCooldown: bn(o.launchCooldownSec),
  }).accountsStrict({ admin: admin.publicKey, platform: pdas.platform(), program: AGENTS_PROGRAM_ID, programData: programDataAddress(), systemProgram: PublicKey.default }).instruction();
  const platformSig = await sendIxs(conn, [
    init,
    ...[o.inference, o.buyback].map((owner) => createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, wsolAta(owner), owner, NATIVE_MINT, TOKEN_PROGRAM_ID)),
  ], [admin]);
  return { config: config.publicKey, configSig, platformSig };
}

export interface NewAgent {
  handle: string;
  modelId: string;
  sessionKey: PublicKey;
  maxTradeLamports: bigint;
  dailyLimitLamports: bigint;
  fundLamports: bigint;
  profileHash?: number[];
  platformTokens?: PublicKey;
}

/** The owner's create_agent instruction (the web app builds the same one for Phantom to sign). */
export function createAgentIx(program: AgentsProgram, owner: PublicKey, a: NewAgent) {
  const agent = pdas.agent(a.handle);
  const vault = pdas.vault(agent);
  return program.methods.createAgent(a.handle, a.modelId, a.profileHash ?? new Array(32).fill(0), a.sessionKey, bn(a.maxTradeLamports), bn(a.dailyLimitLamports), bn(a.fundLamports))
    .accountsStrict({
      owner, platform: pdas.platform(), agent, vault, member: pdas.member(vault), slots: pdas.slots(owner),
      ownerPlatformTokens: a.platformTokens ?? null, systemProgram: PublicKey.default,
    }).instruction();
}
