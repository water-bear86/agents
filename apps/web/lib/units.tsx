"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { formatAmount, formatTokens, type ChainUnitsJson } from "@agents/core/units";
import { API } from "./api";

/** EVM defaults, used until the runtime answers (and by runtimes that predate /v1/chain). */
const EVM: ChainUnitsJson = { family: "evm", nativeSymbol: "ETH", nativeDecimals: 18, nativeBaseName: "wei", tokenDecimals: 18, tokenSupply: (10n ** 27n).toString() };

/** What the runtime says about its chain: units always; on Solana, what the wallet flows need. */
export interface ChainInfo {
  units: ChainUnitsJson;
  mode: "sim" | "onchain" | "paper";
  solana?: { programId: string; sessionKey: string; rpcUrl?: string };
  /** Paper trading the live Solana market: the SOL price in USD and how many real tokens are tradable. */
  paper?: { solUsd: number; tokens: number };
}

const Ctx = createContext<ChainInfo>({ units: EVM, mode: "sim" });
/** Coins whose decimals differ from the chain's usual ones (BONK and MEW have 5), by token. */
const DecimalsCtx = createContext<ReadonlyMap<string, number>>(new Map());

/** Fetches the runtime's chain units once, so every amount on the site uses the right decimals and symbol. */
export function UnitsProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<ChainInfo>({ units: EVM, mode: "sim" });
  const [decimals, setDecimals] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    // The tradable list changes slowly; its odd-decimal coins are re-read every ten minutes.
    let stop = false;
    const read = () => fetch(`${API}/v1/coins`).then((r) => (r.ok ? r.json() : null)).then((d: { coins?: { token: string; decimals?: number }[] } | null) => {
      if (!stop && d?.coins) setDecimals(new Map(d.coins.filter((c) => typeof c.decimals === "number").map((c) => [c.token, c.decimals!])));
    }).catch(() => {});
    void read();
    const t = setInterval(read, 10 * 60_000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  useEffect(() => {
    let stop = false;
    fetch(`${API}/v1/chain`).then((r) => (r.ok ? r.json() : null)).then((d: Partial<ChainInfo> | null) => {
      if (!stop && d?.units) setInfo({ units: d.units, mode: d.mode ?? "sim", solana: d.solana, paper: d.paper });
    }).catch(() => {});
    return () => { stop = true; };
  }, []);
  return <Ctx.Provider value={info}><DecimalsCtx.Provider value={decimals}>{children}</DecimalsCtx.Provider></Ctx.Provider>;
}

/** Formatters bound to the chain in use: `native("1500000000")` is "1.500" on Solana and "<0.0001" on EVM. */
export function useUnits() {
  const u = useContext(Ctx).units;
  const odd = useContext(DecimalsCtx);
  return {
    units: u,
    /** Native currency ticker: ETH or SOL. */
    sym: u.nativeSymbol,
    native: (v: string | number | undefined, signed = false) => formatAmount(v, u.nativeDecimals, signed),
    /** A token amount in whole tokens; pass the token so coins with their own decimals read right. */
    tokens: (v: string | number | undefined, token?: string) => formatTokens(v, (token ? odd.get(token) : undefined) ?? u.tokenDecimals),
  };
}

/** The runtime's chain info. `solana.rpcUrl` falls back to NEXT_PUBLIC_SOLANA_RPC_URL. */
export function useChain(): ChainInfo {
  const c = useContext(Ctx);
  if (!c.solana) return c;
  return { ...c, solana: { ...c.solana, rpcUrl: c.solana.rpcUrl ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL } };
}

/** A strip under the header when the town paper trades the real market, so nobody mistakes it for live money. */
export function PaperBanner() {
  const { mode, paper } = useChain();
  if (mode !== "paper") return null;
  return (
    <div className="paper-banner" role="note">
      <div className="shell">
        <b>Paper trading.</b> Agents trade real Solana tokens at live mainnet prices{paper?.solUsd ? ` (SOL ${paper.solUsd.toLocaleString("en-US", { style: "currency", currency: "USD" })})` : ""}. Every fill is simulated: no transactions, no money moves.
      </div>
    </div>
  );
}
