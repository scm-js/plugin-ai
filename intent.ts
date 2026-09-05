/**
 * Where a tool call lands on the map, worked out from its arguments *before* it runs —
 * the rect `paint_terrain` will fill, the tiles `place_units` will use, the location
 * `edit_location` will move — so the assistant can show its intent on the map (a teal
 * outline through an overlay while the call runs) and flash the result afterwards
 * (gold, through `api.view.flash`). Pure over the call's input and the scenario's
 * lists; a call with no place on the map answers an empty list.
 */
import type { PluginApi } from "@scm-js/plugin-api";

/** A footprint in tiles: rects (exclusive far edges), and units / locations by index. */
export interface Footprint {
  rects: { x0: number; y0: number; x1: number; y1: number }[];
  units: number[];
  locations: number[];
}

const EMPTY: Footprint = { rects: [], units: [], locations: [] };

const n = (v: unknown, d = NaN): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => Math.round(n(x))).filter((x) => Number.isInteger(x) && x >= 0) : []);

/** The tile rect named by `x0, y0, x1, y1` (or the whole map when none is given and `whole` says so). */
function rectOf(input: Record<string, unknown>, width: number, height: number, whole: boolean): Footprint["rects"] {
  const has = ["x0", "y0", "x1", "y1"].some((k) => input[k] !== undefined);
  if (!has) return whole ? [{ x0: 0, y0: 0, x1: width, y1: height }] : [];
  const x0 = Math.max(0, Math.min(width, Math.round(n(input.x0, 0)))), y0 = Math.max(0, Math.min(height, Math.round(n(input.y0, 0))));
  const x1 = Math.max(x0, Math.min(width, Math.round(n(input.x1, width)))), y1 = Math.max(y0, Math.min(height, Math.round(n(input.y1, height))));
  return x1 > x0 && y1 > y0 ? [{ x0, y0, x1, y1 }] : [];
}

/** One tile per `{ x, y }` entry of a list. */
function tilesOf(list: unknown, width: number, height: number): Footprint["rects"] {
  if (!Array.isArray(list)) return [];
  const out: Footprint["rects"] = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const x = Math.round(n((e as Record<string, unknown>).x)), y = Math.round(n((e as Record<string, unknown>).y));
    if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height) out.push({ x0: x, y0: y, x1: x + 1, y1: y + 1 });
  }
  return out;
}

/**
 * The footprint of a tool call. `api` is read only for the map's size and, for calls that
 * name a location by slot, to confirm the slot exists.
 */
export function footprintOf(api: PluginApi, name: string, input: Record<string, unknown>): Footprint {
  const info = api.document.info();
  if (!info) return EMPTY;
  const { width, height } = info;
  switch (name) {
    case "paint_terrain": case "set_fog": case "scatter_doodads":
      return { ...EMPTY, rects: rectOf(input, width, height, false) };
    case "screenshot": case "terrain_at": case "fog_at": case "list_doodads": case "list_sprites":
      return { ...EMPTY, rects: rectOf(input, width, height, name === "screenshot") };
    case "place_units":
      return { ...EMPTY, rects: tilesOf(input.units, width, height) };
    case "place_doodads":
      return { ...EMPTY, rects: tilesOf(input.doodads, width, height) };
    case "place_sprites":
      return { ...EMPTY, rects: tilesOf(input.sprites, width, height) };
    case "move_units": {
      const moves = Array.isArray(input.moves) ? input.moves as Record<string, unknown>[] : [];
      return { ...EMPTY, rects: tilesOf(moves, width, height), units: ints(moves.map((m) => m.index)) };
    }
    case "remove_units": case "update_units":
      return { ...EMPTY, units: ints(input.indices) };
    case "add_location":
      return { ...EMPTY, rects: rectOf(input, width, height, false) };
    case "edit_location": {
      const index = Math.round(n(input.index));
      return { ...EMPTY, rects: rectOf(input, width, height, false), locations: Number.isInteger(index) && index >= 0 ? [index] : [] };
    }
    case "remove_locations":
      return { ...EMPTY, locations: ints(input.indices) };
    case "go_to": {
      const x = n(input.x), y = n(input.y);
      if (Number.isFinite(x) && Number.isFinite(y)) return { ...EMPTY, rects: tilesOf([{ x, y }], width, height) };
      const unit = n(input.unit), location = n(input.location);
      return { ...EMPTY, units: Number.isFinite(unit) ? [unit] : [], locations: Number.isFinite(location) ? [location] : [] };
    }
    case "select": {
      return { ...EMPTY, rects: rectOf(input, width, height, false), units: ints(input.units), locations: ints(input.locations) };
    }
    default:
      return EMPTY;
  }
}

export function footprintEmpty(f: Footprint): boolean {
  return f.rects.length === 0 && f.units.length === 0 && f.locations.length === 0;
}
