import { SOLANA_UNITS } from "@agents/core";
import { describe, expect, it } from "vitest";
import { World } from "../world.js";
import { MARKET, PaperChain, syncMarket } from "./paper.js";

const SOL = "So11111111111111111111111111111111111111112";
const GOOD = "Good1111111111111111111111111111111111111111";
const THIN = "Thin1111111111111111111111111111111111111111";
const MINTABLE = "Mint1111111111111111111111111111111111111111";
const NINE = "Nine1111111111111111111111111111111111111111";

const token = (id: string, over: Record<string, unknown> = {}) => ({
  id, symbol: id.slice(0, 4), name: `${id.slice(0, 4)} token`, decimals: 6, liquidity: 200_000, mcap: 1e6,
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true }, stats1h: { priceChange: 4 }, firstPool: { createdAt: "2026-10-01T00:00:00Z" }, ...over,
});

/** A fake Jupiter + mainnet RPC. `rpcMintAuthority` lets the chain disagree with Jupiter's audit. */
function market(rpcMintAuthority: Record<string, string | null> = {}) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (url.includes("/tokens/v2/toptrending")) return json([token(GOOD), token(THIN, { liquidity: 900 }), token(MINTABLE), token(NINE, { decimals: 9 })]);
    if (url.includes("/price/v3")) return json({ [SOL]: { usdPrice: 100 }, [GOOD]: { usdPrice: 0.5, liquidity: 300_000 } });
    if (url.includes("/swap/v1/quote")) {
      const q = new URL(url).searchParams;
      const amount = BigInt(q.get("amount")!);
      // 0.5 USD per token at 100 USD per SOL: 200 tokens per SOL, less 2% impact.
      const out = q.get("inputMint") === SOL ? (amount * 200n * 98n) / 100n / 1000n : (amount * 1000n * 98n) / 100n / 200n;
      return json({ outAmount: out.toString() });
    }
    if (url.startsWith("https://rpc")) {
      const { params } = JSON.parse(String(init?.body));
      return json({ result: { value: (params[0] as string[]).map((m) => ({ data: { parsed: { info: { decimals: 6, mintAuthority: rpcMintAuthority[m] ?? null, freezeAuthority: null } } } })) } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("paper trading the live market", () => {
  it("trades only liquid tokens with the expected decimals whose mint the chain confirms is fixed", async () => {
    const { f } = market({ [MINTABLE]: "SomeoneCanMint1111111111111111111111111111" });
    const p = new PaperChain(SOLANA_UNITS, { rpcUrl: "https://rpc.example", fetch: f });
    expect((await p.discover()).map((t) => t.mint)).toEqual([GOOD]);
  });

  it("prices from live quotes and fills at a real, size-aware quote without sending anything", async () => {
    const { f, calls } = market();
    const p = new PaperChain(SOLANA_UNITS, { rpcUrl: "https://rpc.example", fetch: f });
    await p.discover();
    await p.refresh();
    expect(p.solUsd).toBe(100);
    // 0.01 SOL at 200 tokens per SOL, less the 1% quote allowance: about 1.98 tokens (6 decimals).
    expect(p.quoteBuy(GOOD, 10_000_000n)).toBe(1_980_000n);
    const fill = await p.execute("agent", { kind: "buy", token: GOOD, ethIn: 10_000_000n, minOut: 1_900_000n } as never);
    expect(fill.out).toBe(1_960_000n);
    expect(fill.txHash).toMatch(/^paper-/);
    expect(calls.some((c) => c.includes("/swap/v1/quote"))).toBe(true);
    await expect(p.execute("agent", { kind: "buy", token: GOOD, ethIn: 10_000_000n, minOut: 2_000_000n } as never)).rejects.toThrow("Slippage");
  });

  it("lists real tokens as market coins and trades nothing else", async () => {
    const { f } = market();
    const p = new PaperChain(SOLANA_UNITS, { rpcUrl: "https://rpc.example", fetch: f });
    await p.discover();
    await p.refresh();
    // A token that isn't on the real market has no price and can't be filled.
    expect(p.isMarket("Mine111111111111111111111111111111111111111")).toBe(false);
    expect(p.quoteBuy("Mine111111111111111111111111111111111111111", 10_000_000n)).toBe(0n);
    await expect(p.execute("agent", { kind: "buy", token: "Mine111111111111111111111111111111111111111", ethIn: 10_000_000n, minOut: 0n } as never)).rejects.toThrow("not a market token");
    expect("launch" in p).toBe(false);
    const world = new World();
    world.units = SOLANA_UNITS;
    syncMarket(world, p);
    expect(world.coins.get(GOOD)).toMatchObject({ market: true, launcher: MARKET, opened: true, symbol: "GOOD" });
    // Half of 300k USD of liquidity at 100 USD per SOL: 1,500 SOL of depth.
    expect(world.coins.get(GOOD)?.ethReserveWei).toBe(1_500n * 10n ** 9n);
  });

  it("prices every tracked token even though Jupiter answers at most 50 ids per request", async () => {
    // Like the real price API: a 200 with prices for only the first 50 ids it was asked about.
    const asked: number[] = [];
    const f = (async (url: string) => {
      const ids = new URL(url).searchParams.get("ids")!.split(",");
      asked.push(ids.length);
      return new Response(JSON.stringify(Object.fromEntries(ids.slice(0, 50).map((id) => [id, { usdPrice: id === SOL ? 100 : 0.5 }]))));
    }) as unknown as typeof fetch;
    const p = new PaperChain(SOLANA_UNITS, { rpcUrl: "https://rpc.example", fetch: f });
    const mints = Array.from({ length: 120 }, (_, i) => `Tok${String(i).padStart(3, "0")}${"1".repeat(40)}`);
    for (const m of mints) p.market.set(m, { mint: m, symbol: "T", name: "T", decimals: 6, liquidityUsd: 100_000 });
    await p.refresh();
    expect(asked.every((n) => n <= 50)).toBe(true);
    expect(mints.filter((m) => p.quoteBuy(m, 10_000_000n) === 0n)).toEqual([]);
    expect(p.solUsd).toBe(100);
  });
});
