import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  acceptAdminIx as webAcceptAdminIx, allowMintIx as webAllowMintIx, closeVaultTokenAccountIx, createAgentIx as webCreateAgentIx, createAtaIx, disallowMintIx as webDisallowMintIx,
  feedBytes as webFeedBytes, lamports, setPausedIx as webSetPausedIx, withdrawSolIx as webWithdrawSolIx, withdrawTokenIx as webWithdrawTokenIx,
} from "../../../web/lib/solana.js";
import { AGENTS_PROGRAM_ID, AgentsClient, agentsProgram, bn, createAgentIx, pdas, vaultAta, withdrawTokenIx } from "./program.js";

const program = agentsProgram({} as Connection);
const same = (a: TransactionInstruction, b: TransactionInstruction) => {
  expect(Buffer.from(a.data).toString("hex")).toBe(Buffer.from(b.data).toString("hex"));
  expect(a.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(b.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
  expect(a.programId.equals(b.programId)).toBe(true);
};

describe("the web app's hand-encoded instructions match Anchor's", () => {
  const owner = Keypair.generate().publicKey;
  const sessionKey = Keypair.generate().publicKey;

  it("create_agent", async () => {
    const args = { handle: "atlas7", modelId: "deepseek/deepseek-v4.1-flash", sessionKey, maxTradeLamports: 100_000_000n, dailyLimitLamports: 500_000_000n, fundLamports: 250_000_000n };
    same(webCreateAgentIx(AGENTS_PROGRAM_ID, owner, args), await createAgentIx(program, owner, {
      handle: args.handle, modelId: args.modelId, profileHash: new Uint8Array(32), sessionKey, maxTrade: args.maxTradeLamports, dailyLimit: args.dailyLimitLamports, fund: args.fundLamports,
    }));
  });

  it("withdraw_sol", async () => {
    const agent = pdas.agent("atlas7");
    const anchorIx = await program.methods.withdrawSol(bn(12_345n))
      .accountsStrict({ owner, agent, vault: pdas.vault(agent), to: owner, systemProgram: PublicKey.default }).instruction();
    same(webWithdrawSolIx(AGENTS_PROGRAM_ID, owner, "atlas7", 12_345n), anchorIx);
  });

  const client = new AgentsClient(program);
  const mint = Keypair.generate().publicKey;
  const feed = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

  it("withdraw_token, to the owner's own token account", async () => {
    const agent = pdas.agent("atlas7");
    const anchorIx = await withdrawTokenIx(program, { owner, agent, mint, to: vaultAta(owner, mint), amount: 777n });
    same(webWithdrawTokenIx(AGENTS_PROGRAM_ID, owner, "atlas7", mint, 777n), anchorIx);
    same(createAtaIx(owner, owner, mint), createAssociatedTokenAccountIdempotentInstruction(owner, vaultAta(owner, mint), owner, mint, TOKEN_PROGRAM_ID));
  });

  it("close_token_account, which turns wrapped SOL back into SOL", async () => {
    const agent = pdas.agent("atlas7");
    same(closeVaultTokenAccountIx(AGENTS_PROGRAM_ID, owner, "atlas7", NATIVE_MINT), await client.closeTokenAccountIx(owner, agent, vaultAta(pdas.vault(agent), NATIVE_MINT)));
  });

  it("the admin's instructions", async () => {
    same(webAcceptAdminIx(AGENTS_PROGRAM_ID, owner), await client.acceptAdminIx(owner));
    same(webSetPausedIx(AGENTS_PROGRAM_ID, owner, true), await client.setPausedIx(owner, true));
    same(webSetPausedIx(AGENTS_PROGRAM_ID, owner, false), await client.setPausedIx(owner, false));
    same(webAllowMintIx(AGENTS_PROGRAM_ID, owner, mint, webFeedBytes(feed)), await client.allowMintIx(owner, mint, feed));
    same(webDisallowMintIx(AGENTS_PROGRAM_ID, owner, mint), await client.disallowMintIx(owner, mint));
  });

  it("parses SOL amounts to lamports without floating point", () => {
    expect(lamports("0.05")).toBe(50_000_000n);
    expect(lamports("1")).toBe(1_000_000_000n);
    expect(lamports("0.123456789999")).toBe(123_456_789n);
  });
});

