// Illustrations for the World map: a scale model of the town on its base board.
// Light comes from the upper left (lit left walls, shaded right walls, shadows to the lower
// right). Colours are CSS tokens (--w-*) so the same model reads as day in the light theme and
// night in the dark one, where windows and lamps light up.

import { HOUSE, box, cylinder, diamond, house, iso, quadL, quadR, shadowOf, windows, type Place } from "../../lib/world";

type Faces = ReturnType<typeof box>;

/** The three faces of a box in one material (`m-card`, `m-tone`, `m-glass`, `m-steel`, `m-wood`). */
function Solid({ f, m }: { f: Faces; m: string }) {
  return (
    <>
      <polygon points={f.left} className={`${m} l`} />
      <polygon points={f.right} className={`${m} r`} />
      <polygon points={f.top} className={`${m} t`} />
    </>
  );
}

/** A vertical drum: lit on the left, shaded on the right, optionally tinted with the place's tone. */
function Drum({ gx, gy, r, h, z0 = 0, tone = false }: { gx: number; gy: number; r: number; h: number; z0?: number; tone?: boolean }) {
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

/** The base board: a slab with visible edges, grass in two shades, and the two roads. */
export function Board({ grid }: { grid: number }) {
  const slab = box(-0.5, -0.5, grid + 1, grid + 1, 12, -12);
  const tiles = [];
  for (let i = 0; i < grid; i++) for (let j = 0; j < grid; j++) if ((i + j) % 2) tiles.push(<polygon key={`${i}-${j}`} points={diamond(i, j)} className="grass-alt" />);
  const lane = (a: { x: number; y: number }, b: { x: number; y: number }) => <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="lane" />;
  return (
    <g className="board" aria-hidden>
      <polygon points={slab.left} className="slab l" />
      <polygon points={slab.right} className="slab r" />
      <polygon points={diamond(-0.5, -0.5, grid + 1, grid + 1)} className="ground" />
      {tiles}
      <polygon points={diamond(3.3, 5, grid - 3.3, 1.4)} className="road" />
      <polygon points={diamond(5, 2.6, 1.4, grid - 2.6)} className="road" />
      {lane(iso(3.5, 5.7), iso(grid, 5.7))}
      {lane(iso(5.7, 2.8), iso(5.7, grid))}
      <polygon points={diamond(5, 5, 1.4, 1.4)} className="road junction" />
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

function Launchpad({ p }: { p: Place }) {
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
      {/* Rocket. */}
      <path d={`M${body.l},${c.y - 6} l-3,6 h${body.w + 6} l-3,-6 Z`} className="exhaust" />
      <path d={`M${body.l},${body.t + 12} L${body.l - 9},${c.y - 4} L${body.l},${c.y - 14} Z`} className="m-tone l" />
      <rect x={body.l} y={body.t} width={body.w} height={body.h} rx={7} className="rocket" />
      <rect x={c.x} y={body.t} width={body.w / 2} height={body.h} rx={0} className="rocket-shade" />
      <path d={`M${body.l + body.w},${body.t + 12} L${body.l + body.w + 9},${c.y - 4} L${body.l + body.w},${c.y - 14} Z`} className="m-tone r" />
      <path d={`M${body.l},${body.t + 2} Q${c.x},${body.t - 30} ${body.l + body.w},${body.t + 2} Z`} className="m-tone l" />
      <rect x={body.l} y={body.t + 34} width={body.w} height={7} className="m-tone r" />
      <circle cx={c.x - 1} cy={body.t + 22} r={3.6} className="porthole" />
    </>
  );
}

function Exchange({ p }: { p: Place }) {
  const { x, y } = p;
  const w = windows(x + 0.55, y + 0.55, 1.9, 1.9, [24, 33, 42, 51, 60, 69, 78, 87, 96], 0.36, 0.2, 5.5);
  const top = iso(x + 1.5, y + 1.5, 120);
  return (
    <>
      <polygon points={shadowOf(x + 0.55, y + 0.55, 1.9, 1.9, 120)} className="shadow" />
      <Solid f={box(x + 0.15, y + 0.15, 2.7, 2.7, 16)} m="m-card" />
      <polygon points={quadL(y + 2.85, x + 0.3, x + 2.7, 11, 15)} className="ticker" />
      <line x1={iso(x + 0.4, y + 2.85, 13).x} y1={iso(x + 0.4, y + 2.85, 13).y} x2={iso(x + 2.6, y + 2.85, 13).x} y2={iso(x + 2.6, y + 2.85, 13).y} className="ticker-lights" />
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

function Plaza({ p }: { p: Place }) {
  const { x, y } = p;
  const lines = [];
  for (let k = 0.5; k < 3; k += 0.5) {
    const a = iso(x + k, y), b = iso(x + k, y + 3), c = iso(x, y + k), d = iso(x + 3, y + k);
    lines.push(<line key={`a${k}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="joint" />, <line key={`b${k}`} x1={c.x} y1={c.y} x2={d.x} y2={d.y} className="joint" />);
  }
  const f = cylinder(x + 1.6, y + 1.7, 24, 6);
  const jet = iso(x + 1.6, y + 1.7, 6);
  const notes = [[0.45, "n1"], [1.05, "n2"], [1.65, "n3"], [2.15, "n1"]] as const;
  return (
    <>
      <polygon points={diamond(x, y, 3, 3)} className="paving" />
      {lines}
      {/* Notice board, where posts go up. */}
      <polygon points={shadowOf(x + 0.3, y + 0.2, 2.4, 0.12, 40)} className="shadow" />
      <Solid f={box(x + 0.35, y + 0.2, 0.08, 0.12, 14)} m="m-steel" />
      <Solid f={box(x + 2.55, y + 0.2, 0.08, 0.12, 14)} m="m-steel" />
      <Solid f={box(x + 0.3, y + 0.2, 2.4, 0.12, 28, 14)} m="m-tone" />
      {notes.map(([a, n], i) => <polygon key={i} points={quadL(y + 0.32, x + a, x + a + 0.38, 19 + (i % 2) * 4, 35 + (i % 2) * 3)} className={`note ${n}`} />)}
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

function Observatory({ p }: { p: Place }) {
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
      {[0.15, 0.55, 0.95].map((a) => <polygon key={a} points={quadL(y + 1.6, x + a, x + a + 0.22, 3, 7)} className="win l" />)}
    </>
  );
}

function DebateHall({ p }: { p: Place }) {
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
    </>
  );
}

export function PlaceArt({ p }: { p: Place }) {
  switch (p.id) {
    case "launchpad": return <Launchpad p={p} />;
    case "exchange": return <Exchange p={p} />;
    case "plaza": return <Plaza p={p} />;
    case "observatory": return <Observatory p={p} />;
    case "debate": return <DebateHall p={p} />;
    default: return null;
  }
}

// ---------------------------------------------------------------- houses and agents

/** A hip-roofed house in its owner's colour; windows glow when the owner is home. */
export function HouseArt({ x, y }: { x: number; y: number }) {
  const n = HOUSE.size;
  const h = house(x, y);
  const siding = [6, 12, 18].map((z) => { const a = iso(x, y + n, z), b = iso(x + n, y + n, z); return <line key={z} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="siding" />; });
  const corner = iso(x + n, y + n, HOUSE.wall);
  const chimneyZ = HOUSE.wall + HOUSE.roof * 0.55;
  return (
    <>
      <polygon points={shadowOf(x, y, n, n, HOUSE.wall + HOUSE.roof * 0.6)} className="shadow" />
      <polygon points={`${iso(x + n * 0.4, y + n).x},${iso(x + n * 0.4, y + n).y} ${iso(x + n * 0.6, y + n).x},${iso(x + n * 0.6, y + n).y} ${iso(x + n * 0.6, y + n + 0.42).x},${iso(x + n * 0.6, y + n + 0.42).y} ${iso(x + n * 0.4, y + n + 0.42).x},${iso(x + n * 0.4, y + n + 0.42).y}`} className="path" />
      <polygon points={h.left} className="m-card l" />
      <polygon points={h.right} className="m-card r" />
      {siding}
      <polygon points={h.door} className="door" />
      <polygon points={quadL(y + n, x + n * 0.08, x + n * 0.28, 10, 18)} className="win l" />
      <polygon points={h.window} className="win r" />
      <polygon points={quadR(x + n, y + n * 0.72, y + n * 0.9, 10, 18)} className="win r" />
      <polygon points={h.roofLeft} className="roof l" />
      <polygon points={h.roofRight} className="roof r" />
      <line x1={corner.x} y1={corner.y} x2={h.apex.x} y2={h.apex.y} className="ridge" />
      <Solid f={box(x + n * 0.66, y + n * 0.22, 0.17, 0.17, 12, chimneyZ)} m="m-card" />
    </>
  );
}

/** An agent: a small robot with a visor in its own colour. Legs swing while it walks. */
export function Robot({ letter, walking, facing }: { letter: string; walking: boolean; facing: 1 | -1 }) {
  return (
    <g className={`robot ${walking ? "walking" : ""}`}>
      <ellipse className="pawn-shadow" cx={3} rx={11} ry={5} />
      <g transform={facing === -1 ? "scale(-1,1)" : undefined}><g className="bot">
        <rect className="leg leg-a" x={-5.2} y={-12} width={3.8} height={12} rx={1.8} />
        <rect className="leg leg-b" x={1.4} y={-12} width={3.8} height={12} rx={1.8} />
        <rect className="bot-body" x={-8} y={-28} width={16} height={18} rx={5} />
        <rect className="bot-body-shade" x={0} y={-28} width={8} height={18} rx={0} />
        <rect className="bot-head" x={-7.5} y={-42} width={15} height={12.5} rx={4} />
        <rect className="visor" x={-5.5} y={-38.5} width={11} height={4.6} rx={2.3} />
        <line className="antenna" x1={0} y1={-42} x2={0} y2={-47} />
        <circle className="antenna-tip" cy={-48.5} r={1.9} />
      </g></g>
      <text className="pawn-letter" y={-15} textAnchor="middle">{letter}</text>
    </g>
  );
}
