// Jupiter routes for a vault: a quote, then the swap instruction with the vault as the user, which
// the agents program wraps in its `swap`. Wrapping and unwrapping SOL is the program's job, so
// Jupiter is asked to route between the vault's own token accounts and take no fee.

import { PublicKey, type AccountMeta } from "@solana/web3.js";
import type { JupiterSwapIx } from "./program.js";

export const JUPITER_API = "https://lite-api.jup.ag";
/** Route discriminators the program accepts (Jupiter v6 exact-in, see solana/programs/agents). */
export const ACCEPTED_ROUTES = {
  route: Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]),
};
const JUPITER_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** Where an accepted route keeps its input amount, fee field and accounts (mirrors the program's check_route). */
export function routeLayout(data: Buffer) {
  const disc = data.subarray(0, 8);
  const n = data.length;
  if (disc.equals(ACCEPTED_ROUTES.route)) return { amount: n - 19, fee: n - 1, authority: 1, source: 2, feeAccount: 6 };
  return null;
}

/**
 * Pools a vault can trade through. Some of Jupiter's market makers (Kipseli, for one) insist that
 * the trader signs the transaction itself, which a vault PDA can't, so routes stay on the open AMMs
 * whose pools work when called from another program.
 */
export const VAULT_DEXES = ["Raydium", "Raydium CLMM", "Raydium CP", "Whirlpool", "Orca V2", "Meteora", "Meteora DLMM", "Meteora DAMM v2", "Pump.fun Amm"];

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  [k: string]: unknown;
}

interface RawIx { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }

export interface VaultRoute {
  quote: JupiterQuote;
  swap: JupiterSwapIx;
  lookupTables: PublicKey[];
  /** The least the vault will receive: the quote less the allowed slippage. */
  minOut: bigint;
}

export interface JupiterOptions {
  api?: string;
  /** Sent as x-api-key (Jupiter's paid API at api.jup.ag); the free lite API needs none. */
  apiKey?: string;
  fetch?: typeof fetch;
  slippageBps?: number;
  /** Leave room in the transaction for the program's own accounts. */
  maxAccounts?: number;
  dexes?: string[];
}

/** Quote and build a Jupiter route paid from the vault's `inputMint` account into its `outputMint` account. */
export async function vaultRoute(p: {
  vault: PublicKey; inputMint: PublicKey; outputMint: PublicKey; amountIn: bigint; vaultInput: PublicKey; vaultOutput: PublicKey;
}, o: JupiterOptions = {}): Promise<VaultRoute> {
  const api = o.api ?? JUPITER_API;
  const f = withRetry(o.fetch ?? fetch, o.apiKey);
  const qs = new URLSearchParams({
    inputMint: p.inputMint.toBase58(), outputMint: p.outputMint.toBase58(), amount: p.amountIn.toString(),
    slippageBps: String(o.slippageBps ?? 100), maxAccounts: String(o.maxAccounts ?? 40), dexes: (o.dexes ?? VAULT_DEXES).join(","),
    // One pool per swap: a multi-hop route passes through middle-token accounts the vault doesn't have,
    // and the program wants every vault account it doesn't trade to come back untouched.
    onlyDirectRoutes: "true",
  });
  const qr = await f(`${api}/swap/v1/quote?${qs}`);
  const quote = (await qr.json()) as JupiterQuote & { error?: string };
  if (!qr.ok || quote.error || !quote.outAmount) throw new Error(`Jupiter quote: ${quote.error ?? qr.status}`);

  const sr = await f(`${api}/swap/v1/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: p.vault.toBase58(),
      wrapAndUnwrapSol: false,
      useSharedAccounts: false,
      destinationTokenAccount: p.vaultOutput.toBase58(),
      dynamicComputeUnitLimit: false,
    }),
  });
  const body = (await sr.json()) as { swapInstruction?: RawIx; addressLookupTableAddresses?: string[]; error?: string };
  if (!sr.ok || !body.swapInstruction) throw new Error(`Jupiter swap instructions: ${body.error ?? sr.status}`);
  const swap = toSwapIx(body.swapInstruction);
  checkRoute(swap, p.vault, p.vaultInput);
  return {
    quote,
    swap,
    lookupTables: (body.addressLookupTableAddresses ?? []).map((a) => new PublicKey(a)),
    minOut: BigInt(quote.otherAmountThreshold),
  };
}

/** Retries rate limits and server errors with backoff (the free API allows about one request a second). */
function withRetry(f: typeof fetch, apiKey?: string): typeof fetch {
  return (async (url: string | URL | Request, init: RequestInit = {}) => {
    const headers = { ...(init.headers as Record<string, string> | undefined), ...(apiKey ? { "x-api-key": apiKey } : {}) };
    for (let i = 0; ; i++) {
      const r = await f(url, { ...init, headers });
      if ((r.status !== 429 && r.status < 500) || i >= 6) return r;
      await new Promise((ok) => setTimeout(ok, Math.min(1000 * 2 ** i, 20_000)));
    }
  }) as typeof fetch;
}

function toSwapIx(raw: RawIx): JupiterSwapIx {
  if (raw.programId !== "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4") throw new Error(`unexpected swap program ${raw.programId}`);
  const accounts: AccountMeta[] = raw.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable }));
  return { accounts, data: Buffer.from(raw.data, "base64") };
}

/** The same checks the program makes, so a route it would refuse never costs a fee. */
export function checkRoute(swap: JupiterSwapIx, vault: PublicKey, vaultInput: PublicKey) {
  const l = routeLayout(swap.data);
  if (!l) throw new Error(`Jupiter returned a route the program doesn't accept (${swap.data.subarray(0, 8).toString("hex")})`);
  if (swap.data.readUInt8(l.fee) !== 0 || swap.accounts[l.feeAccount]?.pubkey.toBase58() !== JUPITER_ID) throw new Error("Jupiter route takes a fee");
  if (!swap.accounts[l.authority]?.pubkey.equals(vault) || !swap.accounts[l.source]?.pubkey.equals(vaultInput)) throw new Error("Jupiter route isn't from this vault");
}
