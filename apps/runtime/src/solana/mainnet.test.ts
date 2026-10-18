import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { configProblems, loadConfig, type MainnetConfig } from "./mainnet.js";

const addr = () => Keypair.generate().publicKey.toBase58();
const filled = (): MainnetConfig => ({ ...loadConfig(), owner: addr(), runtime: { sessionKeyPublic: addr() } });

describe("mainnet settings", () => {
  it("the checked-in config is complete", () => {
    expect(configProblems(loadConfig())).toEqual([]);
    expect(configProblems({ ...loadConfig(), owner: "" })).toEqual(["owner must be the owner's wallet address (the future upgrade authority and admin)"]);
  });

  it("a filled-in config passes", () => {
    expect(configProblems(filled())).toEqual([]);
  });

  it("wants a whitelist of real, distinct mints, each with a Pyth feed", () => {
    const c = filled();
    const feed = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
    expect(configProblems({ ...c, whitelist: [] })).toContain("whitelist needs at least one token");
    expect(configProblems({ ...c, whitelist: [{ symbol: "X", mint: "nope", feed }] })).toContain("whitelist X: mint nope is not an address");
    expect(configProblems({ ...c, whitelist: [{ symbol: "X", mint: addr(), feed: "abc" }] })).toContain("whitelist X: feed must be a Pyth feed id");
    const m = addr();
    expect(configProblems({ ...c, whitelist: [{ symbol: "A", mint: m, feed }, { symbol: "B", mint: m, feed }] })).toContain("whitelist has duplicates");
  });

  it("keeps the oracle settings inside what the program accepts", () => {
    expect(configProblems({ ...filled(), oracle: { maxAgeSeconds: 0, maxSlippageBps: 300 } })).toContain("oracle.maxAgeSeconds must be 1 to 120");
    expect(configProblems({ ...filled(), oracle: { maxAgeSeconds: 600, maxSlippageBps: 300 } })).toContain("oracle.maxAgeSeconds must be 1 to 120");
    expect(configProblems({ ...filled(), oracle: { maxAgeSeconds: 60, maxSlippageBps: 1000 } })).toContain("oracle.maxSlippageBps must be 0 to 500");
  });
});
