// Browser side of the Solana wallet flows: the owner's Phantom (or any wallet exposing
// `window.solana`) signs `create_agent` and `withdraw_sol` on the agents program. The two
// instructions are encoded by hand to keep Anchor out of the bundle; a runtime test checks them
// byte for byte against Anchor's own encoding (apps/runtime/src/solana/web-ix.test.ts).

import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

const CREATE_AGENT = [143, 66, 198, 95, 110, 85, 83, 249];
const WITHDRAW_SOL = [145, 131, 74, 136, 65, 137, 42, 38];

const seed = (s: string) => new TextEncoder().encode(s);
const pda = (program: PublicKey, ...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const solanaPdas = (program: PublicKey) => ({
  platform: () => pda(program, seed("platform")),
  agent: (handle: string) => pda(program, seed("agent"), seed(handle)),
  vault: (agent: PublicKey) => pda(program, seed("vault"), agent.toBytes()),
  member: (vault: PublicKey) => pda(program, seed("member"), vault.toBytes()),
  slots: (owner: PublicKey) => pda(program, seed("slots"), owner.toBytes()),
});

/** Little borsh writer: just the types these two instructions use. */
class Borsh {
  parts: Uint8Array[] = [];
  bytes(b: ArrayLike<number>) { this.parts.push(Uint8Array.from(b)); return this; }
  u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return this.bytes(b); }
  u64(n: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return this.bytes(b); }
  string(s: string) { const b = new TextEncoder().encode(s); return this.u32(b.length).bytes(b); }
  done() { const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

export interface CreateAgentArgs {
  handle: string;
  modelId: string;
  sessionKey: PublicKey;
  maxTradeLamports: bigint;
  dailyLimitLamports: bigint;
  fundLamports: bigint;
  profileHash?: Uint8Array;
}

/** `create_agent`: the owner pays rent, funds the vault, and names the runtime's session key. */
export function createAgentIx(program: PublicKey, owner: PublicKey, a: CreateAgentArgs) {
  const p = solanaPdas(program);
  const agent = p.agent(a.handle);
  const vault = p.vault(agent);
  const data = new Borsh().bytes(CREATE_AGENT).string(a.handle).string(a.modelId).bytes(a.profileHash ?? new Uint8Array(32))
    .bytes(a.sessionKey.toBytes()).u64(a.maxTradeLamports).u64(a.dailyLimitLamports).u64(a.fundLamports).done();
  return new TransactionInstruction({
    programId: program,
    data: Buffer.from(data),
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: p.platform(), isSigner: false, isWritable: false },
      { pubkey: agent, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: p.member(vault), isSigner: false, isWritable: true },
      { pubkey: p.slots(owner), isSigner: false, isWritable: true },
      { pubkey: program, isSigner: false, isWritable: false }, // no platform-token account (slot gating off)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

/** `withdraw_sol`: owner only, from the agent's vault to the owner's wallet. */
export function withdrawSolIx(program: PublicKey, owner: PublicKey, handle: string, lamports: bigint) {
  const p = solanaPdas(program);
  const agent = p.agent(handle);
  return new TransactionInstruction({
    programId: program,
    data: Buffer.from(new Borsh().bytes(WITHDRAW_SOL).u64(lamports).done()),
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: agent, isSigner: false, isWritable: false },
      { pubkey: p.vault(agent), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

interface InjectedWallet {
  publicKey?: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export function solanaWallet(): InjectedWallet {
  const w = globalThis as unknown as { phantom?: { solana?: InjectedWallet }; solana?: InjectedWallet };
  const wallet = w.phantom?.solana ?? w.solana;
  if (!wallet) throw new Error("No Solana wallet found. Install Phantom (or another Solana wallet) to continue.");
  return wallet;
}

/** Connects the wallet, has it sign the instructions `build` makes for it, sends and confirms. */
export async function signAndSend(rpcUrl: string, build: (owner: PublicKey) => TransactionInstruction[]) {
  const wallet = solanaWallet();
  const { publicKey } = await wallet.connect();
  const ixs = build(publicKey);
  const conn = new Connection(rpcUrl, "confirmed");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const signed = await wallet.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize());
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
  return { owner: publicKey, sig };
}

export const lamports = (sol: string) => {
  const [w = "0", f = ""] = sol.trim().split(".");
  return BigInt(w || "0") * 1_000_000_000n + BigInt((f + "000000000").slice(0, 9));
};
