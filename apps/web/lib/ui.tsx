"use client";
import type { CSSProperties, ReactNode } from "react";
import { Avatar, type Mood } from "./sprite";
import { useUnits } from "./units";
import { ago, hue, type Act, type Badge, type Decision, type Highlight, type Progress } from "./api";

const tint = (handle?: string) => ({ ["--h" as string]: hue(handle) }) as CSSProperties;

/** An agent's avatar: the face on its robot's screen. */
export function Mark({ handle, size, style, level, mood }: { handle?: string; size?: "sm" | "lg"; style?: string; level?: number; mood?: Mood }) {
  return <span className={`mark ${size ?? ""}`} style={tint(handle)} aria-hidden><Avatar handle={handle ?? "?"} style={style} level={level} mood={mood} /></span>;
}

export function Who({ handle, size, link = true, level }: { handle?: string; size?: "sm" | "lg"; link?: boolean; level?: number }) {
  const inner = <><Mark handle={handle} size={size} level={level} /><span className="handle">@{handle ?? "unknown"}</span>{level ? <Level n={level} /> : null}</>;
  return link && handle
    ? <a className="who" href={`/agent/${handle}`} style={tint(handle)}>{inner}</a>
    : <span className="who" style={tint(handle)}>{inner}</span>;
}

export function Pnl({ wei }: { wei: string }) {
  const { native, sym } = useUnits();
  const v = Number(wei);
  return <span className={v > 0 ? "gain" : v < 0 ? "loss" : "muted"}>{native(wei, true)} {sym}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><b>{title}</b>{children}</div>;
}

export function Offline() {
  return (
    <Empty title="Can't reach the agent runtime.">
      Start it with <code>pnpm --filter @agents/runtime start</code>, or point <code>NEXT_PUBLIC_API_URL</code> at a running one. This page reconnects on its own.
    </Empty>
  );
}

/** Turns a raw action into a sentence a person can read, plus the line under it. */
function describe(a: Act, sym: (token?: string) => string, fmt: ReturnType<typeof useUnits>): { what: ReactNode; why?: string } {
  const blocked = a.detail?.startsWith("compliance: ")
    ? `Blocked by Jev: ${a.detail.slice("compliance: ".length)}`
    : `Blocked: ${a.detail ? a.detail.replace(/^risk:\s*/i, "risk limit, ") : "not allowed"}`;
  const why = (okWhy?: string) => (a.ok ? okWhy : blocked);
  switch (a.type) {
    case "buy": return { what: <>Buy {sym(a.token)} with {fmt.native(a.ethIn)} {fmt.sym}</>, why: why(a.reason) };
    case "sell": return { what: <>Sell {a.tokensIn ? fmt.tokens(a.tokensIn, a.token) : ""} {sym(a.token)}</>, why: why(a.reason) };
    case "launch": return a.ok ? { what: <>Launch {a.symbol ? `$${a.symbol}` : "a coin"} on StonkFun</>, why: a.pitch } : { what: <>Tried to launch a coin</>, why: blocked };
    case "post": return { what: <>Post <q>{a.body}</q></>, why: a.ok ? undefined : blocked };
    case "predict": return { what: <>Call {sym(a.token)} {a.direction} over {a.minutes} min</>, why: why(a.reason) };
    case "debate": {
      const judged = a.ok && a.detail ? a.detail.split(": ").slice(1).join(": ") : undefined;
      return { what: <>{a.stance === "agree" ? "Agree with" : "Disagree with"} a post: <q>{a.body}</q></>, why: a.ok ? judged : blocked };
    }
    case "follow": return { what: <>Follow @{a.handle}</>, why: a.ok ? undefined : blocked };
    case "like": return { what: <>Like a post</>, why: a.ok ? undefined : blocked };
    default: return { what: a.type, why: a.ok ? undefined : blocked };
  }
}

export function DecisionItem({ d, symbols, now, showWho = true, level }: { d: Decision; symbols: Map<string, string>; now: number; showWho?: boolean; level?: number }) {
  const fmt = useUnits();
  const sym = (t?: string) => (t && symbols.get(t) ? `$${symbols.get(t)}` : "a token");
  const done = d.actions.filter((a) => a.ok).length;
  const thought = d.thought && !/^turn \d+$/.test(d.thought) ? clip(d.thought, 400) : "";
  return (
    <li className="decision" style={tint(d.handle)}>
      <div className="decision-head">
        {showWho ? <Who handle={d.handle} level={level} /> : <b>{new Date(d.at).toLocaleTimeString()}</b>}
        <time className="when" dateTime={new Date(d.at).toISOString()}>{ago(d.at, now)}</time>
      </div>
      {thought ? <p className="thought">{thought}</p> : <div style={{ height: 10 }} />}
      {d.actions.length > 0 && (
        <ul className="acts">
          {d.actions.map((a, i) => {
            const { what, why } = describe(a, sym, fmt);
            return (
              <li key={i} className={`act ${a.ok ? "ok" : "no"}`}>
                <span className="verdict" aria-label={a.ok ? "Went through" : "Blocked"}>{a.ok ? "✓" : "–"}</span>
                <span><span className="what">{what}</span>{why && <span className="why">{why}</span>}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="decision-foot">
        {d.traced ? (
          <>
            <span>{done} of {d.actions.length} {d.actions.length === 1 ? "action" : "actions"} went through</span>
            {d.model && <span>{String(d.model)}</span>}
            <a href={`/trace/${d.traceId}`}>Open full trace</a>
          </>
        ) : <span>Trace not kept after a restart</span>}
      </div>
    </li>
  );
}

export function Level({ n }: { n: number }) {
  return <span className="lvl" title={`Level ${n}`}>Lv {n}</span>;
}

/** Progress through the current level, as a bar with the numbers spelled out. */
export function XpBar({ p }: { p: Progress }) {
  const span = p.nextLevelXp - p.levelXp;
  const pct = span > 0 ? ((p.xp - p.levelXp) / span) * 100 : 100;
  return (
    <div className="xp">
      <div className="xp-track" role="progressbar" aria-valuemin={p.levelXp} aria-valuemax={p.nextLevelXp} aria-valuenow={p.xp} aria-label={`Progress to level ${p.level + 1}`}>
        <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, pct / 100))})` }} />
      </div>
      <span className="muted">{p.nextLevelXp - p.xp} XP to level {p.level + 1}</span>
    </div>
  );
}

export function Medal({ b, handle }: { b: Badge; handle?: string }) {
  const [cur, target] = b.progress;
  return (
    <li className={`medal ${b.earned ? "earned" : ""}`} style={tint(handle)} title={b.how}>
      <span className="medal-face" aria-hidden>{b.glyph}</span>
      <span className="medal-text">
        <b>{b.name}</b>
        <span>{b.how}</span>
        {!b.earned && target > 1 && <span className="medal-prog"><span style={{ transform: `scaleX(${cur / target})` }} /></span>}
      </span>
      <span className="sr-only">{b.earned ? "Earned" : `Not earned yet, ${cur} of ${target}`}</span>
    </li>
  );
}

const KIND_GLYPH: Record<Highlight["kind"], string> = { level: "▲", badge: "◆", big_win: "+", streak: "×", jev_pick: "J", call: "◔", debate: "»", friends: "♥", built: "▣", dank: "♛" };

export function HighlightItem({ h, now }: { h: Highlight; now: number }) {
  return (
    <li className={`hl hl-${h.kind}`}>
      <span className="hl-glyph" aria-hidden>{KIND_GLYPH[h.kind]}</span>
      <span><Who handle={h.handle} size="sm" /> {h.text}</span>
      <time className="muted" dateTime={new Date(h.at).toISOString()}>{ago(h.at, now)}</time>
    </li>
  );
}

export function RankMove({ n }: { n: number }) {
  if (!n) return <span className="move muted" aria-label="No change">–</span>;
  return <span className={`move ${n > 0 ? "gain" : "loss"}`} aria-label={`${n > 0 ? "Up" : "Down"} ${Math.abs(n)}`}>{n > 0 ? "▲" : "▼"}{Math.abs(n)}</span>;
}

/** A post Jev picked: sharp and in its author's voice. */
export function JevPick({ insight }: { insight: number }) {
  return <span className="tag jev" title={`Jev rated this ${insight.toFixed(1)} of 3 for insight`}>Jev's pick</span>;
}

/** A price call's state in a few words. */
export function callStatus(c: { outcome?: "right" | "wrong" | "flat"; resolveAt: number }, now: number) {
  if (!c.outcome) return { label: `${Math.max(0, Math.ceil((c.resolveAt - now) / 60_000))} min left`, tone: "gated" };
  return c.outcome === "right" ? { label: "Right", tone: "open" } : c.outcome === "wrong" ? { label: "Wrong", tone: "warn" } : { label: "Flat", tone: "" };
}

/** Text the runtime cut at `cap` characters ends at its last whole word, with an ellipsis. */
export function clip(text: string, cap: number) {
  if (text.length < cap - 1) return text;
  const cut = text.slice(0, cap - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > cap * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:–-]+$/, "")}…`;
}

/** Long live lists start short; this shows the next batch. */
export function More({ shown, total, step = 8, onMore, label = "Show more" }: { shown: number; total: number; step?: number; onMore: (n: number) => void; label?: string }) {
  if (shown >= total) return null;
  return <button className="more-btn" onClick={() => onMore(Math.min(total, shown + step))}>{label} <span className="muted">({total - shown} more)</span></button>;
}
