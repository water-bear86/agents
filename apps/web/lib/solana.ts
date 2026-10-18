// Browser side of the Solana wallet flows: the owner's Phantom (or any wallet exposing
// `window.solana`) signs agent creation and withdrawals, and the platform admin's wallet signs the
// admin actions. Instructions are encoded by hand to keep Anchor out of the bundle; a runtime test
// checks them byte for byte against Anchor's own encoding (apps/runtime/src/solana/web-ix.test.ts).

import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

const CREATE_AGENT = [143, 66, 198, 95, 110, 85, 83, 249];
const WITHDRAW_SOL = [145, 131, 74, 136, 65, 137, 42, 38];
const WITHDRAW_TOKEN = [136, 235, 181, 5, 101, 109, 57, 81];
const CLOSE_TOKEN_ACCOUNT = [132, 172, 24, 60, 100, 156, 135, 97];
const ACCEPT_ADMIN = [112, 42, 45, 90, 116, 181, 13, 170];
const SET_PAUSED = [91, 60, 125, 192, 176, 225, 166, 218];
const ALLOW_MINT = [240, 28, 240, 70, 124, 240, 245, 225];
const DISALLOW_MINT = [75, 176, 193, 187, 34, 158, 118, 121];
const PLATFORM_ACCOUNT = [77, 92, 204, 58, 187, 98, 91, 12];
const ALLOWED_MINT_ACCOUNT = [173, 229, 179, 46, 121, 164, 247, 6];

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

const seed = (s: string) => new TextEncoder().encode(s);
const pda = (program: PublicKey, ...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const solanaPdas = (program: PublicKey) => ({
  platform: () => pda(program, seed("platform")),
  agent: (handle: string) => pda(program, seed("agent"), seed(handle)),
  vault: (agent: PublicKey) => pda(program, seed("vault"), agent.toBytes()),
  allowed: (mint: PublicKey) => pda(program, seed("mint"), mint.toBytes()),
});

/** The associated token account of `owner` for `mint`. */
export const ata = (owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM) => pda(ATA_PROGRAM, owner.toBytes(), tokenProgram.toBytes(), mint.toBytes());

const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

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
      { pubkey: agent, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
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

/** Creates `owner`'s token account for `mint` if it doesn't exist yet (the associated token program's CreateIdempotent). */
export function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]),
    keys: [meta(payer, true, true), meta(ata(owner, mint, tokenProgram), false, true), meta(owner), meta(mint), meta(SystemProgram.programId), meta(tokenProgram)],
  });
}

/** `withdraw_token`: owner only, from the vault's token account to the owner's. */
export function withdrawTokenIx(program: PublicKey, owner: PublicKey, handle: string, mint: PublicKey, amount: bigint, tokenProgram = TOKEN_PROGRAM) {
  const p = solanaPdas(program);
  const agent = p.agent(handle);
  const vault = p.vault(agent);
  return new TransactionInstruction({
    programId: program,
    data: Buffer.from(new Borsh().bytes(WITHDRAW_TOKEN).u64(amount).done()),
    keys: [meta(owner, true), meta(agent), meta(vault), meta(mint), meta(ata(vault, mint, tokenProgram), false, true), meta(ata(owner, mint, tokenProgram), false, true), meta(tokenProgram)],
  });
}

/** `close_token_account`: closes a vault token account into the vault (wrapped SOL comes back as SOL). */
export function closeVaultTokenAccountIx(program: PublicKey, operator: PublicKey, handle: string, mint: PublicKey, tokenProgram = TOKEN_PROGRAM) {
  const p = solanaPdas(program);
  const agent = p.agent(handle);
  const vault = p.vault(agent);
  return new TransactionInstruction({
    programId: program,
    data: Buffer.from(CLOSE_TOKEN_ACCOUNT),
    keys: [meta(operator, true), meta(agent), meta(vault, false, true), meta(ata(vault, mint, tokenProgram), false, true), meta(tokenProgram)],
  });
}

export function acceptAdminIx(program: PublicKey, pendingAdmin: PublicKey) {
  return new TransactionInstruction({ programId: program, data: Buffer.from(ACCEPT_ADMIN), keys: [meta(pendingAdmin, true), meta(solanaPdas(program).platform(), false, true)] });
}

export function setPausedIx(program: PublicKey, admin: PublicKey, paused: boolean) {
  return new TransactionInstruction({ programId: program, data: Buffer.from([...SET_PAUSED, paused ? 1 : 0]), keys: [meta(admin, true), meta(solanaPdas(program).platform(), false, true)] });
}

export function allowMintIx(program: PublicKey, admin: PublicKey, mint: PublicKey, feed: Uint8Array) {
  if (feed.length !== 32) throw new Error("A Pyth feed id is 32 bytes");
  const p = solanaPdas(program);
  return new TransactionInstruction({
    programId: program,
    data: Buffer.from(new Borsh().bytes(ALLOW_MINT).bytes(feed).done()),
    keys: [meta(admin, true, true), meta(p.platform()), meta(mint), meta(p.allowed(mint), false, true), meta(SystemProgram.programId)],
  });
}

export function disallowMintIx(program: PublicKey, admin: PublicKey, mint: PublicKey) {
  const p = solanaPdas(program);
  return new TransactionInstruction({ programId: program, data: Buffer.from(DISALLOW_MINT), keys: [meta(admin, true, true), meta(p.platform()), meta(p.allowed(mint), false, true)] });
}

export interface PlatformState { admin: PublicKey; pendingAdmin: PublicKey; paused: boolean; maxAge: number; maxSlippageBps: number }

/**
 * The agents program this site was built for. The runtime's API says which program to use, but a
 * compromised API could name another, so wallet flows refuse anything else.
 */
export const AGENTS_PROGRAM_ID = process.env.NEXT_PUBLIC_SOLANA_PROGRAM_ID ?? "4X6PzjKKyC3yVA8MBBNCg7aihCRhqR193FEXRuLTZd5r";

export function trustedProgram(fromApi: string) {
  if (fromApi !== AGENTS_PROGRAM_ID) throw new Error(`The runtime names program ${fromApi}, but this site only signs for ${AGENTS_PROGRAM_ID}. Not signing.`);
  return new PublicKey(fromApi);
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

/** The platform record: admin, proposed admin, pause switch and oracle settings. */
export async function readPlatform(conn: Connection, program: PublicKey): Promise<PlatformState | null> {
  const info = await conn.getAccountInfo(solanaPdas(program).platform());
  if (!info || !info.owner.equals(program) || !same(info.data.subarray(0, 8), PLATFORM_ACCOUNT)) return null;
  const d = info.data;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  // discriminator, admin, pending_admin, paused, oracle { max_age u32, max_slippage_bps u16 }, bump, reserved
  return { admin: new PublicKey(d.subarray(8, 40)), pendingAdmin: new PublicKey(d.subarray(40, 72)), paused: d[72] === 1, maxAge: v.getUint32(73, true), maxSlippageBps: v.getUint16(77, true) };
}

/** Every whitelisted token: its mint and Pyth feed id. */
export async function readWhitelist(conn: Connection, program: PublicKey): Promise<{ mint: PublicKey; feed: string }[]> {
  const list = await conn.getProgramAccounts(program, { filters: [{ memcmp: { offset: 0, bytes: bs58(ALLOWED_MINT_ACCOUNT) } }] });
  return list.filter(({ account }) => account.data.length >= 72).map(({ account }) => ({
    mint: new PublicKey(account.data.subarray(8, 40)),
    feed: Array.from(account.data.subarray(40, 72)).map((b) => b.toString(16).padStart(2, "0")).join(""),
  }));
}

function bs58(bytes: number[]) {
  // Base58 for an 8-byte memcmp filter (the RPC wants base58 by default).
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = bytes.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
  let out = "";
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}

export const feedBytes = (hex: string) => {
  const h = hex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("A Pyth feed id is 64 hex characters");
  return Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
};

interface InjectedWallet {
  publicKey?: PublicKey | null;
  connect(): Promise<{ publicKey: PublicKey }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signMessage?(message: Uint8Array, display?: "utf8"): Promise<{ signature: Uint8Array }>;
}

/**
 * What an owner signs to have the runtime drive their agent: the handle, the style and a hash of
 * the persona. The runtime checks the signature against the agent's on-chain owner, so nobody
 * else can pick how someone's agent behaves. (The runtime builds the same text: enrollmentMessage
 * in apps/runtime/src/enroll.ts.)
 */
export function enrollmentMessage(handle: string, style: string, personaSha256: string) {
  return `Run my agent @${handle} on this town's runtime.\nStyle: ${style}\nPersona sha256: ${personaSha256}`;
}

export async function sha256Hex(text: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Has the connected wallet sign `message`; returns the signature base64-encoded. */
export async function signText(message: string) {
  const wallet = solanaWallet();
  await wallet.connect();
  if (!wallet.signMessage) throw new Error("This wallet can't sign messages. Use Phantom or another wallet that can.");
  const { signature } = await wallet.signMessage(new TextEncoder().encode(message), "utf8");
  return btoa(String.fromCharCode(...signature));
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
