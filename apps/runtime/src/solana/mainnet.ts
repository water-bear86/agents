// Mainnet launch tooling. See docs/MAINNET-LAUNCH.md for the full runbook.
//
//   pnpm --filter @agents/runtime solana:mainnet preflight
//     Read-only. Checks the RPC is mainnet, DBC is live, our program ids, the local builds and
//     what deploying them costs, the deployer's balance, the Squads multisig and its vault, the
//     settings in solana/mainnet.config.json, and (after deploying) the upgrade authority and
//     the Platform record. Sends nothing.
//
//   pnpm --filter @agents/runtime solana:mainnet platform
//     Dry run: prints the DBC config and Platform settings it would create. Sends nothing.
//
//   SOLANA_ALLOW_MAINNET=1 pnpm --filter @agents/runtime solana:mainnet platform --send
//     Creates the DBC config and the Platform record, paid by the deployer, which must still be
//     the agents program's upgrade authority. Spends real SOL (about 0.01). Run it only after
//     the programs are deployed and before handing the upgrade authority to the multisig.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { isMainnet } from "./chain.js";
import { agentsCurve } from "./dbc.js";
import { AGENTS_PROGRAM_ID, DBC_PROGRAM_ID, HOOK_PROGRAM_ID, agentsProgram, pdas } from "./program.js";
import { programDataAddress, setupPlatform } from "./setup.js";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const SQUADS_V4 = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const repo = resolve(import.meta.dirname, "../../../..");

export interface MainnetConfig {
  rpcUrl: string;
  deployer: { keypair: string };
  multisig: { address: string; vaultIndex: number };
  platform: {
    migrationThresholdSol: number; openThresholdSol: number; openWindowHours: number; launchCooldownSec: number;
    inference: string; buyback: string; leftoverReceiver: string; platformMint: string; holdPerSlot: string;
  };
  runtime: { sessionKeyPublic: string };
}

/** Squads v4 vault PDA: the address that becomes the upgrade authority. */
export const squadsVault = (multisig: PublicKey, index = 0) =>
  PublicKey.findProgramAddressSync([Buffer.from("multisig"), multisig.toBuffer(), Buffer.from("vault"), Buffer.from([index])], SQUADS_V4)[0];

const key = (s: string): PublicKey | null => { try { return s ? new PublicKey(s) : null; } catch { return null; } };
const sol = (l: number | bigint) => `${(Number(l) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Problems with the owner's settings, before anything touches the chain. */
export function configProblems(c: MainnetConfig): string[] {
  const out: string[] = [];
  const p = c.platform;
  if (!(p.openThresholdSol > 0)) out.push("platform.openThresholdSol must be positive");
  if (!(p.openThresholdSol < p.migrationThresholdSol)) out.push("platform.openThresholdSol must be below migrationThresholdSol (DBC removes the hook at graduation)");
  if (!(p.openWindowHours > 0)) out.push("platform.openWindowHours must be positive");
  if (p.launchCooldownSec < 0) out.push("platform.launchCooldownSec can't be negative");
  for (const f of ["inference", "buyback", "leftoverReceiver"] as const) if (!key(p[f])) out.push(`platform.${f} must be a wallet address`);
  if (p.inference && p.inference === p.buyback) out.push("platform.inference and platform.buyback should be different wallets");
  if (p.platformMint && !key(p.platformMint)) out.push("platform.platformMint is not an address");
  if (p.platformMint && BigInt(p.holdPerSlot || "0") <= 0n) out.push("platform.holdPerSlot must be positive when slot gating is on");
  if (!key(c.multisig.address)) out.push("multisig.address must be the Squads multisig");
  if (!c.deployer.keypair) out.push("deployer.keypair must point at the mainnet deployer");
  if (!key(c.runtime.sessionKeyPublic)) out.push("runtime.sessionKeyPublic must be the runtime's session key");
  return out;
}

export function loadConfig(file = join(repo, "solana", "mainnet.config.json")): MainnetConfig {
  return JSON.parse(readFileSync(file, "utf8")) as MainnetConfig;
}

type Line = { ok: boolean | null; text: string };

export async function preflight(conn: Connection, c: MainnetConfig): Promise<Line[]> {
  const lines: Line[] = [];
  const say = (ok: boolean | null, text: string) => lines.push({ ok, text });

  const genesis = await conn.getGenesisHash();
  say(genesis === MAINNET_GENESIS, `RPC is mainnet-beta (genesis ${genesis.slice(0, 8)}…)`);

  const dbc = await conn.getAccountInfo(DBC_PROGRAM_ID);
  say(!!dbc?.executable, `Meteora DBC is live at ${DBC_PROGRAM_ID.toBase58()}`);

  // Local builds and what deploying them costs. The loader refunds the write buffer before it charges for the program, so the peak is the larger program's rent.
  let rentTotal = 0;
  let peak = 0;
  for (const [name, id] of [["agents", AGENTS_PROGRAM_ID], ["agents_hook", HOOK_PROGRAM_ID]] as const) {
    const so = join(repo, "solana", "target", "deploy", `${name}.so`);
    const kp = join(repo, "solana", "target", "deploy", `${name}-keypair.json`);
    if (!existsSync(so)) { say(false, `${name}.so not built (run solana-verify build in solana/)`); continue; }
    const bytes = readFileSync(so);
    const rent = await conn.getMinimumBalanceForRentExemption(bytes.length + 45);
    rentTotal += rent;
    peak = Math.max(peak, rent);
    say(null, `${name}.so: ${(bytes.length / 1024).toFixed(0)} KB, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}…, rent ${sol(rent)}`);
    if (existsSync(kp)) {
      const pub = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kp, "utf8")) as number[])).publicKey;
      say(pub.equals(id), `${name} program keypair matches ${id.toBase58()}`);
    } else say(null, `${name} program keypair not in solana/target/deploy (needed for the first deploy only)`);
  }
  say(null, `Deploying both costs about ${sol(rentTotal)} in rent, plus fees; the deployer needs at least ${sol(rentTotal + 0.1 * LAMPORTS_PER_SOL)}`);

  if (c.deployer.keypair && !c.deployer.keypair.startsWith("usb://") && existsSync(expand(c.deployer.keypair))) {
    const d = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(expand(c.deployer.keypair), "utf8")) as number[])).publicKey;
    const bal = await conn.getBalance(d);
    say(bal >= rentTotal + 0.1 * LAMPORTS_PER_SOL, `deployer ${d.toBase58()} holds ${sol(bal)}`);
  } else say(null, c.deployer.keypair ? `deployer ${c.deployer.keypair} (hardware wallet or not on this machine; check its balance with solana balance)` : "deployer not set yet");

  // Squads multisig and its vault.
  const ms = key(c.multisig.address);
  let vault: PublicKey | null = null;
  if (ms) {
    const info = await conn.getAccountInfo(ms);
    say(!!info && info.owner.equals(SQUADS_V4), `multisig ${ms.toBase58()} is a Squads v4 account`);
    vault = squadsVault(ms, c.multisig.vaultIndex);
    say(null, `its vault ${c.multisig.vaultIndex} (the future upgrade authority) is ${vault.toBase58()}`);
  } else say(false, "multisig.address not set");

  // Our programs: before the deploy they don't exist; afterwards their upgrade authority should be the vault.
  for (const [name, id] of [["agents", AGENTS_PROGRAM_ID], ["agents_hook", HOOK_PROGRAM_ID]] as const) {
    const prog = await conn.getAccountInfo(id);
    if (!prog) { say(null, `${name} not deployed yet at ${id.toBase58()}`); continue; }
    const pd = PublicKey.findProgramAddressSync([id.toBuffer()], UPGRADEABLE_LOADER)[0];
    const data = (await conn.getAccountInfo(pd))?.data;
    // ProgramData: u32 tag, u64 slot, Option<Pubkey> authority.
    const authority = data && data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null;
    const owner = authority ? authority.toBase58() : "none (immutable)";
    say(vault ? !!authority?.equals(vault) : null, `${name} deployed; upgrade authority ${owner}${vault && !authority?.equals(vault) ? " (not the multisig vault yet)" : ""}`);
  }
  if (await conn.getAccountInfo(AGENTS_PROGRAM_ID)) {
    const platform = await agentsProgram(conn).account.platform.fetchNullable(pdas.platform());
    say(null, platform ? `Platform set up: DBC config ${platform.dbcConfig.toBase58()}, open at ${sol(BigInt(platform.openThreshold.toString()))}` : "Platform not set up yet");
    if (platform) {
      say(platform.inference.toBase58() === c.platform.inference && platform.buyback.toBase58() === c.platform.buyback, "Platform's fee recipients match mainnet.config.json");
    }
  }

  for (const p of configProblems(c)) say(false, p);
  if (!configProblems(c).length) say(true, "mainnet.config.json settings are complete and consistent");
  return lines;
}

async function main() {
  const [cmd, ...flags] = process.argv.slice(2);
  const c = loadConfig();
  const url = process.env.SOLANA_RPC_URL ?? c.rpcUrl;
  const conn = new Connection(url, "confirmed");

  if (cmd === "preflight") {
    const lines = await preflight(conn, c);
    for (const l of lines) console.log(`${l.ok === null ? "  ·" : l.ok ? "  ✓" : "  ✗"} ${l.text}`);
    const bad = lines.filter((l) => l.ok === false).length;
    console.log(bad ? `\n${bad} item(s) to fix before launch` : "\nready");
    process.exit(bad ? 1 : 0);
  }

  if (cmd === "platform") {
    const problems = configProblems(c).filter((p) => !p.startsWith("multisig") && !p.startsWith("runtime"));
    const p = c.platform;
    const curve = agentsCurve({ migrationQuoteThresholdSol: p.migrationThresholdSol, token2022: true });
    console.log("DBC config (Token-2022 coins with the agents hook, fees claimable by the agents program):");
    console.log(`  fee claimer ${pdas.fees().toBase58()} (agents program's fees PDA), leftover receiver ${p.leftoverReceiver || "(unset)"}`);
    console.log(`  1.25% flat fee, 80% of the platform's part to the launcher, graduation at ${p.migrationThresholdSol} SOL into DAMM v2 with LP locked`);
    console.log(`  migration quote threshold ${curve.migrationQuoteThreshold.toString()} lamports, supply 1B at 6 decimals`);
    console.log("Platform record:");
    console.log(`  open threshold ${p.openThresholdSol} SOL, opening window ${p.openWindowHours} h, launch cooldown ${p.launchCooldownSec} s`);
    console.log(`  inference ${p.inference || "(unset)"}, buyback ${p.buyback || "(unset)"}, slot gating ${p.platformMint ? `${p.holdPerSlot} of ${p.platformMint}` : "off"}`);
    console.log(`  program data ${programDataAddress().toBase58()} (its upgrade authority must sign)`);
    if (problems.length) { console.log(`\nFix first:\n  ${problems.join("\n  ")}`); process.exit(1); }
    if (!flags.includes("--send")) { console.log("\nDry run: nothing sent. Add --send (with SOLANA_ALLOW_MAINNET=1) to create these."); return; }
    if (isMainnet(url) || (await conn.getGenesisHash()) === MAINNET_GENESIS) {
      if (process.env.SOLANA_ALLOW_MAINNET !== "1") throw new Error("refusing to send on mainnet without SOLANA_ALLOW_MAINNET=1");
    }
    if (c.deployer.keypair.startsWith("usb://")) throw new Error("this script signs with a keypair file; with a Ledger, run the same steps through the Anchor CLI or a signer that supports it");
    const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(expand(c.deployer.keypair), "utf8")) as number[]));
    const r = await setupPlatform(conn, agentsProgram(conn), admin, {
      migrationThresholdSol: p.migrationThresholdSol, openThresholdLamports: BigInt(Math.round(p.openThresholdSol * LAMPORTS_PER_SOL)),
      openWindowSec: Math.round(p.openWindowHours * 3600), launchCooldownSec: p.launchCooldownSec,
      inference: new PublicKey(p.inference), buyback: new PublicKey(p.buyback), leftoverReceiver: new PublicKey(p.leftoverReceiver),
      platformMint: p.platformMint ? new PublicKey(p.platformMint) : undefined, holdPerSlot: BigInt(p.holdPerSlot || "0"),
    });
    console.log(`\nDBC config ${r.config.toBase58()}\n  config tx ${r.configSig}\n  platform tx ${r.platformSig}`);
    return;
  }

  console.log("usage: solana:mainnet preflight | platform [--send]");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
