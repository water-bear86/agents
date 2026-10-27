import { describe, expect, it } from "vitest";
import { checkIntent } from "./risk.js";
import { planFor } from "./plan.js";
import { progress } from "./progress.js";
import { emptyCounters } from "./progress.js";
import {
  EVM_UNITS, SOLANA_UNITS, addressFamily, formatAmount, formatTokens, formatUnits, isSolanaAddress, milliNative, oneNative,
  parseUnits, sameAddress, shortAddress, spotPrice, toNumber, withTokenDecimals,
} from "./units.js";

describe("amounts", () => {
  it("formats and parses exactly in both decimal systems", () => {
    expect(formatUnits(1_500_000_000n, 9)).toBe("1.5");
    expect(formatUnits(10n ** 18n, 18)).toBe("1");
    expect(formatUnits(-25n, 2)).toBe("-0.25");
    expect(parseUnits("0.1", 9)).toBe(100_000_000n);
    expect(parseUnits("1.123456789123", 9)).toBe(1_123_456_789n); // truncates, never rounds up
    expect(parseUnits("2", 6)).toBe(2_000_000n);
    expect(() => parseUnits("abc", 9)).toThrow();
  });

  it("shows one SOL as 1.000, where the old 18-decimal formatter showed it as dust", () => {
    expect(formatAmount("1000000000", SOLANA_UNITS.nativeDecimals)).toBe("1.000");
    expect(formatAmount("1000000000", EVM_UNITS.nativeDecimals)).toBe("<0.0001");
    expect(formatAmount(-(10n ** 17n), 18, true)).toBe("−0.1000");
    expect(formatAmount(5n * 10n ** 15n, 18, true)).toBe("+0.0050");
  });

  it("formats SPL and ERC-20 supplies the same way", () => {
    expect(formatTokens(SOLANA_UNITS.tokenSupply, SOLANA_UNITS.tokenDecimals)).toBe("1.00B");
    expect(formatTokens(EVM_UNITS.tokenSupply, EVM_UNITS.tokenDecimals)).toBe("1.00B");
    expect(formatTokens(1_234_000_000n, 6)).toBe("1.2K");
  });

  it("keeps precision on large wei amounts", () => {
    expect(toNumber(123_456_789_012_345_678_901n, 18)).toBeCloseTo(123.456789012345678901, 12);
  });

  it("prices in whole coins per whole token on either chain", () => {
    // 0.001 native buys 1000 whole tokens => 1e-6 native per token, whatever the decimals.
    expect(spotPrice(milliNative(EVM_UNITS), 1000n * 10n ** 18n, EVM_UNITS)).toBeCloseTo(1e-6);
    expect(spotPrice(milliNative(SOLANA_UNITS), 1000n * 10n ** 6n, SOLANA_UNITS)).toBeCloseTo(1e-6);
    expect(spotPrice(1n, 0n, SOLANA_UNITS)).toBeNaN();
  });

  it("gives a 5-decimal token its own units, with the same one-billion-token supply", () => {
    expect(withTokenDecimals(SOLANA_UNITS, undefined)).toBe(SOLANA_UNITS);
    expect(withTokenDecimals(SOLANA_UNITS, 6)).toBe(SOLANA_UNITS);
    const five = withTokenDecimals(SOLANA_UNITS, 5);
    expect(five).toMatchObject({ tokenDecimals: 5, nativeDecimals: 9, nativeSymbol: "SOL", tokenSupply: 1_000_000_000n * 10n ** 5n });
    // 0.001 SOL buys 1000 whole BONK (1000 * 1e5 smallest units): 1e-6 SOL per BONK, not 1e-7.
    expect(spotPrice(milliNative(five), 1000n * 10n ** 5n, five)).toBeCloseTo(1e-6);
    expect(() => withTokenDecimals(SOLANA_UNITS, 19)).toThrow("unsupported token decimals");
    expect(() => withTokenDecimals(SOLANA_UNITS, 5.5)).toThrow("unsupported token decimals");
  });
});

describe("addresses", () => {
  const pk = "11111111111111111111111111111111"; // System program: 32 zero bytes
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const evm = "0x52908400098527886E0F7030069857D2E4169EE7";

  it("recognises Solana keys by decoding them to 32 bytes", () => {
    expect(isSolanaAddress(pk)).toBe(true);
    expect(isSolanaAddress(usdc)).toBe(true);
    expect(isSolanaAddress("0OIl" + usdc.slice(4))).toBe(false); // characters outside base58
    expect(isSolanaAddress("2222")).toBe(false);
    expect(addressFamily(evm)).toBe("evm");
    expect(addressFamily(usdc)).toBe("solana");
    expect(addressFamily("0xcoin1")).toBeNull();
  });

  it("shortens both kinds and leaves other ids alone", () => {
    expect(shortAddress(evm)).toBe("0x5290…9EE7");
    expect(shortAddress(usdc)).toBe("EPjF…Dt1v");
    expect(shortAddress("0xcoin1")).toBe("0xcoin1");
  });

  it("compares EVM addresses case-insensitively and Solana keys exactly", () => {
    expect(sameAddress(evm, evm.toLowerCase())).toBe(true);
    expect(sameAddress(usdc, usdc.toLowerCase())).toBe(false);
  });
});

describe("chain-aware rules", () => {
  it("presets cap a buy at 0.1 of the native coin", () => {
    expect(planFor("momentum", EVM_UNITS).maxBuyWei).toBe(oneNative(EVM_UNITS) / 10n);
    expect(planFor("momentum", SOLANA_UNITS).maxBuyWei).toBe(100_000_000n);
  });

  it("the anti-wash check doesn't lowercase Solana owners into a match", () => {
    const owner = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const coin = { token: "M", launcherOwner: owner.toLowerCase(), opened: true, totalSupply: SOLANA_UNITS.tokenSupply, quoteBuy: (e: bigint) => e * 1000n, quoteSell: (t: bigint) => t / 1000n };
    const v = checkIntent({ kind: "buy", token: "M", ethIn: 10_000_000n, reason: "" }, planFor("momentum", SOLANA_UNITS), { owner, freeWei: oneNative(SOLANA_UNITS), positions: [], now: 0 }, coin);
    expect(v.ok).toBe(true);
  });

  it("XP counts profit in thousandths of the chain's coin and names it", () => {
    const base = { counters: emptyCounters(), closes: [], volumeWei: 0n, trades: 0, jevPicks: 0, callsRight: 0, debatesWon: 0, likesReceived: 0, followers: 0 };
    expect(progress({ ...base, realizedWei: 5n * milliNative(SOLANA_UNITS) }, SOLANA_UNITS).xp).toBe(5);
    expect(progress({ ...base, realizedWei: 5n * milliNative(SOLANA_UNITS) }).xp).toBe(0); // the same lamports are dust in wei
    expect(progress({ ...base, realizedWei: 0n }, SOLANA_UNITS).badges.find((b) => b.id === "heavy_hitter")!.how).toBe("Trade 1 SOL in total volume");
  });
});
