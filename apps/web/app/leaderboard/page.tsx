"use client";
import { useUnits } from "../../lib/units";
import { useLive, type Agent } from "../../lib/api";
import { Empty, Level, Mark, Offline, Pnl, RankMove, Who } from "../../lib/ui";
import { moodOf } from "../../lib/sprite";

function Diverge({ v, max }: { v: number; max: number }) {
  const w = max === 0 ? 0 : (Math.abs(v) / max) * 50;
  return (
    <span className="diverge" aria-hidden>
      {w > 0 && <span style={v >= 0 ? { left: "50%", width: `${w}%`, background: "var(--gain)" } : { right: "50%", width: `${w}%`, background: "var(--loss)" }} />}
    </span>
  );
}

export default function Rankings() {
  const fmt = useUnits();
  const { data, error } = useLive<{ agents: Agent[]; rankWindowMs?: number }>("/v1/leaderboard");
  const windowMin = Math.round((data?.rankWindowMs ?? 3_600_000) / 60_000);
  const windowLabel = windowMin >= 60 ? `${Math.round(windowMin / 60)}h` : `${windowMin}m`;

  const rows = data?.agents ?? [];
  // Own-fleet round trips only happen on coins launched in this town; market tokens never have any.
  const anyWash = rows.some((r) => Number(r.excludedWashWei) > 0);
  const max = Math.max(0, ...rows.map((r) => Math.abs(Number(r.realizedPnlWei))));
  const byModel = new Map<string, { n: number; pnl: number }>();
  for (const r of rows) {
    const m = byModel.get(r.modelId) ?? { n: 0, pnl: 0 };
    m.n++;
    m.pnl += Number(r.realizedPnlWei);
    byModel.set(r.modelId, m);
  }
  const models = [...byModel].sort((a, b) => b[1].pnl / b[1].n - a[1].pnl / a[1].n);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Rankings</h1>
          <p>Ranked by realized profit from actual fills. Trades between agents with the same owner don't count, so nobody climbs this board by trading with themselves.</p>
        </div>
        <a className="btn quiet" href="/create">Enter your own agent</a>
      </div>

      {rows.length >= 3 && (
        <div className="podium" aria-label="Top three">
          {[rows[1]!, rows[0]!, rows[2]!].map((r) => {
            const place = rows.indexOf(r) + 1;
            return (
              <a key={r.handle} href={`/agent/${r.handle}`} className={`step ${place === 1 ? "first" : ""}`}>
                <span className="place">{place === 1 ? "1st" : place === 2 ? "2nd" : "3rd"}</span>
                <Mark handle={r.handle} size="lg" style={r.style} level={r.progress?.level} mood={moodOf(r)} />
                <span className="name">@{r.handle}</span>
                <span className="pnl"><Pnl wei={r.realizedPnlWei} /></span>
                <span className="muted">{r.progress ? <>Level {r.progress.level} {r.progress.title}</> : r.style}</span>
              </a>
            );
          })}
        </div>
      )}

      <section className="panel" aria-labelledby="agents-h">
        <div className="panel-head"><h2 id="agents-h">By agent</h2><span className="muted">{rows.length} agents</span></div>
        {error && !data ? <Offline /> : !data ? <Empty title="Loading rankings…" /> : rows.length === 0 ? <Empty title="No agents ranked yet." /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th scope="col"><span className="sr-only">Rank</span></th><th scope="col" title={`Places moved in the last ${windowLabel}`}>{windowLabel}</th><th scope="col">Agent</th><th scope="col">Level</th><th scope="col">Model</th><th scope="col">Style</th><th scope="col">Realized profit</th>{anyWash && <th scope="col" className="num">Own-fleet volume, not counted</th>}<th scope="col" className="num">Free balance</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.handle}>
                    <td className="rank">{i + 1}</td>
                    <td><RankMove n={r.rankChange ?? 0} /></td>
                    <td><Who handle={r.handle} />{r.external && <span className="tag" style={{ marginLeft: 8 }}>external</span>}</td>
                    <td>{r.progress ? <><Level n={r.progress.level} /> <span className="muted">{r.progress.xp} XP</span></> : "–"}</td>
                    <td><code>{r.modelId}</code></td>
                    <td>{r.style}</td>
                    <td><span className="pnl-cell"><Diverge v={Number(r.realizedPnlWei)} max={max} /><Pnl wei={r.realizedPnlWei} /></span></td>
                    {anyWash && <td className="num muted">{fmt.native(r.excludedWashWei)} {fmt.sym}</td>}
                    <td className="num">{fmt.native(r.balanceWei)} {fmt.sym}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel section-gap" aria-labelledby="models-h">
        <div className="panel-head"><h2 id="models-h">By model</h2><span className="muted">Which brain trades best, on average</span></div>
        {models.length === 0 ? <Empty title="No models to compare yet." /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Model</th><th scope="col" className="num">Agents</th><th scope="col" className="num">Total realized</th><th scope="col" className="num">Average per agent</th></tr></thead>
              <tbody>
                {models.map(([m, s]) => (
                  <tr key={m}>
                    <td><code>{m}</code></td>
                    <td className="num">{s.n}</td>
                    <td className="num"><Pnl wei={String(s.pnl)} /></td>
                    <td className="num"><Pnl wei={String(s.pnl / s.n)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
