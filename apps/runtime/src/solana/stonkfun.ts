// StonkFun (stonkfun.xyz): where the town's agents launch coins and trade them. Every StonkFun coin
// is a Raydium LaunchLab bonding curve (1B supply, 6 decimals) that graduates to a Raydium CPMM pool;
// Jupiter routes both, so trading a real StonkFun coin is an ordinary Jupiter swap. In paper mode an
// agent's launch runs on a simulated curve with StonkFun's live shape (the raise, starting and
// graduation market caps from its pricing API), so a paper launch behaves like a real one would.

const API = "https://www.stonkfun.xyz/api/public/v1";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
/** LaunchLab's curve fee, taken on every buy and sell. */
export const CURVE_FEE_BPS = 100n;

/** A coin's page on StonkFun. */
export const stonkfunUrl = (mint: string) => `https://www.stonkfun.xyz/token/${mint}`;

/** The curve every SOL-paired StonkFun launch starts on, in lamports and base units. */
export interface CurveShape {
  /** Virtual SOL and token reserves the curve starts with. */
  virtualQuote: bigint;
  virtualBase: bigint;
  /** SOL the curve raises before it graduates. */
  raise: bigint;
  /** Tokens sold on the curve; the rest seed the graduated pool. */
  sellable: bigint;
}

/**
 * The shape StonkFun's pricing API gave on 2026-10-26 (an 85 SOL raise from a 27.96 SOL market cap to
 * 410.83 SOL, 793.1M tokens on the curve): used when the API can't be reached.
 */
export const DEFAULT_SHAPE: CurveShape = { virtualQuote: 30_000_000_000n, virtualBase: 1_073_000_000_000_000n, raise: 85_000_000_000n, sellable: 793_100_000_000_000n };

/** One coin on a paper curve: what's been paid in and sold out so far. */
export interface CurveState extends CurveShape {
  /** Lamports the curve holds from buys (less sells). */
  quote: bigint;
  /** Base units sold from the curve (less sold back). */
  sold: bigint;
  graduated: boolean;
}

export const newCurve = (shape: CurveShape): CurveState => ({ ...shape, quote: 0n, sold: 0n, graduated: false });

const k = (c: CurveState) => c.virtualQuote * c.virtualBase;
const reserves = (c: CurveState) => ({ q: c.virtualQuote + c.quote, b: c.virtualBase - c.sold });

/** Tokens out for `lamportsIn` (fee taken first). A curve that hasn't graduated sells at most what's left on it. */
export function curveBuy(c: CurveState, lamportsIn: bigint): bigint {
  if (lamportsIn <= 0n) return 0n;
  const { q, b } = reserves(c);
  const net = (lamportsIn * (10_000n - CURVE_FEE_BPS)) / 10_000n;
  const out = b - k(c) / (q + net);
  return c.graduated ? out : out < c.sellable - c.sold ? out : c.sellable - c.sold;
}

/** Lamports out for `tokensIn` (fee taken from the proceeds). */
export function curveSell(c: CurveState, tokensIn: bigint): bigint {
  if (tokensIn <= 0n || tokensIn > c.sold) return 0n;
  const { q, b } = reserves(c);
  const gross = q - k(c) / (b + tokensIn);
  return (gross * (10_000n - CURVE_FEE_BPS)) / 10_000n;
}

/** Records a fill; returns true when this one graduated the curve. */
export function curveApply(c: CurveState, kind: "buy" | "sell", lamports: bigint, tokens: bigint): boolean {
  if (kind === "buy") { c.quote += (lamports * (10_000n - CURVE_FEE_BPS)) / 10_000n; c.sold += tokens; }
  else { c.quote -= lamports; c.sold -= tokens; }
  if (c.quote < 0n) c.quote = 0n;
  const was = c.graduated;
  if (!was && c.quote >= c.raise) c.graduated = true;
  return !was && c.graduated;
}

/** Share of the raise filled so far, 0 to 1. */
export const curveProgress = (c: CurveState) => (c.graduated ? 1 : Number((c.quote * 10_000n) / c.raise) / 10_000);

/** A coin listed on StonkFun, as its public API reports it. */
export interface StonkFunToken {
  mint: string;
  symbol: string;
  name: string;
  mode: string;
  status: string;
  quoteSymbol: string;
  priceUsd?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  graduationProgress?: number;
  createdAt?: string;
}

export class StonkFunClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly api = API) {}

  async #json<T>(path: string): Promise<T> {
    const r = await this.fetchImpl(`${this.api}${path}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`stonkfun ${path.split("?")[0]}: HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  /**
   * The curve a SOL-paired launch starts on, from StonkFun's pricing API. A constant-product curve
   * that raises R and multiplies its price by M has virtual SOL R / (sqrt(M) - 1).
   */
  async shape(): Promise<CurveShape> {
    const d = (await this.#json<{ data: Record<string, any> }>(`/launchlab/pricing?quoteMint=${SOL_MINT}`)).data;
    const raise = BigInt(d.raise.raw);
    const multiple = Number(d.marketCap.graduationMultiple);
    const startMcapSol = Number(d.marketCap.startQuote);
    const supply = Number(d.curve.totalSupplyTokens);
    const decimals = Number(d.curve.baseDecimals);
    if (!(raise > 0n) || !(multiple > 1) || !(startMcapSol > 0) || !(supply > 0) || decimals !== 6) throw new Error("stonkfun pricing: unexpected shape");
    const vq = Number(raise) / (Math.sqrt(multiple) - 1);
    const lamportsPerBase = (startMcapSol * 1e9) / (supply * 10 ** decimals);
    return { virtualQuote: BigInt(Math.round(vq)), virtualBase: BigInt(Math.round(vq / lamportsPerBase)), raise, sellable: BigInt(d.curve.totalSellA) };
  }

  /** Busy StonkFun coins: standard mode only (reward mode taxes every transfer, which the town's fills don't model). */
  async tokens(pageSize = 50): Promise<StonkFunToken[]> {
    const d = await this.#json<{ data: { tokens: Record<string, any>[] } }>(`/tokens?mode=standard&pageSize=${pageSize}`);
    return d.data.tokens.map((t) => ({
      mint: String(t.mint), symbol: String(t.symbol), name: String(t.name), mode: String(t.mode), status: String(t.status),
      quoteSymbol: String(t.quote?.symbol ?? ""), priceUsd: t.market?.priceUsd ?? undefined, liquidityUsd: t.market?.liquidityUsd ?? undefined,
      marketCapUsd: t.market?.marketCapUsd ?? undefined, graduationProgress: t.graduationProgress ?? undefined, createdAt: t.createdAt ?? undefined,
    }));
  }
}
