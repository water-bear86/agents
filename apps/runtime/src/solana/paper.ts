// Paper trading against the real Solana market. Agents trade real mainnet tokens at live prices,
// and only those: every fill is simulated, so no transaction is sent and nothing is spent. Prices
// and fills come from Jupiter's live mainnet quotes (the real pools, with size and price impact);
// the mainnet RPC double-checks each token's mint before it's tradable.

import type { ChainUnits, Order } from "@agents/core";
import type { Chain } from "../chain.js";
import type { Quoter } from "../actions.js";
import type { World } from "../world.js";
import { StonkFunClient, curveApply, curveBuy, curveSell, newCurve, DEFAULT_SHAPE, type CurveShape, type CurveState, type StonkFunToken } from "./stonkfun.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP = "https://lite-api.jup.ag";
/** The most ids Jupiter's price API will answer in one request. */
const PRICE_BATCH = 50;
/** Price history kept per token for short-term change: one sample per HISTORY_STEP_MS, HISTORY_MS deep. */
const HISTORY_STEP_MS = 20_000;
const HISTORY_MS = 65 * 60_000;
/** Stands in for a coin's launcher and launcher's owner on market tokens: nobody in town made them. */
export const MARKET = "market";

export interface MarketToken {
  mint: string; symbol: string; name: string; decimals: number;
  liquidityUsd: number; mcapUsd?: number; change1h?: number; createdAt?: string;
  mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean;
  /** Listed on StonkFun; its price there stands in when Jupiter's price API hasn't indexed it yet. */
  venue?: "stonkfun"; venuePriceUsd?: number;
}

export interface PaperOptions {
  /** Mainnet RPC for mint checks. */
  rpcUrl: string;
  /** How many real tokens agents may trade, and the least liquidity (USD) one needs. */
  maxTokens?: number;
  minLiquidityUsd?: number;
  fetch?: typeof fetch;
  /** Slippage a paper order is allowed, in bps (the agents' own minOut still applies). */
  slippageBps?: number;
  /** StonkFun: its busy coins join the market and agents launch there. Off when null. */
  stonkfun?: StonkFunClient | null;
  /** How many StonkFun coins join the market, and the least liquidity (USD) one needs. */
  stonkfunTokens?: number;
  stonkfunMinLiquidityUsd?: number;
}

export class PaperChain implements Chain, Quoter {
  /** Real mainnet tokens agents may trade, by mint. */
  readonly market = new Map<string, MarketToken>();
  /** Lamports per smallest token unit, from the last price refresh. */
  readonly #price = new Map<string, number>();
  /** When each price was read (ms), and a short history of it for 5m/1h change. */
  readonly #priceAt = new Map<string, number>();
  readonly #history = new Map<string, Array<[number, number]>>();
  /** Price reads in flight, by mint, so callers asking at once share one request. */
  readonly #pending = new Map<string, Promise<void>>();
  /** Agents' paper launches, each on its own simulated StonkFun curve (the same objects the world saves). */
  readonly #curves = new Map<string, CurveState>();
  #shape: CurveShape = DEFAULT_SHAPE;
  #solUsd = 0;
  #fills = 0;
  #launches = 0;
  readonly #fetch: typeof fetch;

  constructor(readonly units: ChainUnits, private readonly opts: PaperOptions) {
    this.#fetch = opts.fetch ?? fetch;
  }

  get solUsd() { return this.#solUsd; }
  isMarket(token: string) { return this.market.has(token); }
  isLaunch(token: string) { return this.#curves.has(token); }
  get launchesOn() { return !!this.opts.stonkfun; }

  /** Picks up a paper launch's curve from a saved world. */
  adopt(token: string, curve: CurveState) { this.#curves.set(token, curve); }
  curveOf(token: string) { return this.#curves.get(token); }

  async #json<T>(url: string, init?: RequestInit): Promise<T> {
    const r = await this.#fetch(url, init);
    if (!r.ok) {
      const why = await r.text().then((t) => { try { return (JSON.parse(t) as { error?: string }).error ?? t; } catch { return t; } }).catch(() => "");
      throw new Error(`${new URL(url).pathname}: HTTP ${r.status}${why ? ` (${String(why).slice(0, 120)})` : ""}`);
    }
    return (await r.json()) as T;
  }

  /**
   * The tradable universe: trending tokens with real liquidity whose mint and freeze authorities
   * are gone (so nobody can print more or freeze holders), confirmed on the mainnet RPC.
   */
  async discover(): Promise<MarketToken[]> {
    const list = await this.#json<Array<Record<string, any>>>(`${JUP}/tokens/v2/toptrending/1h?limit=60`);
    const candidates: MarketToken[] = list
      .filter((t) => t.decimals === this.units.tokenDecimals && (t.liquidity ?? 0) >= (this.opts.minLiquidityUsd ?? 50_000))
      .filter((t) => t.audit?.mintAuthorityDisabled && t.audit?.freezeAuthorityDisabled)
      .map((t) => ({
        mint: t.id, symbol: String(t.symbol).replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase() || "TOKEN", name: String(t.name).slice(0, 32),
        decimals: t.decimals, liquidityUsd: t.liquidity, mcapUsd: t.mcap, change1h: t.stats1h?.priceChange, createdAt: t.firstPool?.createdAt ?? t.createdAt,
        mintAuthorityDisabled: true, freezeAuthorityDisabled: true,
      }));
    const checked = await this.#checkMints(candidates.map((c) => c.mint));
    const picked = candidates.filter((c) => checked.get(c.mint)).slice(0, this.opts.maxTokens ?? 12);
    for (const t of picked) this.market.set(t.mint, t);
    return [...picked, ...(await this.discoverStonkFun().catch((e) => { console.warn(`[stonkfun] ${String(e)}`); return []; }))];
  }

  /**
   * StonkFun's busy coins join the market, through the same mint check (6 decimals, no mint or freeze
   * authority). Its live curve shape is read too, so paper launches start where real ones would.
   */
  async discoverStonkFun(): Promise<MarketToken[]> {
    const sf = this.opts.stonkfun;
    if (!sf) return [];
    this.#shape = await sf.shape().catch(() => this.#shape);
    const listed: StonkFunToken[] = (await sf.tokens()).filter((t) => (t.liquidityUsd ?? 0) >= (this.opts.stonkfunMinLiquidityUsd ?? 5_000) && !this.market.has(t.mint));
    const checked = await this.#checkMints(listed.map((t) => t.mint));
    const picked: MarketToken[] = listed.filter((t) => checked.get(t.mint)).slice(0, this.opts.stonkfunTokens ?? 8).map((t) => ({
      mint: t.mint, symbol: t.symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase() || "TOKEN", name: t.name.slice(0, 32),
      decimals: this.units.tokenDecimals, liquidityUsd: t.liquidityUsd ?? 0, mcapUsd: t.marketCapUsd, createdAt: t.createdAt,
      mintAuthorityDisabled: true, freezeAuthorityDisabled: true, venue: "stonkfun", venuePriceUsd: t.priceUsd,
    }));
    for (const t of picked) this.market.set(t.mint, t);
    return picked;
  }

  /**
   * An agent's paper launch on StonkFun: a new coin on a simulated LaunchLab curve with StonkFun's
   * live shape. Nothing is sent; the coin exists only in town until real launches are switched on.
   */
  async launch(_account: string, _name: string, symbol: string) {
    if (!this.opts.stonkfun) throw new Error("launching is off on this runtime");
    const token = `paper-${symbol.toLowerCase()}-${Date.now().toString(36)}${(++this.#launches).toString(36)}`;
    this.#curves.set(token, newCurve(this.#shape));
    return { txHash: `paper-launch-${token}`, token };
  }

  /**
   * A fixed universe instead of the trending list: on mainnet, the tokens the program whitelists.
   * Tokens the town can't model (another decimal count) are left out.
   */
  async track(mints: string[]): Promise<MarketToken[]> {
    if (!mints.length) { this.market.clear(); return []; }
    const list = await this.#json<Array<Record<string, any>>>(`${JUP}/tokens/v2/search?query=${mints.join(",")}`);
    const picked: MarketToken[] = list
      .filter((t) => mints.includes(t.id) && t.decimals === this.units.tokenDecimals)
      .map((t) => ({
        mint: t.id, symbol: String(t.symbol).replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase() || "TOKEN", name: String(t.name).slice(0, 32),
        decimals: t.decimals, liquidityUsd: t.liquidity, mcapUsd: t.mcap, change1h: t.stats1h?.priceChange, createdAt: t.firstPool?.createdAt ?? t.createdAt,
        mintAuthorityDisabled: !!t.audit?.mintAuthorityDisabled, freezeAuthorityDisabled: !!t.audit?.freezeAuthorityDisabled,
      }));
    for (const m of [...this.market.keys()]) if (!mints.includes(m)) this.market.delete(m);
    for (const t of picked) this.market.set(t.mint, t);
    return picked;
  }

  /** Reads each mint from the mainnet RPC: it must exist, have the expected decimals and no mint or freeze authority. */
  async #checkMints(mints: string[]): Promise<Map<string, boolean>> {
    const ok = new Map<string, boolean>();
    for (let i = 0; i < mints.length; i += 100) {
      const batch = mints.slice(i, i + 100);
      const r = await this.#json<{ result?: { value: (null | { data: { parsed?: { info?: { decimals: number; mintAuthority: string | null; freezeAuthority: string | null } } } })[] } }>(this.opts.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [batch, { encoding: "jsonParsed" }] }),
      });
      batch.forEach((m, k) => {
        const info = r.result?.value[k]?.data.parsed?.info;
        ok.set(m, !!info && info.decimals === this.units.tokenDecimals && info.mintAuthority === null && info.freezeAuthority === null);
      });
    }
    return ok;
  }

  /**
   * Live prices for every real token, or just `mints`. Jupiter's price API answers at most
   * PRICE_BATCH ids per request (it still returns 200, just without the rest), so the ids go out in batches.
   */
  async refresh(mints?: string[], now = () => Date.now()) {
    const wanted = mints ? [...new Set(mints)].filter((m) => this.market.has(m)) : [...this.market.keys()];
    if (mints && !wanted.length) return;
    const ids = [SOL_MINT, ...wanted];
    const prices: Record<string, { usdPrice: number; liquidity?: number } | null> = {};
    for (let i = 0; i < ids.length; i += PRICE_BATCH) {
      Object.assign(prices, await this.#json<typeof prices>(`${JUP}/price/v3?ids=${ids.slice(i, i + PRICE_BATCH).join(",")}`));
    }
    this.#solUsd = prices[SOL_MINT]?.usdPrice ?? this.#solUsd;
    if (!this.#solUsd) return;
    // StonkFun coins Jupiter hasn't priced yet: StonkFun's own list is read instead (one request).
    const venue = new Map<string, number>();
    const unpriced = wanted.filter((m) => !prices[m]?.usdPrice && this.market.get(m)!.venue === "stonkfun");
    if (unpriced.length && this.opts.stonkfun) {
      for (const t of await this.opts.stonkfun.tokens().catch(() => [])) if (t.priceUsd) venue.set(t.mint, t.priceUsd);
    }
    const at = now();
    for (const mint of wanted) {
      const t = this.market.get(mint)!;
      const p = prices[mint];
      const read = p?.usdPrice || venue.get(mint);
      if (venue.has(mint)) t.venuePriceUsd = venue.get(mint);
      // The listing price from discovery stands in for quotes, but isn't a fresh read.
      const usd = read || t.venuePriceUsd;
      if (!usd) continue;
      if (p?.liquidity) t.liquidityUsd = p.liquidity;
      // USD per whole token -> lamports per smallest unit.
      const price = (usd / this.#solUsd) * 10 ** (this.units.nativeDecimals - this.units.tokenDecimals);
      this.#price.set(mint, price);
      if (read) { this.#priceAt.set(mint, at); this.#record(mint, at, price); }
    }
  }

  #record(mint: string, at: number, price: number) {
    const h = this.#history.get(mint) ?? [];
    if (!h.length || at - h[h.length - 1]![0] >= HISTORY_STEP_MS) h.push([at, price]);
    else h[h.length - 1] = [h[h.length - 1]![0], price];
    while (h.length && at - h[0]![0] > HISTORY_MS) h.shift();
    this.#history.set(mint, h);
  }

  /** When a market token's price was last read (ms); 0 if never. Paper launches quote live off their curve. */
  priceAt(token: string): number | undefined {
    if (this.#curves.has(token) || !this.market.has(token)) return undefined;
    return this.#priceAt.get(token) ?? 0;
  }

  /** Re-reads any of these tokens' prices older than `olderThanMs`, sharing reads already in flight. */
  async ensureFresh(tokens: string[], olderThanMs: number, now = Date.now()) {
    const due = [...new Set(tokens)].filter((t) => this.market.has(t) && now - (this.#priceAt.get(t) ?? 0) > olderThanMs);
    const waits: Promise<void>[] = due.flatMap((t) => this.#pending.get(t) ?? []);
    const fetch = due.filter((t) => !this.#pending.has(t));
    if (fetch.length) {
      const read: Promise<void> = this.refresh(fetch).finally(() => { for (const t of fetch) if (this.#pending.get(t) === read) this.#pending.delete(t); });
      for (const t of fetch) this.#pending.set(t, read);
      waits.push(read);
    }
    await Promise.all(waits);
  }

  /**
   * Price change over the last `minutes`, in %, from the prices this runtime has read. Falls back
   * to Jupiter's 1h change from when the token was listed. Undefined when there's no history that far back.
   */
  change(token: string, minutes: number, now = Date.now()): number | undefined {
    const h = this.#history.get(token);
    const cur = this.#price.get(token);
    const target = now - minutes * 60_000;
    // Accept a sample up to a fifth of the window late, so a 5m change can use a 4-minute-old reading.
    const then = h && cur ? [...h].reverse().find(([at]) => at <= target + minutes * 12_000) : undefined;
    if (then && cur) return ((cur - then[1]) / then[1]) * 100;
    return minutes === 60 ? this.market.get(token)?.change1h : undefined;
  }

  /** Pool depth in lamports, for the town's coin list (half the pool is SOL). */
  reserveOf(mint: string): bigint {
    const c = this.#curves.get(mint);
    if (c) return c.quote;
    const t = this.market.get(mint);
    return t && this.#solUsd ? BigInt(Math.round((t.liquidityUsd / 2 / this.#solUsd) * 10 ** this.units.nativeDecimals)) : 0n;
  }

  // Quotes for decisions and risk checks: live mid price less a 1% allowance for fees and impact.
  // Fills (execute) use a real, size-aware Jupiter quote instead.
  quoteBuy(token: string, ethIn: bigint): bigint {
    const c = this.#curves.get(token);
    if (c) return curveBuy(c, ethIn);
    if (!this.market.has(token)) return 0n;
    const p = this.#price.get(token);
    return p ? BigInt(Math.floor((Number(ethIn) / p) * 0.99)) : 0n;
  }
  quoteSell(token: string, tokensIn: bigint): bigint {
    const c = this.#curves.get(token);
    if (c) return curveSell(c, tokensIn);
    if (!this.market.has(token)) return 0n;
    const p = this.#price.get(token);
    return p ? BigInt(Math.floor(Number(tokensIn) * p * 0.99)) : 0n;
  }

  async execute(_account: string, o: Order) {
    const c = this.#curves.get(o.token);
    if (c) {
      // A paper launch fills on its own curve, which moves with every trade.
      const out = o.kind === "buy" ? curveBuy(c, o.ethIn) : curveSell(c, o.tokensIn);
      if (out <= 0n || out < o.minOut) throw new Error("Slippage");
      const graduated = o.kind === "buy" ? curveApply(c, "buy", o.ethIn, out) : curveApply(c, "sell", out, o.tokensIn);
      return { txHash: `paper-${Date.now().toString(36)}-${++this.#fills}`, out, graduated };
    }
    if (!this.market.has(o.token)) throw new Error("not a market token");
    const [input, output, amount] = o.kind === "buy" ? [SOL_MINT, o.token, o.ethIn] : [o.token, SOL_MINT, o.tokensIn];
    const q = await this.#json<{ outAmount?: string; error?: string }>(`${JUP}/swap/v1/quote?inputMint=${input}&outputMint=${output}&amount=${amount}&slippageBps=${this.opts.slippageBps ?? 100}`);
    if (!q.outAmount) throw new Error(`no route on mainnet${q.error ? `: ${q.error}` : ""}`);
    const out = BigInt(q.outAmount);
    if (out < o.minOut) throw new Error("Slippage");
    return { txHash: `paper-${Date.now().toString(36)}-${++this.#fills}`, out };
  }
}

/** Puts the real tokens into the world as coins agents can see and trade. */
export function syncMarket(world: World, paper: PaperChain) {
  for (const t of paper.market.values()) {
    const c = world.coins.get(t.mint);
    if (c) { c.ethReserveWei = paper.reserveOf(t.mint); continue; }
    world.coins.set(t.mint, {
      token: t.mint, symbol: t.symbol, name: t.name, launcher: MARKET, launcherOwner: MARKET, opened: true,
      ethReserveWei: paper.reserveOf(t.mint), launchedAt: t.createdAt ? Date.parse(t.createdAt) : Date.now(), market: true,
      ...(t.venue ? { venue: t.venue } : {}),
    });
  }
  // Agents' paper launches: the world holds each curve (and saves it); the chain trades on the same object.
  for (const c of world.coins.values()) {
    if (!c.curve) continue;
    if (!paper.isLaunch(c.token)) paper.adopt(c.token, c.curve);
    c.ethReserveWei = c.curve.quote;
  }
}
