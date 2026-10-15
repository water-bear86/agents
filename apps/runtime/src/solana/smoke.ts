// End-to-end proof of the Solana runtime path, through the same applyAction code the scheduler uses:
// create the platform's DBC config (once), fund two agent wallets, launch a coin as one agent,
// buy and sell it as the other, then index reserves and balances from the chain.
//
//   Local validator with the devnet programs cloned (unlimited test SOL):
//     solana-test-validator --reset --url devnet \
//       --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
//       --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
//     SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm --filter @agents/runtime solana:smoke
//   Devnet (fund the key first, e.g. faucet.solana.com):
//     SOLANA_RPC_URL=https://api.devnet.solana.com pnpm --filter @agents/runtime solana:smoke
//
// Keys live outside the repo in ~/.config/agents-solana-devnet (override with SOLANA_KEY_DIR).
// It refuses to run against mainnet.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SOLANA_UNITS, formatUnits, planFor, type Style } from "@agents/core";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { applyAction } from "../actions.js";
import { World, type Agent } from "../world.js";
import { SolanaAgentChain, isMainnet } from "./chain.js";
import { MeteoraDbcVenue, agentsCurve, buildCreateConfig } from "./dbc.js";
import { SolanaIndexer, SolanaQuoter } from "./indexer.js";

const url = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
if (isMainnet(url)) throw new Error("refusing to run the smoke test against mainnet");
const cluster = /127\.0\.0\.1|localhost/.test(url) ? "localnet" : /devnet/.test(url) ? "devnet" : "custom";
const dir = process.env.SOLANA_KEY_DIR ?? join(homedir(), ".config", "agents-solana-devnet");
mkdirSync(dir, { recursive: true, mode: 0o700 });

const explorer = (sig: string) => cluster === "localnet"
  ? `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(url)}`
  : `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
const sol = (l: bigint | number) => `${formatUnits(BigInt(l), 9)} SOL`;

function keypair(name: string): Keypair {
  const f = join(dir, `${name}.json`);
  if (!existsSync(f)) writeFileSync(f, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, "utf8")) as number[]));
}

const conn = new Connection(url, "confirmed");
const payer = keypair("runtime");
console.log(`cluster ${cluster} (${url})\nruntime key ${payer.publicKey.toBase58()}`);

let balance = await conn.getBalance(payer.publicKey);
if (balance < 1.5 * LAMPORTS_PER_SOL) {
  try {
    const sig = await conn.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    balance = await conn.getBalance(payer.publicKey);
  } catch (e) {
    if (balance < 0.8 * LAMPORTS_PER_SOL) throw new Error(`runtime key has ${sol(balance)} and the airdrop failed (${(e as Error).message}). Fund ${payer.publicKey.toBase58()} on ${cluster} and rerun.`);
  }
}
console.log(`balance ${sol(balance)}`);

// 1. Platform config: one per cluster, kept in the key dir.
const stateFile = join(dir, `state-${cluster}.json`);
const state = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as { config?: string }) : {};
if (state.config && !(await conn.getAccountInfo(new PublicKey(state.config)))) delete state.config; // validator was reset
if (!state.config) {
  const { tx, config } = await buildCreateConfig(conn, {
    payer: payer.publicKey, feeClaimer: payer.publicKey, leftoverReceiver: payer.publicKey,
    params: agentsCurve({ migrationQuoteThresholdSol: 5 }),
  });
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, config], { commitment: "confirmed" });
  state.config = config.publicKey.toBase58();
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(`created DBC config ${state.config}\n  ${explorer(sig)}`);
} else console.log(`using DBC config ${state.config}`);

// 2. Two agent wallets, funded by the runtime key.
const world = new World();
world.units = SOLANA_UNITS;
const signers = new Map<string, Keypair>();
const agents: Agent[] = [];
for (const [handle, style, owner] of [["atlas", "momentum", "owner-a"], ["vesper", "contrarian", "owner-b"]] as [string, Style, string][]) {
  const kp = keypair(`agent-${handle}`);
  const have = await conn.getBalance(kp.publicKey);
  const want = 0.3 * LAMPORTS_PER_SOL;
  if (have < want) {
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: want - have })), [payer], { commitment: "confirmed" });
  }
  const a: Agent = { account: kp.publicKey.toBase58(), owner, handle, name: handle, persona: "", modelId: "smoke", plan: planFor(style, SOLANA_UNITS), awake: true, external: false, createdAt: Date.now() };
  world.agents.set(a.account, a);
  signers.set(a.account, kp);
  agents.push(a);
  console.log(`@${handle} ${a.account}`);
}
const [atlas, vesper] = agents as [Agent, Agent];

const venue = new MeteoraDbcVenue(conn, new PublicKey(state.config));
const chain = new SolanaAgentChain(conn, venue, signers, { limits: { maxTradeLamports: BigInt(LAMPORTS_PER_SOL / 10), dailyLimitLamports: BigInt(LAMPORTS_PER_SOL) } });
const quoter = new SolanaQuoter(venue);
const indexer = new SolanaIndexer(conn, venue, world);
await indexer.syncBalances();

const step = async (label: string, r: Awaited<ReturnType<typeof applyAction>>) => {
  console.log(`\n${label}: ${r.ok ? "ok" : "REFUSED"} ${r.detail}${r.txHash ? `\n  ${explorer(r.txHash)}` : ""}`);
  if (!r.ok) throw new Error(`${label} failed: ${r.detail}`);
  return r;
};

// 3. Launch, buy, sell, through applyAction.
const symbol = `SMK${Date.now().toString(36).slice(-3).toUpperCase()}`;
const launched = await step("launch", await applyAction(world, chain, quoter, atlas, { type: "launch", name: `Smoke ${symbol}`, symbol, pitch: "Solana smoke test" }));
const mint = launched.detail;
await indexer.pass();
await quoter.refresh([mint]);
console.log(`  quote: 0.01 SOL buys ${formatUnits(quoter.quoteBuy(mint, BigInt(LAMPORTS_PER_SOL / 100)), 6)} ${symbol}`);

await step("buy", await applyAction(world, chain, quoter, vesper, { type: "buy", token: mint, ethIn: String(LAMPORTS_PER_SOL / 50), reason: "smoke" }));
await quoter.refresh([mint]);
const held = world.positions.get(vesper.account)?.find((p) => p.token === mint)?.amount ?? 0n;
await step("sell", await applyAction(world, chain, quoter, vesper, { type: "sell", token: mint, tokensIn: (held / 2n).toString(), reason: "smoke" }));

// 4. Refused before it costs a fee: minOut = 0 is never sent.
await chain.execute(vesper.account, { kind: "sell", token: mint, tokensIn: 1n, minOut: 0n, reason: "" }).then(
  () => { throw new Error("minOut = 0 was accepted"); },
  (e: Error) => console.log(`\nminOut=0 refused: ${e.message}`),
);

await indexer.pass();
await indexer.syncBalances();
const coin = world.coins.get(mint)!;
console.log(`\n$${coin.symbol} (${coin.name}) mint ${mint}\n  reserve ${sol(coin.ethReserveWei)}, open=${coin.opened}`);
for (const a of agents) console.log(`  @${a.handle}: ${sol(world.balances.get(a.account) ?? 0n)}, holds ${formatUnits(world.positions.get(a.account)?.find((p) => p.token === mint)?.amount ?? 0n, 6)} ${coin.symbol}`);
console.log("\nsmoke test passed");
