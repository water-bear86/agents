"use client";
// Inside an agent's house: a dollhouse cutaway in the same model style as the town, furnished
// from the agent's real record: trophies for badges it has earned, its last turn on the desk
// monitor, the coins it holds in a cabinet, its level on the wall, and the agent itself on its
// charging dock when it's home.

import type { CSSProperties, ReactNode } from "react";
import type { Agent, Decision } from "../../lib/api";
import { hue } from "../../lib/api";
import { houseTier } from "../../lib/world";
import { Bot } from "../../lib/sprite";

export const W = 860;
/** Room grid: floor is SIZE × SIZE units; one unit is 34 px wide on screen. */
export const SIZE = 7;
export const U = 34;
export const WALL = 196;
export const O = { x: W / 2, y: 190 };
/** Cropped to the room so it fills the stage. */
export const VIEW = "150 -22 560 480";
export const p = (x: number, y: number, z = 0) => ({ x: O.x + (x - y) * U, y: O.y + (x + y) * (U / 2) - z });
export const pts = (...q: { x: number; y: number }[]) => q.map((r) => `${r.x},${r.y}`).join(" ");
/** A rectangle on the back-right wall (y = 0) or the back-left wall (x = 0). */
export const onRight = (x0: number, x1: number, z0: number, z1: number, y = 0) => pts(p(x0, y, z0), p(x1, y, z0), p(x1, y, z1), p(x0, y, z1));
export const onLeft = (y0: number, y1: number, z0: number, z1: number, x = 0) => pts(p(x, y0, z0), p(x, y1, z0), p(x, y1, z1), p(x, y0, z1));
/** A box on the floor (or raised to z0): left (y-facing) and right (x-facing) sides and top. */
export function Block({ x, y, sx, sy, h, z0 = 0, m }: { x: number; y: number; sx: number; sy: number; h: number; z0?: number; m: string }) {
  const n = p(x, y, z0 + h), e = p(x + sx, y, z0 + h), s = p(x + sx, y + sy, z0 + h), w = p(x, y + sy, z0 + h);
  const sb = p(x + sx, y + sy, z0), wb = p(x, y + sy, z0), eb = p(x + sx, y, z0);
  return (
    <>
      <polygon points={pts(wb, sb, s, w)} className={`${m} l`} />
      <polygon points={pts(sb, eb, e, s)} className={`${m} r`} />
      <polygon points={pts(n, e, s, w)} className={`${m} t`} />
    </>
  );
}
/** Text lying flat on the back-right wall, reading left to right. */
export const rightWallText = (x: number, z: number) => `matrix(${2 / Math.sqrt(5)} ${1 / Math.sqrt(5)} 0 1 ${p(x, 0, z).x} ${p(x, 0, z).y})`;
/** Text on the back-left wall, reading left to right (toward the viewer's left). */
export const leftWallText = (y: number, z: number) => `matrix(${2 / Math.sqrt(5)} ${-1 / Math.sqrt(5)} 0 1 ${p(0, y, z).x} ${p(0, y, z).y})`;

export const wrap = (s: string, n: number, max: number) => {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > n) { lines.push(cur.trim()); cur = w; } else cur += ` ${w}`;
    if (lines.length === max) break;
  }
  if (lines.length < max && cur.trim()) lines.push(cur.trim());
  if (lines.length === max && words.join(" ").length > lines.join(" ").length) lines[max - 1] = `${lines[max - 1]!.slice(0, n - 1)}…`;
  return lines;
};

/** The room itself: floor, two back walls with skirting, the cut edges, and a window on the right wall. */
export function RoomShell({ window: showWindow = true }: { window?: boolean }) {
  return (
    <>
        <defs>
          <radialGradient id="i-glow"><stop offset="0" style={{ stopColor: "var(--w-glow)", stopOpacity: 0.5 }} /><stop offset="1" style={{ stopColor: "var(--w-glow)", stopOpacity: 0 }} /></radialGradient>
          <linearGradient id="i-sky" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style={{ stopColor: "var(--i-sky-top)" }} /><stop offset="1" style={{ stopColor: "var(--i-sky-low)" }} /></linearGradient>
        </defs>
        {/* Shell: floor, two back walls with skirting, and the cut edges of the walls. */}
        <polygon points={pts(p(0, 0, -14), p(SIZE, 0, -14), p(SIZE, SIZE, -14), p(0, SIZE, -14))} className="i-base" />
        <polygon points={pts(p(0, SIZE), p(SIZE, SIZE), p(SIZE, SIZE, -14), p(0, SIZE, -14))} className="i-cut l" />
        <polygon points={pts(p(SIZE, SIZE), p(SIZE, 0), p(SIZE, 0, -14), p(SIZE, SIZE, -14))} className="i-cut r" />
        <polygon points={pts(p(0, 0), p(SIZE, 0), p(SIZE, SIZE), p(0, SIZE))} className="i-floor" />
        {Array.from({ length: SIZE * 2 - 1 }, (_, k) => { const q = (k + 1) / 2; const a1 = p(q, 0), b1 = p(q, SIZE); return <line key={k} x1={a1.x} y1={a1.y} x2={b1.x} y2={b1.y} className="i-plank" />; })}
        <polygon points={onRight(0, SIZE, 0, WALL)} className="i-wall r" />
        <polygon points={onLeft(0, SIZE, 0, WALL)} className="i-wall l" />
        <polygon points={pts(p(0, 0, WALL), p(SIZE, 0, WALL), p(SIZE, -0.25, WALL), p(-0.25, -0.25, WALL), p(-0.25, SIZE, WALL), p(0, SIZE, WALL))} className="i-wall-top" />
        <polygon points={onRight(0, SIZE, 0, 10)} className="i-skirt" />
        <polygon points={onLeft(0, SIZE, 0, 10)} className="i-skirt" />

        {showWindow && <>
        {/* Window, showing the sky for the theme (day, or night with the town's glow). */}
        <polygon points={onRight(4.4, 6.4, 78, 162)} className="i-frame" />
        <polygon points={onRight(4.55, 6.25, 86, 154)} fill="url(#i-sky)" />
        <circle cx={p(5.8, 0, 140).x} cy={p(5.8, 0, 140).y} r={7} className="i-moon" />
        <line x1={p(5.4, 0, 86).x} y1={p(5.4, 0, 86).y} x2={p(5.4, 0, 154).x} y2={p(5.4, 0, 154).y} className="i-mullion" />
        <line x1={p(4.55, 0, 120).x} y1={p(4.55, 0, 120).y} x2={p(6.25, 0, 120).x} y2={p(6.25, 0, 120).y} className="i-mullion" />

        </>}
    </>
  );
}

export function HouseInterior({ a, home, where, last, symbols, onBack }: {
  a: Agent; home: boolean; where: string; last?: Decision; symbols: Map<string, string>; onBack: () => void;
}) {
  const t = houseTier(a.progress?.level);
  const earned = (a.progress?.badges ?? []).filter((b) => b.earned);
  const style = { ["--h" as string]: hue(a.handle) } as CSSProperties;
  const thought = last?.thought && !/^turn \d+$/.test(last.thought) ? last.thought : "";
  const acts = (last?.actions ?? []).slice(0, 3).map((x) => `${x.ok ? "✓" : "✗"} ${x.type}${x.token && symbols.get(x.token) ? ` $${symbols.get(x.token)}` : x.symbol ? ` $${x.symbol}` : ""}`);
  const screen = [...wrap(thought || "No thoughts written down yet.", 21, 3), ...acts];
  const coins = a.positions.slice(0, 6).map((h) => symbols.get(h.token) ?? "?");
  const certificates = Math.min(3, a.debates?.won ?? 0);
  const telescope = (a.calls?.made ?? 0) > 0;
  const shelfSlots = [...earned].slice(0, 10);

  const dock = p(3.6, 4.4);
  const items: ReactNode[] = [];
  // Trophies on two shelves along the left wall, back to front.
  shelfSlots.forEach((b, i) => {
    const row = i < 5 ? 0 : 1;
    const y = 1.0 + (i % 5) * 0.95;
    const base = p(0.25, y, row ? 92 : 138);
    items.push(
      <g key={b.id} className="trophy" transform={`translate(${base.x},${base.y})`}>
        <title>{`${b.name}: ${b.how}`}</title>
        <path d="M-7,-18 h14 l-2,9 q-5,5 -10,0 Z" className="cup" />
        <rect x={-1.5} y={-9} width={3} height={6} className="cup" />
        <rect x={-5} y={-3.5} width={10} height={3.5} rx={1} className="cup-base" />
        <text y={-11.5} textAnchor="middle" className="cup-glyph">{b.glyph}</text>
      </g>,
    );
  });

  return (
    <div className="interior" style={style}>
      <div className="interior-bar">
        <button className="btn quiet small" onClick={onBack} autoFocus>Back to town</button>
        <span className="muted">Inside @{a.handle}&rsquo;s {t.name}. {home ? "It's home." : `It's out: ${where}.`}</span>
      </div>
      <svg className={`interior-svg tier-${t.tier}`} viewBox={VIEW} role="img" aria-label={`Inside the ${t.name} of @${a.handle}: ${earned.length} trophies, ${a.positions.length} coins held, ${home ? "at home on its charging dock" : "out"}`}>
        <RoomShell />

        {/* Level plaque and debate certificates on the left wall. */}
        <polygon points={onLeft(5.3, 6.7, 118, 160)} className="i-plaque" />
        <g transform={leftWallText(6.62, 152)}>
          <text className="i-plaque-text" x={0} y={0}>Level {a.progress?.level ?? 1}</text>
          <text className="i-plaque-sub" x={0} y={11}>{a.progress?.title ?? "Rookie"}</text>
          <text className="i-plaque-sub" x={0} y={21}>Rank #{a.rank}</text>
        </g>
        {Array.from({ length: certificates }, (_, i) => <polygon key={i} points={onLeft(5.35 + i * 0.5, 5.75 + i * 0.5, 66, 98)} className="i-cert" />)}

        {/* Trophy shelves. */}
        <polygon points={onLeft(0.5, 5.0, 136, 139)} className="i-shelf" />
        <polygon points={onLeft(0.5, 5.0, 90, 93)} className="i-shelf" />
        {items}
        {earned.length === 0 && <g transform={leftWallText(4.6, 128)}><text className="i-plaque-sub">No trophies yet</text></g>}

        {/* Desk and monitor with its last turn. */}
        <Block x={0.8} y={0.15} sx={3} sy={1.05} h={38} m="i-wood" />
        <polygon points={onRight(1.05, 3.55, 46, 104, 0.2)} className="i-monitor" />
        <polygon points={onRight(1.15, 3.45, 51, 99, 0.21)} className="i-screen" />
        <g transform={rightWallText(1.22, 94)}>
          {screen.map((line, i) => <text key={i} x={0} y={i * 8} className={`i-screen-text ${line.startsWith("✓") ? "ok" : line.startsWith("✗") ? "no" : ""}`}>{line}</text>)}
        </g>

        {/* Floor: rug, sofa (two-storey and up), lamp, plant, telescope if it makes price calls. */}
        <polygon points={pts(p(1.9, 2.9), p(5.6, 2.9), p(5.6, 6.2), p(1.9, 6.2))} className="i-rug" />
        {t.tier >= 2 && <><Block x={0.25} y={3.2} sx={0.9} sy={2.2} h={18} m="i-sofa" /><Block x={0.25} y={3.2} sx={0.3} sy={2.2} h={34} m="i-sofa" /></>}
        <Block x={6.2} y={0.35} sx={0.35} sy={0.35} h={6} m="i-steel" />
        <line x1={p(6.37, 0.52).x} y1={p(6.37, 0.52, 6).y} x2={p(6.37, 0.52).x} y2={p(6.37, 0.52, 92).y} className="i-pole" />
        <ellipse cx={p(6.37, 0.52, 96).x} cy={p(6.37, 0.52, 96).y} rx={14} ry={7} className="i-shade" />
        <ellipse cx={p(6.37, 0.52, 80).x} cy={p(6.37, 0.52, 80).y} rx={70} ry={45} fill="url(#i-glow)" className="i-lamp-glow" />
        <Block x={0.35} y={6.1} sx={0.5} sy={0.5} h={16} m="i-pot" />
        {[[-9, -30, 11], [6, -36, 10], [0, -44, 9]].map(([dx, dy, r], i) => <circle key={i} cx={p(0.6, 6.35).x + dx!} cy={p(0.6, 6.35).y + dy!} r={r} className="i-leaf" />)}
        {telescope && (
          <g className="i-scope">
            <line x1={p(5.3, 1.5).x - 8} y1={p(5.3, 1.5).y} x2={p(5.3, 1.5).x} y2={p(5.3, 1.5).y - 40} />
            <line x1={p(5.3, 1.5).x + 8} y1={p(5.3, 1.5).y} x2={p(5.3, 1.5).x} y2={p(5.3, 1.5).y - 40} />
            <line x1={p(5.3, 1.5).x - 14} y1={p(5.3, 1.5).y - 34} x2={p(5.3, 1.5).x + 16} y2={p(5.3, 1.5).y - 58} className="tube" />
          </g>
        )}

        {/* Coin cabinet: the coins it holds. */}
        <Block x={5.5} y={2.9} sx={1.2} sy={1.6} h={30} m="i-wood" />
        {coins.length === 0 ? (
          <text x={p(6.1, 3.7, 34).x} y={p(6.1, 3.7, 34).y} textAnchor="middle" className="i-note">nothing held</text>
        ) : coins.map((sym, i) => {
          const c = p(5.75 + (i % 2) * 0.6, 3.2 + Math.floor(i / 2) * 0.5, 30);
          return (
            <g key={i} className="i-coin" transform={`translate(${c.x},${c.y})`}>
              <title>{`$${sym}`}</title>
              <ellipse cy={-3} rx={9} ry={4.5} className="edge" /><ellipse cy={-5} rx={9} ry={4.5} className="face" />
              <text y={-10} textAnchor="middle" className="i-coin-sym">${sym}</text>
            </g>
          );
        })}

        {/* Charging dock, with the agent on it when it's home. */}
        <ellipse cx={dock.x} cy={dock.y} rx={34} ry={17} className="i-dock" />
        <ellipse cx={dock.x} cy={dock.y} rx={24} ry={12} className="i-dock-ring" />
        {home ? (
          <g transform={`translate(${dock.x},${dock.y - 4}) scale(2.6)`} className="i-agent"><Bot handle={a.handle} style={a.style} level={a.progress?.level} /></g>
        ) : (
          <g transform={`translate(${dock.x},${dock.y - 30})`} className="i-away"><rect x={-58} y={-14} width={116} height={24} rx={6} /><text y={2} textAnchor="middle">Out: {where.length > 22 ? `${where.slice(0, 21)}…` : where}</text></g>
        )}
      </svg>
    </div>
  );
}
