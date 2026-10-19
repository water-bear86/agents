"use client";
import { useCallback, useEffect, useState } from "react";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { useChain } from "../../lib/units";
import { shortAddr } from "../../lib/api";
import { Empty } from "../../lib/ui";
import { AGENTS_PROGRAM_ID, acceptAdminIx, allowMintIx, disallowMintIx, feedBytes, readPlatform, readWhitelist, setPausedIx, signAndSend, solanaWallet, type PlatformState } from "../../lib/solana";

/**
 * The platform admin's page: accept the admin role, pause or resume every session key's trading,
 * and keep the whitelist of tokens session keys may trade. The admin can never touch a vault.
 */
export default function Admin() {
  const chain = useChain();
  const sol = chain.solana;
  const [platform, setPlatform] = useState<PlatformState | null>(null);
  const [whitelist, setWhitelist] = useState<{ mint: PublicKey; feed: string }[]>([]);
  const [me, setMe] = useState<PublicKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [mint, setMint] = useState("");
  const [feed, setFeed] = useState("");

  const load = useCallback(async () => {
    if (!sol?.rpcUrl) return;
    const conn = new Connection(sol.rpcUrl, "confirmed");
    const program = new PublicKey(AGENTS_PROGRAM_ID);
    const [p, w] = await Promise.all([readPlatform(conn, program), readWhitelist(conn, program).catch(() => [])]);
    setPlatform(p);
    setWhitelist(w);
  }, [sol?.rpcUrl, sol?.programId]);
  useEffect(() => { load().catch(() => setStatus({ ok: false, text: "Couldn't read the platform from Solana." })); }, [load]);

  if (!sol) return <Empty title="Nothing to run here yet.">This page manages the on-chain vault program: its token list, pausing it and handing over control. This runtime paper-trades, so there is no program to manage.</Empty>;
  if (!sol.rpcUrl) return <p className="callout">No public Solana RPC URL is configured for wallets.</p>;
  if (sol.programId !== AGENTS_PROGRAM_ID) return <p className="callout">The runtime names program {sol.programId}, but this site only signs for {AGENTS_PROGRAM_ID}.</p>;
  const program = new PublicKey(AGENTS_PROGRAM_ID);

  async function run(label: string, build: (wallet: PublicKey) => TransactionInstruction[]) {
    setBusy(true);
    setStatus(null);
    try {
      const { sig } = await signAndSend(sol!.rpcUrl!, build);
      setStatus({ ok: true, text: `${label}. Transaction ${sig.slice(0, 12)}…` });
      await load();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setStatus({ ok: false, text: /NotAdmin|0x1775/.test(m) ? "This wallet isn't the platform admin." : m });
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    try { setMe((await solanaWallet().connect()).publicKey); } catch (err) { setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
  }

  const isAdmin = !!me && !!platform && platform.admin.equals(me);
  const isPending = !!me && !!platform && platform.pendingAdmin.equals(me);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Platform admin</h1>
          <p>Pause the agents&rsquo; trading and choose the tokens they may trade. The admin can never move money out of a vault: only each agent&rsquo;s owner can.</p>
        </div>
      </div>
      <div className="admin-grid">
        <section className="panel" aria-labelledby="who-h">
          <h2 id="who-h">Admin</h2>
          {!platform ? <p className="muted">The platform isn&rsquo;t set up yet.</p> : (
            <dl>
              <dt>Admin</dt><dd><span className="addr">{platform.admin.toBase58()}</span></dd>
              <dt>Proposed admin</dt><dd>{platform.pendingAdmin.equals(PublicKey.default) ? "None" : platform.pendingAdmin.toBase58()}</dd>
              <dt>Agents&rsquo; trading</dt><dd>{platform.paused ? "Paused" : "Running"}</dd>
              <dt>Price checks</dt><dd>Pyth prices no older than {platform.maxAge}s, at most {platform.maxSlippageBps / 100}% below them</dd>
            </dl>
          )}
          {!me ? <button className="btn small" onClick={connect}>Connect wallet</button> : <p className="muted">Connected as {shortAddr(me.toBase58())}{isAdmin ? ", the admin" : isPending ? ", the proposed admin" : ""}.</p>}
          {isPending && <button className="btn small" disabled={busy} onClick={() => run("You're the admin now", (w) => [acceptAdminIx(program, w)])}>Accept the admin role</button>}
          {isAdmin && platform && (
            <button className="btn small" disabled={busy} onClick={() => run(platform.paused ? "Trading resumed" : "Trading paused", (w) => [setPausedIx(program, w, !platform.paused)])}>
              {platform.paused ? "Resume agents' trading" : "Pause agents' trading"}
            </button>
          )}
        </section>

        <section className="panel" aria-labelledby="wl-h">
          <h2 id="wl-h">Whitelist</h2>
          <p className="muted">Agents may only trade these tokens, each priced by its Pyth feed. Plain SPL tokens only.</p>
          {whitelist.length === 0 ? <p className="muted">No tokens yet.</p> : (
            <ul className="admin-list">
              {whitelist.map((w) => (
                <li key={w.mint.toBase58()}>
                  <span className="addr" title={`Pyth feed ${w.feed}`}>{w.mint.toBase58()}</span>
                  {isAdmin && <button className="btn small ghost" disabled={busy} onClick={() => run("Removed from the whitelist", (a) => [disallowMintIx(program, a, w.mint)])}>Remove</button>}
                </li>
              ))}
            </ul>
          )}
          {isAdmin && (
            <form className="admin-form" onSubmit={(e) => {
              e.preventDefault();
              let m: PublicKey, f: Uint8Array;
              try { m = new PublicKey(mint.trim()); f = feedBytes(feed); } catch (err) { return setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
              run("Added to the whitelist", (a) => [allowMintIx(program, a, m, f)]).then(() => { setMint(""); setFeed(""); });
            }}>
              <label>Token mint<input className="input" value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Mint address" required /></label>
              <label>Pyth USD feed id<input className="input" value={feed} onChange={(e) => setFeed(e.target.value)} placeholder="64 hex characters, from pyth.network/price-feeds" required /></label>
              <button className="btn small" disabled={busy}>Add token</button>
            </form>
          )}
        </section>
        {status && <p className={status.ok ? "muted" : "callout"} role={status.ok ? "status" : "alert"}>{status.text}</p>}
      </div>
    </>
  );
}
