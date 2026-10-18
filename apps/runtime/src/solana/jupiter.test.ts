import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ACCEPTED_ROUTES, checkRoute, routeLayout } from "./jupiter.js";

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const key = () => Keypair.generate().publicKey;

/** A `route` instruction: route_plan (empty vec) then in_amount, quoted_out_amount, slippage_bps, platform_fee_bps. */
function routeV1(amount: bigint, fee = 0) {
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(amount, 0);
  tail.writeBigUInt64LE(1n, 8);
  tail.writeUInt16LE(50, 16);
  tail.writeUInt8(fee, 18);
  return Buffer.concat([ACCEPTED_ROUTES.route, Buffer.alloc(4), tail]);
}

describe("Jupiter routes", () => {
  it("accepts exactly the program's route discriminators", () => {
    for (const [name, d] of Object.entries(ACCEPTED_ROUTES)) expect(d.equals(disc(name))).toBe(true);
    expect(Object.keys(ACCEPTED_ROUTES)).toEqual(["route"]);
  });

  it("finds the amount and fee in v1 routes from the end of the data", () => {
    const data = routeV1(123n);
    const l = routeLayout(data)!;
    expect(data.readBigUInt64LE(l.amount)).toBe(123n);
    expect(l.fee).toBe(data.length - 1);
  });

  it("refuses a fee, a fee account, someone else's account, or an unknown instruction before anything is sent", () => {
    const vault = key(), input = key();
    const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    const accounts = [PublicKey.default, vault, input, key(), key(), key(), JUP].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
    expect(() => checkRoute({ accounts, data: routeV1(5n) }, vault, input)).not.toThrow();
    expect(() => checkRoute({ accounts, data: routeV1(5n, 50) }, vault, input)).toThrow(/fee/);
    expect(() => checkRoute({ accounts, data: routeV1(5n) }, key(), input)).toThrow(/vault/);
    const withFeeAccount = accounts.map((a, i) => (i === 6 ? { ...a, pubkey: key() } : a));
    expect(() => checkRoute({ accounts: withFeeAccount, data: routeV1(5n) }, vault, input)).toThrow(/fee/);
    expect(() => checkRoute({ accounts, data: Buffer.concat([disc("claim"), Buffer.alloc(30)]) }, vault, input)).toThrow(/doesn't accept/);
  });
});
