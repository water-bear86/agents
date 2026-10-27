import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, SOLANA_UNITS, planFor } from "@agents/core";
import { describe, expect, it } from "vitest";
import { applyAction } from "../actions.js";
import { loadWorld, saveWorld } from "../persist.js";
import { World, type Agent } from "../world.js";
import { PaperChain, syncMarket } from "./paper.js";
import { DEFAULT_SHAPE, StonkFunClient, curveApply, curveBuy, curveProgress, curveSell, newCurve } from "./stonkfun.js";

const SOL = "So11111111111111111111111111111111111111112";
const SF = "Stnk1111111111111111111111111111111111111111";
const TAXED = "Taxd1111111111111111111111111111111111111111";
const THIN = "Thin1111111111111111111111111111111111111111";
const LAMPORTS = 1_000_000_000n;

/** StonkFun's pricing API as it answered on 2026-10-26 (the fields the town reads). */
const PRICING = {
  data: {
    raise: { raw: "85000000000", units: 85 },
    marketCap: { startQuote: 27.95912119387466, graduationQuote: 410.8264862252296, graduationMultiple: 14.693826868751305 },
    curve: { programId: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", baseDecimals: 6, supply: "1000000000000000", totalSellA: "793100000000000", totalSupplyTokens: 1_000_000_000 },
  },
};

const sfToken = (mint: string, over: Record<string, unknown> = {}) => ({
  mint, symbol: mint.slice(0, 4).toUpperCase(), name: `${mint.slice(0, 4)} coin`, mode: "standard", status: "new", quote: { symbol: "SOL" },
  market: { priceUsd: 0.0004, liquidityUsd: 20_000, marketCapUsd: 400_000 }, graduationProgress: 0.4, createdAt: "2026-10-25T00:00:00Z", ...over,
});

/** A fake Jupiter + mainnet RPC + StonkFun API. */
function net() {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (url.includes("/tokens/v2/toptrending")) return json([]);
    if (url.includes("stonkfun.xyz/api/public/v1/launchlab/pricing")) return json(PRICING);
    if (url.includes("stonkfun.xyz/api/public/v1/tokens")) {
      // The town asks for standard mode only; a reward-mode coin here would mean it didn't.
      expect(new URL(url).searchParams.get("mode")).toBe("standard");
      return json({ data: { tokens: [sfToken(SF), sfToken(THIN, { market: { priceUsd: 0.001, liquidityUsd: 900 } }), sfToken(TAXED)] } });
    }
    if (url.includes("/price/v3")) return json({ [SOL]: { usdPrice: 100 } }); // Jupiter hasn't indexed the StonkFun coin yet.
    if (url.startsWith("https://rpc")) {
      const { params } = JSON.parse(String(init?.body));
      return json({ result: { value: (params[0] as string[]).map((m) => ({ data: { parsed: { info: { decimals: 6, mintAuthority: m === TAXED ? "Someone1111111111111111111111111111111111111" : null, freezeAuthority: null } } } })) } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const solWorld = () => { const w = new World(); w.units = SOLANA_UNITS; return w; };

const mk = (handle: string, owner: string): Agent => ({
  account: `acct-${handle}`, owner, handle, name: handle, persona: "test", modelId: "m", plan: planFor("momentum", SOLANA_UNITS), awake: true, external: false, createdAt: 0,
});

describe("StonkFun curve", () => {
  it("raising exactly 85 SOL sells exactly the tokens on the curve, then it graduates", () => {
    const c = newCurve(DEFAULT_SHAPE);
    // A buy that big after the 1% fee: 85 SOL net.
    const gross = (85n * LAMPORTS * 10_000n) / 9_900n + 1n;
    const out = curveBuy(c, gross);
    expect(Number(out) / Number(DEFAULT_SHAPE.sellable)).toBeCloseTo(1, 3);
    expect(curveApply(c, "buy", gross, out)).toBe(true);
    expect(c.graduated).toBe(true);
    expect(curveProgress(c)).toBe(1);
  });

  it("prices rise with buys, and a round trip loses the fees", () => {
    const c = newCurve(DEFAULT_SHAPE);
    const first = curveBuy(c, LAMPORTS);
    curveApply(c, "buy", LAMPORTS, first);
    const second = curveBuy(c, LAMPORTS);
    expect(second).toBeLessThan(first);
    const back = curveSell(c, first);
    expect(back).toBeLessThan(LAMPORTS);
    expect(back).toBeGreaterThan((LAMPORTS * 97n) / 100n);
    // Nobody sells tokens the curve never sold.
    expect(curveSell(newCurve(DEFAULT_SHAPE), 1_000n)).toBe(0n);
    expect(curveProgress(c)).toBeGreaterThan(0);
  });

  it("derives the curve from StonkFun's pricing API", async () => {
    const shape = await new StonkFunClient(net().f).shape();
    // A constant-product curve raising 85 SOL with a 14.69x price move starts with 30 SOL virtual.
    expect(Number(shape.virtualQuote) / 1e9).toBeCloseTo(30, 1);
    expect(Number(shape.virtualBase) / 1e15).toBeCloseTo(1.073, 2);
    expect(shape.raise).toBe(85n * LAMPORTS);
    expect(shape.sellable).toBe(793_100_000_000_000n);
  });
});

describe("StonkFun in paper mode", () => {
  it("adds liquid StonkFun coins whose mint is fixed to the market, priced from StonkFun until Jupiter knows them", async () => {
    const { f } = net();
    const p = new PaperChain(SOLANA_UNITS, { rpcUrl: "https://rpc.example", fetch: f, stonkfun: new StonkFunClient(f) });
    expect((await p.discover()).map((t) => t.mint)).toEqual([SF]);
    await p.refresh();
    const world = solWorld();
    syncMarket(world, p);
    expect(world.coins.get(SF)).toMatchObject({ venue: "stonkfun", market: true, opened: true });
    // 0.01 SOL is 1 USD, which buys 2,500 tokens at 0.0004 USD, less the 1% quote allowance.
    expect(Number(p.quoteBuy(SF, 10_000_000n)) / 1e6).toBeCloseTo(2_475, 0);
    // StonkFun's own list was read just now, so the price counts as fresh for the trading guard.
    expect(Date.now() - p.priceAt(SF)!).toBeLessThan(5_000);
  });

  it("an agent launches on a paper curve; others trade it, the launcher's fleet can't, and it survives a restart", async () => {
    const { f } = net();
    const p = new PaperChain(SOLANA_UNITS, { rpcUrl: "https://rpc.example", fetch: f, stonkfun: new StonkFunClient(f) });
    await p.discover();
    const world = solWorld();
    const [maker, sibling, buyer] = [mk("maker", "OwnerA"), mk("sibling", "OwnerA"), mk("buyer", "OwnerB")];
    for (const a of [maker, sibling, buyer]) { world.agents.set(a.account, a); world.balances.set(a.account, 10n * LAMPORTS); }

    const l = await applyAction(world, p, p, maker, { type: "launch", name: "Lantern", symbol: "LNTRN", pitch: "Light for the night market." });
    expect(l.ok).toBe(true);
    const coin = world.coins.get(l.detail)!;
    expect(coin).toMatchObject({ venue: "stonkfun", launcher: maker.account, opened: true });
    expect(coin.curve).toBe(p.curveOf(coin.token));

    expect(await applyAction(world, p, p, sibling, { type: "buy", token: coin.token, ethIn: String(LAMPORTS / 10n), reason: "family" })).toMatchObject({ ok: false, detail: "risk: own fleet's coin (anti-wash)" });
    const buy = await applyAction(world, p, p, buyer, { type: "buy", token: coin.token, ethIn: String(LAMPORTS / 10n), reason: "early on a fresh curve" });
    expect(buy.ok).toBe(true);
    expect(coin.curve!.quote).toBeGreaterThan(0n);
    syncMarket(world, p);
    expect(coin.ethReserveWei).toBe(coin.curve!.quote);

    // Saved and loaded: the curve comes back with the coin, and the chain trades on the same one.
    const file = join(mkdtempSync(join(tmpdir(), "stonk-")), "world.json");
    saveWorld(world, file);
    const again = solWorld();
    loadWorld(again, file);
    const p2 = new PaperChain(SOLANA_UNITS, { rpcUrl: "https://rpc.example", fetch: f, stonkfun: new StonkFunClient(f) });
    syncMarket(again, p2);
    const restored = again.coins.get(coin.token)!;
    expect(restored.curve?.quote).toBe(coin.curve!.quote);
    expect(p2.curveOf(coin.token)).toBe(restored.curve);
    expect(p2.quoteSell(coin.token, 1_000_000n)).toBeGreaterThan(0n);
  });

  it("announces a graduation when a buy fills the curve", async () => {
    const { f } = net();
    const p = new PaperChain(SOLANA_UNITS, { rpcUrl: "https://rpc.example", fetch: f, stonkfun: new StonkFunClient(f) });
    await p.discover();
    const world = solWorld();
    const maker = mk("maker", "OwnerA");
    // A whale with no limits, so one buy can fill the curve (real plans clip size and supply share).
    const whale: Agent = { ...mk("whale", "OwnerB"), plan: { ...PRESETS.conviction, buySizePct: 100, maxBuyWei: 1_000n * LAMPORTS, maxSupplyBps: 10_000, maxPositions: 10, maxSlippageBps: 10_000 } };
    for (const a of [maker, whale]) { world.agents.set(a.account, a); world.balances.set(a.account, 1_000n * LAMPORTS); }
    const l = await applyAction(world, p, p, maker, { type: "launch", name: "Moonrise", symbol: "MOONR", pitch: "x" });
    const buy = await applyAction(world, p, p, whale, { type: "buy", token: l.detail, ethIn: String(90n * LAMPORTS), reason: "fill it" });
    expect(buy).toMatchObject({ ok: true });
    expect(world.coins.get(l.detail)!.curve!.graduated).toBe(true);
    expect(world.highlights.at(-1)).toMatchObject({ kind: "graduated", agent: maker.account, text: "$MOONR filled its curve and graduated on StonkFun" });
  });
});
