// Paper trading against the real Solana market. Agents trade real mainnet tokens at live prices,
// and only those: every fill is simulated, so no transaction is sent and nothing is spent. Prices
// and fills come from Jupiter's live mainnet quotes (the real pools, with size and price impact);
// the mainnet RPC double-checks each token's mint before it's tradable.

import type { ChainUnits, Order } from "@agents/core";
import type { Chain } from "../chain.js";
import type { Quoter } from "../actions.js";
import type { World } from "../world.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP = "https://lite-api.jup.ag";
/** The most ids Jupiter's price API will answer in one request. */
const PRICE_BATCH = 50;
/** Stands in for a coin's launcher and launcher's owner on market tokens: nobody in town made them. */
export const MARKET = "market";

export interface MarketToken {
  mint: string; symbol: string; name: string; decimals: number;
  liquidityUsd: number; mcapUsd?: number; change1h?: number; createdAt?: string;
  mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean;
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
}

export class PaperChain implements Chain, Quoter {
  /** Real mainnet tokens agents may trade, by mint. */
  readonly market = new Map<string, MarketToken>();
  /** Lamports per smallest token unit, from the last price refresh. */
  readonly #price = new Map<string, number>();
  #solUsd = 0;
  #fills = 0;
  readonly #fetch: typeof fetch;

  constructor(readonly units: ChainUnits, private readonly opts: PaperOptions) {
    this.#fetch = opts.fetch ?? fetch;
  }

  get solUsd() { return this.#solUsd; }
  isMarket(token: string) { return this.market.has(token); }

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
    return picked;
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
   * Live prices for every real token. Jupiter's price API answers at most PRICE_BATCH ids per
   * request (it still returns 200, just without the rest), so the ids go out in batches.
   */
  async refresh() {
    const ids = [SOL_MINT, ...this.market.keys()];
    const prices: Record<string, { usdPrice: number; liquidity?: number } | null> = {};
    for (let i = 0; i < ids.length; i += PRICE_BATCH) {
      Object.assign(prices, await this.#json<typeof prices>(`${JUP}/price/v3?ids=${ids.slice(i, i + PRICE_BATCH).join(",")}`));
    }
    this.#solUsd = prices[SOL_MINT]?.usdPrice ?? this.#solUsd;
    if (!this.#solUsd) return;
    for (const [mint, t] of this.market) {
      const p = prices[mint];
      if (!p?.usdPrice) continue;
      if (p.liquidity) t.liquidityUsd = p.liquidity;
      // USD per whole token -> lamports per smallest unit.
      this.#price.set(mint, (p.usdPrice / this.#solUsd) * 10 ** (this.units.nativeDecimals - this.units.tokenDecimals));
    }
  }

  /** Pool depth in lamports, for the town's coin list (half the pool is SOL). */
  reserveOf(mint: string): bigint {
    const t = this.market.get(mint);
    return t && this.#solUsd ? BigInt(Math.round((t.liquidityUsd / 2 / this.#solUsd) * 10 ** this.units.nativeDecimals)) : 0n;
  }

  // Quotes for decisions and risk checks: live mid price less a 1% allowance for fees and impact.
  // Fills (execute) use a real, size-aware Jupiter quote instead.
  quoteBuy(token: string, ethIn: bigint): bigint {
    if (!this.market.has(token)) return 0n;
    const p = this.#price.get(token);
    return p ? BigInt(Math.floor((Number(ethIn) / p) * 0.99)) : 0n;
  }
  quoteSell(token: string, tokensIn: bigint): bigint {
    if (!this.market.has(token)) return 0n;
    const p = this.#price.get(token);
    return p ? BigInt(Math.floor(Number(tokensIn) * p * 0.99)) : 0n;
  }

  async execute(_account: string, o: Order) {
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
    });
  }
}
