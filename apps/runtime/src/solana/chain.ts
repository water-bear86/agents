import { PublicKey, type Connection, type Keypair, type Transaction } from "@solana/web3.js";
import type { Order } from "@agents/core";
import type { Chain } from "../chain.js";
import type { SolanaVenue } from "./venue.js";

/** The slice of web3.js `Connection` the adapter uses, so tests can stand in a mock RPC. */
export type SolanaRpc = Pick<Connection, "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction" | "getTransaction">;

/** Per-agent spend limits, mirroring AgentAccount.maxTradeWei / dailyLimitWei (in lamports). */
export interface SpendLimits { maxTradeLamports: bigint; dailyLimitLamports: bigint }

const DAY_MS = 24 * 60 * 60_000;

/**
 * Chain adapter for Solana. Each agent account is a key the runtime signs with.
 *
 * Fast path, before the agent-vault program exists: the account is a plain wallet the
 * runtime holds, so the AgentAccount rules (minOut, per-trade and daily caps, launch
 * cooldown) are enforced here, off-chain. Once the vault program is deployed, `account`
 * becomes the vault PDA, the signer becomes the session key, and the same rules are
 * enforced by the program; this class keeps checking them so refused trades never cost fees.
 */
export class SolanaAgentChain implements Chain {
  readonly #spent = new Map<string, { dayStart: number; spent: bigint }>();

  constructor(
    private readonly rpc: SolanaRpc,
    private readonly venue: SolanaVenue,
    private readonly signers: Map<string, Keypair>,
    private readonly opts: { limits?: SpendLimits; coinUri?: (symbol: string) => string; now?: () => number } = {},
  ) {}

  #signer(account: string) {
    const kp = this.signers.get(account);
    if (!kp) throw new Error(`no signer for agent account ${account}`);
    return kp;
  }

  async execute(account: string, order: Order) {
    if (order.minOut <= 0n) throw new Error("MinOutRequired"); // AgentAccount._swap refuses minOut = 0
    const kp = this.#signer(account);
    const amountIn = order.kind === "buy" ? order.ethIn : order.tokensIn;
    if (amountIn <= 0n) throw new Error("amount must be positive");
    if (order.kind === "buy") this.#checkCaps(account, amountIn);

    const tx = await this.venue.buildSwap({ owner: kp.publicKey, mint: order.token, side: order.kind, amountIn, minOut: order.minOut });
    const sig = await this.#send(tx, kp, []);
    const out = await this.#filled(sig, kp.publicKey, order.kind, order.token);
    if (out < order.minOut) throw new Error(`Slippage(${out}, ${order.minOut})`); // the program already refused this; belt and braces
    if (order.kind === "buy") this.#recordSpend(account, amountIn);
    return { txHash: sig, out };
  }

  async launch(account: string, name: string, symbol: string) {
    const kp = this.#signer(account);
    const { tx, signers, mint } = await this.venue.buildLaunch({ creator: kp.publicKey, name, symbol, uri: this.opts.coinUri?.(symbol) ?? "" });
    const sig = await this.#send(tx, kp, signers);
    return { txHash: sig, token: mint };
  }

  #checkCaps(account: string, lamports: bigint) {
    const l = this.opts.limits;
    if (!l) return;
    if (lamports > l.maxTradeLamports) throw new Error("OverTradeCap");
    const now = (this.opts.now ?? Date.now)();
    const s = this.#spent.get(account);
    const spent = s && now < s.dayStart + DAY_MS ? s.spent : 0n;
    if (spent + lamports > l.dailyLimitLamports) throw new Error("OverDailyCap");
  }

  #recordSpend(account: string, lamports: bigint) {
    if (!this.opts.limits) return;
    const now = (this.opts.now ?? Date.now)();
    const s = this.#spent.get(account);
    if (!s || now >= s.dayStart + DAY_MS) this.#spent.set(account, { dayStart: now, spent: lamports });
    else s.spent += lamports;
  }

  async #send(tx: Transaction, payer: Keypair, extra: Keypair[]) {
    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer, ...extra);
    const sig = await this.rpc.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    const res = await this.rpc.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  /**
   * What the swap actually delivered, read from the confirmed transaction: the change in the
   * owner's coin balance for a buy, the change in its SOL balance (plus the fee it paid) for a sell.
   * A sell's temporary wrapped-SOL account is opened and closed in the same transaction, so its rent nets out.
   */
  async #filled(sig: string, owner: PublicKey, side: "buy" | "sell", mint: string): Promise<bigint> {
    const tx = await this.rpc.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const meta = tx?.meta;
    if (!tx || !meta) throw new Error(`transaction ${sig} not found after confirmation`);
    const me = owner.toBase58();
    if (side === "buy") {
      const bal = (list: typeof meta.postTokenBalances) => BigInt(list?.find((b) => b.mint === mint && b.owner === me)?.uiTokenAmount.amount ?? "0");
      return bal(meta.postTokenBalances) - bal(meta.preTokenBalances);
    }
    const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
    const i = keys.findIndex((k) => k.equals(owner));
    if (i < 0) throw new Error("owner not in transaction");
    return BigInt(meta.postBalances[i]! - meta.preBalances[i]! + (i === 0 ? meta.fee : 0));
  }
}

/** True for RPC URLs we must never point a test key at. */
export const isMainnet = (url: string) => /mainnet/i.test(url) && !/devnet|testnet/i.test(url);

export { PublicKey };
