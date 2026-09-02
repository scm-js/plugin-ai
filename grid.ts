/**
 * The layout language's grid side: a coarse grid of cells, `cellSize` tiles square,
 * written as rows of single characters that a legend maps to terrain ids. This file
 * turns a map (or an area of one) into that form, and a plan back into a function from
 * tile to terrain id. Pure; the editor is reached through the sampler the caller passes.
 */
import type { LayoutPlan, TerrainVocab } from "./protocol";

/** Legend characters in the order they are handed out; `?` is reserved for "unknown". */
export const LEGEND_CHARS = ".#~^=+-:;abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const UNKNOWN = "?";

export interface TileRect {
  x0: number;
  y0: number;
  /** Exclusive. */
  x1: number;
  y1: number;
}

export interface SampledGrid {
  legend: Record<string, number>;
  grid: string[];
  columns: number;
  rows: number;
  cellSize: number;
  originX: number;
  originY: number;
}

/**
 * A legend for the given terrain ids: the most frequent terrain gets `.`, the next
 * `#`, and so on, so the grid reads as ground and features. Ids come in the order
 * the caller wants them ranked.
 */
export function assignLegend(ranked: readonly number[]): Record<string, number> {
  const legend: Record<string, number> = {};
  ranked.forEach((id, i) => {
    if (i < LEGEND_CHARS.length) legend[LEGEND_CHARS[i]] = id;
  });
  return legend;
}

/** Ids ranked by how often they occur, most common first (ties by id). */
export function rankByCount(counts: ReadonlyMap<number, number>): number[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
}

/**
 * Sample an area of the map into cells. `terrainAt(tx, ty)` answers the terrain id of
 * a tile or null when it is not flat terrain of a known type (a cliff piece, a doodad
 * tile); a cell takes the majority answer of its tiles, the top-left tile breaking
 * ties, and `?` when none of them answered.
 */
export function sampleGrid(terrainAt: (tx: number, ty: number) => number | null, rect: TileRect, cellSize: number): SampledGrid {
  const columns = Math.max(1, Math.ceil((rect.x1 - rect.x0) / cellSize));
  const rows = Math.max(1, Math.ceil((rect.y1 - rect.y0) / cellSize));
  const cells: (number | null)[] = new Array(columns * rows);
  const counts = new Map<number, number>();
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const votes = new Map<number, number>();
      for (let dy = 0; dy < cellSize; dy++) {
        for (let dx = 0; dx < cellSize; dx++) {
          const tx = rect.x0 + cx * cellSize + dx;
          const ty = rect.y0 + cy * cellSize + dy;
          if (tx >= rect.x1 || ty >= rect.y1) continue;
          const id = terrainAt(tx, ty);
          if (id === null) continue;
          votes.set(id, (votes.get(id) ?? 0) + 1);
        }
      }
      let best: number | null = null;
      let bestN = 0;
      for (const [id, n] of votes) if (n > bestN) { best = id; bestN = n; }
      cells[cy * columns + cx] = best;
      if (best !== null) counts.set(best, (counts.get(best) ?? 0) + 1);
    }
  }
  const legend = assignLegend(rankByCount(counts));
  const charOf = new Map<number, string>();
  for (const [ch, id] of Object.entries(legend)) charOf.set(id, ch);
  const grid: string[] = [];
  for (let cy = 0; cy < rows; cy++) {
    let row = "";
    for (let cx = 0; cx < columns; cx++) {
      const id = cells[cy * columns + cx];
      row += id === null ? UNKNOWN : charOf.get(id) ?? UNKNOWN;
    }
    grid.push(row);
  }
  return { legend, grid, columns, rows, cellSize, originX: rect.x0, originY: rect.y0 };
}

/** The terrain type a tile's CV5 group belongs to: the flat pair whose even group is `group` or `group - 1`. */
export function terrainOfGroup(group: number, terrains: readonly { id: number; group: number }[]): number | null {
  for (const t of terrains) if (t.group === group || t.group + 1 === group) return t.id;
  return null;
}

/** The legend character at a map tile of a plan laid at `originX/Y`, or `?` outside it. */
export function charAt(plan: Pick<LayoutPlan, "grid" | "cellSize" | "columns" | "rows">, originX: number, originY: number, tx: number, ty: number): string {
  const cx = Math.floor((tx - originX) / plan.cellSize);
  const cy = Math.floor((ty - originY) / plan.cellSize);
  if (cx < 0 || cy < 0 || cx >= plan.columns || cy >= plan.rows) return UNKNOWN;
  const row = plan.grid[cy] ?? "";
  return cx < row.length ? row[cx] : UNKNOWN;
}

/** A function from map tile to terrain id for a plan laid at `originX/Y`; null off the plan or on `?`. */
export function terrainSampler(plan: LayoutPlan, originX: number, originY: number): (tx: number, ty: number) => number | null {
  return (tx, ty) => {
    const ch = charAt(plan, originX, originY, tx, ty);
    const id = plan.legend[ch];
    return id === undefined ? null : id;
  };
}

/**
 * The terrain for a lattice diamond whose centre sits on the corner between tiles
 * `tx - 1 | tx` and `ty - 1 | ty`: the commonest of the (up to) four, the top-left
 * winning ties; null when all four are unknown.
 */
export function diamondTerrain(terrainAt: (tx: number, ty: number) => number | null, tx: number, ty: number): number | null {
  const counts = new Map<number, number>();
  for (const [x, y] of [[tx - 1, ty - 1], [tx, ty - 1], [tx - 1, ty], [tx, ty]]) {
    const id = terrainAt(x, y);
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [id, n] of counts) if (n > bestN) { best = id; bestN = n; }
  return best;
}

/** Paint order for a set of terrain ids: lowest first, then the commonest first, so cliffs form against ground already laid. */
export function paintOrder(ids: readonly number[], terrains: readonly TerrainVocab[], counts: ReadonlyMap<number, number>): number[] {
  const height = (id: number) => terrains.find((t) => t.id === id)?.height ?? 0;
  return [...ids].sort((a, b) => height(a) - height(b) || (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a - b);
}

/** A cell's height under a plan, for ramps and doodads; -1 for unknown. */
export function heightAt(plan: LayoutPlan, terrains: readonly TerrainVocab[], cx: number, cy: number): number {
  if (cx < 0 || cy < 0 || cx >= plan.columns || cy >= plan.rows) return -1;
  const id = plan.legend[plan.grid[cy]?.[cx] ?? UNKNOWN];
  if (id === undefined) return -1;
  return terrains.find((t) => t.id === id)?.height ?? -1;
}
