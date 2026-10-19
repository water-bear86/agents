"use client";
// The home page's hero: one street of the town, cut from card. Every agent stands outside its own
// building with its latest doing in a speech bubble; spare lots carry a sign inviting a new agent in.

import { useEffect, useState } from "react";
import { hue, type Agent, type Decision } from "../lib/api";
import { Bot, emoteOf, moodOf } from "../lib/sprite";
import { whereabouts } from "../lib/world";

const LOT = 210;
const GROUND = 306;
const H = 400;
const MAX_RESIDENTS = 7;

/** Deterministic 0..1 from a string and a salt, so a building never changes shape between visits. */
const seed = (s: string, salt: number) => {
  let h = 2166136261 ^ salt;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};

function Building({ x, key0, lit, i, owned }: { x: number; key0: string; lit: number; i: number; owned: boolean }) {
  const w = 150 + seed(key0, 1) * 30;
  const h = 120 + seed(key0, 2) * 80;
  const left = x + (LOT - w) / 2;
  const top = GROUND - h;
  const cols = 3 + Math.floor(seed(key0, 3) * 2);
  const rows = Math.max(2, Math.floor((h - 50) / 34));
  const ww = 16, wh = 20;
  const gapX = (w - cols * ww) / (cols + 1);
  const pitched = seed(key0, 4) > 0.55;
  const tone = seed(key0, 5) > 0.5 ? "mid" : "mid-2";
  const windows = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const on = seed(`${key0}${r}${c}`, 6) < lit;
    windows.push(<rect key={`${r}-${c}`} className={`win ${on ? "lit" : ""}`} x={left + gapX + c * (ww + gapX)} y={top + 18 + r * 34} width={ww} height={wh} rx={1.5} />);
  }
  // Scissor cuts: each corner lands a hair off square, the same way every visit.
  const j = (n: number) => (seed(key0, 10 + n) - 0.5) * 3;
  const body = `${left + j(0)},${top + j(1)} ${left + w + j(2)},${top + j(3)} ${left + w},${GROUND} ${left},${GROUND}`;
  const shadow = `${left + 7 + j(0)},${top + 4 + j(1)} ${left + w + 7 + j(2)},${top + 4 + j(3)} ${left + w + 7},${GROUND} ${left + 7},${GROUND}`;
  return (
    <g className="bldg" style={{ ["--i" as string]: i }}>
      {/* A cut-out stands a little off the backdrop, so it throws a soft shadow onto it. */}
      <polygon className="bldg-shadow" points={shadow} />
      {pitched
        ? <path className={`roof ${owned ? "own" : ""}`} d={`M${left - 8},${top + j(1)} L${left + w / 2 + j(4)},${top - 42} L${left + w + 8},${top + j(3)} Z`} />
        : <polygon className={`roof ${owned ? "own" : ""}`} points={`${left - 5},${top - 10 + j(5)} ${left + w + 5},${top - 10 + j(6)} ${left + w + 5},${top + 2} ${left - 5},${top + 2}`} />}
      <polygon className={tone} points={body} />
      {/* The card's thickness shows down its right-hand cut. */}
      <polygon className="thick" points={`${left + w + j(2) - 3},${top + j(3) + 1} ${left + w + j(2)},${top + j(3)} ${left + w},${GROUND} ${left + w - 3},${GROUND}`} />
      <path className="edge" d={`M${left + 1},${GROUND} L${left + j(0) + 1},${top + j(1) + 1} L${left + w + j(2) - 3},${top + j(3) + 1}`} />
      {windows}
      <rect className={`door ${owned ? "own" : ""}`} x={left + w / 2 - 15} y={GROUND - 40} width={30} height={40} rx={2} />
      {/* The fold tab it is glued down by, like a pop-up book. */}
      <polygon className="tab" points={`${left + 8},${GROUND} ${left + w - 8},${GROUND} ${left + w - 18},${GROUND + 7} ${left + 18},${GROUND + 7}`} />
    </g>
  );
}

function Skyline({ width }: { width: number }) {
  const out = [];
  let x = -20;
  let i = 0;
  while (x < width + 20) {
    const w = 60 + seed("far", i) * 90;
    const h = 90 + seed("far", i + 100) * 150;
    out.push(<rect key={i} className="far" x={x} y={GROUND - h} width={w + 2} height={h} />);
    for (let r = 0; r < 4; r++) if (seed("farwin", i * 10 + r) > 0.6) out.push(<rect key={`${i}w${r}`} className="win lit" opacity={0.45} x={x + 10 + seed("fw", i * 7 + r) * (w - 24)} y={GROUND - h + 16 + r * 22} width={6} height={8} />);
    x += w;
    i++;
  }
  return <g className="far-row">{out}</g>;
}

function Lamp({ x }: { x: number }) {
  return (
    <g>
      <ellipse className="glow" cx={x} cy={GROUND - 92} rx={70} ry={70} />
      <rect className="post" x={x - 2.5} y={GROUND - 90} width={5} height={90} />
      <rect className="post" x={x - 9} y={GROUND - 98} width={18} height={10} rx={3} />
      <rect className="win lit" x={x - 6} y={GROUND - 90} width={12} height={5} rx={1} />
    </g>
  );
}

function Speech({ x: at, y, text, width }: { x: number; y: number; text: string; width: number }) {
  const t = text.length > 34 ? `${text.slice(0, 33).replace(/\s+\S*$/, "")}…` : text;
  const w = t.length * 6.6 + 22;
  const x = Math.min(width - w / 2 - 8, Math.max(w / 2 + 8, at));
  return (
    <g className="speech" aria-hidden>
      <rect x={x - w / 2} y={y - 26} width={w} height={26} rx={6} />
      <path d={`M${at - 6},${y - 1} L${at},${y + 8} L${at + 6},${y - 1} Z`} fill="#fffaf0" />
      <text x={x} y={y - 8.5} textAnchor="middle">{t}</text>
    </g>
  );
}

/**
 * The pop-up is decoration. Some browsers hold an animation back (a tab opened in the
 * background, a throttled embedded view), so after SETTLE_MS everything is pinned to its
 * final, standing pose whether or not the animation ever ran.
 */
const SETTLE_MS = 2500;
function useSettled() {
  const [settled, setSettled] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSettled(true), SETTLE_MS); return () => clearTimeout(t); }, []);
  return settled;
}

/** What an agent says out loud: what it did, or failing that the first thing it thought. */
function say(d: Decision | undefined, doing: string) {
  if (d?.actions.some((x) => x.ok) || !d?.thought) return doing;
  const first = d.thought.split(/(?<=[.!?])\s|\n/)[0]!.trim();
  return first.length > 3 ? first : doing;
}

export function Street({ agents, decisions, symbols, now }: { agents: Agent[]; decisions: Decision[]; symbols: Map<string, string>; now: number }) {
  // The most active residents first, then always at least one free lot.
  const latest = new Map<string, Decision>();
  for (const d of decisions) if (d.handle && !latest.has(d.handle)) latest.set(d.handle, d);
  const residents = [...agents]
    .sort((a, b) => (latest.get(b.handle)?.at ?? 0) - (latest.get(a.handle)?.at ?? 0) || (b.progress?.xp ?? 0) - (a.progress?.xp ?? 0))
    .slice(0, MAX_RESIDENTS);
  const lots = Math.max(5, residents.length + 1);
  const width = lots * LOT;
  const speaker = residents.find((a) => { const d = latest.get(a.handle); return d && now - d.at < 120_000; });
  const settled = useSettled();

  return (
    <svg className={`street ${settled ? "settled" : ""}`} viewBox={`0 0 ${width} ${H}`} role="group" aria-label={`The agents' street: ${residents.length} agents outside their buildings`}>
      <defs>
        <radialGradient id="lampglow">
          <stop offset="0" style={{ stopColor: "var(--window-lit)", stopOpacity: "var(--glow-o)" }} />
          <stop offset="1" style={{ stopColor: "var(--window-lit)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <circle className="moon" cx={width - 120} cy={70} r={30} />
      <Skyline width={width} />
      {Array.from({ length: lots }, (_, i) => {
        const a = residents[i];
        return a ? <g key={a.handle} style={{ ["--h" as string]: hue(a.handle) }}><Building i={i} owned={!!a} x={i * LOT} key0={a?.handle ?? `lot${i}`} lit={0.25 + Math.min(0.6, (a.progress?.level ?? 1) * 0.05)} /></g>
          : <Building key={`lot${i}`} i={i} owned={false} x={i * LOT} key0={`lot${i}`} lit={0.08} />;
      })}
      <rect className="curb" x={0} y={GROUND} width={width} height={16} />
      <line className="crease" x1={0} x2={width} y1={GROUND + 0.5} y2={GROUND + 0.5} />
      <rect className="road" x={0} y={GROUND + 16} width={width} height={H - GROUND - 16} />
      <line className="dash" x1={0} x2={width} y1={GROUND + 58} y2={GROUND + 58} />
      {Array.from({ length: lots - 1 }, (_, i) => <Lamp key={i} x={(i + 1) * LOT} />)}

      {residents.map((a, i) => {
        const d = latest.get(a.handle);
        const where = whereabouts(d, symbols);
        const fresh = !!d && now - d.at < 60_000 && d.actions.some((x) => x.ok);
        const cx = i * LOT + LOT / 2;
        const name = `@${a.handle}`;
        const sub = `Level ${a.progress?.level ?? 1} ${a.progress?.title ?? ""}`.trim();
        const tagW = Math.max(name.length * 8.2, sub.length * 6.4) + 24;
        return (
          <a key={a.handle} href={`/agent/${a.handle}`} className="resident" aria-label={`${name}, level ${a.progress?.level ?? 1}: ${where.doing}`} style={{ ["--h" as string]: hue(a.handle), ["--i" as string]: i + 2 }}>
            <g transform={`translate(${cx},${GROUND + 8}) scale(2.3)`}>
              <Bot handle={a.handle} style={a.style} level={a.progress?.level} mood={moodOf(a, d)} emote={fresh ? emoteOf(d) : undefined} talking={speaker === a} />
            </g>
            <g className="nametag" transform={`translate(${cx},${GROUND + 34})`}>
              <rect x={-tagW / 2} y={0} width={tagW} height={38} rx={3} />
              <text y={16} textAnchor="middle">{name}</text>
              <text className="sub" y={31} textAnchor="middle">{sub}</text>
            </g>
            {speaker === a && <Speech x={cx} y={GROUND - 150} text={say(d, where.doing)} width={width} />}
          </a>
        );
      })}

      {Array.from({ length: lots - residents.length }, (_, k) => {
        const cx = (residents.length + k) * LOT + LOT / 2;
        return (
          <a key={`free${k}`} href="/create" className="sign" aria-label="This lot is free: create an agent" style={{ ["--i" as string]: residents.length + k + 2 }}>
            <rect className="stake" x={cx - 3} y={GROUND - 60} width={6} height={68} />
            <rect x={cx - 66} y={GROUND - 112} width={132} height={56} rx={3} />
            <text x={cx} y={GROUND - 89} textAnchor="middle">This lot is free.</text>
            <text x={cx} y={GROUND - 70} textAnchor="middle">Move an agent in</text>
          </a>
        );
      })}
    </svg>
  );
}

/** One agent on its own doorstep: the portrait on its profile page. */
export function Porch({ agent, last }: { agent: Agent; last?: Decision }) {
  const settled = useSettled();
  return (
    <svg className={`street porch ${settled ? "settled" : ""}`} viewBox={`0 ${GROUND - 250} ${LOT} 286`} role="img" aria-label={`@${agent.handle} outside its building`} style={{ ["--h" as string]: hue(agent.handle) }}>
      <defs>
        <radialGradient id="lampglow">
          <stop offset="0" style={{ stopColor: "var(--window-lit)", stopOpacity: "var(--glow-o)" }} />
          <stop offset="1" style={{ stopColor: "var(--window-lit)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <Building i={0} owned x={0} key0={agent.handle} lit={0.25 + Math.min(0.6, (agent.progress?.level ?? 1) * 0.05)} />
      <Lamp x={LOT - 14} />
      <rect className="curb" x={0} y={GROUND} width={LOT} height={14} />
      <rect className="road" x={0} y={GROUND + 14} width={LOT} height={22} />
      <g transform={`translate(${LOT / 2},${GROUND + 8}) scale(2.3)`}>
        <Bot handle={agent.handle} style={agent.style} level={agent.progress?.level} mood={moodOf(agent, last)} emote={last ? emoteOf(last) : undefined} />
      </g>
    </svg>
  );
}
