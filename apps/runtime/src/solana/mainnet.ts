// Mainnet launch tooling. See docs/MAINNET-LAUNCH.md for the full runbook.
//
//   pnpm --filter @agents/runtime solana:mainnet preflight
//     Read-only. Checks the RPC is mainnet, Jupiter is live, the local build and what deploying it
//     costs, the deployer's balance, the settings in solana/mainnet.config.json, and (after the
//     deploy) the upgrade authority, the platform's admin and the whitelist. Sends nothing.
//
//   pnpm --filter @agents/runtime solana:mainnet setup
//     Dry run of the platform setup: what it would create and hand over. Sends nothing.
//
//   SOLANA_ALLOW_MAINNET=1 pnpm --filter @agents/runtime solana:mainnet setup --send
//     Signed by the deployer, which must still be the upgrade authority: sets up the platform,
//     whitelists the tokens in the config, then makes the owner's wallet the platform admin.
//     Spends real SOL (rent for the platform and whitelist records, about 0.002 SOL each).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { isMainnet } from "./chain.js";
import { AGENTS_PROGRAM_ID, AgentsClient, JUPITER_PROGRAM_ID, agentsProgram, pdas, type OracleSettings } from "./program.js";
import { SOL_USD_FEED, feedAccount, publishTime } from "./pyth.js";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const repo = resolve(import.meta.dirname, "../../../..");
/** Program accounts are sized at deploy; a bigger upgrade first extends the program (`solana program extend`), paying rent for the extra bytes then. */
export const DEPLOY_HEADROOM = 1;

export interface MainnetConfig {
  rpcUrl: string;
  deployer: { keypair: string };
  /** The owner's wallet: becomes the upgrade authority and the platform admin after setup. */
  owner: string;
  /** Tokens session keys may trade, each with its Pyth USD feed id (the admin can change the list later). */
  whitelist: { symbol: string; mint: string; feed: string }[];
  oracle: { maxAgeSeconds: number; maxSlippageBps: number };
  runtime: { sessionKeyPublic: string };
}

const key = (s: string): PublicKey | null => { try { return s ? new PublicKey(s) : null; } catch { return null; } };
const sol = (l: number | bigint) => `${(Number(l) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const loadKey = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(expand(p), "utf8")) as number[]));

/** Problems with the owner's settings, before anything touches the chain. */
export function configProblems(c: MainnetConfig): string[] {
  const out: string[] = [];
  if (!c.deployer.keypair) out.push("deployer.keypair must point at the mainnet deployer");
  if (!key(c.owner)) out.push("owner must be the owner's wallet address (the future upgrade authority and admin)");
  if (!Array.isArray(c.whitelist) || !c.whitelist.length) out.push("whitelist needs at least one token");
  for (const w of c.whitelist ?? []) {
    if (!key(w.mint)) out.push(`whitelist ${w.symbol}: mint ${w.mint} is not an address`);
    if (!/^(0x)?[0-9a-f]{64}$/i.test(w.feed ?? "")) out.push(`whitelist ${w.symbol}: feed must be a Pyth feed id`);
  }
  if (new Set((c.whitelist ?? []).map((w) => w.mint)).size !== (c.whitelist ?? []).length) out.push("whitelist has duplicates");
  if (!(c.oracle?.maxAgeSeconds > 0 && c.oracle.maxAgeSeconds <= 120)) out.push("oracle.maxAgeSeconds must be 1 to 120");
  if (!(c.oracle?.maxSlippageBps >= 0 && c.oracle.maxSlippageBps <= 500)) out.push("oracle.maxSlippageBps must be 0 to 500");
  return out;
}

export const oracleSettings = (c: MainnetConfig): OracleSettings => ({ maxAge: c.oracle.maxAgeSeconds, maxSlippageBps: c.oracle.maxSlippageBps });

export function loadConfig(file = join(repo, "solana", "mainnet.config.json")): MainnetConfig {
  return JSON.parse(readFileSync(file, "utf8")) as MainnetConfig;
}

type Line = { ok: boolean | null; text: string };

/** ProgramData: u32 tag, u64 slot, Option<Pubkey> authority. Undefined when not deployed. */
async function upgradeAuthority(conn: Connection): Promise<PublicKey | null | undefined> {
  if (!(await conn.getAccountInfo(AGENTS_PROGRAM_ID))) return undefined;
  const data = (await conn.getAccountInfo(pdas.programData()))?.data;
  return data && data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null;
}

export async function preflight(conn: Connection, c: MainnetConfig): Promise<Line[]> {
  const lines: Line[] = [];
  const say = (ok: boolean | null, text: string) => lines.push({ ok, text });

  const genesis = await conn.getGenesisHash();
  say(genesis === MAINNET_GENESIS, `RPC is mainnet-beta (genesis ${genesis.slice(0, 8)}…)`);
  say(!!(await conn.getAccountInfo(JUPITER_PROGRAM_ID))?.executable, `Jupiter v6 is live at ${JUPITER_PROGRAM_ID.toBase58()}`);

  const so = join(repo, "solana", "target", "deploy", "agents.so");
  const kp = join(repo, "solana", "target", "deploy", "agents-keypair.json");
  let need = 0;
  if (existsSync(so)) {
    const bytes = readFileSync(so);
    const rent = await conn.getMinimumBalanceForRentExemption(bytes.length * DEPLOY_HEADROOM + 45);
    // The upload buffer holds about the same rent until the deploy completes and refunds it.
    const buffer = await conn.getMinimumBalanceForRentExemption(bytes.length + 37);
    need = rent + buffer + 0.1 * LAMPORTS_PER_SOL;
    say(null, `agents.so: ${(bytes.length / 1024).toFixed(0)} KB, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}…, program rent ${sol(rent)} (kept), upload buffer ${sol(buffer)} (refunded)`);
  } else say(false, "agents.so not built (run solana-verify build in solana/)");
  if (existsSync(kp)) say(loadKey(kp).publicKey.equals(AGENTS_PROGRAM_ID), `program keypair matches ${AGENTS_PROGRAM_ID.toBase58()}`);
  else say(null, "program keypair not in solana/target/deploy (needed for the first deploy only)");

  const auth = await upgradeAuthority(conn);
  if (c.deployer.keypair && existsSync(expand(c.deployer.keypair))) {
    const d = loadKey(c.deployer.keypair).publicKey;
    const bal = await conn.getBalance(d);
    say(auth !== undefined ? null : bal >= need, `deployer ${d.toBase58()} holds ${sol(bal)}${auth !== undefined ? "" : `; the deploy needs ${sol(need)}`}`);
  } else say(c.deployer.keypair ? false : null, c.deployer.keypair ? `deployer keypair ${c.deployer.keypair} not found` : "deployer not set yet");

  const owner = key(c.owner);
  if (auth === undefined) say(null, `agents not deployed yet at ${AGENTS_PROGRAM_ID.toBase58()}`);
  else {
    const handed = !!owner && !!auth?.equals(owner);
    say(handed || null, `agents deployed; upgrade authority ${auth ? auth.toBase58() : "none (immutable)"}${owner && !handed ? " (not handed to the owner yet)" : ""}`);
    const platform = await agentsProgram(conn).account.platform.fetchNullable(pdas.platform());
    if (!platform) say(null, "platform not set up yet");
    else {
      const adminHanded = !!owner && platform.admin.equals(owner);
      const pending = platform.pendingAdmin.equals(PublicKey.default) ? null : platform.pendingAdmin;
      say(adminHanded || null, `platform admin ${platform.admin.toBase58()}${owner && !adminHanded ? (pending?.equals(owner) ? " (owner proposed; accept on /admin)" : " (not handed to the owner yet)") : ""}, ${platform.paused ? "session keys PAUSED" : "session keys trading"}`);
      if (pending && !pending.equals(owner ?? PublicKey.default)) say(false, `proposed admin ${pending.toBase58()} is not the owner in the config`);
      const list = (c.whitelist ?? []).map((w) => w.mint).filter(key);
      const allowed = await conn.getMultipleAccountsInfo(list.map((m) => pdas.allowed(new PublicKey(m))));
      say(allowed.every(Boolean) || null, `whitelist: ${allowed.filter(Boolean).length} of ${list.length} configured tokens set up`);
    }
  }

  // Each whitelisted token: a plain SPL mint on this cluster with 6 decimals (what the town models), and a live Pyth feed.
  const now = Date.now() / 1000;
  const feeds = [{ symbol: "SOL", feed: SOL_USD_FEED, mint: "" }, ...(c.whitelist ?? [])];
  const priceInfos = await conn.getMultipleAccountsInfo(feeds.map((f) => feedAccount(f.feed)));
  feeds.forEach((f, i) => {
    const t = priceInfos[i] ? publishTime(priceInfos[i]!.data) : null;
    const age = t === null ? null : Math.round(now - t);
    say(age !== null && age <= (c.oracle?.maxAgeSeconds ?? 120), `${f.symbol} Pyth feed ${age === null ? "missing" : `updated ${age}s ago`}`);
  });
  for (const w of (c.whitelist ?? []).filter((w) => key(w.mint))) {
    const info = await conn.getParsedAccountInfo(new PublicKey(w.mint));
    const parsed = (info.value?.data as { parsed?: { info?: { decimals: number; freezeAuthority: string | null } } } | undefined)?.parsed?.info;
    const spl = info.value?.owner.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    say(!!spl && parsed?.decimals === 6, `${w.symbol} ${w.mint}: ${spl ? "SPL Token" : "not an SPL Token mint"}, ${parsed?.decimals ?? "?"} decimals${parsed?.freezeAuthority ? ", has a freeze authority" : ""}`);
  }
  say(null, key(c.runtime.sessionKeyPublic) ? `runtime session key ${c.runtime.sessionKeyPublic}` : "runtime session key not set yet (needed before the runtime trades on mainnet, not for the deploy)");
  for (const p of configProblems(c)) say(false, p);
  if (!configProblems(c).length) say(true, "mainnet.config.json settings are complete");
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

  if (cmd === "setup") {
    const problems = configProblems(c);
    if (problems.length) { console.log(`Fix first:\n  ${problems.join("\n  ")}`); process.exit(1); }
    const deployer = loadKey(c.deployer.keypair);
    const owner = new PublicKey(c.owner);
    const client = new AgentsClient(agentsProgram(conn));
    const platform = await client.program.account.platform.fetchNullable(pdas.platform());
    const plan: { what: string; ix: () => Promise<TransactionInstruction> }[] = [];
    if (!platform) plan.push({ what: `set up the platform (admin: the deployer ${deployer.publicKey.toBase58()} for now; prices no older than ${c.oracle.maxAgeSeconds}s, slippage up to ${c.oracle.maxSlippageBps / 100}%)`, ix: () => client.initPlatformIx(deployer.publicKey, oracleSettings(c)) });
    const admin = platform?.admin ?? deployer.publicKey;
    if (!admin.equals(deployer.publicKey) && !admin.equals(owner)) throw new Error(`platform admin is ${admin.toBase58()}, neither the deployer nor the owner`);
    if (admin.equals(deployer.publicKey)) {
      const have = await conn.getMultipleAccountsInfo(c.whitelist.map((w) => pdas.allowed(new PublicKey(w.mint))));
      c.whitelist.forEach((w, i) => { if (!have[i]) plan.push({ what: `whitelist ${w.symbol} (${w.mint})`, ix: () => client.allowMintIx(deployer.publicKey, new PublicKey(w.mint), w.feed) }); });
      plan.push({ what: `propose the owner ${owner.toBase58()} as platform admin (the owner accepts from their wallet)`, ix: () => client.setAdminIx(deployer.publicKey, owner) });
    }
    if (!plan.length) { console.log("Nothing to do: the platform is set up and the owner is its admin."); return; }
    console.log("Setup, signed by the deployer:");
    for (const p of plan) console.log(`  - ${p.what}`);
    console.log("Then the owner accepts the admin role on /admin, which proves the wallet is theirs, and only then: solana:mainnet handover");
    if (!flags.includes("--send")) { console.log("\nDry run: nothing sent. Add --send (with SOLANA_ALLOW_MAINNET=1) to do it."); return; }
    if ((isMainnet(url) || (await conn.getGenesisHash()) === MAINNET_GENESIS) && process.env.SOLANA_ALLOW_MAINNET !== "1") {
      throw new Error("refusing to send on mainnet without SOLANA_ALLOW_MAINNET=1");
    }
    // Setup first, whitelist entries a few per transaction, the admin handover last on its own.
    const steps = [...plan];
    while (steps.length) {
      const n = steps[0]!.what.startsWith("whitelist") ? Math.min(6, steps.filter((s) => s.what.startsWith("whitelist")).length) : 1;
      const batch = steps.splice(0, n);
      const tx = new Transaction().add(...(await Promise.all(batch.map((b) => b.ix()))));
      const sig = await sendAndConfirmTransaction(conn, tx, [deployer], { commitment: "confirmed" });
      console.log(`  ✓ ${batch.map((b) => b.what).join("; ")}  ${sig}`);
    }
    return;
  }

  if (cmd === "handover") {
    // The upgrade authority moves without the new holder signing, so only to a wallet that has
    // already proved itself by accepting the admin role on-chain.
    const owner = new PublicKey(c.owner);
    const platform = await agentsProgram(conn).account.platform.fetchNullable(pdas.platform());
    if (!platform?.admin.equals(owner)) {
      console.log(`Not yet: the platform admin is ${platform?.admin.toBase58() ?? "(no platform)"}. The owner ${owner.toBase58()} must accept the admin role on /admin first.`);
      process.exit(1);
    }
    console.log(`The owner ${owner.toBase58()} accepted the admin role, so it holds that key. Hand it the upgrade authority:\n`);
    console.log(`solana program set-upgrade-authority ${AGENTS_PROGRAM_ID.toBase58()} --new-upgrade-authority ${owner.toBase58()} --skip-new-upgrade-authority-signer-check -u "$SOLANA_RPC_URL" -k ${c.deployer.keypair}`);
    return;
  }

  console.log("usage: solana:mainnet preflight | setup [--send] | handover");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
