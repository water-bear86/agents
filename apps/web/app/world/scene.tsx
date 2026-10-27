// Illustrations for the World map: a scale model of the town on its base board.
// Light comes from the upper left (lit left walls, shaded right walls, shadows to the lower
// right). Colours are CSS tokens (--w-*) so the same model reads as day in the light theme and
// night in the dark one, where windows and lamps light up.

import type { CSSProperties } from "react";
import {
  BLOCK, HOUSE, PITCH, SLOT_ORIGINS, box, carRoutes, cylinder, diamond, hash, house, iso, lotDecor, quadL, quadR, shadowOf, townBounds, townLots, windows,
  type Place, type Tier, type YardFeatures,
} from "../../lib/world";

type Faces = ReturnType<typeof box>;

/** The three faces of a box in one material (`m-card`, `m-tone`, `m-glass`, `m-steel`, `m-wood`). */
export function Solid({ f, m }: { f: Faces; m: string }) {
  return (
    <>
      <polygon points={f.left} className={`${m} l`} />
      <polygon points={f.right} className={`${m} r`} />
      <polygon points={f.top} className={`${m} t`} />
    </>
  );
}

/** A vertical drum: lit on the left, shaded on the right, optionally tinted with the place's tone. */
export function Drum({ gx, gy, r, h, z0 = 0, tone = false }: { gx: number; gy: number; r: number; h: number; z0?: number; tone?: boolean }) {
  const c = cylinder(gx, gy, r, h, z0);
  return (
    <>
      <path d={c.side} fill="url(#w-cyl)" className="drum" />
      {tone && <path d={c.side} className="drum-tone" />}
      <ellipse cx={c.top.x} cy={c.top.y} rx={c.rx} ry={c.ry} className={tone ? "m-tone t" : "m-card t"} />
    </>
  );
}

export function Defs() {
  return (
    <defs>
      <linearGradient id="w-cyl" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" style={{ stopColor: "var(--w-wall)" }} />
        <stop offset="0.38" style={{ stopColor: "var(--w-wall)" }} />
        <stop offset="1" style={{ stopColor: "var(--w-wall-shade)" }} />
      </linearGradient>
      <radialGradient id="w-glow">
        <stop offset="0" style={{ stopColor: "var(--w-glow)", stopOpacity: 0.55 }} />
        <stop offset="1" style={{ stopColor: "var(--w-glow)", stopOpacity: 0 }} />
      </radialGradient>
      <radialGradient id="w-canopy" cx="0.35" cy="0.3" r="0.75">
        <stop offset="0" style={{ stopColor: "var(--w-leaf-lit)" }} />
        <stop offset="1" style={{ stopColor: "var(--w-leaf)" }} />
      </radialGradient>
    </defs>
  );
}

/** Stars over the night town (hidden by day). Fixed positions, so they don't shimmer between renders. */
function Stars({ top }: { top: number }) {
  const stars = Array.from({ length: 90 }, (_, i) => ({ x: (hash(i, 1) - 0.5) * 2600, y: top - 40 - hash(i, 2) * 700, r: 0.5 + hash(i, 3) * 1.1 }));
  return <g className="stars" aria-hidden>{stars.map((st, i) => <circle key={i} cx={st.x} cy={st.y} r={st.r} />)}</g>;
}

function Garden({ x, y }: { x: number; y: number }) {
  return (
    <g className="garden">
      <polygon points={diamond(x + 0.08, y + 0.1, 1.15, 1.1)} className="bed-edge" />
      {[0, 1, 2].map((k) => <polygon key={k} points={diamond(x + 0.18, y + 0.2 + k * 0.33, 0.95, 0.2)} className={`bed b${(k + Math.floor(x + y)) % 3}`} />)}
    </g>
  );
}

function Pond({ gx, gy, rx = 17 }: { gx: number; gy: number; rx?: number }) {
  const c = iso(gx, gy);
  return (
    <g className="pond">
      <ellipse cx={c.x} cy={c.y} rx={rx + 2} ry={rx / 2 + 1} className="pond-rim" />
      <ellipse cx={c.x} cy={c.y} rx={rx} ry={rx / 2} className="water" />
      <ellipse cx={c.x - rx * 0.35} cy={c.y - 1} rx={rx * 0.22} ry={rx * 0.09} className="lily" />
      <path d={`M${c.x + rx * 0.7},${c.y} l1,-9 M${c.x + rx * 0.78},${c.y + 1} l3,-7 M${c.x + rx * 0.6},${c.y + 1} l-1,-6`} className="reeds" />
    </g>
  );
}

/** A block with no houses yet: a little park with crossing paths and a pond. */
function Park({ ox, oy }: { ox: number; oy: number }) {
  return (
    <g className="park">
      <polygon points={diamond(ox + 1.85, oy + 0.05, 0.3, BLOCK - 0.1)} className="park-path" />
      <polygon points={diamond(ox + 0.05, oy + 1.85, BLOCK - 0.1, 0.3)} className="park-path" />
      <Pond gx={ox + 2} gy={oy + 2} rx={22} />
    </g>
  );
}

/** The base board: a slab with visible edges, streets everywhere between the blocks, and one lot per
 *  block. Empty house lots grow trees, gardens or ponds; a block with no houses yet is a park. */
export function Board({ rings, houses }: { rings: number; houses: number }) {
  const { min, max } = townBounds(rings);
  const size = max - min;
  const slab = box(min, min, size, size, 12, -12);
  const lanes = [];
  for (let k = -rings; k <= 2 + rings; k++) {
    const c = k * PITCH - 0.5;
    const a = iso(c, min), b = iso(c, max), d = iso(min, c), e = iso(max, c);
    lanes.push(<line key={`x${k}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="lane" />, <line key={`y${k}`} x1={d.x} y1={d.y} x2={e.x} y2={e.y} className="lane" />);
  }
  const lots = townLots(rings);
  return (
    <g className="board" aria-hidden>
      <Stars top={iso(min, min).y} />
      <polygon points={slab.left} className="slab l" />
      <polygon points={slab.right} className="slab r" />
      <polygon points={diamond(min, min, size, size)} className="road" />
      {lanes}
      {lots.map((l) => <polygon key={`${l.bx},${l.by}`} points={diamond(l.bx * PITCH, l.by * PITCH, BLOCK, BLOCK)} className={`lot ${l.kind}`} />)}
      {lots.filter((l) => l.kind === "homes").map((l) => {
        const ox = l.bx * PITCH, oy = l.by * PITCH;
        if (l.first >= houses) return <Park key={`p${l.bx},${l.by}`} ox={ox} oy={oy} />;
        return SLOT_ORIGINS.map((sl, j) => {
          if (l.first + j < houses) return null;
          const d = lotDecor(l.bx, l.by, j);
          return d === "garden" ? <Garden key={`g${l.bx},${l.by},${j}`} x={ox + sl.x} y={oy + sl.y} />
            : d === "pond" ? <Pond key={`o${l.bx},${l.by},${j}`} gx={ox + sl.x + 0.65} gy={oy + sl.y + 0.7} />
            : null;
        });
      })}
    </g>
  );
}

/** A few cars on the streets round the town centre. Hidden when reduced motion is preferred. */
export function Cars({ rings }: { rings: number }) {
  const tints = ["c1", "c2", "c3", "c4"];
  return (
    <g className="cars" aria-hidden>
      {carRoutes(rings).map((r, i) => {
        const a = iso(r.from.x, r.from.y), b = iso(r.to.x, r.to.y);
        const f = r.axis === "x" ? box(-0.24, -0.11, 0.48, 0.22, 5) : box(-0.11, -0.24, 0.22, 0.48, 5);
        const cab = r.axis === "x" ? box(-0.12, -0.1, 0.24, 0.2, 4, 5) : box(-0.1, -0.12, 0.2, 0.24, 4, 5);
        const style = { ["--fx" as string]: `${a.x}px`, ["--fy" as string]: `${a.y}px`, ["--tx" as string]: `${b.x}px`, ["--ty" as string]: `${b.y}px`, animationDuration: `${r.dur}s`, animationDelay: `${r.delay}s` } as CSSProperties;
        return (
          <g key={i} className={`car ${tints[i % tints.length]}`} style={style}>
            <ellipse cx={3} cy={2} rx={11} ry={4.5} className="shadow" />
            <Solid f={f} m="m-car" />
            <Solid f={cab} m="m-cab" />
          </g>
        );
      })}
    </g>
  );
}

export function Tree({ x, y, s }: { x: number; y: number; s: number }) {
  const b = iso(x, y);
  const r = 11 * s;
  return (
    <g className="tree" aria-hidden>
      <ellipse cx={b.x + 9 * s} cy={b.y + 2} rx={13 * s} ry={5.5 * s} className="shadow" />
      <rect x={b.x - 1.6 * s} y={b.y - 13 * s} width={3.2 * s} height={13 * s} className="trunk" />
      <circle cx={b.x} cy={b.y - 13 * s - r * 0.8} r={r} fill="url(#w-canopy)" className="canopy" />
      <circle cx={b.x - 5 * s} cy={b.y - 13 * s - r * 0.35} r={r * 0.62} fill="url(#w-canopy)" className="canopy" />
    </g>
  );
}

export function Lamp({ x, y }: { x: number; y: number }) {
  const b = iso(x, y);
  return (
    <g className="lamp" aria-hidden>
      <ellipse cx={b.x} cy={b.y - 30} rx={26} ry={18} fill="url(#w-glow)" className="lamp-glow" />
      <line x1={b.x} y1={b.y} x2={b.x} y2={b.y - 28} className="lamp-post" />
      <circle cx={b.x} cy={b.y - 30} r={3} className="lamp-head" />
    </g>
  );
}

// ---------------------------------------------------------------- places

/** What's happening at each place right now, from the live data. */
export interface Activity {
  /** Key of a coin launched in the last few seconds: Mission control's rocket lifts off (and a new one is wheeled out after). */
  launch?: string;
  ticker: { sym: string; dir: 1 | 0 | -1 }[];
  /** Notes pinned to the plaza's board. */
  papers: number;
  calling: boolean;
  debating: boolean;
  /** Ideas pinned to the Café's board. */
  ideas: number;
}

/** Mission control: a pad with a rocket that lifts off when an agent launches a coin. */
function MissionControl({ p, launch }: { p: Place; launch?: string }) {
  const { x, y } = p;
  const c = iso(x + 1.5, y + 1.5, 5);
  const body = { l: c.x - 9, t: c.y - 98, w: 18, h: 92 };
  return (
    <>
      <polygon points={shadowOf(x + 2.05, y + 0.55, 0.45, 0.45, 104)} className="shadow" />
      <Solid f={box(x + 0.2, y + 0.2, 2.6, 2.6, 5)} m="m-card" />
      <polygon points={diamond(x + 0.6, y + 0.6, 1.8, 1.8)} className="hazard" transform="translate(0,-5)" />
      {/* Gantry: a steel tower with an arm reaching the rocket. */}
      <Solid f={box(x + 2.05, y + 0.55, 0.45, 0.45, 104, 5)} m="m-steel" />
      {[30, 52, 74, 96].map((z) => <polygon key={z} points={quadL(y + 1, x + 2.05, x + 2.5, z, z + 1.5)} className="m-card t" />)}
      <Solid f={box(x + 1.62, y + 0.7, 0.45, 0.14, 4, 78)} m="m-steel" />
      {launch && <g key={`smoke${launch}`} className="smoke">{[-22, -8, 8, 22].map((dx) => <circle key={dx} cx={c.x + dx} cy={c.y - 4} r={9} />)}</g>}
      {/* Rocket: lifts off when an agent launches a coin. */}
      <g key={launch ?? "idle"} className={`rocket-g ${launch ? "liftoff" : ""}`}>
      {launch && <path d={`M${c.x - 6},${c.y} Q${c.x},${c.y + 34} ${c.x + 6},${c.y} Z`} className="flame" />}
      <path d={`M${body.l},${c.y - 6} l-3,6 h${body.w + 6} l-3,-6 Z`} className="exhaust" />
      <path d={`M${body.l},${body.t + 12} L${body.l - 9},${c.y - 4} L${body.l},${c.y - 14} Z`} className="m-tone l" />
      <rect x={body.l} y={body.t} width={body.w} height={body.h} rx={7} className="rocket" />
      <rect x={c.x} y={body.t} width={body.w / 2} height={body.h} rx={0} className="rocket-shade" />
      <path d={`M${body.l + body.w},${body.t + 12} L${body.l + body.w + 9},${c.y - 4} L${body.l + body.w},${c.y - 14} Z`} className="m-tone r" />
      <path d={`M${body.l},${body.t + 2} Q${c.x},${body.t - 30} ${body.l + body.w},${body.t + 2} Z`} className="m-tone l" />
      <rect x={body.l} y={body.t + 34} width={body.w} height={7} className="m-tone r" />
      <circle cx={c.x - 1} cy={body.t + 22} r={3.6} className="porthole" />
      </g>
    </>
  );
}

function Exchange({ p, ticker }: { p: Place; ticker: Activity["ticker"] }) {
  const { x, y } = p;
  const w = windows(x + 0.55, y + 0.55, 1.9, 1.9, [24, 33, 42, 51, 60, 69, 78, 87, 96], 0.36, 0.2, 5.5);
  const top = iso(x + 1.5, y + 1.5, 120);
  return (
    <>
      <polygon points={shadowOf(x + 0.55, y + 0.55, 1.9, 1.9, 120)} className="shadow" />
      <Solid f={box(x + 0.15, y + 0.15, 2.7, 2.7, 16)} m="m-card" />
      <polygon points={quadL(y + 2.85, x + 0.3, x + 2.7, 10, 15.5)} className="ticker" />
      {/* The ticker scrolls the live coins on the podium's lit wall (a transform aligns text with the wall). */}
      {(() => {
        const o = iso(x + 0.3, y + 2.85, 15.5);
        const w = 2.4 * Math.hypot(32, 16);
        const items = ticker.length ? ticker : [{ sym: "WAITING FOR THE MARKET", dir: 0 as const }];
        const run = (k: number) => items.map((t, i) => <tspan key={`${k}-${i}`} className={t.dir > 0 ? "up" : t.dir < 0 ? "down" : ""}>{`$${t.sym}${t.dir > 0 ? " ▲" : t.dir < 0 ? " ▼" : ""}   `}</tspan>);
        return (
          <g transform={`matrix(${32 / Math.hypot(32, 16)} ${16 / Math.hypot(32, 16)} 0 1 ${o.x} ${o.y})`}>
            <clipPath id="w-ticker-clip"><rect x={0} y={0} width={w} height={5.5} /></clipPath>
            <g clipPath="url(#w-ticker-clip)"><text x={2} y={4.3} className="ticker-text">{run(0)}{run(1)}</text></g>
          </g>
        );
      })()}
      <polygon points={quadL(y + 2.85, x + 1.15, x + 1.85, 0, 9)} className="entrance" />
      <Solid f={box(x + 0.55, y + 0.55, 1.9, 1.9, 92, 16)} m="m-glass" />
      {w.left.map((q) => <polygon key={q} points={q} className="win l" />)}
      {w.right.map((q) => <polygon key={q} points={q} className="win r" />)}
      <Solid f={box(x + 0.85, y + 0.85, 1.3, 1.3, 12, 108)} m="m-card" />
      <line x1={top.x} y1={top.y} x2={top.x} y2={top.y - 22} className="mast" />
      <circle cx={top.x} cy={top.y - 23} r={2.2} className="beacon" />
    </>
  );
}

function Plaza({ p, papers }: { p: Place; papers: number }) {
  const { x, y } = p;
  const lines = [];
  for (let k = 0.5; k < 3; k += 0.5) {
    const a = iso(x + k, y), b = iso(x + k, y + 3), c = iso(x, y + k), d = iso(x + 3, y + k);
    lines.push(<line key={`a${k}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="joint" />, <line key={`b${k}`} x1={c.x} y1={c.y} x2={d.x} y2={d.y} className="joint" />);
  }
  const f = cylinder(x + 1.6, y + 1.7, 24, 6);
  const jet = iso(x + 1.6, y + 1.7, 6);
  const notes = ([[0.4, "n1"], [0.8, "n2"], [1.2, "n3"], [1.6, "n1"], [2.0, "n2"], [0.6, "n3"], [1.4, "n2"], [1.85, "n3"]] as const).slice(0, Math.max(1, Math.min(8, papers)));
  return (
    <>
      <polygon points={diamond(x, y, 3, 3)} className="paving" />
      {lines}
      {/* Notice board, where posts go up. */}
      <polygon points={shadowOf(x + 0.3, y + 0.2, 2.4, 0.12, 40)} className="shadow" />
      <Solid f={box(x + 0.35, y + 0.2, 0.08, 0.12, 14)} m="m-steel" />
      <Solid f={box(x + 2.55, y + 0.2, 0.08, 0.12, 14)} m="m-steel" />
      <Solid f={box(x + 0.3, y + 0.2, 2.4, 0.12, 28, 14)} m="m-tone" />
      {notes.map(([a, n], i) => <polygon key={i} points={quadL(y + 0.32, x + a, x + a + 0.32, (i >= 5 ? 17 : 26) + (i % 2) * 2, (i >= 5 ? 25 : 36) + (i % 2) * 2)} className={`note ${n}`} />)}
      {/* Fountain. */}
      <path d={f.side} fill="url(#w-cyl)" className="drum" />
      <ellipse cx={f.top.x} cy={f.top.y} rx={f.rx} ry={f.ry} className="m-card t" />
      <ellipse cx={f.top.x} cy={f.top.y + 1} rx={f.rx - 4} ry={f.ry - 2.5} className="water" />
      <path d={`M${jet.x},${jet.y} C${jet.x - 1},${jet.y - 26} ${jet.x - 12},${jet.y - 20} ${jet.x - 15},${jet.y - 4} M${jet.x},${jet.y} C${jet.x + 1},${jet.y - 26} ${jet.x + 12},${jet.y - 20} ${jet.x + 15},${jet.y - 4}`} className="spray" />
      {/* Benches. */}
      <Solid f={box(x + 0.35, y + 2.45, 0.75, 0.2, 5)} m="m-wood" />
      <Solid f={box(x + 2.45, y + 0.6, 0.2, 0.75, 5)} m="m-wood" />
    </>
  );
}

function Observatory({ p, calling }: { p: Place; calling: boolean }) {
  const { x, y } = p;
  const cx = x + 0.8, cy = y + 0.8;
  const d = cylinder(cx, cy, 30, 30, 9);
  const r = 31;
  return (
    <>
      <polygon points={shadowOf(x + 0.2, y + 0.2, 1.2, 1.2, 80)} className="shadow" />
      <Solid f={box(x, y, 1.6, 1.6, 9)} m="m-card" />
      <Drum gx={cx} gy={cy} r={30} h={30} z0={9} />
      {/* Dome, its observing slit, and the telescope. */}
      <path d={`M${d.top.x - r},${d.top.y} A${r},${r * 0.95} 0 0 1 ${d.top.x + r},${d.top.y} A${r},${r / 2} 0 0 1 ${d.top.x - r},${d.top.y} Z`} className="dome" />
      <path d={`M${d.top.x - r},${d.top.y} A${r},${r * 0.95} 0 0 1 ${d.top.x + r},${d.top.y} A${r},${r / 2} 0 0 1 ${d.top.x - r},${d.top.y} Z`} className="dome-shade" />
      <path d={`M${d.top.x - 3},${d.top.y + 8} L${d.top.x - 5},${d.top.y - 26} L${d.top.x + 5},${d.top.y - 27} L${d.top.x + 4},${d.top.y + 8} Z`} className="slit" />
      <line x1={d.top.x} y1={d.top.y - 8} x2={d.top.x + 15} y2={d.top.y - 36} className="scope" />
      {calling && <path d={`M${d.top.x + 17},${d.top.y - 48} l2,7 l7,2 l-7,2 l-2,7 l-2,-7 l-7,-2 l7,-2 Z`} className="glint" />}
      {[0.15, 0.55, 0.95].map((a) => <polygon key={a} points={quadL(y + 1.6, x + a, x + a + 0.22, 3, 7)} className="win l" />)}
    </>
  );
}

function DebateHall({ p, debating }: { p: Place; debating: boolean }) {
  const { x, y } = p;
  const cx = x + 1.1, cy = y + 1.1;
  const top = iso(cx, cy, 40);
  // The front half of a ring of columns (toward the viewer is +x/+y), back to front.
  const cols = [-40, -10, 20, 50, 80, 110, 130].map((deg) => ({ gx: cx + 0.74 * Math.cos((deg * Math.PI) / 180), gy: cy + 0.74 * Math.sin((deg * Math.PI) / 180) }))
    .sort((a, b) => a.gx + a.gy - (b.gx + b.gy));
  return (
    <>
      <polygon points={shadowOf(x + 0.3, y + 0.3, 1.6, 1.6, 64)} className="shadow" />
      <Solid f={box(x, y, 2.2, 2.2, 4)} m="m-card" />
      <Solid f={box(x + 0.18, y + 0.18, 1.84, 1.84, 4, 4)} m="m-card" />
      <Drum gx={cx} gy={cy} r={27} h={30} z0={8} tone />
      {cols.map((c, i) => <Drum key={i} gx={c.gx} gy={c.gy} r={3.4} h={30} z0={8} />)}
      <ellipse cx={top.x} cy={top.y} rx={44} ry={22} className="m-card r" />
      <ellipse cx={top.x} cy={top.y - 3} rx={44} ry={22} className="m-card t" />
      <path d={`M${top.x - 32},${top.y - 3} A32,22 0 0 1 ${top.x + 32},${top.y - 3} A32,16 0 0 1 ${top.x - 32},${top.y - 3} Z`} className="m-tone l" />
      {debating && (
        <g className="speech">
          <g transform={`translate(${top.x - 24},${top.y - 44})`}><rect x={-11} y={-9} width={22} height={15} rx={7} /><path d="M-3,6 l-4,6 l9,-6 Z" /><text y={2.5} textAnchor="middle">!?</text></g>
          <g transform={`translate(${top.x + 22},${top.y - 52})`} className="late"><rect x={-11} y={-9} width={22} height={15} rx={7} /><path d="M3,6 l4,6 l-9,-6 Z" /><text y={2.5} textAnchor="middle">!</text></g>
        </g>
      )}
    </>
  );
}

/** The Café: a corner shop with a striped awning, its neon sign on the roof and the idea board on its side wall. */
function Cafe({ p, ideas }: { p: Place; ideas: number }) {
  const { x, y, sx, sy, h } = p;
  const front = y + sy, side = x + sx;
  // Awning stripes along the front, sloping out over the terrace.
  const stripes = [];
  for (let k = 0, a = x + 0.1; a < side - 0.15; a += 0.3, k++) {
    const b = Math.min(a + 0.3, side - 0.1);
    stripes.push(<polygon key={k} points={[iso(a, front, 27), iso(b, front, 27), iso(b, front + 0.5, 19), iso(a, front + 0.5, 19)].map((q) => `${q.x},${q.y}`).join(" ")} className={k % 2 ? "awning-b" : "awning-a"} />);
  }
  const sign = iso(x + sx / 2, y + sy / 2, h + 10);
  const notes = [[0.18, 0.5, 22], [0.62, 0.95, 24], [1.05, 1.38, 21], [0.25, 0.6, 12], [0.7, 1.05, 13], [1.1, 1.42, 11]].slice(0, Math.max(1, Math.min(6, ideas)));
  return (
    <>
      <polygon points={diamond(10, 5, BLOCK, BLOCK)} className="terrace" />
      {[0.8, 1.6, 2.4, 3.2].map((k) => { const a = iso(10 + k, 5), b = iso(10 + k, 9), c = iso(10, 5 + k), d = iso(14, 5 + k); return <g key={k}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="joint" /><line x1={c.x} y1={c.y} x2={d.x} y2={d.y} className="joint" /></g>; })}
      <polygon points={shadowOf(x, y, sx, sy, h)} className="shadow" />
      <Solid f={box(x, y, sx, sy, h)} m="m-card" />
      <Solid f={box(x - 0.05, y - 0.05, sx + 0.1, sy + 0.1, 3, h)} m="m-tone" />
      {/* Shopfront glazing, door, and the windows on the side street. */}
      <polygon points={quadL(front, x + 0.15, x + 1.05, 4, 22)} className="win l cafe-glass" />
      <polygon points={quadL(front, x + 1.55, side - 0.15, 4, 22)} className="win l cafe-glass" />
      <polygon points={quadL(front, x + 1.15, x + 1.45, 0, 20)} className="door" />
      <polygon points={quadR(side, y + 0.15, y + 0.45, 8, 20)} className="win r" />
      {/* The idea board: one note per idea pinned there. */}
      <polygon points={quadR(side + 0.01, y + 0.55, y + sy - 0.08, 6, 28)} className="idea-board" />
      {notes.map(([a, b, z], i) => <polygon key={i} points={quadR(side + 0.02, y + 0.5 + a!, y + 0.5 + b!, z!, z! + 7)} className={`note n${(i % 3) + 1}`} />)}
      {stripes}
      {/* Neon sign on the roof. */}
      <g className="cafe-sign" transform={`translate(${sign.x},${sign.y})`}>
        <rect x={-21} y={-13} width={42} height={16} rx={4} />
        <text y={-1.5} textAnchor="middle">Café</text>
      </g>
    </>
  );
}

/** A café table on the terrace, drawn in depth order with the agents sitting at it; a busy table has steaming cups. */
export function CafeTable({ x, y, busy }: { x: number; y: number; busy: boolean }) {
  const top = iso(x, y, 15);
  const c = cylinder(x, y, 2, 14);
  return (
    <g className="cafe-table" aria-hidden>
      <ellipse cx={iso(x, y).x} cy={iso(x, y).y} rx={13} ry={6.5} className="shadow" />
      <path d={c.side} className="m-steel l" />
      <ellipse cx={top.x} cy={top.y + 1.5} rx={13} ry={6.5} className="m-wood r" />
      <ellipse cx={top.x} cy={top.y} rx={13} ry={6.5} className="m-wood t" />
      <rect x={top.x - 7} y={top.y - 4} width={3.5} height={3.5} rx={1} className="cup" />
      <rect x={top.x + 3.5} y={top.y - 2} width={3.5} height={3.5} rx={1} className="cup" />
      {busy && <path d={`M${top.x - 5.3},${top.y - 5} q-2,-4 0,-7 t0,-7 M${top.x + 5.2},${top.y - 3} q2,-4 0,-7 t0,-7`} className="steam" />}
    </g>
  );
}

/** String lights over the front of the terrace, drawn above everything on it. */
export function CafeLights() {
  const posts = [{ x: 10.2, y: 9.1 }, { x: 14.05, y: 9.1 }, { x: 14.05, y: 5.6 }];
  const top = (q: { x: number; y: number }) => iso(q.x, q.y, 52);
  const sag = (a: { x: number; y: number }, b: { x: number; y: number }) => `M${a.x},${a.y} Q${(a.x + b.x) / 2},${(a.y + b.y) / 2 + 16} ${b.x},${b.y}`;
  const runs = [[posts[0]!, posts[1]!], [posts[1]!, posts[2]!]] as const;
  const bulbs = runs.flatMap(([a, b], r) => Array.from({ length: 9 }, (_, i) => {
    const t = (i + 0.5) / 9, A = top(a), B = top(b);
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2 + 16;
    return { x: (1 - t) ** 2 * A.x + 2 * (1 - t) * t * mx + t * t * B.x, y: (1 - t) ** 2 * A.y + 2 * (1 - t) * t * my + t * t * B.y, k: r * 9 + i };
  }));
  return (
    <g className="cafe-lights" aria-hidden>
      {posts.map((q, i) => { const b = iso(q.x, q.y), t = top(q); return <line key={i} x1={b.x} y1={b.y} x2={t.x} y2={t.y} className="post" />; })}
      {runs.map(([a, b], i) => <path key={i} d={sag(top(a), top(b))} className="wire" />)}
      {bulbs.map((b) => <circle key={b.k} cx={b.x} cy={b.y + 2} r={1.8} className={`bulb b${b.k % 3}`} />)}
    </g>
  );
}

export function PlaceArt({ p, act }: { p: Place; act: Activity }) {
  switch (p.id) {
    case "launchpad": return <MissionControl p={p} launch={act.launch} />;
    case "exchange": return <Exchange p={p} ticker={act.ticker} />;
    case "plaza": return <Plaza p={p} papers={act.papers} />;
    case "observatory": return <Observatory p={p} calling={act.calling} />;
    case "debate": return <DebateHall p={p} debating={act.debating} />;
    case "cafe": return <Cafe p={p} ideas={act.ideas} />;
    default: return null;
  }
}

// ---------------------------------------------------------------- houses and agents

/** An agent's home, sized by its level (cottage, two-storey, villa with a pool, tower), with its
 *  badges in the yard. Windows glow when the owner is home. */
export function HouseArt({ x, y, t, yard }: { x: number; y: number; t: Tier; yard: YardFeatures }) {
  const n = HOUSE.size;
  const tower = t.tier === 4;
  const h = house(x, y, t.wall, t.roof);
  const siding = Array.from({ length: Math.floor(t.wall / 6) }, (_, k) => (k + 1) * 6).filter((z) => z < t.wall - 2)
    .map((z) => { const a = iso(x, y + n, z), b = iso(x + n, y + n, z); return <line key={z} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="siding" />; });
  const corner = iso(x + n, y + n, t.wall);
  const chimneyZ = t.wall + t.roof * 0.55;
  const topC = iso(x + n / 2, y + n / 2, t.wall + 4);
  const pathPts = [iso(x + n * 0.4, y + n), iso(x + n * 0.6, y + n), iso(x + n * 0.6, y + n + 0.42), iso(x + n * 0.4, y + n + 0.42)].map((q) => `${q.x},${q.y}`).join(" ");
  return (
    <>
      <polygon points={shadowOf(x, y, n, n, t.wall + t.roof * 0.6)} className="shadow" />
      <polygon points={pathPts} className="path" />
      {t.tier === 3 && (
        <>
          <Solid f={box(x - 0.18, y - 0.18, 0.12, n + 0.3, 7)} m="m-hedge" />
          <polygon points={diamond(x + n * 0.7, y + n + 0.1, 0.42, 0.4)} className="pool-rim" />
          <polygon points={diamond(x + n * 0.7 + 0.04, y + n + 0.14, 0.34, 0.32)} className="water" />
        </>
      )}
      <polygon points={h.left} className="m-card l" />
      <polygon points={h.right} className="m-card r" />
      {siding}
      <polygon points={h.door} className="door" />
      {t.storeys.map((z) => (
        <g key={z}>
          <polygon points={quadL(y + n, x + n * 0.08, x + n * 0.28, z, z + 8)} className="win l" />
          {z > 10 && <polygon points={quadL(y + n, x + n * 0.72, x + n * 0.92, z, z + 8)} className="win l" />}
          <polygon points={quadR(x + n, y + n * 0.3, y + n * 0.5, z, z + 8)} className="win r" />
          <polygon points={quadR(x + n, y + n * 0.72, y + n * 0.9, z, z + 8)} className="win r" />
        </g>
      ))}
      {tower ? (
        <>
          <Solid f={box(x - 0.02, y - 0.02, n + 0.04, n + 0.04, 4, t.wall)} m="m-tone-agent" />
          <line x1={topC.x} y1={topC.y} x2={topC.x} y2={topC.y - 20} className="mast" />
          <circle cx={topC.x} cy={topC.y - 21} r={3} className="house-beacon" />
        </>
      ) : (
        <>
          <polygon points={h.roofLeft} className="roof l" />
          <polygon points={h.roofRight} className="roof r" />
          <line x1={corner.x} y1={corner.y} x2={h.apex.x} y2={h.apex.y} className="ridge" />
          <Solid f={box(x + n * 0.66, y + n * 0.22, 0.17, 0.17, 12, chimneyZ)} m="m-card" />
        </>
      )}
      {yard.statue && (() => {
        const b = iso(x + n + 0.1, y + n + 0.42, 7);
        return (
          <g className="statue">
            <Solid f={box(x + n + 0.02, y + n + 0.34, 0.16, 0.16, 7)} m="m-card" />
            <rect x={b.x - 3} y={b.y - 12} width={6} height={8} rx={2} /><rect x={b.x - 2.5} y={b.y - 18} width={5} height={5} rx={1.5} />
          </g>
        );
      })()}
      {yard.fire && (() => {
        const b = iso(x - 0.08, y + n + 0.42);
        return (
          <g className="firepit">
            <ellipse cx={b.x} cy={b.y} rx={6} ry={3} className="pit" />
            <path d={`M${b.x - 3},${b.y} Q${b.x - 2},${b.y - 9} ${b.x},${b.y - 12} Q${b.x + 2},${b.y - 7} ${b.x + 3},${b.y} Z`} className="fire" />
            <circle cx={b.x} cy={b.y - 4} r={12} fill="url(#w-glow)" className="fire-glow" />
          </g>
        );
      })()}
      {yard.flag && (() => {
        const b = iso(x + n + 0.12, y + 0.05);
        return (
          <g className="flag">
            <line x1={b.x} y1={b.y} x2={b.x} y2={b.y - 44} className="flagpole" />
            <path d={`M${b.x},${b.y - 44} q9,-3 18,2 q-4,5 0,9 q-9,-4 -18,-2 Z`} className="flag-cloth" />
          </g>
        );
      })()}
    </>
  );
}
