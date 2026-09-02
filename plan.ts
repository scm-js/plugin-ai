/**
 * What happens to a plan between the server and the map, all of it pure: checking the
 * plan against the terrain vocabulary and the map's size (and quietly mending what can
 * be mended), enforcing the symmetry it names, mirroring its bases and numbering the
 * mains, choosing the diamonds to paint and their order, picking ramp doodads, and
 * scattering decoration. `render.ts` turns the results into one transaction.
 */
import { charAt, diamondTerrain, heightAt, paintOrder, terrainSampler, UNKNOWN, type TileRect } from "./grid";
import {
  centreOf, DEFAULT_SPEC, HALL, layoutBase, rectAt, rectImages, symmetryAvailable, symmetryImages, TILE,
  type BaseLayout, type Point, type PointMap, type TileRect as FootRect,
} from "./layout";
import type { BasePlan, Direction, LayoutPlan, MapPlan, SymmetryMode, TerrainVocab } from "./protocol";

export const DIRECTIONS: readonly Direction[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/** Screen angle of a compass direction: 0 east, π/2 south. */
export function directionAngle(d: Direction): number {
  return { e: 0, se: Math.PI / 4, s: Math.PI / 2, sw: (3 * Math.PI) / 4, w: Math.PI, nw: (-3 * Math.PI) / 4, n: -Math.PI / 2, ne: -Math.PI / 4 }[d];
}

/** The compass direction nearest an angle. */
export function angleDirection(a: number): Direction {
  const k = Math.round(a / (Math.PI / 4));
  return (["e", "se", "s", "sw", "w", "nw", "n", "ne"] as const)[((k % 8) + 8) % 8];
}

/* ── Checking and mending ───────────────────────────────── */

export interface PlanContext {
  terrains: readonly TerrainVocab[];
  /** The map's size in tiles. */
  width: number;
  height: number;
  /** Where the plan's cell (0, 0) lies on the map. */
  originX: number;
  originY: number;
}

export interface Checked<P extends LayoutPlan> {
  plan: P;
  /** What was mended or dropped, for the person and for a refinement round. */
  problems: string[];
}

/**
 * Make a plan safe to render: the row count and every row's length match `rows` ×
 * `columns` (padded with the commonest character, trimmed when long), every legend id
 * is in the vocabulary (an unknown id becomes the commonest terrain), an unknown
 * character becomes `?`, and every coordinate is inside the map. Nothing throws.
 */
export function checkPlan<P extends LayoutPlan>(input: P, ctx: PlanContext): Checked<P> {
  const problems: string[] = [];
  const plan: P = { ...input, legend: { ...input.legend }, grid: [...(input.grid ?? [])], bases: [...(input.bases ?? [])], ramps: [...(input.ramps ?? [])], doodads: [...(input.doodads ?? [])], units: [...(input.units ?? [])], locations: [...(input.locations ?? [])], notes: [...(input.notes ?? [])] };
  const known = new Set(ctx.terrains.map((t) => t.id));
  const fallback = ctx.terrains[0]?.id ?? 0;

  plan.cellSize = Math.max(1, Math.floor(plan.cellSize || 1));
  const columns = Math.max(1, Math.floor(plan.columns || 1));
  const rows = Math.max(1, Math.floor(plan.rows || 1));
  plan.columns = columns;
  plan.rows = rows;

  for (const [ch, id] of Object.entries(plan.legend)) {
    if (ch.length !== 1 || ch === UNKNOWN) { delete plan.legend[ch]; problems.push(`legend key "${ch}" is not a single character; dropped`); continue; }
    if (!known.has(id)) { plan.legend[ch] = fallback; problems.push(`legend "${ch}" named terrain ${id}, which this tileset lacks; it now means terrain ${fallback}`); }
  }

  const counts = new Map<string, number>();
  for (const row of plan.grid) for (const ch of row) if (plan.legend[ch] !== undefined) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let filler = UNKNOWN;
  let fillerN = 0;
  for (const [ch, n] of counts) if (n > fillerN) { filler = ch; fillerN = n; }
  if (filler === UNKNOWN) {
    const first = Object.keys(plan.legend)[0];
    if (first) filler = first;
  }

  if (plan.grid.length !== rows) problems.push(`the grid has ${plan.grid.length} rows, not ${rows}; ${plan.grid.length < rows ? "padded" : "trimmed"}`);
  plan.grid.length = Math.min(plan.grid.length, rows);
  while (plan.grid.length < rows) plan.grid.push("");
  let mended = 0;
  let unknownChars = 0;
  plan.grid = plan.grid.map((row) => {
    let out = "";
    for (const ch of row.slice(0, columns)) {
      if (plan.legend[ch] !== undefined) out += ch;
      else { out += UNKNOWN; unknownChars++; }
    }
    if (out.length !== row.length) mended++;
    while (out.length < columns) out += filler;
    return out;
  });
  if (mended > 0) problems.push(`${mended} row${mended === 1 ? "" : "s"} had the wrong length; padded or trimmed`);
  if (unknownChars > 0) problems.push(`${unknownChars} cell${unknownChars === 1 ? "" : "s"} used a character the legend does not define; left as they were`);

  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < ctx.width && y < ctx.height;
  const clampX = (x: number) => Math.max(0, Math.min(ctx.width - 1, Math.round(x)));
  const clampY = (y: number) => Math.max(0, Math.min(ctx.height - 1, Math.round(y)));

  plan.bases = plan.bases.filter((b) => {
    if (typeof b.x !== "number" || typeof b.y !== "number") { problems.push("a base had no position; dropped"); return false; }
    if (!DIRECTIONS.includes(b.mineralDirection)) { problems.push(`base at ${b.x},${b.y}: direction "${String(b.mineralDirection)}" is not a compass point; using w`); b.mineralDirection = "w"; }
    b.minerals = Math.max(0, Math.min(12, Math.round(b.minerals ?? 8)));
    b.geysers = Math.max(0, Math.min(2, Math.round(b.geysers ?? 1)));
    if (!inMap(b.x, b.y) || !inMap(b.x + HALL.w - 1, b.y + HALL.h - 1)) {
      const nx = Math.max(0, Math.min(ctx.width - HALL.w, Math.round(b.x)));
      const ny = Math.max(0, Math.min(ctx.height - HALL.h, Math.round(b.y)));
      problems.push(`base at ${b.x},${b.y} hangs off the map; moved to ${nx},${ny}`);
      b.x = nx; b.y = ny;
    }
    return true;
  });
  plan.ramps = plan.ramps.filter((r) => {
    if (typeof r.x !== "number" || typeof r.y !== "number") return false;
    if (!DIRECTIONS.includes(r.direction)) { problems.push(`ramp at ${r.x},${r.y}: direction "${String(r.direction)}" is not a compass point; dropped`); return false; }
    if (!inMap(r.x, r.y)) { problems.push(`ramp at ${r.x},${r.y} is off the map; dropped`); return false; }
    return true;
  });
  plan.doodads = plan.doodads.filter((d) => {
    if (typeof d.category !== "string" || typeof d.on !== "string") return false;
    d.density = Math.max(0, Math.min(1, Number(d.density) || 0));
    return true;
  });
  plan.units = plan.units.filter((u) => {
    if (typeof u.unit !== "string" || typeof u.x !== "number" || typeof u.y !== "number") return false;
    if (!inMap(u.x, u.y)) { problems.push(`${u.unit} at ${u.x},${u.y} is off the map; moved inside`); u.x = clampX(u.x); u.y = clampY(u.y); }
    u.player = Math.max(1, Math.min(12, Math.round(u.player ?? 12)));
    return true;
  });
  plan.locations = plan.locations.filter((l) => {
    if (typeof l.x0 !== "number" || typeof l.y0 !== "number" || typeof l.x1 !== "number" || typeof l.y1 !== "number") return false;
    const x0 = Math.max(0, Math.min(ctx.width, Math.round(Math.min(l.x0, l.x1))));
    const x1 = Math.max(0, Math.min(ctx.width, Math.round(Math.max(l.x0, l.x1))));
    const y0 = Math.max(0, Math.min(ctx.height, Math.round(Math.min(l.y0, l.y1))));
    const y1 = Math.max(0, Math.min(ctx.height, Math.round(Math.max(l.y0, l.y1))));
    if (x1 <= x0 || y1 <= y0) { problems.push(`location "${l.name}" has no area; dropped`); return false; }
    l.x0 = x0; l.y0 = y0; l.x1 = x1; l.y1 = y1;
    l.name = String(l.name ?? "Location").slice(0, 60);
    return true;
  });
  return { plan, problems };
}

/* ── Symmetry ───────────────────────────────────────────── */

/** The symmetry a plan names when it is possible on this map, else `none`. */
export function usableSymmetry(mode: SymmetryMode | undefined, width: number, height: number): SymmetryMode {
  if (!mode || mode === "none") return "none";
  return symmetryAvailable(mode, width, height) ? mode : "none";
}

/** The cell an image lands in: map the cell's centre and floor back to a cell. */
function imageCell(f: PointMap, cx: number, cy: number, cellSize: number): { x: number; y: number } {
  const p = f({ x: (cx + 0.5) * cellSize * TILE, y: (cy + 0.5) * cellSize * TILE });
  return { x: Math.floor(p.x / (cellSize * TILE)), y: Math.floor(p.y / (cellSize * TILE)) };
}

/**
 * Make the grid exactly symmetric: among a cell and its images the one earliest in
 * reading order is canonical and the others take its character. The model is asked to
 * draw the whole map symmetric; this makes sure of it, so the players get the same
 * ground whatever it drew. Only whole-map plans have a symmetry.
 */
export function enforceSymmetry(plan: MapPlan, width: number, height: number): MapPlan {
  const mode = usableSymmetry(plan.symmetry, width, height);
  if (mode === "none") return { ...plan, symmetry: "none" };
  const images = symmetryImages(mode, width * TILE, height * TILE);
  const grid = plan.grid.map((r) => r.split(""));
  const seen = new Set<number>();
  for (let cy = 0; cy < plan.rows; cy++) {
    for (let cx = 0; cx < plan.columns; cx++) {
      const key = cy * plan.columns + cx;
      if (seen.has(key)) continue;
      const cells = images.map((f) => imageCell(f, cx, cy, plan.cellSize)).filter((c) => c.x >= 0 && c.y >= 0 && c.x < plan.columns && c.y < plan.rows);
      let canon = cells[0];
      for (const c of cells) if (c.y < canon.y || (c.y === canon.y && c.x < canon.x)) canon = c;
      const ch = grid[canon.y][canon.x];
      for (const c of cells) { grid[c.y][c.x] = ch; seen.add(c.y * plan.columns + c.x); }
    }
  }
  return { ...plan, symmetry: mode, grid: grid.map((r) => r.join("")) };
}

/* ── Bases ──────────────────────────────────────────────── */

export interface PlacedBase {
  kind: BasePlan["kind"];
  hall: FootRect;
  /** Screen angle the mineral line lies at. */
  direction: number;
  minerals: number;
  geysers: number;
  /** 1-based player for a main; null otherwise. */
  player: number | null;
  /** Which image of its plan entry this is (0 = as listed). */
  image: number;
  layout: BaseLayout;
}

/**
 * Every base a plan implies: each listed base and its images under the symmetry, laid
 * out with the vendored Melee Wizard geometry (an image that turns rows into columns is
 * laid out again round the hall's image). Mains are numbered in the order they come —
 * the listed base's images first, so a two-player plan lists one main and gets players
 * 1 and 2 — unless the symmetry is `none`, when the plan's own numbers are kept.
 */
export function placeBases(bases: readonly BasePlan[], mode: SymmetryMode, width: number, height: number): PlacedBase[] {
  const images = symmetryImages(usableSymmetry(mode, width, height), width * TILE, height * TILE);
  const toward: Point = { x: (width * TILE) / 2, y: (height * TILE) / 2 };
  const out: PlacedBase[] = [];
  let nextPlayer = 1;
  const used = new Set<number>();
  for (const b of bases) {
    const hall: FootRect = { x: b.x, y: b.y, w: HALL.w, h: HALL.h };
    const c = centreOf(hall);
    const angle = directionAngle(b.mineralDirection);
    images.forEach((f, image) => {
      const hallImage = rectImages(hall, [f], toward)[0];
      let direction = angle;
      if (image > 0) {
        const o = f(c);
        const d = f({ x: c.x + 100 * Math.cos(angle), y: c.y + 100 * Math.sin(angle) });
        direction = Math.atan2(d.y - o.y, d.x - o.x);
      }
      const layout = layoutBase(hallImage, { ...DEFAULT_SPEC, minerals: b.minerals, geysers: b.geysers, direction });
      let player: number | null = null;
      if (b.kind === "main") {
        if (images.length === 1 && b.player && !used.has(b.player)) player = b.player;
        else { while (used.has(nextPlayer)) nextPlayer++; player = nextPlayer; }
        used.add(player);
      }
      out.push({ kind: b.kind, hall: hallImage, direction, minerals: b.minerals, geysers: b.geysers, player, image, layout });
    });
  }
  return out;
}

/* ── Terrain ────────────────────────────────────────────── */

export interface PaintGroup {
  terrainId: number;
  diamonds: { x: number; y: number }[];
}

/**
 * Which diamonds get which terrain, in paint order. A diamond `(x, y)` of the lattice
 * is centred on the corner between tiles `2x - 1 | 2x` and `y - 1 | y`; it takes the
 * commonest terrain of those four cells under the plan. Diamonds the plan says nothing
 * about (a `?` cell, or off the plan) are left alone.
 */
export function paintGroups(plan: LayoutPlan, ctx: PlanContext, diamonds: readonly { x: number; y: number }[]): PaintGroup[] {
  const sampler = terrainSampler(plan, ctx.originX, ctx.originY);
  const byTerrain = new Map<number, { x: number; y: number }[]>();
  for (const d of diamonds) {
    const id = diamondTerrain(sampler, d.x * 2, d.y);
    if (id === null) continue;
    let list = byTerrain.get(id);
    if (!list) { list = []; byTerrain.set(id, list); }
    list.push(d);
  }
  const counts = new Map<number, number>();
  for (const [id, list] of byTerrain) counts.set(id, list.length);
  return paintOrder([...byTerrain.keys()], ctx.terrains, counts).map((terrainId) => ({ terrainId, diamonds: byTerrain.get(terrainId)! }));
}

/** The cells (in tiles, exclusive far edge) of the plan whose character is one of `chars`. */
export function cellsWith(plan: LayoutPlan, ctx: Pick<PlanContext, "originX" | "originY">, chars: string): TileRect[] {
  const out: TileRect[] = [];
  for (let cy = 0; cy < plan.rows; cy++) {
    for (let cx = 0; cx < plan.columns; cx++) {
      if (!chars.includes(plan.grid[cy][cx])) continue;
      const x0 = ctx.originX + cx * plan.cellSize;
      const y0 = ctx.originY + cy * plan.cellSize;
      out.push({ x0, y0, x1: x0 + plan.cellSize, y1: y0 + plan.cellSize });
    }
  }
  return out;
}

/* ── Ramps ──────────────────────────────────────────────── */

export interface DoodadChoice {
  id: number;
  name: string;
  category: string;
  width: number;
  height: number;
}

export interface PlacedDoodad {
  doodadId: number;
  tx: number;
  ty: number;
  name: string;
  width: number;
  height: number;
}

/**
 * A ramp doodad for a plan's ramp. The tilesets keep ramps as doodads whose names say
 * nothing about their direction, so the choice is by footprint: a ramp that goes down
 * north or south is taller than wide, one that goes east or west wider than tall, and
 * a diagonal one is squarish. Among the matches the one nearest the map's usual ramp
 * size wins. Null when the tileset has no ramp category at all.
 */
export function chooseRamp(direction: Direction, x: number, y: number, ramps: readonly DoodadChoice[]): PlacedDoodad | null {
  if (ramps.length === 0) return null;
  const vertical = direction === "n" || direction === "s";
  const horizontal = direction === "e" || direction === "w";
  const score = (d: DoodadChoice) => {
    const ratio = d.width / Math.max(1, d.height);
    const shape = vertical ? (ratio < 1 ? 0 : 2) : horizontal ? (ratio > 1 ? 0 : 2) : Math.abs(ratio - 1) < 0.34 ? 0 : 1;
    return shape * 100 + Math.abs(d.width * d.height - 24);
  };
  const best = [...ramps].sort((a, b) => score(a) - score(b))[0];
  return { doodadId: best.id, tx: Math.round(x - best.width / 2), ty: Math.round(y - best.height / 2), name: best.name, width: best.width, height: best.height };
}

/* ── Decoration ─────────────────────────────────────────── */

/** A small deterministic PRNG (mulberry32), seeded from the plan so a re-render decorates the same way. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Where a plan's decoration goes: for each entry, up to `density` × the number of
 * matching cells × 0.4 doodads of the category, each dropped at a random tile of a
 * random matching cell, kept when its whole footprint lies on matching cells (so trees
 * stay off the paths) and touches nothing placed before. `occupied(rect)` lets the
 * caller keep bases and units clear.
 */
export function scatterDoodads(plan: LayoutPlan, ctx: PlanContext, categories: ReadonlyMap<string, readonly DoodadChoice[]>, occupied: (r: TileRect) => boolean): { placed: PlacedDoodad[]; problems: string[] } {
  const placed: PlacedDoodad[] = [];
  const taken: TileRect[] = [];
  const problems: string[] = [];
  const random = prng(hashString(plan.grid.join("\n")));
  const overlaps = (a: TileRect, b: TileRect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  for (const entry of plan.doodads) {
    const key = [...categories.keys()].find((k) => k.toLowerCase() === entry.category.toLowerCase());
    const choices = key ? categories.get(key)! : [];
    if (choices.length === 0) { problems.push(`no doodad category called "${entry.category}" in this tileset`); continue; }
    const cells = cellsWith(plan, ctx, entry.on);
    if (cells.length === 0) continue;
    const want = Math.round(entry.density * cells.length * 0.4);
    let got = 0;
    for (let attempt = 0; attempt < want * 6 && got < want; attempt++) {
      const cell = cells[Math.floor(random() * cells.length)];
      const d = choices[Math.floor(random() * choices.length)];
      const tx = cell.x0 + Math.floor(random() * plan.cellSize);
      const ty = cell.y0 + Math.floor(random() * plan.cellSize);
      const foot: TileRect = { x0: tx, y0: ty, x1: tx + d.width, y1: ty + d.height };
      if (foot.x1 > ctx.width || foot.y1 > ctx.height) continue;
      let onAllowed = true;
      for (let y = foot.y0; y < foot.y1 && onAllowed; y++) for (let x = foot.x0; x < foot.x1; x++) if (!entry.on.includes(charAt(plan, ctx.originX, ctx.originY, x, y))) { onAllowed = false; break; }
      if (!onAllowed) continue;
      if (taken.some((t) => overlaps(t, foot)) || occupied(foot)) continue;
      taken.push(foot);
      placed.push({ doodadId: d.id, tx, ty, name: d.name, width: d.width, height: d.height });
      got++;
    }
  }
  return { placed, problems };
}

/** The height of the ground a plan puts under a tile rect, or -1 when it is mixed or unknown. */
export function groundHeight(plan: LayoutPlan, ctx: PlanContext, r: TileRect): number {
  let h = -2;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const cx = Math.floor((x - ctx.originX) / plan.cellSize);
      const cy = Math.floor((y - ctx.originY) / plan.cellSize);
      const v = heightAt(plan, ctx.terrains, cx, cy);
      if (h === -2) h = v;
      else if (h !== v) return -1;
    }
  }
  return h === -2 ? -1 : h;
}

/** A hall's footprint plus the tiles its mineral line and geyser take, for keeping decoration off a base. */
export function baseFootprint(b: PlacedBase): TileRect {
  let x0 = b.hall.x, y0 = b.hall.y, x1 = b.hall.x + b.hall.w, y1 = b.hall.y + b.hall.h;
  for (const r of [...b.layout.minerals, ...b.layout.geysers]) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x0: x0 - 1, y0: y0 - 1, x1: x1 + 1, y1: y1 + 1 };
}

/** A unit's tile rect from its centre pixel and size in tiles. */
export function unitRect(px: number, py: number, w: number, h: number): TileRect {
  const r = rectAt(px, py, { w, h });
  return { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
}
