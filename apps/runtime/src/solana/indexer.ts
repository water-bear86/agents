import { PublicKey, type Connection } from "@solana/web3.js";
import type { Quoter } from "../actions.js";
import type { World } from "../world.js";
import type { PoolSnapshot, SolanaVenue } from "./venue.js";

/** Metaplex Token Metadata program (coins launched on DBC with SPL mints get a metadata account from it). */
export const TOKEN_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export const metadataAddress = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("metadata"), TOKEN_METADATA_PROGRAM.toBuffer(), mint.toBuffer()], TOKEN_METADATA_PROGRAM)[0];

/**
 * Name and symbol from a Token Metadata account (borsh: key u8, update authority, mint,
 * then length-prefixed strings padded with NULs). Returns null for anything else.
 */
export function parseMetadata(data: Uint8Array): { name: string; symbol: string; uri: string } | null {
  if (data.length < 69 || data[0] !== 4) return null; // Key::MetadataV1
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 65;
  const str = () => {
    if (o + 4 > data.length) throw new Error("short");
    const n = view.getUint32(o, true);
    o += 4;
    if (o + n > data.length) throw new Error("short");
    const s = new TextDecoder().decode(data.subarray(o, o + n)).replace(/\0+$/, "");
    o += n;
    return s;
  };
  try { return { name: str(), symbol: str(), uri: str() }; } catch { return null; }
}

/** Quotes from pool snapshots refreshed once per scheduler pass, the same contract as the EVM PoolQuoter. */
export class SolanaQuoter implements Quoter {
  readonly state = new Map<string, PoolSnapshot>();
  constructor(private readonly venue: SolanaVenue) {}

  async refresh(mints: string[]) {
    const pools = await this.venue.readPools(mints);
    for (const [m, p] of pools) this.state.set(m, p);
  }

  quoteBuy(token: string, lamportsIn: bigint) { return this.state.get(token)?.quote("buy", lamportsIn) ?? 0n; }
  quoteSell(token: string, tokensIn: bigint) { return this.state.get(token)?.quote("sell", tokensIn) ?? 0n; }
}

type Rpc = Pick<Connection, "getBalance" | "getMultipleAccountsInfo">;

/**
 * Keeps `World` in sync with the venue: discovers coins our agents launched (including ones
 * launched outside this runtime), reads names from Metaplex metadata, and takes reserves,
 * phase and SOL balances from the chain rather than our own bookkeeping.
 */
export class SolanaIndexer {
  constructor(private readonly rpc: Rpc, private readonly venue: SolanaVenue, private readonly world: World) {}

  async pass() {
    const launches = (await this.venue.listLaunches()).filter((l) => this.world.agents.has(l.creator) && !this.world.coins.has(l.mint));
    if (launches.length) {
      const metas = await this.rpc.getMultipleAccountsInfo(launches.map((l) => metadataAddress(new PublicKey(l.mint))));
      launches.forEach((l, i) => {
        const meta = metas[i] ? parseMetadata(metas[i]!.data) : null;
        const agent = this.world.agents.get(l.creator)!;
        this.world.coins.set(l.mint, {
          token: l.mint, symbol: meta?.symbol || l.mint.slice(0, 4), name: meta?.name || l.mint, launcher: l.creator,
          launcherOwner: agent.owner, opened: false, ethReserveWei: 0n, launchedAt: Date.now(),
        });
      });
    }
    await this.syncReserves();
    return { discovered: launches.length };
  }

  /** Reserve and phase straight from the pools, so trades from inside and outside the runtime both count once. */
  async syncReserves() {
    const pools = await this.venue.readPools([...this.world.coins.keys()]);
    for (const [m, p] of pools) {
      const c = this.world.coins.get(m);
      if (!c) continue;
      c.ethReserveWei = p.quoteReserve;
      c.opened = p.open || p.migrated;
    }
  }

  /** Agent SOL balances are the chain's, not our bookkeeping's. */
  async syncBalances() {
    await Promise.all([...this.world.agents.keys()].map(async (a) => {
      this.world.balances.set(a, BigInt(await this.rpc.getBalance(new PublicKey(a), "confirmed")));
    }));
  }
}
