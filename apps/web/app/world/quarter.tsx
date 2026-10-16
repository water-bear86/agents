// The agents' quarter: buildings agents put up themselves with bricks. A proposed building is a
// fenced lot with a fundraising sign; a funded one is going up under scaffolding with a crane; a
// finished one stands in its proposer's colour with its name over the door.

import type { CSSProperties, KeyboardEvent } from "react";
import { hue, type Project } from "../../lib/api";
import { Bot } from "../../lib/sprite";
import { LOT, box, cylinder, diamond, iso, quadL, quadR, quarterLot, shadowOf, windows } from "../../lib/world";
import { Drum, Solid } from "./scene";

const pts = (...p: { x: number; y: number }[]) => p.map((q) => `${q.x},${q.y}`).join(" ");

/** How tall each kind stands, for its label and its construction progress. */
export const KIND_TOP: Record<Project["kind"], number> = { tower: 128, dome: 70, arcade: 52, garden: 34, statue: 66, lighthouse: 112, stage: 48, lab: 64 };

function Finished({ p, x, y }: { p: Project; x: number; y: number }) {
  const c = { gx: x + LOT / 2, gy: y + LOT / 2 };
  switch (p.kind) {
    case "tower": {
      const w = windows(x + 0.3, y + 0.3, 1, 1, [14, 34, 54, 74, 94], 0.25, 0.14, 8);
      const top = iso(c.gx, c.gy, 116);
      return (
        <>
          <polygon points={shadowOf(x + 0.3, y + 0.3, 1, 1, 116)} className="shadow" />
          <Solid f={box(x + 0.3, y + 0.3, 1, 1, 112)} m="m-card" />
          <Solid f={box(x + 0.25, y + 0.25, 1.1, 1.1, 5, 112)} m="m-tone" />
          {w.left.map((q, i) => <polygon key={`l${i}`} points={q} className="win l" />)}
          {w.right.map((q, i) => <polygon key={`r${i}`} points={q} className="win r" />)}
          <line x1={top.x} y1={top.y} x2={top.x} y2={top.y - 14} className="q-mast" />
          <circle cx={top.x} cy={top.y - 16} r={3} className="q-beacon" />
        </>
      );
    }
    case "dome": {
      const d = cylinder(c.gx, c.gy, 30, 22, 8);
      const r = 31;
      return (
        <>
          <polygon points={shadowOf(x + 0.1, y + 0.1, 1.4, 1.4, 70)} className="shadow" />
          <Solid f={box(x + 0.05, y + 0.05, 1.5, 1.5, 8)} m="m-card" />
          <Drum gx={c.gx} gy={c.gy} r={30} h={22} z0={8} />
          <path d={`M${d.top.x - r},${d.top.y} A${r},${r * 0.95} 0 0 1 ${d.top.x + r},${d.top.y} A${r},${r / 2} 0 0 1 ${d.top.x - r},${d.top.y} Z`} className="q-dome" />
          <path d={`M${d.top.x - r},${d.top.y} A${r},${r * 0.95} 0 0 1 ${d.top.x + r},${d.top.y} A${r},${r / 2} 0 0 1 ${d.top.x - r},${d.top.y} Z`} className="dome-shade" />
          {[0.3, 0.7, 1.1].map((a) => <polygon key={a} points={quadL(y + 1.55, x + a, x + a + 0.2, 2, 7)} className="win l" />)}
        </>
      );
    }
    case "arcade": {
      const sign = iso(x + 0.8, y + 1.4, 46);
      return (
        <>
          <polygon points={shadowOf(x, y + 0.2, 1.6, 1.2, 40)} className="shadow" />
          <Solid f={box(x, y + 0.2, 1.6, 1.2, 34)} m="m-card" />
          <Solid f={box(x - 0.04, y + 0.16, 1.68, 1.28, 4, 34)} m="m-tone" />
          <polygon points={quadL(y + 1.4, x + 0.15, x + 1.45, 4, 24)} className="q-neon-glass" />
          <g className="q-neon" transform={`translate(${sign.x},${sign.y})`}><rect x={-26} y={-10} width={52} height={14} rx={4} /><text y={0.5} textAnchor="middle">ARCADE</text></g>
        </>
      );
    }
    case "garden": {
      const f = cylinder(c.gx, c.gy, 14, 5);
      const jet = iso(c.gx, c.gy, 5);
      return (
        <>
          <polygon points={diamond(x, y, LOT, LOT)} className="q-lawn" />
          <Solid f={box(x, y, LOT, 0.18, 9)} m="m-hedge" />
          <Solid f={box(x, y, 0.18, LOT, 9)} m="m-hedge" />
          <path d={f.side} fill="url(#w-cyl)" className="drum" />
          <ellipse cx={f.top.x} cy={f.top.y} rx={f.rx} ry={f.ry} className="m-card t" />
          <ellipse cx={f.top.x} cy={f.top.y + 1} rx={f.rx - 3} ry={f.ry - 2} className="water" />
          <path d={`M${jet.x},${jet.y} c-1,-16 -8,-12 -10,-2 M${jet.x},${jet.y} c1,-16 8,-12 10,-2`} className="spray" />
          {[[0.35, 1.25], [1.25, 0.35], [1.3, 1.3]].map(([a, b]) => { const q = iso(x + a!, y + b!, 6); return <circle key={`${a}${b}`} cx={q.x} cy={q.y} r={5} className="q-flower" />; })}
        </>
      );
    }
    case "statue": {
      const base = iso(c.gx, c.gy, 26);
      return (
        <>
          <polygon points={diamond(x + 0.2, y + 0.2, 1.2, 1.2)} className="paving" />
          <polygon points={shadowOf(x + 0.45, y + 0.45, 0.7, 0.7, 66)} className="shadow" />
          <Solid f={box(x + 0.45, y + 0.45, 0.7, 0.7, 20)} m="m-card" />
          <Solid f={box(x + 0.4, y + 0.4, 0.8, 0.8, 4, 20)} m="m-tone" />
          {/* The proposer, cast in bronze. */}
          <g className="q-statue" transform={`translate(${base.x},${base.y}) scale(0.95)`}><Bot handle={p.handle ?? "?"} level={1} /></g>
        </>
      );
    }
    case "lighthouse": {
      const lamp = iso(c.gx, c.gy, 96);
      return (
        <>
          <polygon points={shadowOf(x + 0.3, y + 0.3, 1, 1, 110)} className="shadow" />
          <Solid f={box(x + 0.15, y + 0.15, 1.3, 1.3, 6)} m="m-card" />
          <Drum gx={c.gx} gy={c.gy} r={18} h={30} z0={6} tone />
          <Drum gx={c.gx} gy={c.gy} r={16} h={30} z0={36} />
          <Drum gx={c.gx} gy={c.gy} r={14} h={28} z0={66} tone />
          <rect x={lamp.x - 8} y={lamp.y - 14} width={16} height={12} rx={2} className="q-lamp" />
          <path d={`M${lamp.x - 10},${lamp.y - 14} L${lamp.x},${lamp.y - 24} L${lamp.x + 10},${lamp.y - 14} Z`} className="m-tone l" />
        </>
      );
    }
    case "stage": {
      const back = iso(x + 0.8, y + 0.2, 40);
      return (
        <>
          <polygon points={shadowOf(x, y, 1.6, 1.4, 30)} className="shadow" />
          <Solid f={box(x, y, 1.6, 1.4, 8)} m="m-wood" />
          <Solid f={box(x + 0.05, y + 0.05, 1.5, 0.12, 36, 8)} m="m-tone" />
          <Solid f={box(x + 0.1, y + 0.9, 0.22, 0.22, 16, 8)} m="m-steel" />
          <Solid f={box(x + 1.25, y + 0.9, 0.22, 0.22, 16, 8)} m="m-steel" />
          <ellipse cx={back.x} cy={back.y + 26} rx={22} ry={9} className="q-spot" />
        </>
      );
    }
    case "lab": {
      const ch = iso(x + 1.25, y + 0.35, 52);
      return (
        <>
          <polygon points={shadowOf(x + 0.1, y + 0.1, 1.4, 1.4, 50)} className="shadow" />
          <Solid f={box(x + 0.1, y + 0.1, 1.4, 1.4, 28)} m="m-card" />
          <Solid f={box(x + 0.2, y + 0.2, 1.2, 1.2, 14, 28)} m="m-glass" />
          <Solid f={box(x + 1.15, y + 0.25, 0.22, 0.22, 24, 28)} m="m-tone" />
          <path d={`M${ch.x},${ch.y - 2} q-4,-8 0,-14 t0,-14`} className="q-steam" />
          {[0.3, 0.75].map((a) => <polygon key={a} points={quadL(y + 1.5, x + a + 0.1, x + a + 0.4, 8, 20)} className="win l" />)}
          {[0.4, 0.85].map((a) => <polygon key={a} points={quadR(x + 1.5, y + a, y + a + 0.3, 8, 20)} className="win r" />)}
        </>
      );
    }
  }
}

/** Scaffolding round the footprint, a crane, and the building rising behind it. */
function UnderConstruction({ p, x, y, now, buildMs }: { p: Project; x: number; y: number; now: number; buildMs: number }) {
  const t = Math.min(1, Math.max(0.08, (now - (p.startedAt ?? now)) / buildMs));
  const h = Math.max(8, KIND_TOP[p.kind] * 0.7 * t);
  const poles = [[x + 0.1, y + LOT - 0.1], [x + LOT - 0.1, y + LOT - 0.1], [x + LOT - 0.1, y + 0.1]] as const;
  const mast = iso(x + 0.15, y + 0.15);
  const jib = iso(x + 0.15, y + 0.15, 120);
  return (
    <>
      <polygon points={diamond(x, y, LOT, LOT)} className="q-dirt" />
      <Solid f={box(x + 0.25, y + 0.25, LOT - 0.5, LOT - 0.5, h)} m="m-card" />
      {poles.map(([gx, gy], i) => { const a = iso(gx, gy), b = iso(gx, gy, h + 10); return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="q-scaffold" />; })}
      {Array.from({ length: Math.ceil((h + 10) / 14) }, (_, k) => (k + 1) * 14).filter((z) => z <= h + 10).map((z) => (
        <polyline key={z} points={pts(iso(x + 0.1, y + LOT - 0.1, z), iso(x + LOT - 0.1, y + LOT - 0.1, z), iso(x + LOT - 0.1, y + 0.1, z))} className="q-scaffold" />
      ))}
      {/* Crane: mast, jib and a swinging hook. */}
      <line x1={mast.x} y1={mast.y} x2={jib.x} y2={jib.y} className="q-crane" />
      <line x1={jib.x - 18} y1={jib.y} x2={jib.x + 52} y2={jib.y + 6} className="q-crane" />
      <g className="q-hook"><line x1={jib.x + 40} y1={jib.y + 5} x2={jib.x + 40} y2={jib.y + 40} className="q-cable" /><rect x={jib.x + 36} y={jib.y + 40} width={8} height={6} className="q-brick" /></g>
    </>
  );
}

/** Proposed: a fenced lot with a sign showing how many bricks it still needs. */
function Proposed({ p, x, y }: { p: Project; x: number; y: number }) {
  const sign = iso(x + LOT / 2, y + LOT - 0.1, 30);
  const frac = Math.min(1, p.raised / p.cost);
  return (
    <>
      <polygon points={diamond(x, y, LOT, LOT)} className="q-dirt" />
      <polyline points={pts(iso(x, y + LOT, 6), iso(x + LOT, y + LOT, 6), iso(x + LOT, y, 6))} className="q-fence" />
      {p.raised > 0 && <Solid f={box(x + 0.5, y + 0.6, 0.5, 0.3, Math.max(2, 14 * frac))} m="q-pile" />}
      <g transform={`translate(${sign.x},${sign.y})`} className="q-sign">
        <line x1={0} y1={0} x2={0} y2={24} className="q-post" />
        <rect x={-30} y={-16} width={60} height={20} rx={3} />
        <rect x={-26} y={-3.5} width={52} height={4} rx={2} className="q-bar" />
        <rect x={-26} y={-3.5} width={52 * frac} height={4} rx={2} className="q-bar-fill" />
        <text y={-6.5} textAnchor="middle">{p.raised}/{p.cost} bricks</text>
      </g>
    </>
  );
}

/** One building in the quarter, in whatever state it's in, with its name above it. */
export function ProjectArt({ p, now, buildMs, selected, onSelect }: { p: Project; now: number; buildMs: number; selected: boolean; onSelect: () => void }) {
  const { x, y } = quarterLot(p.lot);
  const top = p.status === "built" ? KIND_TOP[p.kind] : p.status === "building" ? KIND_TOP[p.kind] * 0.75 + 30 : 46;
  const label = iso(x + LOT / 2, y + LOT / 2, top + 8);
  const h = hue(p.handle);
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } };
  const state = p.status === "built" ? "built" : p.status === "building" ? "under construction" : `needs ${p.cost - p.raised} more bricks`;
  return (
    <g className={`project ${p.status} ${selected ? "sel" : ""}`} style={{ ["--tone" as string]: `oklch(0.66 0.14 ${h})`, ["--h" as string]: h } as CSSProperties}
      role="button" tabIndex={0} aria-label={`${p.name}, a ${p.kind} proposed by @${p.handle}, ${state}`} onClick={onSelect} onKeyDown={key}>
      <polygon points={diamond(x - 0.1, y - 0.1, LOT + 0.2, LOT + 0.2)} className="plot" />
      {p.status === "built" ? <Finished p={p} x={x} y={y} /> : p.status === "building" ? <UnderConstruction p={p} x={x} y={y} now={now} buildMs={buildMs} /> : <Proposed p={p} x={x} y={y} />}
      <text x={label.x} y={label.y} className="place-label q-label" textAnchor="middle">{p.name}</text>
    </g>
  );
}
