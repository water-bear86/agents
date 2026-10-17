import {
  ActivationType, BaseFeeMode, DYNAMIC_BONDING_CURVE_PROGRAM_ID, CollectFeeMode, DynamicBondingCurveClient, MigrationFeeOption, MigrationOption, TokenAuthorityOption,
  TokenDecimal, TokenType, buildCurve, deriveDbcPoolAddress, getCurrentPoint, swapQuote, type ConfigParameters, type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import type { PoolReader, PoolSnapshot } from "./venue.js";

const VIRTUAL_POOL_DISC = [213, 224, 5, 209, 98, 69, 119, 92];
const TRANSFER_HOOK_POOL_DISC = [237, 219, 184, 23, 42, 189, 169, 35];

/**
 * Meteora Dynamic Bonding Curve, read side. We are the "partner": one config account fixes the
 * curve, fees and migration for every coin; each agent's vault is the pool creator of its coins.
 * Launches and swaps go through the agents program (see program.ts), which CPIs into DBC.
 *
 * Mapping of the EVM rules (see docs/SOLANA-PORT.md for the full table):
 * - 1B fixed supply, mint authority dropped (TokenAuthorityOption.Immutable)
 * - 1.25% trading fee (1% after Meteora's 20% cut); the creator share goes to the launching agent, the partner share to our
 *   fee claimer (which splits it inference/buyback off-chain, or via a splitter program)
 * - quote reserve threshold = the EVM open threshold, but here it is the graduation point
 * - LP after graduation: 100% permanently locked, split partner/creator
 */
export class MeteoraDbcVenue implements PoolReader {
  readonly client: DynamicBondingCurveClient;
  #config: PoolConfig | null = null;
  /** For coins with the agents-only hook: whether a coin is open, from the agents program's Coin record. */
  opensOf?: (mint: string) => boolean | undefined;

  constructor(private readonly connection: Connection, readonly config: PublicKey) {
    this.client = new DynamicBondingCurveClient(connection, "confirmed");
  }

  poolAddress(mint: string) {
    return deriveDbcPoolAddress(NATIVE_MINT, new PublicKey(mint), this.config);
  }

  async poolConfig() {
    this.#config ??= await this.client.state.getPoolConfig(this.config);
    if (!this.#config) throw new Error(`DBC config ${this.config.toBase58()} not found`);
    return this.#config;
  }

  async readPools(mints: string[]) {
    const out = new Map<string, PoolSnapshot>();
    if (!mints.length) return out;
    const config = await this.poolConfig();
    const addresses = mints.map((m) => this.poolAddress(m));
    const [infos, point] = await Promise.all([
      this.connection.getMultipleAccountsInfo(addresses),
      getCurrentPoint(this.connection, config.activationType as ActivationType),
    ]);
    const coder = this.client.state.program.coder.accounts;
    mints.forEach((m, i) => {
      const info = infos[i];
      if (!info || !info.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) return;
      // Token-2022 coins with a transfer hook live in TransferHookPool accounts; both wrap the same pool state.
      const disc = Buffer.from(info.data.subarray(0, 8));
      const kind = disc.equals(Buffer.from(TRANSFER_HOOK_POOL_DISC)) ? "transferHookPool" : disc.equals(Buffer.from(VIRTUAL_POOL_DISC)) ? "virtualPool" : null;
      if (!kind) return;
      const pool = coder.decode(kind, info.data) as VirtualPool;
      out.set(m, dbcSnapshot(m, pool, config, point, this.opensOf?.(m)));
    });
    return out;
  }
}

/** Venue-neutral view of a DBC pool, quoting with the SDK's own swap math (exact, fees included). */
export function dbcSnapshot(mint: string, pool: VirtualPool, config: PoolConfig, currentPoint: BN, open?: boolean): PoolSnapshot {
  const s = pool.poolState;
  return {
    mint,
    creator: s.creator.toBase58(),
    quoteReserve: BigInt(s.quoteReserve.toString()),
    baseReserve: BigInt(s.baseReserve.toString()),
    // Plain DBC pools have no agents-only phase; hooked ones are open once the agents program says so.
    open: open ?? true,
    migrated: s.isMigrated !== 0,
    quote(side, amountIn) {
      if (amountIn <= 0n || s.isMigrated !== 0) return 0n;
      try {
        const q = swapQuote(pool, config, side === "sell", new BN(amountIn.toString()), 0, false, currentPoint, false);
        return BigInt(q.outputAmount.toString());
      } catch {
        return 0n; // past the curve's end, or an amount the program would reject
      }
    },
  };
}

/**
 * Our platform config, as close to the EVM LaunchHook as DBC allows. `migrationQuoteThreshold`
 * is in SOL. On devnet keep it tiny so a smoke test can see a coin graduate.
 */
export function agentsCurve(opts: { migrationQuoteThresholdSol: number; creatorFeeSharePct?: number; token2022?: boolean }): ConfigParameters {
  return buildCurve({
    token: {
      tokenType: opts.token2022 ? TokenType.Token2022 : TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 0,
    },
    fee: {
      // Flat 1.25% for the life of the curve. Meteora keeps a fixed 20% of the trading fee, which
      // leaves 1% for us and the launching agent: the same 1% the EVM hook charges.
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 125, endingFeeBps: 125, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      // Of what's left after the protocol share: the launching agent's cut. 100 => all of it to the
      // creator; our 80/10/10 needs creator = 80% and the partner (inference + buyback) = 20%.
      creatorTradingFeePercentage: opts.creatorFeeSharePct ?? 80,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    // All post-graduation LP is permanently locked (the EVM liquidity is locked forever too).
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 50, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: opts.migrationQuoteThresholdSol,
  });
}

/** Creates the partner config (once per platform). Returns the unsigned transaction and the new config key. */
export async function buildCreateConfig(connection: Connection, p: { payer: PublicKey; feeClaimer: PublicKey; leftoverReceiver: PublicKey; params: ConfigParameters; transferHookProgram?: PublicKey }) {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const config = Keypair.generate();
  const base = { config: config.publicKey, feeClaimer: p.feeClaimer, leftoverReceiver: p.leftoverReceiver, quoteMint: NATIVE_MINT, payer: p.payer, ...p.params };
  const tx = p.transferHookProgram
    ? await client.partner.createConfigWithTransferHook({ ...base, transferHookProgram: p.transferHookProgram })
    : await client.partner.createConfig(base);
  return { tx, config };
}
