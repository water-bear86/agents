// Agent sprites: every agent is a small robot whose head is an LED screen. The parts, the screen's
// colours and its resting face are picked by the agent's handle, so it always looks the same
// wherever it appears; its expression follows what it's doing and how its trades are going. Its
// trading style adds a piece of gear and its level adds trim. Drawn with the feet at (0, 0), about
// 50 px tall, facing the viewer.
//
// The LED faces and screen palettes are adapted from DiceBear's "Pixelbot" style (CC0 1.0,
// https://www.dicebear.com), extended with more expressions.

import type { CSSProperties } from "react";
import { hue, type Agent, type Decision } from "./api";

export type Locomotion = "legs" | "wheels" | "hover";
export interface Build {
  head: "monitor" | "capsule" | "tv" | "visor";
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
    head: pick(["monitor", "capsule", "tv", "visor"] as const, h),
    antenna: pick(["ball", "twin", "bolts", "dish"] as const, h >>> 6),
    body: pick(["box", "barrel", "taper"] as const, h >>> 9),
    moves: pick(["legs", "legs", "wheels", "hover"] as const, h >>> 12),
  };
}

// ---------------------------------------------------------------- faces
// Eyes are 8 columns by 3 rows (left eye in columns 0-2, right eye in 5-7), mouths 8 by 2.

const EYES = {
  round: [".#....#.", "###..###", ".#....#."],
  blocks: ["........", "##....##", "##....##"],
  tall: ["##....##", "##....##", "##....##"],
  slim: ["........", ".#....#.", ".#....#."],
  wide: ["........", "###..###", "###..###"],
  // Expressions.
  happy: ["........", ".#....#.", "#.#..#.#"],
  shut: ["........", "........", "###..###"],
  angry: ["#......#", ".##..##.", ".##..##."],
  sad: ["..#..#..", ".#....#.", "##....##"],
  rekt: ["#.#..#.#", ".#....#.", "#.#..#.#"],
  heart: ["#.#..#.#", "###..###", ".#....#."],
  wow: ["###..###", "#.#..#.#", "###..###"],
  up: ["##....##", "##....##", "........"],
} as const;
type EyeKind = keyof typeof EYES;

/** Each mouth has a resting and a wider shape: talking flips between them, and idle faces grin now and then. */
const MOUTHS = {
  smile: [["..#..#..", "...##..."], [".#....#.", "..####.."]],
  flat: [["........", "..####.."], ["........", ".######."]],
  tiny: [["........", "...##..."], ["........", "..####.."]],
  // Expressions.
  grin: [[".#....#.", "..####.."], ["#......#", ".######."]],
  open: [["...##...", "...##..."], ["..####..", "..####.."]],
  frown: [["...##...", "..#..#.."], ["..####..", ".#....#."]],
  wavy: [["..#..#..", ".#.##.#."], [".#.##.#.", "#.#..#.#"]],
} as const;
type MouthKind = keyof typeof MOUTHS;

/** Pixelbot's screen colours and glows. */
const SCREENS = ["#0f172a", "#111827", "#172554", "#1e1b4b", "#2e1065", "#3b0764", "#500724", "#022c22", "#042f2e", "#083344"] as const;
const GLOWS = ["#7dd3fc", "#5eead4", "#86efac", "#bef264", "#fde68a", "#fdba74", "#f9a8d4", "#c4b5fd", "#ffffff"] as const;

export interface Face { eyes: EyeKind; mouth: MouthKind; screen: string; glow: string; blink: number; delay: number }

/** An agent's resting face and screen colours: fixed by its handle. */
export function faceFor(handle: string): Face {
  const h = seed(`${handle}#face`);
  return {
    eyes: pick(["round", "blocks", "tall", "slim", "wide"] as const, h),
    mouth: pick(["smile", "flat", "tiny", "smile"] as const, h >>> 4),
    screen: pick(SCREENS, h >>> 8),
    glow: pick(GLOWS, h >>> 12),
    // Everyone blinks on their own rhythm, so a crowd never blinks in unison.
    blink: 3.6 + ((h >>> 16) % 30) / 10,
    delay: ((h >>> 20) % 40) / 10,
  };
}

export type Mood = "neutral" | "happy" | "elated" | "excited" | "sad" | "rekt" | "angry" | "thinking" | "loving" | "sleepy";

const EXPRESSIONS: Record<Exclude<Mood, "neutral">, [EyeKind, MouthKind]> = {
  happy: ["happy", "smile"],
  elated: ["happy", "grin"],
  excited: ["wow", "open"],
  sad: ["sad", "frown"],
  rekt: ["rekt", "wavy"],
  angry: ["angry", "flat"],
  thinking: ["up", "tiny"],
  loving: ["heart", "smile"],
  sleepy: ["shut", "flat"],
};

/** Realized profit as a share of the money the agent started with. */
function returnOf(a: Agent) {
  const pnl = Number(a.realizedPnlWei ?? 0);
  const start = Math.max(Number(a.balanceWei ?? 0) - pnl, 1e16);
  return pnl / start;
}

/** How an agent feels: what its last turn did, else how its trading is going. */
export function moodOf(a: Agent, last?: Decision): Mood {
  const ok = last?.actions.filter((x) => x.ok) ?? [];
  const did = (...t: string[]) => ok.find((x) => t.includes(x.type));
  if (last && last.actions.length > 0 && ok.length === 0) return "angry";
  if (did("launch")) return "excited";
  if (did("like", "follow")) return "loving";
  const debate = did("debate");
  if (debate) return debate.stance === "agree" ? "happy" : "angry";
  if (did("predict")) return "thinking";
  if (last && last.actions.length === 0) return "sleepy";
  const r = returnOf(a);
  if (r <= -0.3) return "rekt";
  if (r <= -0.04) return "sad";
  if (r >= 0.25) return "elated";
  if (r >= 0.04) return "happy";
  return "neutral";
}

export type Emote = "$" | "!" | "?" | "♥" | "…" | "×" | "z" | "↑";

/** The little sign that pops over an agent's head right after it acts. */
export function emoteOf(last?: Decision): Emote | undefined {
  if (!last) return undefined;
  const ok = last.actions.filter((x) => x.ok);
  if (last.actions.length > 0 && ok.length === 0) return "×";
  const t = new Set(ok.map((x) => x.type));
  if (t.has("launch")) return "↑";
  if (t.has("buy") || t.has("sell")) return "$";
  if (t.has("debate")) return "!";
  if (t.has("predict")) return "?";
  if (t.has("like") || t.has("follow")) return "♥";
  if (t.has("post")) return "…";
  return undefined;
}

const GLYPHS: Record<Emote, string[]> = {
  "$": [".###.", "##...", ".###.", "...##", ".###."],
  "!": ["..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "..##.", ".....", "..#.."],
  "♥": [".#.#.", "#####", "#####", ".###.", "..#.."],
  "…": [".....", ".....", "#.#.#", ".....", "....."],
  "×": ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  "z": ["#####", "...#.", "..#..", ".#...", "#####"],
  "↑": ["..#..", ".###.", "#.#.#", "..#..", "..#.."],
};

/** Lit cells of a bitmap as one path of little rounded squares, `cell` apart, offset by (col, row). */
function cells(rows: readonly string[], cell: number, col = 0, row = 0) {
  const s = cell * 0.82, r = cell * 0.22, o = (cell - s) / 2;
  let d = "";
  rows.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      if (line[x] !== "#") continue;
      const px = +((col + x) * cell + o).toFixed(2), py = +((row + y) * cell + o).toFixed(2);
      d += `M${px + r},${py}h${(s - 2 * r).toFixed(2)}q${r},0 ${r},${r}v${(s - 2 * r).toFixed(2)}q0,${r} -${r},${r}h-${(s - 2 * r).toFixed(2)}q-${r},0 -${r},-${r}v-${(s - 2 * r).toFixed(2)}q0,-${r} ${r},-${r}z`;
    }
  });
  return d;
}

const gridOf = (cols: number, rows: number) => Array.from({ length: rows }, () => "#".repeat(cols));
const DIM = new Map<string, string>();
/** The unlit LED matrix behind a face, built once per screen size. */
function dimCells(cols: number, rows: number, cell: number) {
  const k = `${cols}x${rows}@${cell}`;
  if (!DIM.has(k)) DIM.set(k, cells(gridOf(cols, rows), cell));
  return DIM.get(k)!;
}

/** An LED face on a `cols` x `rows` matrix, eyes at row `eyeRow`, mouth at row `mouthRow`. */
function Screen({ face, mood = "neutral", cols, rows, cell, eyeRow, mouthRow, talking, look = 0 }: {
  face: Face; mood?: Mood; cols: number; rows: number; cell: number; eyeRow: number; mouthRow: number; talking?: boolean; look?: -1 | 0 | 1;
}) {
  const [eyes, mouth] = mood === "neutral" ? [face.eyes, face.mouth] : EXPRESSIONS[mood];
  const col = (cols - 8) / 2;
  const [small, wide] = MOUTHS[mouth];
  return (
    <g className={`sp-face ${talking ? "talking" : ""} ${eyes === "shut" ? "asleep" : ""}`}
      style={{ ["--glow" as string]: face.glow, ["--blink" as string]: `${face.blink}s`, ["--blink-d" as string]: `-${face.delay}s`, ["--cell" as string]: cell } as CSSProperties}>
      <path className="sp-dim" d={dimCells(cols, rows, cell)} />
      <g className="sp-lit">
        <g transform={look ? `translate(${look * cell},0)` : undefined}>
          <g className="sp-eyes">
            <path className="sp-open" d={cells(EYES[eyes], cell, col, eyeRow)} />
            <path className="sp-shut" d={cells(EYES.shut, cell, col, eyeRow)} />
          </g>
        </g>
        <path className="sp-m-a" d={cells(small, cell, col, mouthRow)} />
        <path className="sp-m-b" d={cells(wide, cell, col, mouthRow)} />
      </g>
    </g>
  );
}

/** A pop-up sign over the head. */
function EmoteBubble({ emote, x, y, glow }: { emote: Emote; x: number; y: number; glow: string }) {
  const c = 1.5;
  return (
    <g className={`sp-emote ${emote === "z" ? "snooze" : ""}`} transform={`translate(${x},${y})`} style={{ ["--glow" as string]: glow } as CSSProperties}>
      <g className="sp-emote-pop">
        <path className="sp-emote-bg" d="M-6,-6.5 h12 q2,0 2,2 v8.5 q0,2 -2,2 h-7 l-3,3 v-3 h-2 q-2,0 -2,-2 v-8.5 q0,-2 2,-2 z" />
        <path className="sp-emote-glyph" d={cells(GLYPHS[emote], c, 0, 0)} transform={`translate(${-2.5 * c},${-5.5})`} />
      </g>
    </g>
  );
}

// ---------------------------------------------------------------- the robot

/** The head: a screen in a bezel, its bottom edge on the body's shoulders. */
const HEAD = { x: -11, y: -49, w: 22, h: 18.5 };
const CELL = 1.8, COLS = 10, ROWS = 8;
const SCREEN = { x: -(COLS * CELL) / 2, y: HEAD.y + (HEAD.h - ROWS * CELL) / 2 };

function Bezel({ kind }: { kind: Build["head"] }) {
  const { x, y, w, h } = HEAD;
  switch (kind) {
    case "monitor": return <rect className="sp-head" x={x} y={y} width={w} height={h} rx={4} />;
    case "capsule": return <rect className="sp-head" x={x - 0.5} y={y} width={w + 1} height={h} rx={8} />;
    case "tv": return <><rect className="sp-steel" x={x - 2.2} y={y + 6} width={3} height={6} rx={1.2} /><rect className="sp-steel" x={x + w - 0.8} y={y + 6} width={3} height={6} rx={1.2} /><rect className="sp-head" x={x} y={y} width={w} height={h} rx={2.5} /></>;
    case "visor": return <path className="sp-head" d={`M${x},${y + h - 3} V${y + 9} Q${x},${y - 1} 0,${y - 1} Q${x + w},${y - 1} ${x + w},${y + 9} V${y + h - 3} Q${x + w},${y + h} ${x + w - 3},${y + h} H${x + 3} Q${x},${y + h} ${x},${y + h - 3} Z`} />;
  }
}

function Antenna({ kind, top, gold }: { kind: Build["antenna"]; top: number; gold: boolean }) {
  const tip = gold ? "sp-gold" : "sp-tip";
  switch (kind) {
    case "ball": return <><line className="sp-wire" x1={0} y1={top} x2={0} y2={top - 5} /><circle className={tip} cy={top - 6.5} r={1.9} /></>;
    case "twin": return <><line className="sp-wire" x1={-3.5} y1={top + 0.5} x2={-6} y2={top - 4.5} /><line className="sp-wire" x1={3.5} y1={top + 0.5} x2={6} y2={top - 4.5} /><circle className={tip} cx={-6.3} cy={top - 5.5} r={1.5} /><circle className={tip} cx={6.3} cy={top - 5.5} r={1.5} /></>;
    case "bolts": return <><circle className={tip} cx={HEAD.x - 0.6} cy={top + 4.5} r={1.8} /><circle className={tip} cx={HEAD.x + HEAD.w + 0.6} cy={top + 4.5} r={1.8} /></>;
    case "dish": return <><line className="sp-wire" x1={0} y1={top} x2={0} y2={top - 3} /><path className={tip} d={`M-4.5,${top - 6} q4.5,5 9,0 Z`} /></>;
  }
}

/** Trading-style gear, so you can tell a sniper from a scalper at a glance. */
function Gear({ style }: { style?: string }) {
  const { x, y, w } = HEAD;
  switch (style) {
    case "momentum": return <path className="sp-stripe" d="M-6,-15 l5,-8 M-2,-13 l5,-8" />;
    case "contrarian": return <path className="sp-badge" d="M-3,-25 h6 l-3,4.5 Z" />;
    case "sniper": return <><rect className="sp-gear" x={x + w - 0.5} y={y + 2.5} width={6} height={3.4} rx={1} /><circle className="sp-lens" cx={x + w + 5.7} cy={y + 4.2} r={1.7} /></>;
    case "scalper": return <><path className="sp-gear-line" d={`M${x - 1},${y + 7} Q0,${y - 7} ${x + w + 1},${y + 7}`} /><rect className="sp-gear" x={x - 3} y={y + 5} width={3.2} height={6} rx={1} /><path className="sp-gear-line" d={`M${x - 1.5},${y + 10} q1,6 7,6`} /></>;
    case "conviction": return <path className="sp-shield" d="M-4.5,-27 h9 v4 q0,4.5 -4.5,6.5 q-4.5,-2 -4.5,-6.5 Z" />;
    default: return null;
  }
}

/** Arm angles (left, right) in degrees from hanging straight down; positive swings the left arm out. */
const POSE: Record<Mood, [number, number]> = {
  neutral: [12, -12], happy: [38, -38], elated: [150, -150], excited: [160, -140], sad: [4, -4], rekt: [-4, 4],
  angry: [30, -30], thinking: [14, -168], loving: [100, -100], sleepy: [3, -3],
};
/** How far the head hangs, in degrees, when things go badly. */
const DROOP: Partial<Record<Mood, number>> = { sad: -6, rekt: 11, sleepy: -8 };

function Arm({ side, x, angle, swing }: { side: "l" | "r"; x: number; angle: number; swing?: boolean }) {
  return (
    <g transform={`translate(${x},-27.5) rotate(${angle})`}>
      <g className={`arm arm-${side} ${swing ? "swing" : ""}`}>
        <rect className="sp-steel" x={-1.5} y={-1} width={3} height={10} rx={1.5} />
        <circle className="sp-hand" cy={10} r={2.1} />
      </g>
    </g>
  );
}

export interface BotProps {
  handle: string; style?: string; level?: number; walking?: boolean; facing?: 1 | -1;
  mood?: Mood; emote?: Emote; talking?: boolean;
}

/** A whole agent, feet at the origin. */
export function Bot({ handle, style, level = 1, walking = false, facing = 1, mood = "neutral", emote, talking }: BotProps) {
  const b = buildFor(handle);
  const face = faceFor(handle);
  const lift = b.moves === "hover" ? -5 : b.moves === "wheels" ? -2 : 0;
  const shown = emote ?? (mood === "sleepy" ? "z" : undefined);
  const [la, ra] = walking ? [10, -10] : POSE[mood];
  const shoulder = b.body === "taper" ? 9.6 : b.body === "barrel" ? 8.8 : 8.2;
  const droop = DROOP[mood] ?? 0;
  return (
    <g className={`sprite moves-${b.moves} mood-${mood} ${walking ? "walking" : ""}`} style={{ ["--h" as string]: hue(handle) } as CSSProperties}>
      <ellipse className="pawn-shadow" cx={3} rx={11} ry={5} />
      <g transform={facing === -1 ? "scale(-1,1)" : undefined}>
        <g className="bot">
          {b.moves === "legs" && <><rect className="sp-steel leg leg-a" x={-5.2} y={-12} width={3.8} height={12} rx={1.8} /><rect className="sp-steel leg leg-b" x={1.4} y={-12} width={3.8} height={12} rx={1.8} /></>}
          {b.moves === "wheels" && <><rect className="sp-steel" x={-6} y={-12} width={12} height={6} rx={2} /><g className="wheel"><circle className="sp-tyre" cx={-5} cy={-4} r={4} /><line className="sp-spoke" x1={-5} y1={-7} x2={-5} y2={-1} /></g><g className="wheel"><circle className="sp-tyre" cx={5} cy={-4} r={4} /><line className="sp-spoke" x1={5} y1={-7} x2={5} y2={-1} /></g></>}
          {b.moves === "hover" && <><ellipse className="sp-jet" cy={-3} rx={6} ry={2.4} /><path className="sp-steel" d="M-5,-12 h10 l-2,4 h-6 Z" /></>}
          <g transform={`translate(0,${lift})`}>
            {b.body === "box" && <rect className="sp-body" x={-8} y={-31} width={16} height={19} rx={5} />}
            {b.body === "barrel" && <rect className="sp-body" x={-9} y={-31} width={18} height={19} rx={9} />}
            {b.body === "taper" && <path className="sp-body" d="M-10,-31 Q-10,-32 -9,-32 H9 Q10,-32 10,-31 L7,-12 H-7 Z" />}
            <path className="sp-shade" d={b.body === "taper" ? "M0,-32 H9 Q10,-32 10,-31 L7,-12 H0 Z" : `M0,-31 H${b.body === "barrel" ? 0 : 3} Q8,-31 8,-26 V-17 Q8,-12 3,-12 H0 Z`} />
            {!style && <circle className="sp-core" cy={-21} r={2.4} />}
            <Gear style={style} />
            <Arm side="l" x={-shoulder} angle={la} swing={walking} />
            <Arm side="r" x={shoulder} angle={ra} swing={walking || talking} />
            <g transform={droop ? `rotate(${droop},0,${HEAD.y + HEAD.h})` : undefined}>
            {(level < 8 || b.antenna === "bolts") && <Antenna kind={b.antenna} top={b.head === "visor" ? HEAD.y - 1 : HEAD.y} gold={level >= 5} />}
            <Bezel kind={b.head} />
            <rect className="sp-screen" x={SCREEN.x - 0.6} y={SCREEN.y - 0.6} width={COLS * CELL + 1.2} height={ROWS * CELL + 1.2} rx={b.head === "capsule" ? 5 : 2.5} style={{ fill: face.screen }} />
            {/* The face is never mirrored; while walking, its eyes look where it's going. */}
            <g transform={`translate(${SCREEN.x},${SCREEN.y})${facing === -1 ? ` scale(-1,1) translate(${-COLS * CELL},0)` : ""}`}>
              <Screen face={face} mood={mood} cols={COLS} rows={ROWS} cell={CELL} eyeRow={1} mouthRow={5} talking={talking} look={walking ? facing : 0} />
            </g>
            {/* Level 8 and up wear a crown, which takes the place of a top-mounted antenna. */}
            {level >= 8 && <path className="sp-gold" d={`M-6,${HEAD.y + 1} l-0.6,-7 l3.5,2.8 l3.1,-5 l3.1,5 l3.5,-2.8 l-0.6,7 Z`} />}
            </g>
          </g>
        </g>
      </g>
      {shown && <EmoteBubble key={shown} emote={shown} x={13} y={HEAD.y + lift - 4} glow={face.glow} />}
    </g>
  );
}

/** An agent's portrait: its screen, full bleed, the way DiceBear draws a Pixelbot. */
export function Avatar({ handle, mood, level }: { handle: string; style?: string; level?: number; mood?: Mood }) {
  const face = faceFor(handle);
  return (
    <svg className={`avatar-sprite sprite mood-${mood ?? "neutral"}`} viewBox="0 0 24 24" aria-hidden style={{ background: face.screen }}>
      <Screen face={face} mood={mood} cols={12} rows={12} cell={2} eyeRow={3} mouthRow={8} />
      {(level ?? 0) >= 5 && <rect className="sp-trim" x={0.5} y={0.5} width={23} height={23} rx={2.5} />}
    </svg>
  );
}
