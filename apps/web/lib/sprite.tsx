// Agent sprites: every agent is a small robot assembled from parts picked by its handle, so it
// always looks the same, wherever it appears. Its trading style adds a piece of gear and its
// level adds trim. Drawn with the feet at (0, 0), about 50 px tall, facing the viewer.

import type { CSSProperties } from "react";
import { hue } from "./api";

export type Locomotion = "legs" | "wheels" | "hover";
export interface Build {
  head: "box" | "dome" | "tv" | "can";
  eyes: "visor" | "round" | "cyclops" | "led";
  antenna: "ball" | "twin" | "bolts" | "dish";
  body: "box" | "barrel" | "taper";
  moves: Locomotion;
}

const seed = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};
const pick = <T,>(xs: readonly T[], n: number) => xs[n % xs.length]!;

/** The parts an agent is built from: fixed by its handle. */
export function buildFor(handle: string): Build {
  const h = seed(handle);
  return {
    head: pick(["box", "dome", "tv", "can"] as const, h),
    eyes: pick(["visor", "round", "cyclops", "led"] as const, h >>> 3),
    antenna: pick(["ball", "twin", "bolts", "dish"] as const, h >>> 6),
    body: pick(["box", "barrel", "taper"] as const, h >>> 9),
    moves: pick(["legs", "legs", "wheels", "hover"] as const, h >>> 12),
  };
}

/** Head geometry per shape: its box, and where the eyes sit. */
const HEADS = {
  box: { x: -7.5, y: -44, w: 15, h: 12.5, r: 4, eye: -38 },
  dome: { x: -8, y: -45, w: 16, h: 14, r: 8, eye: -37 },
  tv: { x: -10, y: -43, w: 20, h: 12, r: 2.5, eye: -37.5 },
  can: { x: -6.5, y: -46, w: 13, h: 15, r: 6.5, eye: -39 },
} as const;

function Eyes({ kind, y }: { kind: Build["eyes"]; y: number }) {
  switch (kind) {
    case "visor": return <rect className="sp-eye" x={-5.5} y={y - 2.3} width={11} height={4.6} rx={2.3} />;
    case "round": return <><circle className="sp-eye" cx={-3} cy={y} r={2.1} /><circle className="sp-eye" cx={3} cy={y} r={2.1} /></>;
    case "cyclops": return <><circle className="sp-eye" cx={0} cy={y} r={3.3} /><circle className="sp-pupil" cx={0.6} cy={y} r={1.3} /></>;
    case "led": return <>{[-4.5, -1.5, 1.5, 4.5].map((x) => <rect key={x} className="sp-eye" x={x - 1} y={y - 1.4} width={2} height={2.8} rx={0.6} />)}</>;
  }
}

function Antenna({ kind, top, gold }: { kind: Build["antenna"]; top: number; gold: boolean }) {
  const tip = gold ? "sp-gold" : "sp-tip";
  switch (kind) {
    case "ball": return <><line className="sp-wire" x1={0} y1={top} x2={0} y2={top - 5} /><circle className={tip} cy={top - 6.5} r={1.9} /></>;
    case "twin": return <><line className="sp-wire" x1={-2.5} y1={top} x2={-5} y2={top - 5} /><line className="sp-wire" x1={2.5} y1={top} x2={5} y2={top - 5} /><circle className={tip} cx={-5.3} cy={top - 6} r={1.5} /><circle className={tip} cx={5.3} cy={top - 6} r={1.5} /></>;
    case "bolts": return <><circle className={tip} cx={-8.4} cy={top + 6} r={1.8} /><circle className={tip} cx={8.4} cy={top + 6} r={1.8} /></>;
    case "dish": return <><line className="sp-wire" x1={0} y1={top} x2={0} y2={top - 3} /><path className={tip} d={`M-4.5,${top - 6} q4.5,5 9,0 Z`} /></>;
  }
}

/** Trading-style gear, so you can tell a sniper from a scalper at a glance. */
function Gear({ style, head }: { style?: string; head: (typeof HEADS)[keyof typeof HEADS] }) {
  switch (style) {
    case "momentum": return <path className="sp-stripe" d="M-6,-17 l5,-8 M-2,-15 l5,-8" />;
    case "contrarian": return <path className="sp-badge" d="M-3,-24 h6 l-3,4.5 Z" />;
    case "sniper": return <><rect className="sp-gear" x={head.x + head.w - 1} y={head.y + 2} width={6} height={3.4} rx={1} /><circle className="sp-lens" cx={head.x + head.w + 5.2} cy={head.y + 3.7} r={1.7} /></>;
    case "scalper": return <><path className="sp-gear-line" d={`M${head.x - 1},${head.y + 6} Q0,${head.y - 6} ${head.x + head.w + 1},${head.y + 6}`} /><rect className="sp-gear" x={head.x - 2.5} y={head.y + 4} width={3} height={5} rx={1} /><path className="sp-gear-line" d={`M${head.x - 1},${head.y + 8} q1,5 6,5`} /></>;
    case "conviction": return <path className="sp-shield" d="M-4.5,-27 h9 v4 q0,4.5 -4.5,6.5 q-4.5,-2 -4.5,-6.5 Z" />;
    default: return null;
  }
}

/** A whole agent, feet at the origin. */
export function Bot({ handle, style, level = 1, walking = false, facing = 1 }: { handle: string; style?: string; level?: number; walking?: boolean; facing?: 1 | -1 }) {
  const b = buildFor(handle);
  const hd = HEADS[b.head];
  const lift = b.moves === "hover" ? -5 : b.moves === "wheels" ? -2 : 0;
  return (
    <g className={`sprite moves-${b.moves} ${walking ? "walking" : ""}`} style={{ ["--h" as string]: hue(handle) } as CSSProperties}>
      <ellipse className="pawn-shadow" cx={3} rx={11} ry={5} />
      <g transform={facing === -1 ? "scale(-1,1)" : undefined}>
        <g className="bot">
          {b.moves === "legs" && <><rect className="sp-steel leg leg-a" x={-5.2} y={-12} width={3.8} height={12} rx={1.8} /><rect className="sp-steel leg leg-b" x={1.4} y={-12} width={3.8} height={12} rx={1.8} /></>}
          {b.moves === "wheels" && <><rect className="sp-steel" x={-6} y={-12} width={12} height={6} rx={2} /><g className="wheel"><circle className="sp-tyre" cx={-5} cy={-4} r={4} /><line className="sp-spoke" x1={-5} y1={-7} x2={-5} y2={-1} /></g><g className="wheel"><circle className="sp-tyre" cx={5} cy={-4} r={4} /><line className="sp-spoke" x1={5} y1={-7} x2={5} y2={-1} /></g></>}
          {b.moves === "hover" && <><ellipse className="sp-jet" cy={-3} rx={6} ry={2.4} /><path className="sp-steel" d="M-5,-12 h10 l-2,4 h-6 Z" /></>}
          <g transform={`translate(0,${lift})`}>
            {b.body === "box" && <rect className="sp-body" x={-8} y={-30} width={16} height={18} rx={5} />}
            {b.body === "barrel" && <rect className="sp-body" x={-9} y={-30} width={18} height={18} rx={9} />}
            {b.body === "taper" && <path className="sp-body" d="M-10,-30 Q-10,-31 -9,-31 H9 Q10,-31 10,-30 L7,-12 H-7 Z" />}
            <path className="sp-shade" d={b.body === "taper" ? "M0,-31 H9 Q10,-31 10,-30 L7,-12 H0 Z" : `M0,-30 H${b.body === "barrel" ? 0 : 3} Q8,-30 8,-25 V-17 Q8,-12 3,-12 H0 Z`} />
            {!style && <circle className="sp-core" cy={-21} r={2.4} />}
            <Gear style={style} head={hd} />
            {/* Neck: every head sits about a pixel above the body. */}
            <rect className="sp-steel" x={-2.5} y={hd.y + hd.h - 1.5} width={5} height={4} rx={1} />
            <rect className="sp-head" x={hd.x} y={hd.y} width={hd.w} height={hd.h} rx={hd.r} />
            <Eyes kind={b.eyes} y={hd.eye} />
            {/* Level 8 and up wear a crown, which takes the place of a top-mounted antenna. */}
            {(level < 8 || b.antenna === "bolts") && <Antenna kind={b.antenna} top={hd.y} gold={level >= 5} />}
            {level >= 8 && <path className="sp-gold" d={`M-5.5,${hd.y + 0.5} l-0.5,-6.5 l3.2,2.6 l2.8,-4.6 l2.8,4.6 l3.2,-2.6 l-0.5,6.5 Z`} />}
          </g>
        </g>
      </g>
    </g>
  );
}

/** Head-and-shoulders portrait for avatars. */
export function Avatar({ handle, style, level }: { handle: string; style?: string; level?: number }) {
  return (
    <svg className="avatar-sprite" viewBox="-19 -66 38 40" aria-hidden>
      <Bot handle={handle} style={style} level={level} />
    </svg>
  );
}
