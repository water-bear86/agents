"use client";
import { brand } from "@agents/brand";
import { use, useMemo, useState } from "react";
import { useLive, usd, type Span } from "../../../lib/api";
import { Empty, Offline, Who } from "../../../lib/ui";

const KIND: Record<string, string> = { run: "turn", llm_call: "model call", tx: "transaction", tool_call: "action" };

function flatten(nodes: Span[], depth = 0, out: { s: Span; depth: number }[] = []) {
  for (const n of nodes) { out.push({ s: n, depth }); flatten(n.children ?? [], depth + 1, out); }
  return out;
}

const errored = (s: Span) => s.status === "error";
const blocked = (s: Span) => !errored(s) && s.attrs.ok === false;
const json = (v: unknown) => (v === undefined || v === null ? "Nothing recorded." : typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** Model replies are usually JSON in a string; pretty-print them when they parse. */
const reply = (content: unknown) => {
  if (typeof content !== "string") return json(content);
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
};

type Msg = { role: string; content: unknown };
const messages = (v: unknown): Msg[] | null => {
  const m = (v as { messages?: unknown } | null)?.messages;
  return Array.isArray(m) && m.every((x) => x && typeof x === "object" && "role" in x) ? (m as Msg[]) : null;
};
const ROLE: Record<string, string> = { system: "Instructions", user: "What it saw", assistant: "Its reply", tool: "Tool result" };

function Body({ title, value, isReply }: { title: string; value: unknown; isReply?: boolean }) {
  const msgs = messages(value);
  const out = value as { role?: string; content?: unknown } | null;
  if (msgs) return <>{msgs.map((m, i) => <div key={i}><h4>{ROLE[m.role] ?? m.role}</h4><pre>{m.role === "assistant" ? reply(m.content) : json(m.content)}</pre></div>)}</>;
  if (isReply && out && typeof out === "object" && "content" in out) return <><h4>{ROLE[out.role ?? "assistant"] ?? title}</h4><pre>{reply(out.content)}</pre></>;
  return <><h4>{title}</h4><pre>{json(value)}</pre></>;
}

export default function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useLive<{ tree: Span[] }>(`/v1/traces/${id}`, id);
  const [selId, setSel] = useState<string | null>(null);
  const [pos, setPos] = useState(1);
  const rows = useMemo(() => flatten(data?.tree ?? []), [data]);

  if (error && !data) return <Offline />;
  if (!data) return <p className="muted">Loading trace…</p>;
  const root = data.tree[0];
  if (!root) return <Empty title="This trace isn't available.">Traces are kept in memory, so turns from before the runtime last restarted can't be opened. <a href="/">Back to live decisions</a></Empty>;

  const start = root.startedAt;
  const end = Math.max(...rows.map(({ s }) => s.endedAt ?? Date.now()), start + 1);
  const span = end - start;
  const at = start + span * pos;
  const sel = rows.find((r) => r.s.id === selId)?.s ?? rows.find((r) => r.s.kind === "llm_call")?.s ?? root;
  const llm = rows.filter(({ s }) => s.kind === "llm_call");
  const requested = String(root.attrs.requestedModel ?? "");
  const served = ((root.attrs.servedModels as string[] | undefined) ?? []).filter(Boolean);
  const swapped = served.some((m) => m !== requested);
  const thought = String(root.attrs.thought ?? "");
  const shot = [...rows].reverse().find(({ s }) => s.startedAt <= at && typeof s.attrs.screenshot === "string")?.s;
  const pct = (t: number) => `${((t - start) / span) * 100}%`;

  return (
    <>
      <header className="trace-head">
        <h1><Who handle={String(root.attrs.handle ?? "")} size="lg" /> <span>turn at {new Date(start).toLocaleTimeString()}</span></h1>
        {thought && !/^turn \d+$/.test(thought) && <p className="persona">{thought}</p>}
        <div className="facts">
          <span><b>{usd(root.totalCostUsd)}</b> total cost</span>
          <span><b>{(root.tokens.prompt + root.tokens.completion).toLocaleString()}</b> tokens</span>
          <span><b>{llm.length}</b> {llm.length === 1 ? "model call" : "model calls"}</span>
          <span><b>{(span / 1000).toFixed(2)}s</b> start to finish</span>
          <span>Model <b>{served.join(", ") || requested}</b></span>
        </div>
        {swapped && <p className="callout" style={{ marginTop: 14 }}>{brand.copy.modelSwapNotice(requested, served.join(", "))}</p>}
      </header>

      <div className="trace-grid">
        <section className="panel" aria-labelledby="wf-h">
          <div className="panel-head"><h2 id="wf-h">Timeline</h2><span className="muted">Select a step to inspect it</span></div>
          <div className="scrub">
            <label htmlFor="replay">Replay</label>
            <input id="replay" type="range" min={0} max={1} step={0.001} value={pos} onChange={(e) => setPos(Number(e.target.value))} />
            <span>{((at - start) / 1000).toFixed(2)}s</span>
          </div>
          <ul className="waterfall">
            {rows.map(({ s, depth }) => {
              const stop = Math.min(s.endedAt ?? at, at);
              return (
                <li key={s.id}>
                  <button className={`wf-row ${s.startedAt > at ? "future" : ""}`} aria-pressed={sel.id === s.id} onClick={() => { setSel(s.id); setPos(Math.min(1, ((s.endedAt ?? end) - start) / span)); }}>
                    <span className="wf-name" style={{ paddingLeft: depth * 14 }}>
                      {errored(s) && <span className="loss" aria-label="Failed">✕</span>}
                      {blocked(s) && <span className="muted" aria-label="Blocked">–</span>}
                      {s.name}<span className="wf-kind">{KIND[s.kind] ?? s.kind}</span>
                    </span>
                    <span className="wf-track" aria-hidden>
                      {s.startedAt <= at && <span className={`wf-bar k-${s.kind} ${errored(s) ? "bad" : blocked(s) ? "blocked" : ""}`} style={{ left: pct(s.startedAt), width: `calc(${pct(Math.max(stop, s.startedAt))} - ${pct(s.startedAt)})` }} />}
                    </span>
                    <span className="wf-cost">{usd(s.totalCostUsd)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {shot && <div className="panel-body"><img src={String(shot.attrs.screenshot)} alt="What the agent saw at this point" style={{ maxWidth: "100%", borderRadius: 6 }} /></div>}
        </section>

        <section className="panel detail" aria-live="polite">
          <div className="panel-head"><h2>{sel.name}</h2><span className="muted">{KIND[sel.kind] ?? sel.kind}</span></div>
          <div className="panel-body" style={{ paddingTop: 12 }}>
            <div className="facts" style={{ marginTop: 0 }}>
              <span className={`tag ${errored(sel) ? "warn" : blocked(sel) ? "" : sel.status === "running" ? "gated" : "open"}`}>{errored(sel) ? "Failed" : blocked(sel) ? "Blocked by its limits" : sel.status === "running" ? "Running" : "Went through"}</span>
              <span>{sel.endedAt ? `${sel.endedAt - sel.startedAt} ms` : "still running"}</span>
              <span>{usd(sel.costUsd)} own, {usd(sel.totalCostUsd)} with children</span>
              <span>{sel.tokens.prompt} in, {sel.tokens.completion} out tokens</span>
            </div>
            {sel.error && <p className="callout" style={{ marginTop: 12 }}>{sel.error}</p>}
            <Body title="Input" value={sel.input} />
            <Body title="Output" value={sel.output} isReply />
            <h4>Attributes</h4><pre>{json(sel.attrs)}</pre>
          </div>
        </section>
      </div>
    </>
  );
}
