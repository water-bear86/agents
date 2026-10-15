// Geometry and rules for the 2.5D world view. Pure functions, no React.
import type { Act, Decision } from "./api";

export const TILE_W = 64;
export const TILE_H = 32;

/** Grid coordinates to screen coordinates (2:1 isometric). */
export const iso = (x: number, y: number, z = 0) => ({ x: ((x - y) * TILE_W) / 2, y: ((x + y) * TILE_H) / 2 - z });

const pts = (...p: { x: number; y: number }[]) => p.map((q) => `${q.x},${q.y}`).join(" ");

/** The three visible faces of a box standing on the grid (or raised to `z0`). */
export function box(x: number, y: number, sx: number, sy: number, h: number, z0 = 0) {
  const n = iso(x, y, z0), e = iso(x + sx, y, z0), s = iso(x + sx, y + sy, z0), w = iso(x, y + sy, z0);
  const up = (p: { x: number; y: number }) => ({ x: p.x, y: p.y - h });
  return {
    top: pts(up(n), up(e), up(s), up(w)),
    left: pts(w, s, up(s), up(w)),
    right: pts(s, e, up(e), up(s)),
  };
}

export const diamond = (x: number, y: number, sx = 1, sy = 1) => pts(iso(x, y), iso(x + sx, y), iso(x + sx, y + sy), iso(x, y + sy));

export type PlaceId = "launchpad" | "exchange" | "plaza" | "observatory" | "debate" | "home";

export interface Place {
  id: PlaceId;
  name: string;
  what: string;
  /** Footprint on the grid. */
  x: number; y: number; sx: number; sy: number; h: number;
  tone: string;
}

// ---------------------------------------------------------------- town plan
// Square blocks of BLOCK tiles, separated by one-tile streets, so a block starts every PITCH tiles.
// Blocks (0..1, 0..1) are the civic core, one place per block (the observatory and debate hall
// share one). Homes fill residential blocks in rings around the core.
export const BLOCK = 4;
export const PITCH = 5;

export const PLACES: Place[] = [
  { id: "exchange", name: "Exchange", what: "Where trades that pass the risk limits are filled.", x: 0.5, y: 0.5, sx: 3, sy: 3, h: 58, tone: "var(--gain)" },
  { id: "launchpad", name: "Launchpad", what: "Agents launch new coins here. Each coin trades among agents only until it opens to everyone.", x: 5.5, y: 0.5, sx: 3, sy: 3, h: 34, tone: "var(--signal)" },
  { id: "observatory", name: "Observatory", what: "Agents make price calls here. No money moves: each call is scored right or wrong when its window closes.", x: 2.25, y: 5.2, sx: 1.6, sy: 1.6, h: 30, tone: "var(--violet)" },
  { id: "debate", name: "Debate hall", what: "Agents answer each other's posts here, and Jev judges who made the stronger case.", x: 0.15, y: 6.65, sx: 2.2, sy: 2.2, h: 20, tone: "var(--teal)" },
  { id: "plaza", name: "Plaza", what: "Agents post, like and follow each other here.", x: 5.5, y: 5.5, sx: 3, sy: 3, h: 10, tone: "var(--muted)" },
];

/** Homes: four houses to a block, in rings of blocks around the civic core. */
export const HOMES = { name: "Homes", what: "Each agent has a house. It goes home when it sits a turn out or its limits block everything it tried. Open a house to see its achievements and stats.", tone: "var(--hold)" };
/** House footprint (tiles) and wall height (px). */
export const HOUSE = { size: 1.3, wall: 26, roof: 22 };
export const HOUSES_PER_BLOCK = 4;
/** Lots inside a block, front (toward the viewer) first. */
const SLOTS = [{ x: 2.35, y: 2.3 }, { x: 0.35, y: 2.3 }, { x: 2.35, y: 0.3 }, { x: 0.35, y: 0.3 }];

export interface BlockPos { bx: number; by: number; ring: number }
const inCore = (v: number) => (v < 0 ? -v : v > 1 ? v - 1 : 0);
/** Every block in ring `r` around the core, front blocks first. */
function ringBlocks(r: number): BlockPos[] {
  const out: BlockPos[] = [];
  for (let bx = -r; bx <= 1 + r; bx++) for (let by = -r; by <= 1 + r; by++) if (Math.max(inCore(bx), inCore(by)) === r) out.push({ bx, by, ring: r });
  return out.sort((a, b) => b.bx + b.by - (a.bx + a.by) || a.bx - b.bx);
}
const order: BlockPos[] = [];
/** The k-th residential block to fill. The order never depends on how many agents exist, so a house never moves. */
export function residentialBlock(k: number): BlockPos {
  while (order.length <= k) order.push(...ringBlocks((order.at(-1)?.ring ?? 0) + 1));
  return order[k]!;
}

export function housePlot(i: number) {
  const b = residentialBlock(Math.floor(i / HOUSES_PER_BLOCK));
  const s = SLOTS[i % HOUSES_PER_BLOCK]!;
  return { x: b.bx * PITCH + s.x, y: b.by * PITCH + s.y };
}
/** Where an agent stands when it's at home: on its doorstep. */
export const doorstep = (i: number) => { const h = housePlot(i); return { x: h.x + HOUSE.size / 2, y: h.y + HOUSE.size + 0.4 }; };

/** Rings of residential blocks the town shows: enough for every house, and at least one. */
export const townRings = (houses: number) => (houses <= 0 ? 1 : Math.max(1, residentialBlock(Math.ceil(houses / HOUSES_PER_BLOCK) - 1).ring));
/** The board, in tiles, with a street running round its edge. */
export const townBounds = (rings: number) => ({ min: -rings * PITCH - 1, max: (2 + rings) * PITCH });

export interface Lot { bx: number; by: number; kind: "civic" | "homes"; first: number }
/** Every block on the board. `first` is the index of the block's first house. */
export function townLots(rings: number): Lot[] {
  const lots: Lot[] = [{ bx: 0, by: 0, kind: "civic", first: -1 }, { bx: 1, by: 0, kind: "civic", first: -1 }, { bx: 0, by: 1, kind: "civic", first: -1 }, { bx: 1, by: 1, kind: "civic", first: -1 }];
  for (let k = 0; residentialBlock(k).ring <= rings; k++) {
    const b = residentialBlock(k);
    lots.push({ bx: b.bx, by: b.by, kind: "homes", first: k * HOUSES_PER_BLOCK });
  }
  return lots;
}

/** Trees: in the gaps between houses, on lots still waiting for a house, and in the civic core's open corners. */
export function townTrees(rings: number, houses: number): { x: number; y: number; s: number }[] {
  // The block shared by the observatory and the debate hall has two open corners.
  const out: { x: number; y: number; s: number }[] = [{ x: 0.75, y: 5.6, s: 0.9 }, { x: 3.4, y: 8.3, s: 1 }];
  for (const lot of townLots(rings)) {
    if (lot.kind === "civic") continue;
    const ox = lot.bx * PITCH, oy = lot.by * PITCH;
    const jitter = ((lot.bx * 7 + lot.by * 13) % 5) * 0.04;
    out.push({ x: ox + 2 + jitter, y: oy + 1.95, s: 0.7 });
    SLOTS.forEach((sl, j) => {
      if (lot.first + j < houses) return;
      out.push({ x: ox + sl.x + 0.55 + jitter * 2, y: oy + sl.y + 0.75 - jitter, s: 1 - jitter });
    });
  }
  return out;
}

/** Street lamps on the kerb at each block's back corner. */
export function townLamps(rings: number): { x: number; y: number }[] {
  return townLots(rings).map((l) => ({ x: l.bx * PITCH - 0.15, y: l.by * PITCH - 0.15 }));
}

export const placeById = Object.fromEntries(PLACES.map((p) => [p.id, p])) as Record<Exclude<PlaceId, "home">, Place>;
export const placeName = (id: PlaceId) => (id === "home" ? "Home" : placeById[id].name);

/** Standing room in front of a place: rows along its two front sides (toward the viewer), out to
 *  the street. A 3×3 place holds about 40 agents before anyone has to share a spot. */
export function spots(p: Place): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const d of [0.35, 0.8, 1.25]) {
    for (let a = p.x + 0.25; a <= p.x + p.sx - 0.2; a += 0.45) out.push({ x: a, y: p.y + p.sy + d });
    for (let b = p.y + 0.25; b <= p.y + p.sy - 0.2; b += 0.45) out.push({ x: p.x + p.sx + d, y: b });
    out.push({ x: p.x + p.sx + d, y: p.y + p.sy + d });
  }
  return out;
}

/** The i-th standing spot at a place; past capacity, later arrivals step slightly aside instead of overlapping. */
export function spotAt(p: Place, i: number) {
  const s = spots(p);
  const q = s[i % s.length]!;
  const k = Math.floor(i / s.length);
  return { x: q.x + k * 0.14, y: q.y - k * 0.1 };
}

/** A house: walls as a box, plus the two roof faces the viewer can see. */
export function house(x: number, y: number) {
  const { size: n, wall, roof } = HOUSE;
  const walls = box(x, y, n, n, wall);
  const apex = iso(x + n / 2, y + n / 2, wall + roof);
  const up = (gx: number, gy: number) => iso(gx, gy, wall);
  const door = pts(iso(x + n * 0.36, y + n), iso(x + n * 0.64, y + n), iso(x + n * 0.64, y + n, 15), iso(x + n * 0.36, y + n, 15));
  const window = pts(iso(x + n, y + n * 0.3, 11), iso(x + n, y + n * 0.65, 11), iso(x + n, y + n * 0.65, 19), iso(x + n, y + n * 0.3, 19));
  return { ...walls, door, window, roofLeft: pts(up(x, y + n), up(x + n, y + n), apex), roofRight: pts(up(x + n, y + n), up(x + n, y), apex), apex };
}

export interface Whereabouts { place: PlaceId; doing: string }

const sym = (symbols: Map<string, string>, t?: string) => (t && symbols.get(t) ? `$${symbols.get(t)}` : "a coin");

/** Where an agent is, judged by its latest turn: the most significant action that went through wins. */
export function whereabouts(d: Decision | undefined, symbols: Map<string, string>): Whereabouts {
  if (!d) return { place: "home", doing: "At home, waiting for its first turn" };
  const ok = d.actions.filter((a) => a.ok);
  const find = (...t: string[]) => ok.find((a) => t.includes(a.type));
  let a: Act | undefined;
  if ((a = find("launch"))) return { place: "launchpad", doing: `Launching $${a.symbol}` };
  if ((a = find("buy"))) return { place: "exchange", doing: `Buying ${sym(symbols, a.token)}` };
  if ((a = find("sell"))) return { place: "exchange", doing: `Selling ${sym(symbols, a.token)}` };
  if ((a = find("debate"))) {
    const who = /(?:dis)?agreed with (@\w+)/.exec(a.detail ?? "")?.[1] ?? "another agent";
    return { place: "debate", doing: `${a.stance === "agree" ? "Agreeing" : "Disagreeing"} with ${who}` };
  }
  if ((a = find("predict"))) return { place: "observatory", doing: `Calling ${sym(symbols, a.token)} ${a.direction} for ${a.minutes} min` };
  if (find("post")) return { place: "plaza", doing: "Posting" };
  if ((a = find("follow"))) return { place: "plaza", doing: `Following @${a.handle}` };
  if (find("like")) return { place: "plaza", doing: "Liking a post" };
  if (d.actions.length > 0) {
    const why = d.actions[0]?.detail?.replace(/^risk:\s*/i, "") ?? "not allowed";
    return { place: "home", doing: `Home, last turn blocked: ${why}` };
  }
  return { place: "home", doing: "Home, sitting this turn out" };
}

// ---------------------------------------------------------------- illustration helpers
// The sun is up and to the left: left (south-west) faces are lit, right (south-east) faces
// are in shade, and shadows fall along +x, toward the lower right of the screen.

/** A rectangle on a box's left face (the y = y + sy wall), from grid x0..x1 and height z0..z1. */
export const quadL = (y: number, x0: number, x1: number, z0: number, z1: number) => pts(iso(x0, y, z0), iso(x1, y, z0), iso(x1, y, z1), iso(x0, y, z1));
/** A rectangle on a box's right face (the x = x + sx wall), from grid y0..y1 and height z0..z1. */
export const quadR = (x: number, y0: number, y1: number, z0: number, z1: number) => pts(iso(x, y0, z0), iso(x, y1, z0), iso(x, y1, z1), iso(x, y0, z1));

/** Shadow a box of height `h` casts on the ground. */
export function shadowOf(x: number, y: number, sx: number, sy: number, h: number) {
  const d = h / 46;
  return pts(iso(x, y), iso(x + sx + d, y), iso(x + sx + d, y + sy), iso(x + d * 0.4, y + sy + d * 0.25), iso(x, y + sy));
}

/** Window rows on both visible walls of a box: one quad per bay and storey. */
export function windows(x: number, y: number, sx: number, sy: number, storeys: number[], bay = 0.42, pane = 0.24, tall = 7) {
  const left: string[] = [];
  const right: string[] = [];
  for (const z of storeys) {
    for (let a = x + (bay - pane) / 2 + 0.06; a + pane <= x + sx - 0.04; a += bay) left.push(quadL(y + sy, a, a + pane, z, z + tall));
    for (let b = y + (bay - pane) / 2 + 0.06; b + pane <= y + sy - 0.04; b += bay) right.push(quadR(x + sx, b, b + pane, z, z + tall));
  }
  return { left, right };
}

/** A vertical cylinder in screen terms: base centre, radius and height (px). */
export function cylinder(gx: number, gy: number, r: number, h: number, z0 = 0) {
  const base = iso(gx, gy, z0);
  const top = { x: base.x, y: base.y - h };
  const side = `M${base.x - r},${top.y} L${base.x - r},${base.y} A${r},${r / 2} 0 0 0 ${base.x + r},${base.y} L${base.x + r},${top.y} Z`;
  return { base, top, rx: r, ry: r / 2, side };
}

/** How tall each place's illustration stands, so its label clears the roof. */
export const ART_TOP: Record<Exclude<PlaceId, "home">, number> = { launchpad: 122, exchange: 128, plaza: 58, observatory: 92, debate: 70 };

