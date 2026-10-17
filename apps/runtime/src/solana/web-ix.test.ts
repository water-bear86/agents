import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { createAgentIx as webCreateAgentIx, lamports, withdrawSolIx as webWithdrawSolIx } from "../../../web/lib/solana.js";
import { AGENTS_PROGRAM_ID, agentsProgram, bn, pdas } from "./program.js";
import { createAgentIx } from "./setup.js";

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
    same(webCreateAgentIx(AGENTS_PROGRAM_ID, owner, args), await createAgentIx(program, owner, args));
  });

  it("withdraw_sol", async () => {
    const agent = pdas.agent("atlas7");
    const anchorIx = await program.methods.withdrawSol(bn(12_345n))
      .accountsStrict({ owner, agent, vault: pdas.vault(agent), to: owner, systemProgram: PublicKey.default }).instruction();
    same(webWithdrawSolIx(AGENTS_PROGRAM_ID, owner, "atlas7", 12_345n), anchorIx);
  });

  it("parses SOL amounts to lamports without floating point", () => {
    expect(lamports("0.05")).toBe(50_000_000n);
    expect(lamports("1")).toBe(1_000_000_000n);
    expect(lamports("0.123456789999")).toBe(123_456_789n);
  });
});

