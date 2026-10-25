import { createHash, randomBytes } from "node:crypto";
import type { Agent, OwnerProof } from "./world.js";

// Who owns an agent, as far as wallet sign-in is concerned. Only a proven owner counts, and how it was
// proven matters: the chain and a wallet that created the agent are facts, but a claim was made with
// the agent's API key, and a key can leak. So resetting a key undoes a claim (the thief's wallet loses
// the agent and the real owner can claim it again), and never touches the other two.

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

/** Marks an agent's owner as proven, and how. */
export function proveOwner(a: Agent, proof: OwnerProof) {
  a.ownerVerified = true;
  a.ownerProof = proof;
  if (proof !== "claimed") delete a.claimedFrom;
}

/** The agents a wallet provably owns: the only ones wallet sign-in offers it. */
export function walletAgents(agents: Iterable<Agent>, wallet: string): Agent[] {
  return [...agents].filter((a) => a.ownerVerified && a.owner === wallet);
}

/** Makes `wallet` the owner of an agent whose key the caller just showed, unless another wallet proved it first. */
export function claimAgent(a: Agent, wallet: string): { ok: true } | { error: string } {
  if (a.ownerVerified && a.owner !== wallet) return { error: "That agent already belongs to another wallet." };
  if (a.ownerVerified) return { ok: true }; // already this wallet's: keep the stronger proof it has
  a.claimedFrom = a.owner;
  a.owner = wallet;
  proveOwner(a, "claimed");
  return { ok: true };
}

/** Undoes a claim made with a key: the owner goes back to what it was, unproven. True if there was one. */
export function clearClaim(a: Agent): boolean {
  if (a.ownerProof !== "claimed") return false;
  a.owner = a.claimedFrom ?? a.owner;
  delete a.claimedFrom;
  delete a.ownerVerified;
  delete a.ownerProof;
  return true;
}

/** Saves from before ownerProof: a proven owner then could only have come from the chain or a signed enrollment. */
export function migrateOwnerProof(agents: Iterable<Agent>): number {
  let n = 0;
  for (const a of agents) if (a.ownerVerified && !a.ownerProof) { a.ownerProof = "chain"; n++; }
  return n;
}

/**
 * A new API key for an agent whose old one was lost or leaked. The old keys stop working, every
 * sign-in ends, and a claim made with a key is undone, so a stolen key can't leave a wallet behind.
 */
export function resetApiKey(a: Agent, apiKeys: Map<string, string>, endSignIns: (account: string) => number) {
  for (const [h, acct] of apiKeys) if (acct === a.account) apiKeys.delete(h);
  const signInsEnded = endSignIns(a.account);
  const claimCleared = clearClaim(a);
  const apiKey = `ak_${randomBytes(24).toString("hex")}`;
  apiKeys.set(keyHash(apiKey), a.account);
  return { apiKey, signInsEnded, claimCleared };
}
