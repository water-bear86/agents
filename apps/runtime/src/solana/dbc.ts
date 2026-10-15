import {
  ActivationType, BaseFeeMode, CollectFeeMode, DynamicBondingCurveClient, MigrationFeeOption, MigrationOption, TokenAuthorityOption,
  TokenDecimal, TokenType, buildCurve, deriveDbcPoolAddress, getCurrentPoint, swapQuote, type ConfigParameters, type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import type { PoolSnapshot, SolanaVenue } from "./venue.js";

/**
 * Fast-path venue: Meteora Dynamic Bonding Curve. We are the "partner": one config account
 * fixes the curve, fees and migration for every coin; each agent is the pool creator of its coins.
 *
 * Mapping of the EVM rules (see docs/SOLANA-PORT.md for the full table):
 * - 1B fixed supply, mint authority dropped (TokenAuthorityOption.Immutable)
 * - 1.25% trading fee (1% after Meteora's 20% cut); the creator share goes to the launching agent, the partner share to our
 *   fee claimer (which splits it inference/buyback off-chain, or via a splitter program)
 * - quote reserve threshold = the EVM open threshold, but here it is the graduation point
 * - LP after graduation: 100% permanently locked, split partner/creator
 */
export class MeteoraDbcVenue implements SolanaVenue {
  readonly client: DynamicBondingCurveClient;
  #config: PoolConfig | null = null;

  constructor(private readonly connection: Connection, readonly config: PublicKey) {
    this.client = new DynamicBondingCurveClient(connection, "confirmed");
  }

  poolAddress(mint: string) {
    return deriveDbcPoolAddress(NATIVE_MINT, new PublicKey(mint), this.config);
  }

  async buildLaunch({ creator, name, symbol, uri }: { creator: PublicKey; name: string; symbol: string; uri: string }) {
    const mint = Keypair.generate();
    const tx = await this.client.creator.createPool({ name, symbol, uri, payer: creator, poolCreator: creator, config: this.config, baseMint: mint.publicKey });
    return { tx, signers: [mint], mint: mint.publicKey.toBase58() };
  }

  async buildSwap({ owner, mint, side, amountIn, minOut }: { owner: PublicKey; mint: string; side: "buy" | "sell"; amountIn: bigint; minOut: bigint }) {
    return this.client.pool.swap({
      owner, pool: this.poolAddress(mint), amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(minOut.toString()),
      swapBaseForQuote: side === "sell", referralTokenAccount: null,
    });
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
    const [pools, point] = await Promise.all([
      this.client.state.program.account.virtualPool.fetchMultiple(mints.map((m) => this.poolAddress(m))),
      getCurrentPoint(this.connection, config.activationType as ActivationType),
    ]);
    mints.forEach((m, i) => { const p = pools[i]; if (p) out.set(m, dbcSnapshot(m, p as VirtualPool, config, point)); });
    return out;
  }

  async listLaunches() {
    const pools = await this.client.state.getPoolsByConfig(this.config);
    return pools.map((p) => ({ mint: p.account.poolState.baseMint.toBase58(), creator: p.account.poolState.creator.toBase58() }));
  }
}

/** Venue-neutral view of a DBC pool, quoting with the SDK's own swap math (exact, fees included). */
export function dbcSnapshot(mint: string, pool: VirtualPool, config: PoolConfig, currentPoint: BN): PoolSnapshot {
  const s = pool.poolState;
  return {
    mint,
    creator: s.creator.toBase58(),
    quoteReserve: BigInt(s.quoteReserve.toString()),
    baseReserve: BigInt(s.baseReserve.toString()),
    // Plain DBC pools have no agents-only phase: anyone may trade from the first block.
    open: true,
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
export function agentsCurve(opts: { migrationQuoteThresholdSol: number; creatorFeeSharePct?: number }): ConfigParameters {
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9,
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
export async function buildCreateConfig(connection: Connection, p: { payer: PublicKey; feeClaimer: PublicKey; leftoverReceiver: PublicKey; params: ConfigParameters }) {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const config = Keypair.generate();
  const tx = await client.partner.createConfig({ config: config.publicKey, feeClaimer: p.feeClaimer, leftoverReceiver: p.leftoverReceiver, quoteMint: NATIVE_MINT, payer: p.payer, ...p.params });
  return { tx, config };
}
