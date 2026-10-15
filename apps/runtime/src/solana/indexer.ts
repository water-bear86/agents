import { PublicKey, type Connection } from "@solana/web3.js";
import type { Quoter } from "../actions.js";
import type { World } from "../world.js";
import type { SolanaAgentChain } from "./chain.js";
import { pdas, wsolAta, type AgentsClient } from "./program.js";
import type { PoolReader, PoolSnapshot } from "./venue.js";

/** Quotes from pool snapshots refreshed once per scheduler pass, the same contract as the EVM PoolQuoter. */
export class SolanaQuoter implements Quoter {
  readonly state = new Map<string, PoolSnapshot>();
  constructor(private readonly pools: PoolReader) {}

  async refresh(mints: string[]) {
    const pools = await this.pools.readPools(mints);
    for (const [m, p] of pools) this.state.set(m, p);
  }

  quoteBuy(token: string, lamportsIn: bigint) { return this.state.get(token)?.quote("buy", lamportsIn) ?? 0n; }
  quoteSell(token: string, tokensIn: bigint) { return this.state.get(token)?.quote("sell", tokensIn) ?? 0n; }
}

/** A coin as the agents program records it. */
export interface CoinRecord { mint: string; launcher: string; pool: string; opensAt: number; opened: boolean; name: string; symbol: string }

/** The program data the indexer reads; `AgentsClient` in production, a stub in tests. */
export interface CoinSource {
  coins(): Promise<CoinRecord[]>;
  platform(): Promise<{ openThreshold: bigint; inference: string; buyback: string }>;
}

export function programSource(client: AgentsClient): CoinSource {
  return {
    async coins() {
      const all = await client.program.account.coin.all();
      return all.map(({ account: c }) => ({
        mint: c.mint.toBase58(), launcher: c.launcher.toBase58(), pool: c.pool.toBase58(), opensAt: Number(c.opensAt) * 1000,
        opened: c.opened, name: c.name, symbol: c.symbol,
      }));
    },
    async platform() {
      const p = await client.program.account.platform.fetch(pdas.platform());
      return { openThreshold: BigInt(p.openThreshold.toString()), inference: p.inference.toBase58(), buyback: p.buyback.toBase58() };
    },
  };
}

type Rpc = Pick<Connection, "getMultipleAccountsInfo">;

/** Amount field of an SPL token account (bytes 64..72), or 0 if the account doesn't exist. */
const tokenAmount = (data?: Uint8Array | null) => (data && data.length >= 72 ? Buffer.from(data).readBigUInt64LE(64) : 0n);

/**
 * Keeps `World` in sync with the chain: coins launched by our agents (from the agents program's
 * Coin records, including launches made outside this runtime), reserves from the pools, phase
 * from the program, and each agent's spendable SOL from its vault.
 */
export class SolanaIndexer {
  readonly records = new Map<string, CoinRecord>();
  #lastFees = 0;

  constructor(
    private readonly rpc: Rpc,
    private readonly source: CoinSource,
    private readonly pools: PoolReader,
    private readonly world: World,
  ) {}

  async pass() {
    let discovered = 0;
    for (const r of await this.source.coins()) {
      this.records.set(r.mint, r);
      const agent = this.world.agents.get(r.launcher);
      if (!agent || this.world.coins.has(r.mint)) continue;
      this.world.coins.set(r.mint, {
        token: r.mint, symbol: r.symbol, name: r.name, launcher: r.launcher, launcherOwner: agent.owner, opened: r.opened, ethReserveWei: 0n, launchedAt: Date.now(),
      });
      discovered++;
    }
    await this.syncReserves();
    return { discovered };
  }

  /** Reserve from the pool; open once the program says so (or its opening time has passed, which the hook honours too). */
  async syncReserves() {
    const pools = await this.pools.readPools([...this.world.coins.keys()]);
    for (const c of this.world.coins.values()) {
      const p = pools.get(c.token);
      const r = this.records.get(c.token);
      if (p) c.ethReserveWei = p.quoteReserve;
      c.opened = !!(r?.opened || (r && Date.now() >= r.opensAt) || p?.migrated);
    }
  }

  /** Spendable SOL: the vault's lamports plus its wrapped-SOL account (where sale proceeds land). */
  async syncBalances() {
    const agents = [...this.world.agents.keys()].map((a) => new PublicKey(a));
    if (!agents.length) return;
    const keys = agents.flatMap((a) => { const v = pdas.vault(a); return [v, wsolAta(v)]; });
    const infos = await this.rpc.getMultipleAccountsInfo(keys);
    agents.forEach((a, i) => {
      const lamports = BigInt(infos[2 * i]?.lamports ?? 0);
      this.world.balances.set(a.toBase58(), lamports + tokenAmount(infos[2 * i + 1]?.data));
    });
  }

  /** Coins that may be opened now (the program checks the same conditions). */
  async readyToOpen(now = Date.now()) {
    const { openThreshold } = await this.source.platform();
    return [...this.world.coins.values()].filter((c) => {
      const r = this.records.get(c.token);
      return r && !r.opened && (c.ethReserveWei >= openThreshold || now >= r.opensAt);
    }).map((c) => c.token);
  }

  /**
   * Permissionless upkeep, paid by the session key: opens coins that reached their threshold or
   * time, and every `feeEveryMs` claims creator fees into vaults and splits the platform's share.
   */
  async crank(chain: SolanaAgentChain, client: AgentsClient, feeEveryMs = 10 * 60_000) {
    const done: string[] = [];
    for (const mint of await this.readyToOpen()) {
      try {
        await chain.send([await client.openIx(new PublicKey(mint))], []);
        const r = this.records.get(mint);
        if (r) r.opened = true;
        done.push(`opened ${mint}`);
      } catch (e) { done.push(`open ${mint} failed: ${(e as Error).message}`); }
    }
    if (Date.now() - this.#lastFees >= feeEveryMs) {
      this.#lastFees = Date.now();
      const { inference, buyback } = await this.source.platform();
      for (const c of this.world.coins.values()) {
        const mint = new PublicKey(c.token);
        try {
          await chain.send(await client.claimCreatorFeesIxs(chain.sessionKey, new PublicKey(c.launcher), mint), []);
          await chain.send(await client.distributeFeesIxs(chain.sessionKey, mint, new PublicKey(inference), new PublicKey(buyback)), []);
          done.push(`fees ${c.symbol}`);
        } catch (e) { done.push(`fees ${c.symbol} failed: ${(e as Error).message}`); }
      }
    }
    return done;
  }
}
