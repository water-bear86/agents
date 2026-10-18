import { encodeAbiParameters, keccak256, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import type { Quoter } from "./actions.js";
import type { World } from "./world.js";

const Q96 = 2n ** 96n;
const POOLS_SLOT = 6n; // PoolManager `pools` mapping slot (v4-core StateLibrary)
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const SUPPLY = 1_000_000_000n * 10n ** 18n;
/** sqrtPriceX96 at TickMath.minUsableTick(200) = -887200 (negligible next to the start price). */
const SQRT_MIN_USABLE = 4310618292n;

export const poolKey = (token: Address, hook: Address) => ({ currency0: ZERO, currency1: token, fee: 10_000, tickSpacing: 200, hooks: hook });

export function poolId(token: Address, hook: Address): Hex {
  const k = poolKey(token, hook);
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
  ));
}

const pmAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

/**
 * Exact quotes for launch-hook pools without a quoter contract: every pool has one
 * position spanning [minTick, START_TICK], so swaps stay in a single liquidity range
 * and the concentrated-liquidity formulas are closed-form. State is read from
 * PoolManager storage (slot0, liquidity) and refreshed before each tick.
 */
export class PoolQuoter implements Quoter {
  readonly state = new Map<string, { sqrtP: bigint; L: bigint }>();
  constructor(private readonly client: PublicClient, private readonly poolManager: Address, private readonly hook: Address) {}

  async refresh(tokens: string[]) {
    await Promise.all(tokens.map(async (t) => {
      const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(t as Address, this.hook), POOLS_SLOT])));
      const [slot0, liq] = await Promise.all([
        this.client.readContract({ address: this.poolManager, abi: pmAbi, functionName: "extsload", args: [`0x${base.toString(16).padStart(64, "0")}`] }),
        this.client.readContract({ address: this.poolManager, abi: pmAbi, functionName: "extsload", args: [`0x${(base + 3n).toString(16).padStart(64, "0")}`] }),
      ]);
      const sqrtP = BigInt(slot0) & ((1n << 160n) - 1n);
      let L = BigInt(liq) & ((1n << 128n) - 1n);
      // At launch the price sits exactly on the position's upper tick, where v4 reports
      // zero active liquidity; the first buy moves into range. Use the position's own L.
      if (L === 0n && sqrtP > 0n) L = (SUPPLY * Q96) / (sqrtP - SQRT_MIN_USABLE);
      this.state.set(t, { sqrtP, L });
    }));
  }

  /** ETH in (zeroForOne), 1% fee taken from input. */
  quoteBuy(token: string, ethIn: bigint): bigint {
    const s = this.state.get(token);
    if (!s || s.L === 0n) return 0n;
    const dx = (ethIn * 99n) / 100n;
    const next = (s.L * s.sqrtP * Q96) / (s.L * Q96 + dx * s.sqrtP);
    return (s.L * (s.sqrtP - next)) / Q96;
  }

  /** Tokens in (oneForZero), 1% fee taken from input. */
  quoteSell(token: string, tokensIn: bigint): bigint {
    const s = this.state.get(token);
    if (!s || s.L === 0n) return 0n;
    const dy = (tokensIn * 99n) / 100n;
    const next = s.sqrtP + (dy * Q96) / s.L;
    return (s.L * Q96 * (next - s.sqrtP)) / s.sqrtP / next;
  }
}

const hookAbi = parseAbi(["function coins(bytes32) view returns (address launcher, uint64 opensAt, bool opened, int256 ethReserve)"]);

const events = {
  created: parseAbiItem("event AgentCreated(address indexed account, address indexed owner, string handle, string modelId, bytes32 profileHash)"),
  launched: parseAbiItem("event Launched(address indexed token, address indexed launcher, bytes32 indexed id, string name, string symbol, uint64 opensAt)"),
  opened: parseAbiItem("event Opened(bytes32 indexed id, bool byThreshold)"),
};

/**
 * Keeps `World` in sync with chain events (reorg-tolerant by re-reading a few
 * confirmed blocks back each pass; handlers are idempotent).
 */
export class Indexer {
  from: bigint;
  constructor(private readonly client: PublicClient, private readonly registry: Address, private readonly hook: Address, private readonly world: World, fromBlock = 0n) {
    this.from = fromBlock;
  }

  async pass(confirmations = 2n) {
    const head = await this.client.getBlockNumber();
    const to = head > confirmations ? head - confirmations : head;
    if (to < this.from) return;
    // Trades aren't read from logs: reserves come from the hook and balances from each account, so a
    // chain-wide Traded query (which any contract could spam) would add nothing.
    const [created, launched, opened] = await Promise.all([
      this.client.getLogs({ address: this.registry, event: events.created, fromBlock: this.from, toBlock: to }),
      this.client.getLogs({ address: this.hook, event: events.launched, fromBlock: this.from, toBlock: to }),
      this.client.getLogs({ address: this.hook, event: events.opened, fromBlock: this.from, toBlock: to }),
    ]);
    for (const l of created) {
      const a = l.args;
      const existing = this.world.agents.get(a.account!);
      if (existing) { existing.owner = a.owner!; existing.modelId = a.modelId!; }
    }
    for (const l of launched) {
      const a = l.args;
      const launcher = this.world.agents.get(a.launcher!);
      if (!this.world.coins.has(a.token!)) {
        this.world.coins.set(a.token!, { token: a.token!, symbol: a.symbol!, name: a.name!, launcher: a.launcher!, launcherOwner: launcher?.owner ?? "", opened: false, ethReserveWei: 0n, launchedAt: Date.now() });
      }
    }
    for (const l of opened) {
      for (const c of this.world.coins.values()) if (poolId(c.token as Address, this.hook) === l.args.id) c.opened = true;
    }
    await this.syncReserves();
    this.from = to + 1n;
    return { created: created.length, launched: launched.length, opened: opened.length };
  }

  /** Reserve and phase come straight from the hook, so internal and external trades both count exactly once. */
  async syncReserves() {
    await Promise.all([...this.world.coins.values()].map(async (c) => {
      const [, , opened, reserve] = await this.client.readContract({ address: this.hook, abi: hookAbi, functionName: "coins", args: [poolId(c.token as Address, this.hook)] });
      c.opened = opened;
      c.ethReserveWei = reserve;
    }));
  }

  /** Agent ETH balances are the chain's, not our bookkeeping's. */
  async syncBalances() {
    await Promise.all([...this.world.agents.keys()].map(async (a) => {
      this.world.balances.set(a, await this.client.getBalance({ address: a as Address }));
    }));
  }
}
