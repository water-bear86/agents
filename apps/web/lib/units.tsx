"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { formatAmount, formatTokens, type ChainUnitsJson } from "@agents/core/units";
import { API } from "./api";

/** EVM defaults, used until the runtime answers (and by runtimes that predate /v1/chain). */
const EVM: ChainUnitsJson = { family: "evm", nativeSymbol: "ETH", nativeDecimals: 18, nativeBaseName: "wei", tokenDecimals: 18, tokenSupply: (10n ** 27n).toString() };

const Ctx = createContext<ChainUnitsJson>(EVM);

/** Fetches the runtime's chain units once, so every amount on the site uses the right decimals and symbol. */
export function UnitsProvider({ children }: { children: ReactNode }) {
  const [units, setUnits] = useState(EVM);
  useEffect(() => {
    let stop = false;
    fetch(`${API}/v1/chain`).then((r) => (r.ok ? r.json() : null)).then((d: { units?: ChainUnitsJson } | null) => {
      if (!stop && d?.units) setUnits(d.units);
    }).catch(() => {});
    return () => { stop = true; };
  }, []);
  return <Ctx.Provider value={units}>{children}</Ctx.Provider>;
}

/** Formatters bound to the chain in use: `native("1500000000")` is "1.500" on Solana and "<0.0001" on EVM. */
export function useUnits() {
  const u = useContext(Ctx);
  return {
    units: u,
    /** Native currency ticker: ETH or SOL. */
    sym: u.nativeSymbol,
    native: (v: string | number | undefined, signed = false) => formatAmount(v, u.nativeDecimals, signed),
    tokens: (v: string | number | undefined) => formatTokens(v, u.tokenDecimals),
  };
}
