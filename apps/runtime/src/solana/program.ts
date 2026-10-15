import { AnchorProvider, BorshCoder, EventParser, Program, type Wallet } from "@coral-xyz/anchor";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID, deriveDbcEventAuthority, deriveDbcPoolAddress, deriveDbcPoolAuthority, deriveDbcTokenVaultAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, type AccountMeta, type Connection, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import agentsIdl from "./idl/agents.json" with { type: "json" };
import type { Agents } from "./idl/agents-types.js";

/** Program ids (localnet and devnet use the same keys; see solana/Anchor.toml). */
export const AGENTS_PROGRAM_ID = new PublicKey(agentsIdl.address);
export const HOOK_PROGRAM_ID = new PublicKey("8ERRnkHC3UfwzoD6cxfVAcFkGhdeUMTG9pAvwZyY4dB9");
export const DBC_PROGRAM_ID = DYNAMIC_BONDING_CURVE_PROGRAM_ID;

const seed = (s: string) => Buffer.from(s);
const pda = (seeds: Buffer[], program = AGENTS_PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];

/** Every address the agents program uses, derived the same way the program does. */
export const pdas = {
  platform: () => pda([seed("platform")]),
  agent: (handle: string) => pda([seed("agent"), Buffer.from(handle)]),
  vault: (agent: PublicKey) => pda([seed("vault"), agent.toBuffer()]),
  member: (owner: PublicKey) => pda([seed("member"), owner.toBuffer()]),
  slots: (owner: PublicKey) => pda([seed("slots"), owner.toBuffer()]),
  coin: (mint: PublicKey) => pda([seed("coin"), mint.toBuffer()]),
  hookAuthority: () => pda([seed("hook-auth")]),
  fees: () => pda([seed("fees")]),
  extraMetas: (mint: PublicKey) => pda([seed("extra-account-metas"), mint.toBuffer()], HOOK_PROGRAM_ID),
};

export const dbc = {
  poolAuthority: deriveDbcPoolAuthority(),
  eventAuthority: deriveDbcEventAuthority(),
  pool: (config: PublicKey, mint: PublicKey) => deriveDbcPoolAddress(NATIVE_MINT, mint, config),
  baseVault: (mint: PublicKey, pool: PublicKey) => deriveDbcTokenVaultAddress(pool, mint),
  quoteVault: (pool: PublicKey) => deriveDbcTokenVaultAddress(pool, NATIVE_MINT),
};

export const coinAta = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
export const wsolAta = (owner: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID);

/**
 * Accounts Token-2022 needs to run our transfer hook for a transfer of `mint` into a token
 * account owned by `destinationOwner`: the extra accounts in the hook's order, then the hook
 * program and its validation account. (Meteora's SDK resolves these with placeholder accounts,
 * which doesn't work for a hook that looks at the receiver, so we build them here.)
 */
export function hookAccounts(mint: PublicKey, destinationOwner: PublicKey): AccountMeta[] {
  return [AGENTS_PROGRAM_ID, pdas.coin(mint), pdas.member(destinationOwner), HOOK_PROGRAM_ID, pdas.extraMetas(mint)]
    .map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
}

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

/** Builders for each instruction, with every account spelled out (no network lookups). */
export class AgentsClient {
  constructor(readonly program: AgentsProgram, readonly dbcConfig: PublicKey) {}

  async tradeIxs(p: { side: "buy" | "sell"; operator: PublicKey; agent: PublicKey; mint: PublicKey; amountIn: bigint; minOut: bigint }): Promise<TransactionInstruction[]> {
    const vault = pdas.vault(p.agent);
    const pool = dbc.pool(this.dbcConfig, p.mint);
    const accounts = {
      operator: p.operator, platform: pdas.platform(), agent: p.agent, vault, coin: pdas.coin(p.mint), dbcConfig: this.dbcConfig, pool,
      baseVault: dbc.baseVault(p.mint, pool), quoteVault: dbc.quoteVault(pool), baseMint: p.mint, quoteMint: NATIVE_MINT,
      vaultBase: coinAta(vault, p.mint), vaultQuote: wsolAta(vault), poolAuthority: dbc.poolAuthority,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID, dbcEventAuthority: dbc.eventAuthority,
      dbcProgram: DBC_PROGRAM_ID, systemProgram: PublicKey.default,
    };
    // Coins land in the vault on a buy, in DBC's base vault (owned by the pool authority) on a sell.
    const remaining = hookAccounts(p.mint, p.side === "buy" ? vault : dbc.poolAuthority);
    const method = p.side === "buy" ? this.program.methods.buy(bn(p.amountIn), bn(p.minOut)) : this.program.methods.sell(bn(p.amountIn), bn(p.minOut));
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(p.operator, wsolAta(vault), vault, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(p.operator, coinAta(vault, p.mint), vault, p.mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      await method.accountsStrict(accounts).remainingAccounts(remaining).instruction(),
    ];
  }

  async launchIxs(p: { operator: PublicKey; agent: PublicKey; mint: PublicKey; name: string; symbol: string; uri: string }) {
    const vault = pdas.vault(p.agent);
    const pool = dbc.pool(this.dbcConfig, p.mint);
    const ix = await this.program.methods.launch(p.name, p.symbol, p.uri).accountsStrict({
      operator: p.operator, platform: pdas.platform(), agent: p.agent, vault, baseMint: p.mint, coin: pdas.coin(p.mint), dbcConfig: this.dbcConfig,
      pool, baseVault: dbc.baseVault(p.mint, pool), quoteVault: dbc.quoteVault(pool), quoteMint: NATIVE_MINT, poolAuthority: dbc.poolAuthority,
      tokenQuoteProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_2022_PROGRAM_ID, hookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: pdas.extraMetas(p.mint),
      hookAuthority: pdas.hookAuthority(), dbcEventAuthority: dbc.eventAuthority, dbcProgram: DBC_PROGRAM_ID, systemProgram: PublicKey.default,
    }).instruction();
    return [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix];
  }

  async openIx(mint: PublicKey) {
    return this.program.methods.openCoin().accountsStrict({ platform: pdas.platform(), coin: pdas.coin(mint), pool: dbc.pool(this.dbcConfig, mint) }).instruction();
  }

  async claimCreatorFeesIxs(payer: PublicKey, agent: PublicKey, mint: PublicKey) {
    const vault = pdas.vault(agent);
    const pool = dbc.pool(this.dbcConfig, mint);
    return [
      createAssociatedTokenAccountIdempotentInstruction(payer, wsolAta(vault), vault, NATIVE_MINT, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(payer, coinAta(vault, mint), vault, mint, TOKEN_2022_PROGRAM_ID),
      await this.program.methods.claimCreatorFees().accountsStrict({
        agent, vault, coin: pdas.coin(mint), pool, vaultBase: coinAta(vault, mint), vaultQuote: wsolAta(vault), baseVault: dbc.baseVault(mint, pool),
        quoteVault: dbc.quoteVault(pool), baseMint: mint, quoteMint: NATIVE_MINT, poolAuthority: dbc.poolAuthority, tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID, dbcEventAuthority: dbc.eventAuthority, dbcProgram: DBC_PROGRAM_ID,
      }).instruction(),
    ];
  }

  async distributeFeesIxs(payer: PublicKey, mint: PublicKey, inference: PublicKey, buyback: PublicKey) {
    const fees = pdas.fees();
    const pool = dbc.pool(this.dbcConfig, mint);
    return [
      createAssociatedTokenAccountIdempotentInstruction(payer, wsolAta(fees), fees, NATIVE_MINT, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(payer, coinAta(fees, mint), fees, mint, TOKEN_2022_PROGRAM_ID),
      await this.program.methods.distributeFees().accountsStrict({
        platform: pdas.platform(), fees, coin: pdas.coin(mint), dbcConfig: this.dbcConfig, pool, feesBase: coinAta(fees, mint), feesQuote: wsolAta(fees),
        inferenceQuote: wsolAta(inference), buybackQuote: wsolAta(buyback), baseVault: dbc.baseVault(mint, pool), quoteVault: dbc.quoteVault(pool),
        baseMint: mint, quoteMint: NATIVE_MINT, poolAuthority: dbc.poolAuthority, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
        dbcEventAuthority: dbc.eventAuthority, dbcProgram: DBC_PROGRAM_ID,
      }).instruction(),
    ];
  }
}
