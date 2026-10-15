import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Chain as ViemChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Order } from "@agents/core";

/** What the runtime needs from the chain. `ViemChain` in prod, `SimChain` in tests/demo. */
export interface Chain {
  execute(account: string, order: Order): Promise<{ txHash: string; out: bigint }>;
  launch(account: string, name: string, symbol: string): Promise<{ txHash: string; token: string }>;
}

const accountAbi = parseAbi([
  "function buy((address,address,uint24,int24,address) key, uint256 ethIn, uint256 minTokensOut) returns (uint256)",
  "function sell((address,address,uint24,int24,address) key, uint256 tokensIn, uint256 minEthOut) returns (uint256)",
  "function launch(string name, string symbol) returns (address)",
]);
const hookAbi = parseAbi(["event Launched(address indexed token, address indexed launcher, bytes32 indexed id, string name, string symbol, uint64 opensAt)"]);

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
    await this.pub.waitForTransactionReceipt({ hash: txHash });
    return { txHash, out: result };
  }

  async launch(account: string, name: string, symbol: string) {
    const txHash = await this.wallet.writeContract({ address: account as Address, abi: accountAbi, functionName: "launch", args: [name, symbol], chain: this.wallet.chain, account: this.wallet.account });
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    const logs = await this.pub.getContractEvents({ address: this.hook, abi: hookAbi, eventName: "Launched", fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    const token = logs.find((l) => l.transactionHash === txHash)?.args.token;
    if (!token) throw new Error("Launched event not found");
    return { txHash, token };
  }
}

/** Constant-product simulation used by tests and demo mode. */
export class SimChain implements Chain {
  pools = new Map<string, { eth: bigint; tokens: bigint }>();
  #n = 0;

  quoteBuy(token: string, ethIn: bigint) {
    const p = this.pools.get(token)!;
    const eff = (ethIn * 99n) / 100n;
    return (p.tokens * eff) / (p.eth + eff);
  }
  quoteSell(token: string, tokensIn: bigint) {
    const p = this.pools.get(token)!;
    return ((p.eth * tokensIn) / (p.tokens + tokensIn) * 99n) / 100n;
  }

  async execute(_account: string, o: Order) {
    const p = this.pools.get(o.token);
    if (!p) throw new Error("unknown pool");
    const out = o.kind === "buy" ? this.quoteBuy(o.token, o.ethIn) : this.quoteSell(o.token, o.tokensIn);
    if (out < o.minOut) throw new Error("Slippage");
    if (o.kind === "buy") { p.eth += o.ethIn; p.tokens -= out; } else { p.eth -= out; p.tokens += o.tokensIn; }
    return { txHash: `0xsim${Date.now().toString(36)}${++this.#n}`, out };
  }

  async launch(_account: string, _name: string, _symbol: string) {
    // Pools are restored from a snapshot after a restart while the counter is not, so skip
    // every id already taken. Reusing one would hand old holders a fresh pool to drain.
    let token: string;
    do token = `0xcoin${++this.#n}`; while (this.pools.has(token));
    this.pools.set(token, { eth: 1n * 10n ** 18n, tokens: 1_000_000_000n * 10n ** 18n });
    return { txHash: `0xsim${this.#n}`, token };
  }
}
