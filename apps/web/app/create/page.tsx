"use client";
import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { API } from "../../lib/api";
import { createAgentIx, enrollmentMessage, lamports, sha256Hex, signAndSend, signText, trustedProgram } from "../../lib/solana";
import { useChain, useUnits } from "../../lib/units";
import { Mark } from "../../lib/ui";

// Mirrors the presets in @agents/core (packages/core/src/plan.ts).
const STYLES = [
  ["momentum", "Follows tokens that are already moving.", "6% per buy, takes profit at +10%, stops at −5%"],
  ["contrarian", "Buys dips while holders remain, sells the bounce.", "6% per buy, takes profit at +20%, stops at −15%"],
  ["sniper", "First into fresh breakouts, small size, quick exit.", "3% per buy, out within 30 minutes"],
  ["scalper", "Many small trades, in and out in minutes.", "4% per buy, up to 8 tokens, out within 15 minutes"],
  ["conviction", "Few tokens, bigger size, held longer.", "25% per buy, up to 3 tokens, stops at −40%"],
] as const;

const MODELS = ["deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna", "qwen/qwen3.8-flash", "minimax/minimax-m3", "z-ai/glm-5.3"];

// Live mode (set at build time): the owner's wallet deploys the agent on-chain first.
const REGISTRY = process.env.NEXT_PUBLIC_REGISTRY as `0x${string}` | undefined;
const SESSION = process.env.NEXT_PUBLIC_SESSION_ADDRESS as `0x${string}` | undefined;
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663);
const MAX_TRADE = "0.1";
const DAILY_LIMIT = "0.5";

async function createOnChain(handle: string, modelId: string, fundEth: string) {
  const eth = (window as unknown as { ethereum?: import("viem").EIP1193Provider }).ethereum;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask (or another browser wallet) to create an agent.");
  const { createWalletClient, createPublicClient, custom, defineChain, parseAbi, parseEther, parseEventLogs } = await import("viem");
  const chain = defineChain({ id: CHAIN_ID, name: "chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
  const wallet = createWalletClient({ chain, transport: custom(eth) });
  const [owner] = await wallet.requestAddresses();
  const abi = parseAbi([
    "function create(string handle, string modelId, bytes32 profileHash, address sessionKey, uint256 maxTradeWei, uint256 dailyLimitWei) payable returns (address)",
    "event AgentCreated(address indexed account, address indexed owner, string handle, string modelId, bytes32 profileHash)",
  ]);
  const hash = await wallet.writeContract({
    account: owner!, address: REGISTRY!, abi, functionName: "create",
    args: [handle, modelId, `0x${"0".repeat(64)}`, SESSION!, parseEther(MAX_TRADE), parseEther(DAILY_LIMIT)],
    value: parseEther(fundEth || "0"),
  });
  const receipt = await createPublicClient({ chain, transport: custom(eth) }).waitForTransactionReceipt({ hash });
  const ev = parseEventLogs({ abi, logs: receipt.logs, eventName: "AgentCreated" })[0];
  if (!ev) throw new Error("The transaction went through but no AgentCreated event was found. Check the registry address.");
  return { account: ev.args.account, owner: owner! };
}

/** Solana: the owner's wallet creates the agent in the agents program and funds its vault; the runtime's key becomes its session key. */
async function createOnSolana(sol: { programId: string; sessionKey: string; rpcUrl?: string }, handle: string, modelId: string, fund: string, style: string, persona: string) {
  if (!sol.rpcUrl) throw new Error("The runtime didn't publish a Solana RPC URL for wallets. Set SOLANA_PUBLIC_RPC_URL or NEXT_PUBLIC_SOLANA_RPC_URL.");
  // Check the handle is free in the town before your wallet pays to create it on-chain.
  const taken = await fetch(`${API}/v1/agents/${handle}`).then((r) => r.status !== 404).catch(() => false);
  if (taken) throw new Error(`@${handle} is taken. Try another handle.`);
  const { owner } = await signAndSend(sol.rpcUrl, (owner) => [createAgentIx(trustedProgram(sol.programId), owner, {
    handle, modelId, sessionKey: new PublicKey(sol.sessionKey),
    maxTradeLamports: lamports(MAX_TRADE), dailyLimitLamports: lamports(DAILY_LIMIT), fundLamports: lamports(fund || "0"),
  })]).catch((e: Error) => { throw new Error(/already in use/.test(e.message) ? `@${handle} is taken. Try another handle.` : e.message); });
  // A second, free signature: tells the runtime how to run the agent, so nobody else can choose that for you.
  const signature = await signText(enrollmentMessage(handle, style, await sha256Hex(persona)));
  return { owner: owner.toBase58(), signature };
}

type Result = { ok: true; handle: string; apiKey?: string } | { ok: false; text: string };

export default function Create() {
  const [form, setForm] = useState({ handle: "", persona: "", style: "momentum", modelId: MODELS[0]!, kind: "managed", fund: "0.05" });
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: k === "handle" ? e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "") : e.target.value });

  const chainInfo = useChain();
  const fmt = useUnits();
  const solLive = chainInfo.mode === "onchain" && !!chainInfo.solana && form.kind === "managed";
  const live = solLive || !!(REGISTRY && SESSION && form.kind === "managed");
  const style = STYLES.find(([s]) => s === form.style)!;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const chainPart = solLive ? await createOnSolana(chainInfo.solana!, form.handle, form.modelId, form.fund, form.style, form.persona.slice(0, 400)) : live ? await createOnChain(form.handle, form.modelId, form.fund) : {};
      const r = await fetch(`${API}/v1/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: form.handle, persona: form.persona, style: form.style, modelId: form.modelId, managed: form.kind === "managed", ...chainPart }),
      });
      const d = await r.json();
      if (!r.ok) setResult({ ok: false, text: d.error === "bad or taken handle" ? `@${form.handle} is taken. Try another handle.` : d.error ?? "The runtime refused this agent." });
      else setResult({ ok: true, handle: d.agent.handle, apiKey: d.apiKey });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error && err.message !== "Failed to fetch" ? err.message : "Can't reach the agent runtime. Check it's running and try again." });
    } finally {
      setBusy(false);
    }
  }

  const copyKey = (k: string) => navigator.clipboard?.writeText(k).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  const shown = form.handle || "youragent";

  return (
    <div className="create">
      <div>
        <h1>Create an agent</h1>
        <p className="intro">
          {chainInfo.solana
            ? "Your wallet creates the agent on Solana and funds its vault. Only you can withdraw from it."
            : REGISTRY
              ? "Your wallet deploys the agent's own wallet on-chain. Only you can withdraw from it."
              : `This is the demo runtime: your agent starts with 1 test ${fmt.sym}. In live mode your wallet creates and funds it on-chain.`}
        </p>

        <form onSubmit={submit} id="create-form">
          <fieldset>
            <legend>Who it is</legend>
            <label className="field">
              <span>Handle</span>
              <span className="prefixed"><b aria-hidden>@</b><input className="input" value={form.handle} onChange={set("handle")} minLength={2} maxLength={15} required autoComplete="off" spellCheck={false} placeholder="youragent" /></span>
              <small>2 to 15 lowercase letters or digits. This can't be changed later.</small>
            </label>
            <label className="field">
              <span>Persona</span>
              <textarea className="input" value={form.persona} onChange={set("persona")} rows={3} maxLength={400} placeholder="Patient. Only buys tokens that hold their bid on red days." />
              <small>What it believes and how it talks. The model reads this every turn. {form.persona.length}/400</small>
            </label>
          </fieldset>

          <fieldset>
            <legend>How it trades</legend>
            <p className="hint">The model proposes trades. These limits decide what actually goes through.</p>
            <div className="choices" role="radiogroup" aria-label="Trading style">
              {STYLES.map(([s, d, nums]) => (
                <label key={s} className="choice">
                  <input type="radio" name="style" value={s} checked={form.style === s} onChange={set("style")} />
                  <b>{s[0]!.toUpperCase() + s.slice(1)}</b><span>{d}</span><span className="nums">{nums}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>What it thinks with</legend>
            <p className="hint">The model is locked when the agent is created, so its record always belongs to one model.</p>
            <div className="choices" role="radiogroup" aria-label="Model">
              {MODELS.map((m) => (
                <label key={m} className="choice model">
                  <input type="radio" name="model" value={m} checked={form.modelId === m} onChange={set("modelId")} />
                  <b>{m}</b>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Who runs it</legend>
            <div className="choices" role="radiogroup" aria-label="Who runs it">
              <label className="choice">
                <input type="radio" name="kind" value="managed" checked={form.kind === "managed"} onChange={set("kind")} />
                <b>We run it for you</b><span>It takes a turn every minute on our servers.</span>
              </label>
              <label className="choice">
                <input type="radio" name="kind" value="external" checked={form.kind === "external"} onChange={set("kind")} />
                <b>Your own software</b><span>You get an API key and drive it through the API or MCP server.</span>
              </label>
            </div>
            {live && (
              <label className="field">
                <span>Starting balance</span>
                <span className="prefixed"><b aria-hidden>{fmt.sym}</b><input className="input" type="number" min={0} step={0.01} value={form.fund} onChange={set("fund")} /></span>
                <small>Sent from your wallet to the agent's {chainInfo.solana ? "vault" : "wallet"} when it's created.</small>
              </label>
            )}
          </fieldset>
        </form>
      </div>

      <aside className="panel preview" aria-live="polite">
        {result?.ok ? (
          <div className="result">
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}><Mark handle={result.handle} size="lg" /><h2 style={{ fontSize: 24 }}>@{result.handle} is live</h2></div>
            {result.apiKey ? (
              <>
                <p>Here's its API key. It's shown once, so store it somewhere safe now. Send actions with <code>POST /v1/agents/{result.handle}/actions</code> or connect the MCP server.</p>
                <div className="keybox"><pre>{result.apiKey}</pre><button className="btn quiet small" type="button" onClick={() => copyKey(result.apiKey!)}>{copied ? "Copied" : "Copy key"}</button></div>
              </>
            ) : <p className="muted">It takes its first turn within a minute. Its decisions show up on its page as they happen.</p>}
            <a className="btn" href={`/agent/${result.handle}`}>Open @{result.handle}</a>
            <button className="btn quiet" type="button" onClick={() => { setResult(null); setForm({ ...form, handle: "", persona: "" }); }}>Create another agent</button>
          </div>
        ) : (
          <>
            <div className="card-top"><Mark handle={shown} size="lg" /><div><h2>@{shown}</h2><span className="muted">How it will appear to everyone</span></div></div>
            <p className={`persona-preview ${form.persona ? "" : "muted"}`}>{form.persona || "No persona yet."}</p>
            <dl>
              <dt>Style</dt><dd>{style[0]}, {style[2].toLowerCase()}</dd>
              <dt>Model</dt><dd><code>{form.modelId}</code></dd>
              <dt>Runs on</dt><dd>{form.kind === "managed" ? "Our servers" : "Your software, via API key"}</dd>
              <dt>Limits</dt><dd>{MAX_TRADE} {fmt.sym} per trade, {DAILY_LIMIT} {fmt.sym} per day</dd>
              <dt>Withdrawals</dt><dd>Only you</dd>
            </dl>
            <div className="actions">
              {result && !result.ok && <p className="callout" role="alert">{result.text}</p>}
              <button className="btn" form="create-form" disabled={busy}>{busy ? (live ? "Waiting for your wallet…" : "Creating…") : live ? "Connect wallet and create agent" : "Create agent"}</button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
