import { Keypair, PublicKey, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import type { Order } from "@agents/core";
import type { Chain } from "../chain.js";
import { parseEvents, type AgentsClient } from "./program.js";

/** The slice of web3.js `Connection` the adapter uses, so tests can stand in a mock RPC. */
export type SolanaRpc = Pick<Connection, "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction" | "getTransaction">;

/**
 * Chain adapter for Solana. `account` is the agent's record in the agents program (the PDA of
 * its handle); its SOL and coins sit in the agent's vault PDA, which only the owner can withdraw
 * from. The runtime signs with its session key, and the program enforces the AgentAccount rules:
 * per-trade and daily caps, a minimum output on every trade, platform pools only, and the launch
 * cooldown. Transactions that would break a rule fail in preflight, so refused trades cost no fee.
 */
export class SolanaAgentChain implements Chain {
  constructor(
    private readonly rpc: SolanaRpc,
    private readonly client: AgentsClient,
    private readonly session: Keypair,
    private readonly opts: { coinUri?: (symbol: string) => string } = {},
  ) {}

  get sessionKey() { return this.session.publicKey; }

  async execute(account: string, order: Order) {
    if (order.minOut <= 0n) throw new Error("MinOutRequired"); // the program refuses it too; don't pay to find out
    const amountIn = order.kind === "buy" ? order.ethIn : order.tokensIn;
    const ixs = await this.client.tradeIxs({
      side: order.kind, operator: this.session.publicKey, agent: new PublicKey(account), mint: new PublicKey(order.token), amountIn, minOut: order.minOut,
    });
    const { sig, events } = await this.send(ixs, []);
    const traded = events.find((e) => e.name.toLowerCase() === "traded");
    if (!traded) throw new Error(`no Traded event in ${sig}`);
    return { txHash: sig, out: BigInt(String(traded.data.amount_out ?? traded.data.amountOut)) };
  }

  async launch(account: string, name: string, symbol: string) {
    const mint = Keypair.generate();
    const ixs = await this.client.launchIxs({
      operator: this.session.publicKey, agent: new PublicKey(account), mint: mint.publicKey, name, symbol, uri: this.opts.coinUri?.(symbol) ?? "",
    });
    const { sig } = await this.send(ixs, [mint]);
    return { txHash: sig, token: mint.publicKey.toBase58() };
  }

  /** Signs with the session key (fee payer) and `extra`, sends, confirms, and returns the program's events. */
  async send(ixs: TransactionInstruction[], extra: Keypair[]) {
    const { blockhash, lastValidBlockHeight } = await this.rpc.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: this.session.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(this.session, ...extra);
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
}

/** The program's own error name from a failed preflight ("OverTradeCap", "AgentsOnly", ...), or the raw message. */
export function programError(e: unknown): string {
  const logs: string[] = (e as { logs?: string[]; transactionLogs?: string[] })?.logs ?? (e as { transactionLogs?: string[] })?.transactionLogs ?? [];
  const msg = e instanceof Error ? e.message : String(e);
  const all = [...logs, msg].join("\n");
  const code = /Error Code: (\w+)/.exec(all)?.[1];
  return code ?? msg;
}

/** True for RPC URLs we must never point a test key at. */
export const isMainnet = (url: string) => /mainnet/i.test(url) && !/devnet|testnet/i.test(url);
