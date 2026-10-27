import type { CurveState } from "./solana/stonkfun.js";
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Chain as ViemChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_UNITS, oneNative, type ChainUnits, type Order } from "@agents/core";

/** What the runtime needs from the chain. `ViemChain` in prod, `SimChain` in tests/demo. */
export interface Chain {
  /** `graduated`: this fill finished a launch's bonding curve. */
  execute(account: string, order: Order): Promise<{ txHash: string; out: bigint; graduated?: boolean }>;
}

/** A chain agents can launch coins on (StonkFun in paper mode, the offline demo's pools). */
export interface Launcher {
  launch(account: string, name: string, symbol: string): Promise<{ txHash: string; token: string }>;
  /** False when this chain could launch but the runtime has launching switched off. */
  readonly launchesOn?: boolean;
  /** A paper launch's curve, for the world to keep and save. */
  curveOf?(token: string): CurveState | undefined;
}

export const canLaunch = (c: Chain): c is Chain & Launcher => typeof (c as Partial<Launcher>).launch === "function";

const accountAbi = parseAbi([
  "function buy((address,address,uint24,int24,address) key, uint256 ethIn, uint256 minTokensOut) returns (uint256)",
  "function sell((address,address,uint24,int24,address) key, uint256 tokensIn, uint256 minEthOut) returns (uint256)",
]);

/** Signs with the runtime's session key; AgentAccount enforces caps and minOut on-chain. */
export class ViemAgentChain implements Chain {
  readonly pub;
  readonly wallet;
  constructor(rpcUrl: string, chain: ViemChain, sessionKey: Hex, private readonly hook: Address) {
    const account = privateKeyToAccount(sessionKey);
    this.pub = createPublicClient({ chain, transport: http(rpcUrl) });
    this.wallet = createWalletClient({ chain, transport: http(rpcUrl), account });
  }

  #key(token: string) {
    return ["0x0000000000000000000000000000000000000000", token as Address, 10_000, 200, this.hook] as const;
  }

  async execute(account: string, order: Order) {
    const fn = order.kind === "buy" ? "buy" : "sell";
    const amount = order.kind === "buy" ? order.ethIn : order.tokensIn;
    const { result, request } = await this.pub.simulateContract({
      address: account as Address, abi: accountAbi, functionName: fn, args: [this.#key(order.token), amount, order.minOut], account: this.wallet.account,
    });
    const txHash = await this.wallet.writeContract(request);
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    // The simulation predicted the output; only a successful receipt makes it a fill. (The indexer's
    // balance sync then reconciles the vault with what the chain actually holds.)
    if (receipt.status !== "success") throw new Error(`trade ${txHash} reverted`);
    return { txHash, out: result };
  }

}

/**
 * Constant-product simulation used by tests and the offline demo, where there is no live market to
 * trade: `list` opens a simulated pool for a token, standing in for its real one.
 */
export class SimChain implements Chain {
  pools = new Map<string, { eth: bigint; tokens: bigint }>();
  #n = 0;
  constructor(readonly units: ChainUnits = EVM_UNITS) {}

  /** Opens a pool for `token` (one native coin against the full supply unless told otherwise); keeps an existing one. */
  list(token: string, eth: bigint = oneNative(this.units), tokens: bigint = this.units.tokenSupply) {
    if (!this.pools.has(token)) this.pools.set(token, { eth, tokens });
    return token;
  }

  quoteBuy(token: string, ethIn: bigint) {
    const p = this.pools.get(token);
    if (!p) return 0n;
    const eff = (ethIn * 99n) / 100n;
    return (p.tokens * eff) / (p.eth + eff);
  }
  quoteSell(token: string, tokensIn: bigint) {
    const p = this.pools.get(token);
    if (!p) return 0n;
    return ((p.eth * tokensIn) / (p.tokens + tokensIn) * 99n) / 100n;
  }

  /** The offline demo's launch: a fresh token with its own simulated pool. */
  async launch(_account: string, _name: string, symbol: string) {
    const token = this.list(`sim-${symbol.toLowerCase()}-${(++this.#n).toString(36)}`);
    return { txHash: `0xsim${Date.now().toString(36)}${this.#n}`, token };
  }

  async execute(_account: string, o: Order) {
    const p = this.pools.get(o.token);
    if (!p) throw new Error("unknown pool");
    const out = o.kind === "buy" ? this.quoteBuy(o.token, o.ethIn) : this.quoteSell(o.token, o.tokensIn);
    if (out < o.minOut) throw new Error("Slippage");
    if (o.kind === "buy") { p.eth += o.ethIn; p.tokens -= out; } else { p.eth -= out; p.tokens += o.tokensIn; }
    return { txHash: `0xsim${Date.now().toString(36)}${++this.#n}`, out };
  }
}
