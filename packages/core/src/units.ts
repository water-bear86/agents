/**
 * Chain-aware amounts and addresses.
 *
 * Every amount in the runtime is an integer in the chain's smallest unit: wei on EVM
 * (18 decimals), lamports on Solana (9). Coins are 18-decimal ERC-20s on EVM and usually
 * 6-decimal SPL mints on Solana. Field names such as `balanceWei` and `ethIn` predate the
 * Solana port and are kept for API compatibility: read them as "smallest native unit".
 */

export type ChainFamily = "evm" | "solana";

export interface ChainUnits {
  family: ChainFamily;
  /** Ticker of the native currency agents trade with ("ETH", "SOL"). */
  nativeSymbol: string;
  nativeDecimals: number;
  /** Name of the smallest native unit, for prompts and logs ("wei", "lamports"). */
  nativeBaseName: string;
  /** Decimals of the tokens agents trade (18 for ERC-20s, usually 6 for SPL mints). */
  tokenDecimals: number;
  /** Supply assumed for a token when capping an agent's share of it, in its smallest unit. */
  tokenSupply: bigint;
}

export const pow10 = (decimals: number) => 10n ** BigInt(decimals);

export const EVM_UNITS: ChainUnits = {
  family: "evm", nativeSymbol: "ETH", nativeDecimals: 18, nativeBaseName: "wei", tokenDecimals: 18, tokenSupply: 1_000_000_000n * pow10(18),
};

export const SOLANA_UNITS: ChainUnits = {
  family: "solana", nativeSymbol: "SOL", nativeDecimals: 9, nativeBaseName: "lamports", tokenDecimals: 6, tokenSupply: 1_000_000_000n * pow10(6),
};

/**
 * The same units for one token with its own decimal count (BONK and MEW have 5, most SPL coins 6).
 * Supply stays one billion whole tokens, so supply caps mean the same share whatever the decimals.
 */
export function withTokenDecimals(u: ChainUnits, decimals: number | undefined): ChainUnits {
  if (decimals === undefined || decimals === u.tokenDecimals) return u;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) throw new Error(`unsupported token decimals: ${decimals}`);
  return { ...u, tokenDecimals: decimals, tokenSupply: 1_000_000_000n * pow10(decimals) };
}

/** The most decimals a token may have and still be modelled (SPL mints go up to 9 in practice). */
export const MAX_TOKEN_DECIMALS = 18;

export const unitsFor = (family: ChainFamily): ChainUnits => (family === "solana" ? SOLANA_UNITS : EVM_UNITS);

/** One whole native coin, and a thousandth of one, in the smallest unit. */
export const oneNative = (u: ChainUnits) => pow10(u.nativeDecimals);
export const milliNative = (u: ChainUnits) => pow10(u.nativeDecimals - 3);

/** Units as they travel over JSON (bigints become strings). */
export type ChainUnitsJson = Omit<ChainUnits, "tokenSupply"> & { tokenSupply: string };
export const unitsToJson = (u: ChainUnits): ChainUnitsJson => ({ ...u, tokenSupply: u.tokenSupply.toString() });

const toBig = (v: bigint | string | number | undefined): bigint => {
  if (typeof v === "bigint") return v;
  if (v === undefined || v === "") return 0n;
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
  try { return BigInt(v); } catch { return BigInt(Math.trunc(Number(v) || 0)); }
};

/** Exact decimal string: formatUnits(1500000000n, 9) === "1.5". */
export function formatUnits(v: bigint | string | number, decimals: number): string {
  const n = toBig(v);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const base = pow10(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** parseUnits("0.1", 9) === 100000000n. Extra fraction digits are truncated, never rounded up. */
export function parseUnits(s: string, decimals: number): bigint {
  const m = /^\s*(-)?(\d*)(?:\.(\d*))?\s*$/.exec(s);
  if (!m || (!m[2] && !m[3])) throw new Error(`not a decimal amount: ${s}`);
  const whole = BigInt(m[2] || "0") * pow10(decimals);
  const frac = BigInt(((m[3] ?? "").slice(0, decimals)).padEnd(decimals, "0") || "0");
  return (m[1] ? -1n : 1n) * (whole + frac);
}

/** Float value for display and ratios; splits whole and fraction so large wei amounts keep their precision. */
export function toNumber(v: bigint | string | number | undefined, decimals: number): number {
  const n = toBig(v);
  const base = pow10(decimals);
  return Number(n / base) + Number(n % base) / Number(base);
}

/** Native or token amount with display precision: "<0.0001", "0.1234", "12.345", with an optional sign. */
export function formatAmount(v: bigint | string | number | undefined, decimals: number, signed = false): string {
  const x = toNumber(v, decimals);
  const a = Math.abs(x);
  const body = a === 0 ? "0" : a < 0.0001 ? "<0.0001" : a < 1 ? a.toFixed(4) : a.toFixed(3);
  const sign = x < 0 ? "−" : signed && x > 0 ? "+" : "";
  return `${sign}${body}`;
}

/** Token counts with K/M/B suffixes. */
export function formatTokens(v: bigint | string | number | undefined, decimals: number): string {
  const x = toNumber(v, decimals);
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)}K`;
  return x.toFixed(2);
}

/** Price in whole native coins per whole token, from an amount in and the tokens it bought. */
export function spotPrice(nativeIn: bigint, tokensOut: bigint, u: ChainUnits): number {
  if (tokensOut <= 0n) return NaN;
  return toNumber(nativeIn, u.nativeDecimals) / toNumber(tokensOut, u.tokenDecimals);
}

// ---------------------------------------------------------------- addresses

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 decode (Bitcoin alphabet). Returns null on a character outside the alphabet. */
export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.push(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}

export const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

/** A Solana public key: base58 text that decodes to exactly 32 bytes. */
export const isSolanaAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && base58Decode(s)?.length === 32;

export const isAddress = (s: string, family: ChainFamily) => (family === "solana" ? isSolanaAddress(s) : isEvmAddress(s));

export const addressFamily = (s: string): ChainFamily | null => (isEvmAddress(s) ? "evm" : isSolanaAddress(s) ? "solana" : null);

/** EVM addresses compare case-insensitively (checksums), Solana keys are case-sensitive. */
export const sameAddress = (a: string, b: string) => (a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);

/** "0x1234…abcd" or "7xKX…9fQa"; anything that isn't an address is returned as is. */
export function shortAddress(s: string): string {
  if (isEvmAddress(s)) return `${s.slice(0, 6)}…${s.slice(-4)}`;
  if (isSolanaAddress(s)) return `${s.slice(0, 4)}…${s.slice(-4)}`;
  return s;
}
