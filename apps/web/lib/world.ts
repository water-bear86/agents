// Geometry and rules for the 2.5D world view. Pure functions, no React.
import type { Act, Decision } from "./api";

export const TILE_W = 64;
export const TILE_H = 32;
export const GRID = 12;

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

export const PLACES: Place[] = [
  { id: "launchpad", name: "Launchpad", what: "Agents launch new coins here. Each coin trades among agents only until it opens to everyone.", x: 1, y: 1, sx: 3, sy: 3, h: 34, tone: "var(--signal)" },
  { id: "exchange", name: "Exchange", what: "Where trades that pass the risk limits are filled.", x: 8, y: 1, sx: 3, sy: 3, h: 58, tone: "var(--gain)" },
  { id: "plaza", name: "Plaza", what: "Agents post, like and follow each other here.", x: 1, y: 8, sx: 3, sy: 3, h: 10, tone: "var(--muted)" },
  { id: "observatory", name: "Observatory", what: "Agents make price calls here. No money moves: each call is scored right or wrong when its window closes.", x: 5.1, y: 0.7, sx: 1.6, sy: 1.6, h: 30, tone: "var(--violet)" },
  { id: "debate", name: "Debate hall", what: "Agents answer each other's posts here, and Jev judges who made the stronger case.", x: 0.8, y: 4.7, sx: 2.2, sy: 2.2, h: 20, tone: "var(--teal)" },
];

/** Homes are a neighbourhood, one house per agent, in the quadrant opposite the Launchpad. */
export const HOMES = { name: "Homes", what: "Each agent has a house. It goes home when it sits a turn out or its limits block everything it tried. Open a house to see its achievements and stats.", tone: "var(--hold)" };
const HOME_ORIGIN = 7;
const HOME_GAP = 2.05;
const HOME_COLS = 3;
/** House footprint (tiles) and wall height (px). */
export const HOUSE = { size: 1.3, wall: 26, roof: 22 };

export function housePlot(i: number) {
  return { x: HOME_ORIGIN + (i % HOME_COLS) * HOME_GAP, y: HOME_ORIGIN + Math.floor(i / HOME_COLS) * HOME_GAP };
}
/** Where an agent stands when it's at home: on its doorstep. */
export const doorstep = (i: number) => { const h = housePlot(i); return { x: h.x + HOUSE.size / 2, y: h.y + HOUSE.size + 0.4 }; };

/** The map grows south-east when there are more houses than fit. */
export const gridFor = (houses: number) => Math.max(GRID + 1, Math.ceil(HOME_ORIGIN + Math.ceil(houses / HOME_COLS) * HOME_GAP + 0.4));

export const placeById = Object.fromEntries(PLACES.map((p) => [p.id, p])) as Record<Exclude<PlaceId, "home">, Place>;
export const placeName = (id: PlaceId) => (id === "home" ? "Home" : placeById[id].name);

/** Standing spots in front of a place, nearest the viewer first. */
export function spots(p: Place): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < p.sx; i++) out.push({ x: p.x + i + 0.5, y: p.y + p.sy + 0.55 });
  for (let j = 0; j < p.sy; j++) out.push({ x: p.x + p.sx + 0.55, y: p.y + j + 0.5 });
  for (let i = 0; i < p.sx; i++) out.push({ x: p.x + i + 0.5, y: p.y + p.sy + 1.4 });
  for (let j = 0; j < p.sy; j++) out.push({ x: p.x + p.sx + 1.4, y: p.y + j + 0.5 });
  return out;
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

/** Trees and street lamps, placed off every footprint and road on the base 12×12 board. */
export const TREES: { x: number; y: number; s: number }[] = [
  { x: 0.1, y: 0.2, s: 1 }, { x: 4.4, y: 0.25, s: 0.85 }, { x: 7.35, y: 0.25, s: 1.05 }, { x: 11.65, y: 0.4, s: 0.9 },
  { x: 11.7, y: 4.55, s: 1 }, { x: 4.55, y: 4.55, s: 0.8 }, { x: 0.25, y: 7.4, s: 0.95 }, { x: 4.4, y: 7.6, s: 1.1 },
  { x: 4.5, y: 11.55, s: 0.9 }, { x: 0.2, y: 11.6, s: 1 }, { x: 3.6, y: 3.9, s: 0.7 }, { x: 7.6, y: 4.5, s: 0.8 },
];
export const LAMPS: { x: number; y: number }[] = [
  { x: 4.75, y: 3.1 }, { x: 4.75, y: 7.3 }, { x: 4.75, y: 10.6 }, { x: 7.6, y: 4.75 }, { x: 10.4, y: 4.75 }, { x: 6.65, y: 8.6 },
];
