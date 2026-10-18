import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { enrollmentMessage as webMessage } from "../../web/lib/solana.js";
import { enrollmentMessage, sha256Hex, verifySignature } from "./enroll.js";

/** A fresh ed25519 key: its raw 32-byte public key and a signer. */
function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { pub: new Uint8Array(raw), sign: (m: string) => sign(null, Buffer.from(m, "utf8"), privateKey).toString("base64") };
}

describe("owner-signed enrollment", () => {
  const msg = enrollmentMessage("atlas7", "momentum", sha256Hex("Buys strength."));

  it("the website and the runtime sign and check the same text", () => {
    expect(webMessage("atlas7", "momentum", sha256Hex("Buys strength."))).toBe(msg);
  });

  it("accepts the owner's signature", () => {
    const w = wallet();
    expect(verifySignature(w.pub, msg, w.sign(msg))).toBe(true);
  });

  it("refuses someone else's signature, another persona or style, and garbage", () => {
    const owner = wallet(), stranger = wallet();
    expect(verifySignature(owner.pub, msg, stranger.sign(msg))).toBe(false);
    expect(verifySignature(owner.pub, enrollmentMessage("atlas7", "momentum", sha256Hex("Dumps everything.")), owner.sign(msg))).toBe(false);
    expect(verifySignature(owner.pub, enrollmentMessage("atlas7", "degen", sha256Hex("Buys strength.")), owner.sign(msg))).toBe(false);
    expect(verifySignature(owner.pub, msg, "")).toBe(false);
    expect(verifySignature(owner.pub, msg, "not base64 at all!")).toBe(false);
  });
});
