import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SQUADS_V4, configProblems, loadConfig, squadsVault, type MainnetConfig } from "./mainnet.js";

const addr = () => Keypair.generate().publicKey.toBase58();
const filled = (): MainnetConfig => {
  const c = loadConfig();
  return {
    ...c,
    deployer: { keypair: "usb://ledger" },
    multisig: { address: addr(), vaultIndex: 0 },
    platform: { ...c.platform, inference: addr(), buyback: addr(), leftoverReceiver: addr() },
    runtime: { sessionKeyPublic: addr() },
  };
};

describe("mainnet settings", () => {
  it("the checked-in template lists exactly the owner's open decisions", () => {
    const problems = configProblems(loadConfig());
    expect(problems).toEqual(expect.arrayContaining([
      "platform.inference must be a wallet address", "multisig.address must be the Squads multisig", "deployer.keypair must point at the mainnet deployer",
    ]));
    expect(problems.some((p) => p.includes("Threshold"))).toBe(false); // the suggested thresholds are consistent
  });

  it("a filled-in config passes", () => {
    expect(configProblems(filled())).toEqual([]);
  });

  it("refuses an open threshold at or above graduation (DBC drops the hook at graduation)", () => {
    const c = filled();
    c.platform.openThresholdSol = c.platform.migrationThresholdSol;
    expect(configProblems(c)).toContain("platform.openThresholdSol must be below migrationThresholdSol (DBC removes the hook at graduation)");
  });

  it("wants different inference and buyback wallets, and a hold amount when slot gating is on", () => {
    const c = filled();
    c.platform.buyback = c.platform.inference;
    c.platform.platformMint = addr();
    c.platform.holdPerSlot = "0";
    expect(configProblems(c)).toEqual(expect.arrayContaining([
      "platform.inference and platform.buyback should be different wallets", "platform.holdPerSlot must be positive when slot gating is on",
    ]));
  });
});

describe("Squads vault", () => {
  it("derives an off-curve PDA per multisig and index, under the Squads v4 program", () => {
    const ms = Keypair.generate().publicKey;
    const v0 = squadsVault(ms, 0);
    expect(PublicKey.isOnCurve(v0.toBytes())).toBe(false);
    expect(squadsVault(ms, 1).equals(v0)).toBe(false);
    expect(v0.equals(PublicKey.findProgramAddressSync([Buffer.from("multisig"), ms.toBuffer(), Buffer.from("vault"), Buffer.from([0])], SQUADS_V4)[0])).toBe(true);
  });
});
