// Test agents for a devnet town: makes sure each one exists, owned by its own devnet wallet and
// driven by this runtime's session key, then prints the AGENTS_JSON to run the scheduler with.
// Existing agents are left alone, so it's safe to rerun. Refuses mainnet.
//
//   SOLANA_RPC_URL=https://api.devnet.solana.com pnpm --filter @agents/runtime solana:town
//
// Keys live outside the repo in ~/.config/agents-solana-devnet (override with SOLANA_KEY_DIR):
// runtime.json is the session key that pays for setup; owner-<name>.json are created as needed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { isMainnet } from "./chain.js";
import { agentsProgram, pdas } from "./program.js";
import { createAgentIx, sendIxs } from "./setup.js";

const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
if (isMainnet(rpc)) throw new Error("solana:town is for devnet and local validators only");
const dir = process.env.SOLANA_KEY_DIR ?? join(homedir(), ".config", "agents-solana-devnet");
const load = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as number[]));
const ownerKey = (name: string) => {
  const file = join(dir, `owner-${name}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  return load(`owner-${name}`);
};

/** Each test agent: its handle, trading style, a persona, and the owner wallet that funds it. */
const TOWN = (process.env.TOWN_JSON ? JSON.parse(process.env.TOWN_JSON) : [
  { handle: "atlas7z24", owner: "atlas", style: "momentum", persona: "Follows real demand, ignores fleet noise." },
  { handle: "vesper7z24", owner: "vesper", style: "contrarian", persona: "Fades crowded trades; patient." },
  { handle: "quill", owner: "quill", style: "sniper", persona: "First into fresh launches with small size." },
  { handle: "moss", owner: "moss", style: "conviction", persona: "Few coins, held long." },
]) as { handle: string; owner: string; style: string; persona: string }[];

/** What a new agent's vault starts with, and its on-chain trade limits (lamports). */
const FUND = BigInt(Math.round(Number(process.env.TOWN_FUND_SOL ?? 0.06) * LAMPORTS_PER_SOL));
const MAX_TRADE = BigInt(LAMPORTS_PER_SOL / 50);
const DAILY = BigInt(LAMPORTS_PER_SOL / 10);

const conn = new Connection(rpc, "confirmed");
const session = load("runtime");
const program = agentsProgram(conn);
const sol = (l: number | bigint) => `${(Number(l) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;

console.log(`session key ${session.publicKey.toBase58()}: ${sol(await conn.getBalance(session.publicKey))}`);
for (const t of TOWN) {
  const agent = pdas.agent(t.handle);
  const existing = await program.account.agent.fetchNullable(agent);
  if (existing) {
    const mine = existing.sessionKey.equals(session.publicKey);
    console.log(`@${t.handle}: exists${mine ? "" : " (NOT driven by this session key)"}, vault ${sol(await conn.getBalance(pdas.vault(agent)))}`);
    continue;
  }
  const owner = ownerKey(t.owner);
  const need = FUND + BigInt(LAMPORTS_PER_SOL / 100); // vault funding plus rent for the agent records
  const have = BigInt(await conn.getBalance(owner.publicKey));
  if (have < need) await sendIxs(conn, [SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: owner.publicKey, lamports: need - have })], [session]);
  const sig = await sendIxs(conn, [await createAgentIx(program, owner.publicKey, {
    handle: t.handle, modelId: "demo/model", sessionKey: session.publicKey, maxTradeLamports: MAX_TRADE, dailyLimitLamports: DAILY, fundLamports: FUND,
  })], [owner]);
  console.log(`@${t.handle}: created by ${owner.publicKey.toBase58()}, vault ${sol(FUND)} (${sig})`);
}
console.log(`session key left: ${sol(await conn.getBalance(session.publicKey))}`);
console.log(`\nAGENTS_JSON='${JSON.stringify(TOWN.map(({ handle, style, persona }) => ({ handle, style, persona })))}'`);
