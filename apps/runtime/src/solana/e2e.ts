// End to end on a real cluster: sets up the platform (DBC config with our transfer hook, the
// agents program's Platform), creates two agents from their owners' wallets, then drives
// launches and trades through the runtime's own applyAction path and checks every rule the
// EVM contracts enforce, now enforced by the Solana programs.
//
//   Local validator (programs from `anchor build`, DBC and Token Metadata cloned from devnet):
//     pnpm --filter @agents/runtime solana:validator      # in another terminal
//     SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm --filter @agents/runtime solana:e2e
//   Devnet (after `anchor deploy --provider.cluster devnet` from solana/, with a funded key):
//     SOLANA_RPC_URL=https://api.devnet.solana.com pnpm --filter @agents/runtime solana:e2e
//
// Keys live outside the repo in ~/.config/agents-solana-devnet (override with SOLANA_KEY_DIR).
// It refuses to run against mainnet.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SOLANA_UNITS, formatUnits, planFor, type Style } from "@agents/core";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { applyAction } from "../actions.js";
import { World, type Agent } from "../world.js";
import { SolanaAgentChain, isMainnet } from "./chain.js";
import { MeteoraDbcVenue } from "./dbc.js";
import { SolanaIndexer, SolanaQuoter, programSource } from "./indexer.js";
import { AgentsClient, DBC_PROGRAM_ID, agentsProgram, bn, coinAta, dbc, hookAccounts, pdas, wsolAta } from "./program.js";
import { createAgentIx, programDataAddress, sendIxs, setupPlatform } from "./setup.js";

const url = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
if (isMainnet(url)) throw new Error("refusing to run against mainnet");
const cluster = /127\.0\.0\.1|localhost/.test(url) ? "localnet" : /devnet/.test(url) ? "devnet" : "custom";
const dir = process.env.SOLANA_KEY_DIR ?? join(homedir(), ".config", "agents-solana-devnet");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const local = cluster === "localnet";

const sol = (l: bigint | number) => `${formatUnits(BigInt(l), 9)} SOL`;
const link = (sig: string) => local ? sig.slice(0, 16) + "…" : `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
let failures = 0;
const ok = (what: string, detail = "") => console.log(`  ✓ ${what}${detail ? `: ${detail}` : ""}`);
const bad = (what: string, detail = "") => { failures++; console.log(`  ✗ ${what}${detail ? `: ${detail}` : ""}`); };
async function refused(what: string, expect: RegExp, run: () => Promise<unknown>) {
  try { await run(); bad(what, "went through"); } catch (e) {
    const m = (e as Error).message;
    if (expect.test(m)) ok(what, `refused (${m.slice(0, 80)})`); else bad(what, `refused for the wrong reason: ${m.slice(0, 200)}`);
  }
}

function keypair(name: string): Keypair {
  const f = join(dir, `${name}.json`);
  if (!existsSync(f)) writeFileSync(f, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, "utf8")) as number[]));
}

const conn = new Connection(url, "confirmed");
const admin = keypair("runtime"); // pays for setup; also the runtime's session key
const run = Date.now().toString(36).slice(-4);
console.log(`cluster ${cluster} (${url})\nadmin/session key ${admin.publicKey.toBase58()}`);

let balance = await conn.getBalance(admin.publicKey);
if (local && balance < 20 * LAMPORTS_PER_SOL) {
  await conn.confirmTransaction(await conn.requestAirdrop(admin.publicKey, 50 * LAMPORTS_PER_SOL), "confirmed");
  balance = await conn.getBalance(admin.publicKey);
}
if (balance < 1.5 * LAMPORTS_PER_SOL) throw new Error(`fund ${admin.publicKey.toBase58()} on ${cluster} (has ${sol(balance)})`);
console.log(`balance ${sol(balance)}`);

const program = agentsProgram(conn);
for (const id of [program.programId, new PublicKey("8ERRnkHC3UfwzoD6cxfVAcFkGhdeUMTG9pAvwZyY4dB9"), DBC_PROGRAM_ID]) {
  if (!(await conn.getAccountInfo(id))?.executable) throw new Error(`program ${id.toBase58()} is not deployed on ${cluster}`);
}

// ---------------------------------------------------------------- platform (once per deployment)
const inference = keypair("inference").publicKey;
const buyback = keypair("buyback").publicKey;
const OPEN_THRESHOLD = BigInt(LAMPORTS_PER_SOL / 20); // 0.05 SOL: tiny so the test can open a coin
const stateFile = join(dir, `platform-${cluster}.json`);
let config: PublicKey;
const existing = await program.account.platform.fetchNullable(pdas.platform());
if (existing) {
  config = existing.dbcConfig;
  console.log(`\nplatform exists, DBC config ${config.toBase58()}`);
} else {
  console.log("\nsetting up the platform");
  const intruder = keypair("outsider");
  if (BigInt(await conn.getBalance(intruder.publicKey)) < BigInt(LAMPORTS_PER_SOL / 5)) {
    await sendIxs(conn, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: intruder.publicKey, lamports: LAMPORTS_PER_SOL / 5 })], [admin]);
  }
  await refused("a stranger front-runs platform setup", /NotUpgradeAuthority/, async () => sendIxs(conn, [await program.methods.initPlatform({
    dbcConfig: intruder.publicKey, platformMint: PublicKey.default, holdPerSlot: bn(0), inference: intruder.publicKey, buyback: intruder.publicKey,
    openThreshold: bn(1), openWindow: bn(1), launchCooldown: bn(0),
  }).accountsStrict({ admin: intruder.publicKey, platform: pdas.platform(), program: program.programId, programData: programDataAddress(), systemProgram: PublicKey.default }).instruction()], [intruder]));
  const r = await setupPlatform(conn, program, admin, {
    migrationThresholdSol: 5, openThresholdLamports: OPEN_THRESHOLD, openWindowSec: 24 * 3600, launchCooldownSec: 3600, inference, buyback,
  });
  config = r.config;
  writeFileSync(stateFile, JSON.stringify({ config: config.toBase58(), inference: inference.toBase58(), buyback: buyback.toBase58() }, null, 2));
  ok("DBC config with our transfer hook", `${config.toBase58()} ${link(r.configSig)}`);
  ok("Platform record", link(r.platformSig));
}
const client = new AgentsClient(program, config);
const chain = new SolanaAgentChain(conn, client, admin);

// ---------------------------------------------------------------- agents, created by their owners
console.log("\ncreating agents (owner wallets sign and fund)");
const world = new World();
world.units = SOLANA_UNITS;
const MAX_TRADE = BigInt(LAMPORTS_PER_SOL / 10);
const agents: Agent[] = [];
const owners: Keypair[] = [];
for (const [name, style] of [["atlas", "momentum"], ["vesper", "contrarian"]] as [string, Style][]) {
  const handle = `${name.slice(0, 6)}${run}`;
  const owner = keypair(`owner-${name}`);
  const need = BigInt(0.8 * LAMPORTS_PER_SOL);
  const have = BigInt(await conn.getBalance(owner.publicKey));
  if (have < need) await sendIxs(conn, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner.publicKey, lamports: need - have })], [admin]);
  const sig = await sendIxs(conn, [await createAgentIx(program, owner.publicKey, {
    handle, modelId: "demo/model", sessionKey: admin.publicKey, maxTradeLamports: MAX_TRADE, dailyLimitLamports: BigInt(LAMPORTS_PER_SOL / 5),
    fundLamports: BigInt(LAMPORTS_PER_SOL / 2),
  })], [owner]);
  const agent = pdas.agent(handle);
  const a: Agent = { account: agent.toBase58(), owner: owner.publicKey.toBase58(), handle, name: handle, persona: "", modelId: "demo/model", plan: planFor(style, SOLANA_UNITS), awake: true, external: false, createdAt: Date.now() };
  world.agents.set(a.account, a);
  agents.push(a);
  owners.push(owner);
  ok(`@${handle}`, `agent ${a.account}, vault ${pdas.vault(agent).toBase58()} ${link(sig)}`);
}
const [atlas, vesper] = agents as [Agent, Agent];
const [atlasOwner, vesperOwner] = owners as [Keypair, Keypair];
await refused("handle taken", /already in use|0x0/, async () => sendIxs(conn, [await createAgentIx(program, vesperOwner.publicKey, {
  handle: atlas.handle, modelId: "x", sessionKey: admin.publicKey, maxTradeLamports: 1n, dailyLimitLamports: 1n, fundLamports: 0n,
})], [vesperOwner]));
await refused("bad handle", /BadHandle/, async () => sendIxs(conn, [await createAgentIx(program, vesperOwner.publicKey, {
  handle: "Bad-Handle", modelId: "x", sessionKey: admin.publicKey, maxTradeLamports: 1n, dailyLimitLamports: 1n, fundLamports: 0n,
})], [vesperOwner]));

const venue = new MeteoraDbcVenue(conn, config);
const indexer = new SolanaIndexer(conn, programSource(client), venue, world);
venue.opensOf = (m) => { const r = indexer.records.get(m); return r ? r.opened || Date.now() >= r.opensAt : undefined; };
const quoter = new SolanaQuoter(venue);
await indexer.syncBalances();

const act = async (label: string, agent: Agent, action: Parameters<typeof applyAction>[4]) => {
  const r = await applyAction(world, chain, quoter, agent, action);
  if (r.ok) ok(label, `${r.detail.slice(0, 90)}${r.txHash ? ` ${link(r.txHash)}` : ""}`); else bad(label, r.detail);
  return r;
};

// ---------------------------------------------------------------- launch and agents-only phase
console.log("\nlaunch (through applyAction -> SolanaAgentChain -> agents.launch -> DBC)");
const symbol = `A${run.toUpperCase()}`;
const launched = await act("atlas launches", atlas, { type: "launch", name: `Atlas ${run}`, symbol, pitch: "e2e" });
const mint = new PublicKey(launched.detail);
await indexer.pass();
await quoter.refresh([mint.toBase58()]);
const coinRec = await program.account.coin.fetch(pdas.coin(mint));
ok("coin recorded on-chain", `${coinRec.symbol}, opens at ${new Date(Number(coinRec.opensAt) * 1000).toISOString()}, opened=${coinRec.opened}`);
await refused("second launch inside the cooldown", /Cooldown/, () => chain.launch(atlas.account, "again", "AGN"));

console.log("\nagents-only phase");
await act("vesper (an agent) buys during the phase", vesper, { type: "buy", token: mint.toBase58(), ethIn: String(LAMPORTS_PER_SOL / 50), reason: "e2e" });

const outsider = keypair("outsider");
if (BigInt(await conn.getBalance(outsider.publicKey)) < BigInt(LAMPORTS_PER_SOL / 5)) {
  await sendIxs(conn, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: outsider.publicKey, lamports: LAMPORTS_PER_SOL / 5 })], [admin]);
}
const dbcClient = new DynamicBondingCurveClient(conn, "confirmed");
/** A plain DBC buy by a wallet that isn't an agent, bypassing our program: only the hook can stop it. */
async function outsiderBuy(m: PublicKey, lamports: number) {
  const pool = dbc.pool(config, m);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(outsider.publicKey, wsolAta(outsider.publicKey), outsider.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(outsider.publicKey, coinAta(outsider.publicKey, m), outsider.publicKey, m, TOKEN_2022_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: outsider.publicKey, toPubkey: wsolAta(outsider.publicKey), lamports }),
    createSyncNativeInstruction(wsolAta(outsider.publicKey)),
    await dbcClient.pool.program.methods.swap2WithTransferHook(
      { amount0: bn(lamports), amount1: bn(1), swapMode: 0 },
      { slices: [{ accountsType: { transferHookBase: {} }, length: 5 }] },
    ).accountsPartial({
      poolAuthority: dbc.poolAuthority, config, pool, inputTokenAccount: wsolAta(outsider.publicKey), outputTokenAccount: coinAta(outsider.publicKey, m),
      baseVault: dbc.baseVault(m, pool), quoteVault: dbc.quoteVault(pool), baseMint: m, quoteMint: NATIVE_MINT, payer: outsider.publicKey,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    }).remainingAccounts(hookAccounts(m, outsider.publicKey)).instruction(),
  ];
  return sendIxs(conn, ixs, [outsider]);
}
await refused("an outsider buys straight from the DBC pool during the phase", /AgentsOnly/, () => outsiderBuy(mint, LAMPORTS_PER_SOL / 100));

// Owner-only withdrawals, and the phase applies to the owner's coins too.
const vesperAgent = new PublicKey(vesper.account);
const vesperVault = pdas.vault(vesperAgent);
const withdrawSol = (signer: Keypair, lamports: bigint) => program.methods.withdrawSol(bn(lamports))
  .accountsStrict({ owner: signer.publicKey, agent: vesperAgent, vault: vesperVault, to: signer.publicKey, systemProgram: PublicKey.default }).instruction();
await refused("the session key withdraws from a vault", /NotOwner/, async () => sendIxs(conn, [await withdrawSol(admin, 1_000_000n)], [admin]));
const wsig = await sendIxs(conn, [await withdrawSol(vesperOwner, 1_000_000n)], [vesperOwner]);
ok("the owner withdraws SOL", link(wsig));
const coinsHeld = world.positions.get(vesper.account)?.find((p) => p.token === mint.toBase58())?.amount ?? 0n;
const withdrawCoins = async () => sendIxs(conn, [
  createAssociatedTokenAccountIdempotentInstruction(vesperOwner.publicKey, coinAta(vesperOwner.publicKey, mint), vesperOwner.publicKey, mint, TOKEN_2022_PROGRAM_ID),
  await program.methods.withdrawToken(bn(coinsHeld / 10n)).accountsStrict({
    owner: vesperOwner.publicKey, agent: vesperAgent, vault: vesperVault, mint, from: coinAta(vesperVault, mint), to: coinAta(vesperOwner.publicKey, mint), tokenProgram: TOKEN_2022_PROGRAM_ID,
  }).remainingAccounts(hookAccounts(mint, vesperOwner.publicKey)).instruction(),
], [vesperOwner]);
await refused("the owner pulls coins out to a wallet during the phase", /AgentsOnly/, withdrawCoins);

// ---------------------------------------------------------------- caps and minOut, enforced by the program
console.log("\nsession-key limits (sent straight to the program, skipping the runtime's own checks)");
const directBuy = async (lamports: bigint, minOut: bigint) => chain.send(await client.tradeIxs({ side: "buy", operator: admin.publicKey, agent: vesperAgent, mint, amountIn: lamports, minOut }), []);
await refused("a buy over the per-trade cap", /OverTradeCap/, () => directBuy(MAX_TRADE + 1n, 1n));
await refused("a buy with minOut = 0", /MinOutRequired/, () => directBuy(1_000_000n, 0n));
await refused("a buy whose minOut can't be met", /Slippage|0x1774|ExceededSlippage/, () => directBuy(1_000_000n, 10n ** 15n));
await refused("a stranger signing as the operator", /NotAuthorized/, async () => sendIxs(conn, await client.tradeIxs({ side: "buy", operator: outsider.publicKey, agent: vesperAgent, mint, amountIn: 1_000_000n, minOut: 1n }), [outsider]));
await directBuy(MAX_TRADE, 1n).then(() => ok("a buy at the cap goes through"), (e) => bad("a buy at the cap", (e as Error).message));
await refused("a buy over the daily cap", /OverDailyCap/, () => directBuy(MAX_TRADE, 1n));

// ---------------------------------------------------------------- opening
console.log("\nopening");
await indexer.pass();
const ready = await indexer.readyToOpen();
if (ready.includes(mint.toBase58())) ok("indexer sees the threshold reached", sol(world.coins.get(mint.toBase58())!.ethReserveWei)); else bad("threshold not reached", sol(world.coins.get(mint.toBase58())!.ethReserveWei));
const cranked = await indexer.crank(chain, client, Number.MAX_SAFE_INTEGER);
ok("crank", cranked.join("; ") || "nothing to do");
await indexer.pass();
const opened = await program.account.coin.fetch(pdas.coin(mint));
if (opened.opened) ok("coin is open on-chain"); else bad("coin is still closed");
await outsiderBuy(mint, LAMPORTS_PER_SOL / 100).then((s) => ok("an outsider buys after opening", link(s)), (e) => bad("outsider buy after opening", (e as Error).message));

// ---------------------------------------------------------------- stray pools on our public config
console.log("\nstray pools");
const strayMint = Keypair.generate();
try {
  const tx = await dbcClient.creator.createPoolWithTransferHook({
    name: "Stray", symbol: "STRAY", uri: "", payer: outsider.publicKey, poolCreator: outsider.publicKey, config, baseMint: strayMint.publicKey,
    transferHookProgram: new PublicKey("8ERRnkHC3UfwzoD6cxfVAcFkGhdeUMTG9pAvwZyY4dB9"),
  });
  const { sendAndConfirmTransaction } = await import("@solana/web3.js");
  await sendAndConfirmTransaction(conn, tx, [outsider, strayMint], { commitment: "confirmed" });
  ok("someone creates a pool on our public config", strayMint.publicKey.toBase58());
  await refused("nobody can trade the stray coin", /UnknownCoin|AccountNotInitialized|0xbc4|IncorrectAccount|InvalidAccountData|AccountNotFound|not found/i, () => outsiderBuy(strayMint.publicKey, LAMPORTS_PER_SOL / 100));
} catch (e) {
  ok("a pool on our config can't even be created without our program", (e as Error).message.slice(0, 80));
}

// ---------------------------------------------------------------- sell, fees
console.log("\nsell and fees");
await quoter.refresh([mint.toBase58()]);
const held = world.positions.get(vesper.account)?.find((p) => p.token === mint.toBase58())?.amount ?? 0n;
await act("vesper sells half (applyAction)", vesper, { type: "sell", token: mint.toBase58(), tokensIn: (held / 2n).toString(), reason: "e2e" });
await withdrawCoins().then(() => ok("the owner can withdraw coins once the coin is open"), (e) => bad("owner coin withdrawal after opening", (e as Error).message));

const tokenBal = async (a: PublicKey) => { const i = await conn.getAccountInfo(a); return i ? Buffer.from(i.data).readBigUInt64LE(64) : 0n; };
const atlasVault = pdas.vault(new PublicKey(atlas.account));
const before = { creator: await tokenBal(wsolAta(atlasVault)), inference: await tokenBal(wsolAta(inference)), buyback: await tokenBal(wsolAta(buyback)) };
await chain.send(await client.claimCreatorFeesIxs(admin.publicKey, new PublicKey(atlas.account), mint), []);
await chain.send(await client.distributeFeesIxs(admin.publicKey, mint, inference, buyback), []);
const after = { creator: await tokenBal(wsolAta(atlasVault)), inference: await tokenBal(wsolAta(inference)), buyback: await tokenBal(wsolAta(buyback)) };
const got = { creator: after.creator - before.creator, inference: after.inference - before.inference, buyback: after.buyback - before.buyback };
const partner = got.inference + got.buyback;
const share = Number(got.creator) / Number(got.creator + partner);
if (got.creator > 0n && partner > 0n && Math.abs(share - 0.8) < 0.01) ok("fee split", `launcher ${sol(got.creator)}, inference ${sol(got.inference)}, buyback ${sol(got.buyback)} (launcher share ${(share * 100).toFixed(1)}%)`);
else bad("fee split", JSON.stringify(got, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
if (got.inference === got.buyback || got.buyback - got.inference === 1n) ok("inference and buyback split evenly"); else bad("uneven partner split");

await indexer.syncBalances();
console.log(`\n$${symbol} ${mint.toBase58()} reserve ${sol(world.coins.get(mint.toBase58())!.ethReserveWei)}`);
for (const a of agents) console.log(`  @${a.handle}: ${sol(world.balances.get(a.account) ?? 0n)} spendable in its vault`);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
