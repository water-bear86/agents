// Pyth price feeds on Solana: the sponsored feed accounts (shard 0) that Pyth keeps updated on
// mainnet, which the agents program reads to put a floor under every session-key swap.

import { PublicKey } from "@solana/web3.js";

/** Pyth's push-oracle program, which owns the sponsored feed account addresses (pyth-solana-receiver-sdk 1.2.0). */
export const PYTH_PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
export const HERMES = "https://hermes.pyth.network";
/** Pyth's SOL/USD feed id. */
export const SOL_USD_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const feedBytes = (id: string) => {
  const b = Buffer.from(id.replace(/^0x/, ""), "hex");
  if (b.length !== 32) throw new Error(`not a Pyth feed id: ${id}`);
  return b;
};

/** The sponsored price update account for a feed. */
export function feedAccount(feed: string | Uint8Array, shard = 0) {
  const s = Buffer.alloc(2);
  s.writeUInt16LE(shard);
  return PublicKey.findProgramAddressSync([s, typeof feed === "string" ? feedBytes(feed) : Buffer.from(feed)], PYTH_PUSH_ORACLE)[0];
}

/** Publish time (unix seconds) of a PriceUpdateV2 account, or null if it can't be read. */
export function publishTime(data: Buffer | Uint8Array) {
  const d = Buffer.from(data);
  if (d.length < 8 + 32 + 2 + 32 + 28) return null;
  // discriminator, write authority, verification level (1 byte Full, 2 bytes Partial), feed id, price, conf, exponent, publish time
  const o = 8 + 32 + (d[40] === 1 ? 1 : 2) + 32 + 8 + 8 + 4;
  return Number(d.readBigInt64LE(o));
}

/** Feed ids for USD prices by Pyth symbol (e.g. "Crypto.BONK/USD"). */
export async function feedIds(f: typeof fetch = fetch) {
  const list = (await (await f(`${HERMES}/v2/price_feeds?asset_type=crypto`)).json()) as { id: string; attributes: { symbol: string } }[];
  return new Map(list.map((x) => [x.attributes.symbol, x.id]));
}
