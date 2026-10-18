import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type Connection, type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { Order } from "@agents/core";
import type { Chain } from "../chain.js";
import type { World } from "../world.js";
import { vaultRoute, type JupiterOptions } from "./jupiter.js";
import { parseEvents, pdas, vaultAta, wsolAta, type AgentsClient } from "./program.js";
import { SOL_USD_FEED } from "./pyth.js";

/** The slice of web3.js `Connection` the adapter uses, so tests can stand in a mock RPC. */
export type SolanaRpc = Pick<Connection,
  "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction" | "getTransaction" | "getAddressLookupTable" | "getAccountInfo" | "getMultipleAccountsInfo">;

/**
 * Real trading on Solana. `account` is the agent's record in the agents program (the PDA of its
 * handle); its SOL and tokens sit in the agent's vault PDA, which only the owner can withdraw
 * from. The runtime signs with its session key and the program enforces the rules: Jupiter
 * routes only, buys within the per-trade and daily caps and only into whitelisted tokens, sells
 * back to SOL only, a minimum output on every swap. A swap that would break a rule fails in
 * preflight, so a refused trade costs no fee.
 */
export class SolanaVaultChain implements Chain {
  readonly #tokenProgram = new Map<string, PublicKey>();
  /** The whitelist as the program holds it: mint -> Pyth feed id. */
  readonly feeds = new Map<string, Uint8Array>();

  constructor(
    private readonly rpc: SolanaRpc,
    private readonly client: AgentsClient,
    private readonly session: Keypair,
    private readonly jupiter: JupiterOptions = {},
  ) {}

  get sessionKey() { return this.session.publicKey; }

  async execute(account: string, order: Order) {
    if (order.minOut <= 0n) throw new Error("MinOutRequired"); // the program refuses it too; don't pay to find out
    const agent = new PublicKey(account);
    const vault = pdas.vault(agent);
    const token = new PublicKey(order.token);
    const buy = order.kind === "buy";
    const [inputMint, outputMint] = buy ? [NATIVE_MINT, token] : [token, NATIVE_MINT];
    const tokenProgram = await this.tokenProgramOf(token);
    const [inTp, outTp] = buy ? [TOKEN_PROGRAM_ID, tokenProgram] : [tokenProgram, TOKEN_PROGRAM_ID];
    const amountIn = buy ? order.ethIn : order.tokensIn;
    const r = await vaultRoute({ vault, inputMint, outputMint, amountIn, vaultInput: vaultAta(vault, inputMint, inTp), vaultOutput: vaultAta(vault, outputMint, outTp) }, this.jupiter);
    // The agent's own floor, or the route's, whichever is stricter.
    const minOut = r.minOut > order.minOut ? r.minOut : order.minOut;
    if (!this.feeds.has(order.token)) await this.refreshWhitelist();
    const tokenFeed = this.feeds.get(order.token);
    if (!tokenFeed) throw new Error("NotWhitelisted");
    const ixs = await this.client.swapIxs({
      payer: this.session.publicKey, operator: this.session.publicKey, agent, inputMint, outputMint, inputTokenProgram: inTp, outputTokenProgram: outTp,
      amountIn, minOut, route: r.swap, oracle: { tokenMint: token, solFeed: SOL_USD_FEED, tokenFeed },
    });
    const { sig, events } = await this.send(ixs, r.lookupTables);
    const swapped = events.find((e) => e.name.toLowerCase() === "swapped");
    if (!swapped) throw new Error(`no Swapped event in ${sig}`);
    return { txHash: sig, out: BigInt(String(swapped.data.amount_out ?? swapped.data.amountOut)) };
  }

  /** SPL Token or Token-2022, read once per mint. */
  async tokenProgramOf(mint: PublicKey) {
    const k = mint.toBase58();
    let tp = this.#tokenProgram.get(k);
    if (!tp) {
      const owner = (await this.rpc.getAccountInfo(mint))?.owner;
      if (!owner || !(owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID))) throw new Error(`${k} is not a token mint`);
      this.#tokenProgram.set(k, (tp = owner));
    }
    return tp;
  }

  /** Signs with the session key (fee payer), sends a v0 transaction with Jupiter's lookup tables, confirms, and returns the program's events. */
  async send(ixs: TransactionInstruction[], tables: PublicKey[] = []) {
    const alts: AddressLookupTableAccount[] = [];
    for (const t of tables) {
      const a = (await this.rpc.getAddressLookupTable(t)).value;
      if (a) alts.push(a);
    }
    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: this.session.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs],
    }).compileToV0Message(alts);
    const tx = new VersionedTransaction(msg);
    tx.sign([this.session]);
    let sig: string;
    try {
      sig = await this.rpc.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    } catch (e) {
      throw new Error(programError(e));
    }
    const res = await this.rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
    const got = await this.rpc.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return { sig, events: parseEvents(got?.meta?.logMessages ?? []) };
  }

  /**
   * Brings the world in line with the vaults: each agent's spendable SOL (its SOL plus wrapped
   * SOL) and the size of each position, since owners can deposit and withdraw at any time.
   */
  async syncBalances(world: World) {
    const agents = [...world.agents.keys()];
    if (!agents.length) return;
    const keys = agents.flatMap((a) => { const v = pdas.vault(new PublicKey(a)); return [v, wsolAta(v)]; });
    const infos = await this.rpc.getMultipleAccountsInfo(keys);
    agents.forEach((a, i) => world.balances.set(a, BigInt(infos[2 * i]?.lamports ?? 0) + tokenAmount(infos[2 * i + 1]?.data)));
    for (const a of agents) {
      const positions = world.positions.get(a);
      if (!positions?.length) continue;
      const vault = pdas.vault(new PublicKey(a));
      const atas = await Promise.all(positions.map(async (p) => vaultAta(vault, new PublicKey(p.token), await this.tokenProgramOf(new PublicKey(p.token)))));
      const held = await this.rpc.getMultipleAccountsInfo(atas);
      positions.forEach((p, i) => { p.amount = tokenAmount(held[i]?.data); });
      world.positions.set(a, positions.filter((p) => p.amount > 0n));
    }
  }

  /** Reads the whitelist from the program; returns the whitelisted mints. */
  async refreshWhitelist() {
    const allowed = await this.client.program.account.allowedMint.all();
    this.feeds.clear();
    for (const { account } of allowed) this.feeds.set(account.mint.toBase58(), Uint8Array.from(account.feed));
    return [...this.feeds.keys()];
  }
}

/** A token account's balance, or 0 if it doesn't exist. */
export function tokenAmount(data?: Buffer | Uint8Array | null) {
  return data && data.length >= 72 ? Buffer.from(data).readBigUInt64LE(64) : 0n;
}

/** The program's own error name from a failed preflight ("OverTradeCap", "NotWhitelisted", ...), or the raw message. */
export function programError(e: unknown): string {
  const logs: string[] = (e as { logs?: string[]; transactionLogs?: string[] })?.logs ?? (e as { transactionLogs?: string[] })?.transactionLogs ?? [];
  const msg = e instanceof Error ? e.message : String(e);
  const all = [...logs, msg].join("\n");
  const code = /Error Code: (\w+)/.exec(all)?.[1];
  return code ?? msg;
}

/** Solana mainnet-beta's genesis hash: what a cluster reports when it's mainnet, whatever its URL says. */
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** True for RPC URLs we must never point a test key at. */
export const isMainnet = (url: string) => /mainnet/i.test(url) && !/devnet|testnet/i.test(url);
