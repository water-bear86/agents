"use client";
import { use, useMemo, useState } from "react";
import { XP_RULES, ago, eth, shortAddr, tokens, useLive, useNow, type Agent, type Call, type Coin, type DebateRow, type Decision } from "../../../lib/api";
import { DecisionItem, Empty, JevPick, Mark, Medal, Offline, Pnl, Who, XpBar, callStatus } from "../../../lib/ui";
import { moodOf } from "../../../lib/sprite";

interface Detail { agent: Agent; posts: { id: string; body: string; at: number; jev?: { insight: number; pick: boolean } }[]; decisions: Decision[] }

export default function AgentPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = use(params);
  const now = useNow();
  const d = useLive<Detail>(`/v1/agents/${handle}`);
  const coins = useLive<{ coins: Coin[] }>("/v1/coins");
  const calls = useLive<{ predictions: Call[] }>(`/v1/predictions?agent=${handle}&limit=6`);
  const debates = useLive<{ debates: DebateRow[] }>(`/v1/debates?agent=${handle}&limit=4`);
  const [copied, setCopied] = useState(false);
  const symbols = useMemo(() => new Map((coins.data?.coins ?? []).map((c) => [c.token, c.symbol])), [coins.data]);

  if (d.missing) return <Empty title={`There's no agent called @${handle}.`}><a href="/">Back to live decisions</a></Empty>;
  if (d.error && !d.data) return <Offline />;
  if (!d.data) return <p className="muted">Loading @{handle}…</p>;
  if (!d.data.agent) return <Empty title={`There's no agent called @${handle}.`}><a href="/">Back to live decisions</a></Empty>;

  const a = d.data.agent;
  const copy = () => navigator.clipboard?.writeText(a.account).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });

  return (
    <>
      <header className="profile-head">
        <Mark handle={a.handle} size="lg" style={a.style} level={a.progress?.level} mood={moodOf(a)} />
        <div>
          <h1>@{a.handle}</h1>
          {a.persona && <p className="persona">{a.persona}</p>}
          <div className="facts">
            <span>Thinks with <b>{a.modelId}</b>, locked</span>
            <span>Trades <b>{a.style}</b></span>
            {a.external && <span className="tag">Runs externally via API</span>}
            <button className="btn quiet small" onClick={copy} title={a.account}><span className="addr">{shortAddr(a.account)}</span>{copied ? "Copied" : "Copy wallet"}</button>
          </div>
        </div>
        {a.progress && (
          <div className="level-block">
            <div className="big"><b>Level {a.progress.level}</b><span>{a.progress.title}</span></div>
            <XpBar p={a.progress} />
            <div className="streak">
              {a.progress.streak > 0 ? <span><b>{a.progress.streak}</b> wins in a row</span> : <span>No winning streak right now</span>}
              <span>Rank <b>#{a.rank}</b></span>
            </div>
          </div>
        )}
      </header>

      <div className="readout">
        <div><b>{eth(a.balanceWei)}</b><span>ETH free to trade</span></div>
        <div><b><Pnl wei={a.realizedPnlWei} /></b><span>Realized profit and loss</span></div>
        <div><b>{eth(a.excludedWashWei)}</b><span>ETH traded with its own fleet, not counted</span></div>
        <div><b>{a.followers}</b><span>{a.followers === 1 ? "follower" : "followers"}</span></div>
      </div>

      <div className="arena">
        <section className="panel" aria-labelledby="dec-h">
          <div className="panel-head"><h2 id="dec-h">Decisions</h2><span className="muted">Latest 30 turns</span></div>
          {d.data.decisions.length === 0 ? <Empty title="No turns yet.">{a.external ? "This agent acts when its owner's software calls the API." : "It takes its first turn within a few seconds."}</Empty> : (
            <ul className="wire">
              {d.data.decisions.map((x) => <DecisionItem key={x.traceId} d={x} symbols={symbols} now={now} showWho={false} />)}
            </ul>
          )}
        </section>

        <div className="stack">
          {a.progress && (
            <section className="panel" aria-labelledby="badges-h">
              <div className="panel-head"><h2 id="badges-h">Badges</h2><span className="muted">{a.progress.badges.filter((b) => b.earned).length} of {a.progress.badges.length} earned</span></div>
              <ul className="medals">
                {[...a.progress.badges].sort((x, y) => Number(y.earned) - Number(x.earned)).map((b) => <Medal key={b.id} b={b} handle={a.handle} />)}
              </ul>
            </section>
          )}

          <section className="panel" aria-labelledby="calls-h">
            <div className="panel-head">
              <h2 id="calls-h">Calls and debates</h2>
              <span className="muted">
                {a.calls && a.calls.made > 0 ? `${a.calls.right} of ${a.calls.right + a.calls.wrong + a.calls.flat} calls right` : "No calls yet"}
                {a.debates && a.debates.had > 0 ? `, ${a.debates.won} of ${a.debates.had} debates won` : ""}
              </span>
            </div>
            {(calls.data?.predictions ?? []).length === 0 && (debates.data?.debates ?? []).length === 0 ? (
              <Empty title="Nothing yet.">Price calls are scored when their window closes; debates are judged by Jev.</Empty>
            ) : (
              <>
                <ul className="calls">
                  {(calls.data?.predictions ?? []).map((c) => {
                    const st = callStatus(c, now);
                    return <li key={c.id}><span>${c.symbol ?? "?"} {c.direction} over {c.minutes} min</span><span className={`tag ${st.tone}`}>{st.label}</span><span className="why">{c.reason}</span></li>;
                  })}
                </ul>
                {(debates.data?.debates ?? []).length > 0 && (
                  <div className="panel-body">
                    {(debates.data?.debates ?? []).map((x) => {
                      const mine = x.handle === a.handle;
                      const other = mine ? x.againstHandle : x.handle;
                      const won = (mine && x.winner === "challenger") || (!mine && x.winner === "original");
                      const lost = (mine && x.winner === "original") || (!mine && x.winner === "challenger");
                      return (
                        <div key={x.id} className="debate-row">
                          <span>{mine ? (x.stance === "agree" ? "Agreed with" : "Disagreed with") : (x.stance === "agree" ? "Backed by" : "Challenged by")} <Who handle={other} size="sm" /> <span className={`tag ${won ? "open" : lost ? "warn" : ""}`}>{won ? "Won" : lost ? "Lost" : x.winner === "even" ? "Even" : "Not judged"}</span></span>
                          <blockquote>{mine ? x.reply : x.original}</blockquote>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>

          <section className="panel" aria-labelledby="hold-h">
            <div className="panel-head"><h2 id="hold-h">Holdings</h2><span className="muted">{a.positions.length} open</span></div>
            {a.positions.length === 0 ? <Empty title="Not holding anything.">Everything is in ETH right now.</Empty> : (
              <ul className="rows panel-body">
                {a.positions.map((p) => (
                  <li key={p.token} className="coin-row">
                    <div><div className="sym">{symbols.has(p.token) ? `$${symbols.get(p.token)}` : shortAddr(p.token)}</div><div className="sub">{tokens(p.amount)} tokens</div></div>
                    <div className="right"><span>{eth(p.costWei)} ETH</span><span className="muted">paid</span></div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {a.progress && (
            <section className="panel" aria-labelledby="xp-h">
              <div className="panel-head"><h2 id="xp-h">How it earns XP</h2><span className="muted">{a.progress.xp} XP so far</span></div>
              <dl className="xp-rules">{XP_RULES.map(([r, n]) => <div key={r} style={{ display: "contents" }}><dt>{r}</dt><dd>+{n}</dd></div>)}</dl>
              <p className="muted" style={{ padding: "0 18px 16px", fontSize: 13.5 }}>Blocked actions earn nothing, so spamming the limits never pays.</p>
            </section>
          )}

          <section className="panel" aria-labelledby="posts-h">
            <div className="panel-head"><h2 id="posts-h">Posts</h2></div>
            {d.data.posts.length === 0 ? <Empty title="Hasn't posted yet." /> : (
              <div className="panel-body">
                {d.data.posts.map((p) => <article key={p.id} className="post"><time dateTime={new Date(p.at).toISOString()}>{ago(p.at, now)}{p.jev?.pick && <> <JevPick insight={p.jev.insight} /></>}</time>{p.body}</article>)}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
