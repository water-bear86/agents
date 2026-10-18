// End-to-end check of the agents program against real Jupiter routes, on a local mainnet fork
// (Surfpool): mainnet's Jupiter and pools, our program deployed locally. Nothing touches mainnet.
//
//   surfpool start --rpc-url https://api.mainnet-beta.solana.com --no-deploy --ci --airdrop-keypair-path ~/.config/agents-solana-devnet/runtime.json
//   solana program deploy -u localhost -k ~/.config/agents-solana-devnet/runtime.json --program-id solana/target/deploy/agents-keypair.json solana/target/deploy/agents.so
//   SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm --filter @agents/runtime solana:e2e

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type AddressLookupTableAccount, type TransactionInstruction,
} from "@solana/web3.js";
import { programError, isMainnet } from "./chain.js";
import { routeLayout, vaultRoute, type VaultRoute } from "./jupiter.js";
import { SOL_USD_FEED, feedAccount, feedIds } from "./pyth.js";
import { readPlatform, readWhitelist } from "../../../web/lib/solana.js";
import { AgentsClient, agentsProgram, createAgentIx, parseEvents, pdas, vaultAta, withdrawSolIx, withdrawTokenIx, wsolAta } from "./program.js";

// The fork caches each pool when it first reads it, while Jupiter quotes the live market, so allow wide slippage here.
const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
if (isMainnet(RPC) || !/127\.0\.0\.1|localhost/.test(RPC)) throw new Error("run this against a local fork only");
const conn = new Connection(RPC, "confirmed");
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
const admin = load(join(homedir(), ".config/agents-solana-devnet/runtime.json"));
const program = agentsProgram(conn);
const client = new AgentsClient(program);

let pass = 0, fail = 0;
const ok = (name: string, cond: unknown, extra = "") => { if (cond) pass++; else fail++; console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? `: ${extra}` : ""}`); };
const sol = (n: number) => BigInt(Math.round(n * LAMPORTS_PER_SOL));

async function send(ixs: TransactionInstruction[], signers: Keypair[], tables: PublicKey[] = []) {
  const alts: AddressLookupTableAccount[] = [];
  for (const t of tables) { const a = (await conn.getAddressLookupTable(t)).value; if (a) alts.push(a); }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: signers[0]!.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs] }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  let sig: string;
  try { sig = await conn.sendTransaction(tx); } catch (e) {
    const code = programError(e);
    if (process.env.DEBUG) console.log(((e as { logs?: string[] }).logs ?? (await (e as { getLogs?: (c: Connection) => Promise<string[]> }).getLogs?.(conn)) ?? []).join("\n"));
    throw new Error(code);
  }
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`failed: ${JSON.stringify(res.value.err)}`);
  const got = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { sig, events: parseEvents(got?.meta?.logMessages ?? []) };
}
const refused = async (name: string, p: Promise<unknown>, code: string) => {
  try { await p; ok(name, false, "went through"); } catch (e) { const m = (e as Error).message; ok(name, m.includes(code), `refused (${m.slice(0, 80)})`); }
};

// Read from Jupiter's verified token list (tokens/v2/search) and checked on-chain below.
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const JUP = new PublicKey("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN");
const balance = async (acct: PublicKey) => { try { return (await getAccount(conn, acct)).amount; } catch { return 0n; } };

/** The fork's clock trails mainnet by a few seconds, and some pools refuse an oracle newer than the clock: step it ahead. */
let clock = 0;
const surfnet = (method: string, params: unknown[]) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
/** Writes `factor` times the current price into the fork's copy of Pyth's sponsored account for `feed` (a fork-only cheat code). */
async function skewPrice(feed: string, factor: bigint) {
  const acct = feedAccount(feed);
  const info = (await conn.getAccountInfo(acct))!;
  const data = Buffer.from(info.data);
  const at = 8 + 32 + (data[40] === 1 ? 1 : 2) + 32; // price i64 after discriminator, write authority, verification level, feed id
  data.writeBigInt64LE(data.readBigInt64LE(at) * factor, at);
  await surfnet("surfnet_setAccount", [acct.toBase58(), { lamports: info.lamports, data: data.toString("hex"), owner: info.owner.toBase58(), executable: false }]);
}

let skewed = false;
async function catchUpClock() {
  if (skewed) return;
  // The fork caches Pyth's price accounts too: read them again from mainnet first.
  for (const f of [SOL_USD_FEED, ...FEEDS.values()]) await surfnet("surfnet_resetAccount", [feedAccount(f).toBase58()]);
  clock = Math.max(clock + 2_000, Date.now() + 20_000);
  await surfnet("surfnet_timeTravel", [{ absoluteTimestamp: clock }]);
}

/** Pool errors that come from the fork's cached pool state lagging the live quote, not from our program. */
const FORK_LAG = /InvalidFirstTickArrayAccount|SlippageToleranceExceeded|InvalidTimestamp|0x1771|ExceededSlippage|TickArray/;

/** A Jupiter route for the vault plus the program's swap around it, optionally tampered with; re-quoted when the fork lags. */
type Oracle = { tokenMint: PublicKey; solFeed: string; tokenFeed: string; noPrices?: boolean };
async function swap(p: { operator: Keypair; agent: PublicKey; input: PublicKey; output: PublicKey; amount: bigint; whitelisted: boolean; tamper?: (r: VaultRoute) => void; minOut?: bigint; oracle?: (o: Oracle) => Oracle }) {
  for (let attempt = 0; ; attempt++) {
    try { return await swapOnce(p); } catch (e) { if (attempt >= 3 || !FORK_LAG.test((e as Error).message)) throw e; }
  }
}

async function swapOnce(p: Parameters<typeof swap>[0]) {
  await new Promise((ok) => setTimeout(ok, 2500)); // the free Jupiter API allows about one request a second
  const vault = pdas.vault(p.agent);
  const r = await vaultRoute({ vault, inputMint: p.input, outputMint: p.output, amountIn: p.amount, vaultInput: vaultAta(vault, p.input), vaultOutput: vaultAta(vault, p.output) }, { slippageBps: 1500 });
  p.tamper?.(r);
  await catchUpClock();
  const tokenMint = p.input.equals(NATIVE_MINT) ? p.output : p.input;
  const base: Oracle = { tokenMint, solFeed: SOL_USD_FEED, tokenFeed: FEEDS.get(tokenMint.toBase58()) ?? SOL_USD_FEED };
  const oracle = p.whitelisted ? (p.oracle ? p.oracle(base) : base) : undefined;
  const ixs = await client.swapIxs({ payer: p.operator.publicKey, operator: p.operator.publicKey, agent: p.agent, inputMint: p.input, outputMint: p.output, amountIn: p.amount, minOut: p.minOut ?? r.minOut, route: r.swap, oracle });
  return send(ixs, [p.operator], r.lookupTables);
}

console.log(`fork ${RPC}\n\nsetup`);
const pyth = await feedIds();
const FEEDS = new Map([[USDC.toBase58(), pyth.get("Crypto.USDC/USD")!], [JUP.toBase58(), pyth.get("Crypto.JUP/USD")!]]);
const ORACLE = { maxAge: 120, maxSlippageBps: 500 };
for (const m of [USDC, JUP]) if (!(await conn.getAccountInfo(m))?.owner.equals(TOKEN_PROGRAM_ID)) throw new Error(`${m.toBase58()} isn't an SPL mint`);
const owner = Keypair.generate(), session = Keypair.generate(), stranger = Keypair.generate();
await send([owner, session, stranger].map((k) => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: k.publicKey, lamports: 5 * LAMPORTS_PER_SOL })), [admin]);

if (!(await conn.getAccountInfo(pdas.platform()))) {
  await refused("a stranger can't set up the platform", send([await client.initPlatformIx(stranger.publicKey, ORACLE)], [stranger]), "NotUpgradeAuthority");
  await send([await client.initPlatformIx(admin.publicKey, ORACLE)], [admin]);
  ok("the upgrade authority sets up the platform", true);
} else ok("platform already set up on this fork", true);
await refused("a stranger can't whitelist a token", send([await client.allowMintIx(stranger.publicKey, JUP, FEEDS.get(JUP.toBase58())!)], [stranger]), "NotAdmin");
if (!(await conn.getAccountInfo(pdas.allowed(USDC)))) await send([await client.allowMintIx(admin.publicKey, USDC, FEEDS.get(USDC.toBase58())!)], [admin]);
ok("the admin whitelists USDC", !!(await conn.getAccountInfo(pdas.allowed(USDC))));

await send([await client.setAdminIx(admin.publicKey, stranger.publicKey)], [admin]);
await refused("a proposed admin has no power until it accepts", send([await client.setPausedIx(stranger.publicKey, true)], [stranger]), "NotAdmin");
await refused("only the proposed admin can accept", send([await client.acceptAdminIx(owner.publicKey)], [owner]), "NotAdmin");
await send([await client.acceptAdminIx(stranger.publicKey)], [stranger]);
await send([await client.setAdminIx(stranger.publicKey, admin.publicKey)], [stranger]);
await send([await client.acceptAdminIx(admin.publicKey)], [admin]);
const web = await readPlatform(conn, program.programId);
const onchain = await program.account.platform.fetch(pdas.platform());
ok("the website reads the platform record the way Anchor does", !!web && web.admin.equals(onchain.admin) && web.paused === onchain.paused && web.maxAge === onchain.oracle.maxAge && web.maxSlippageBps === onchain.oracle.maxSlippageBps);
ok("the website lists the whitelist", (await readWhitelist(conn, program.programId)).some((w) => w.mint.equals(USDC) && w.feed === FEEDS.get(USDC.toBase58())));
ok("the admin hands over in two steps, and back", (await program.account.platform.fetch(pdas.platform())).admin.equals(admin.publicKey));

const handle = `e2e${Date.now().toString(36).slice(-6)}`;
const agent = pdas.agent(handle);
const vault = pdas.vault(agent);
await send([await createAgentIx(program, owner.publicKey, { handle, modelId: "e2e/model", profileHash: new Uint8Array(32), sessionKey: session.publicKey, maxTrade: sol(0.2), dailyLimit: sol(0.3), fund: sol(2) })], [owner]);
ok("the owner creates an agent with 2 SOL", (await conn.getBalance(vault)) === 2 * LAMPORTS_PER_SOL, handle);

console.log("\nsession-key trading through Jupiter");
const usdcAta = vaultAta(vault, USDC);
const buy = await swap({ operator: session, agent, input: NATIVE_MINT, output: USDC, amount: sol(0.1), whitelisted: true });
const usdcAfterBuy = await balance(usdcAta);
ok("buys USDC with 0.1 SOL", usdcAfterBuy > 0n && buy.events.some((e) => e.name.toLowerCase() === "swapped"), `${Number(usdcAfterBuy) / 1e6} USDC`);
await refused("a buy over the per-trade cap", swap({ operator: session, agent, input: NATIVE_MINT, output: USDC, amount: sol(0.25), whitelisted: true }), "OverTradeCap");
await swap({ operator: session, agent, input: NATIVE_MINT, output: USDC, amount: sol(0.2), whitelisted: true });
ok("a buy up to the daily cap goes through", true);
await refused("a buy over the daily cap", swap({ operator: session, agent, input: NATIVE_MINT, output: USDC, amount: sol(0.05), whitelisted: true }), "OverDailyCap");
await refused("a buy of a token that isn't whitelisted", swap({ operator: session, agent, input: NATIVE_MINT, output: JUP, amount: sol(0.01), whitelisted: false }), "NotWhitelisted");

console.log("\nroutes that try to take something");
await refused("a route with a platform fee", swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: true, tamper: (r) => {
  r.swap.data.writeUInt8(100, routeLayout(r.swap.data)!.fee);
} }), "RouteTakesFee");
await refused("a route that names a fee account", swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: true, tamper: (r) => {
  r.swap.accounts[routeLayout(r.swap.data)!.feeAccount]!.pubkey = getAssociatedTokenAddressSync(NATIVE_MINT, stranger.publicKey);
} }), "RouteTakesFee");
const thiefAta = getAssociatedTokenAddressSync(NATIVE_MINT, stranger.publicKey);
await send([createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, thiefAta, stranger.publicKey, NATIVE_MINT)], [stranger]);
await refused("a route that pays someone else", swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: true, tamper: (r) => {
  for (const a of r.swap.accounts) if (a.pubkey.equals(wsolAta(vault))) a.pubkey = thiefAta;
} }), "BadRoute");
await refused("a route for a different amount", swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: true, tamper: (r) => {
  r.swap.data.writeBigUInt64LE(5_000_000n, routeLayout(r.swap.data)!.amount);
} }), "BadRoute");
await refused("a stranger trading the vault", swap({ operator: stranger, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: true }), "NotAuthorized");

console.log("\nthe oracle floor");
await catchUpClock();
await skewPrice(FEEDS.get(USDC.toBase58())!, 2n); // the oracle now says USDC is worth $2
skewed = true;
await refused("a sell at the market price when the oracle says it's worth twice that", swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: true, minOut: 1n }), "BelowOraclePrice");
skewed = false;
await send([await client.setOracleIx(admin.publicKey, { ...ORACLE, maxAge: 1 })], [admin]);
await refused("a swap on a stale price", swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: true }), "BadPrice");
await send([await client.setOracleIx(admin.publicKey, ORACLE)], [admin]);
await refused("a session-key swap without its whitelist entry", swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: false }), "NotWhitelisted");
await refused("a session-key swap without the price accounts", swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: true, oracle: (o) => ({ ...o, noPrices: true }) }), "PriceRequired");
await refused("a price account for another feed", swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: true, oracle: (o) => ({ ...o, tokenFeed: FEEDS.get(JUP.toBase58())! }) }), "BadPrice");
await refused("the admin can't allow 10% slippage", send([await client.setOracleIx(admin.publicKey, { ...ORACLE, maxSlippageBps: 1000 })], [admin]), "BadArgs");
await refused("the admin can't allow prices older than two minutes", send([await client.setOracleIx(admin.publicKey, { ...ORACLE, maxAge: 600 })], [admin]), "BadArgs");

console.log("\nsells");
const wsolBefore = await balance(wsolAta(vault));
await swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: usdcAfterBuy / 2n, whitelisted: true });
ok("sells half its USDC back to SOL", (await balance(wsolAta(vault))) > wsolBefore);
await refused("a session-key swap from USDC into another token", swap({ operator: session, agent, input: USDC, output: JUP, amount: 1_000_000n, whitelisted: true }), "SellsToSolOnly");

console.log("\npause");
await send([await client.setPausedIx(admin.publicKey, true)], [admin]);
await refused("session-key trading while paused", swap({ operator: session, agent, input: USDC, output: NATIVE_MINT, amount: 1_000_000n, whitelisted: true }), "Paused");
await swap({ operator: owner, agent, input: NATIVE_MINT, output: JUP, amount: sol(0.05), whitelisted: false });
ok("the owner still trades while paused, any token", (await balance(vaultAta(vault, JUP))) > 0n);
await send([await client.setPausedIx(admin.publicKey, false)], [admin]);

console.log("\nwithdrawals");
await refused("the session key withdraws SOL", send([await withdrawSolIx(program, session.publicKey, agent, session.publicKey, 1000n)], [session]), "NotOwner");
const ownerUsdc = getAssociatedTokenAddressSync(USDC, owner.publicKey);
await send([createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerUsdc, owner.publicKey, USDC)], [owner]);
const left = await balance(usdcAta);
await send([await withdrawTokenIx(program, { owner: owner.publicKey, agent, mint: USDC, to: ownerUsdc, amount: left })], [owner]);
ok("the owner withdraws all the USDC", (await balance(ownerUsdc)) === left && (await balance(usdcAta)) === 0n);
const lamportsBefore = await conn.getBalance(vault);
const wsol = await balance(wsolAta(vault));
await send([await client.closeTokenAccountIx(session.publicKey, agent, wsolAta(vault))], [session]);
ok("closing the wrapped-SOL account returns it to the vault as SOL", (await conn.getBalance(vault)) > lamportsBefore + Number(wsol) - 1);
await refused("closing a token account that still holds tokens", send([await client.closeTokenAccountIx(session.publicKey, agent, vaultAta(vault, JUP))], [session]), "NotEmpty");
const all = await conn.getBalance(vault);
await send([await withdrawSolIx(program, owner.publicKey, agent, owner.publicKey, BigInt(all))], [owner]);
ok("the owner empties the vault", (await conn.getBalance(vault)) === 0);

console.log("\nwhitelist removal");
await send([await client.disallowMintIx(admin.publicKey, USDC)], [admin]);
await refused("a buy of a token taken off the whitelist", swap({ operator: session, agent, input: NATIVE_MINT, output: USDC, amount: sol(0.01), whitelisted: true }), "AccountNotInitialized");
await send([await client.allowMintIx(admin.publicKey, USDC, FEEDS.get(USDC.toBase58())!)], [admin]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
