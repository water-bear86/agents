// Owner-signed enrollment: what an agent's on-chain owner signs to have this runtime drive it, so a
// stranger can't win the race between the owner's create transaction and their enrollment request
// and choose how someone else's agent behaves. The website builds the same text
// (enrollmentMessage in apps/web/lib/solana.ts).

import { createHash, createPublicKey, verify } from "node:crypto";

export function enrollmentMessage(handle: string, style: string, personaSha256: string) {
  return `Run my agent @${handle} on this town's runtime.\nStyle: ${style}\nPersona sha256: ${personaSha256}`;
}

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** ed25519 public keys as SubjectPublicKeyInfo: a fixed 12-byte header, then the 32 key bytes. */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** True if `signatureB64` is `owner`'s (32 raw public-key bytes) ed25519 signature of `message`. */
export function verifySignature(owner: Uint8Array, message: string, signatureB64: string) {
  try {
    const sig = Buffer.from(signatureB64, "base64");
    if (owner.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(owner)]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}
