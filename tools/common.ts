/**
 * What every tool file shares: the `Tool` shape, the input coercions (the model's JSON
 * is loosely typed), tile rects, the result cap, and the name lookups — units, upgrades,
 * technologies, doodads and sprites by the names the editor shows, case-insensitively,
 * with the resource aliases people actually use.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { AgentContent, AgentTool, ImageInput } from "../protocol";
import type { Ctx } from "../ui";

export const TILE = 32;
export const RESULT_CAP = 8_000;

export type ToolResult = string | { text?: string; image?: ImageInput };

export interface Tool {
  def: AgentTool;
  /** Whether it changes the map (shown differently in the transcript). */
  writes: boolean;
  /** A settings-style write: not in the undo model. */
  settings?: boolean;
  run(input: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> | ToolResult;
}

export const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
export const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
export const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : typeof v === "string" && /^(true|yes|on)$/i.test(v) ? true : typeof v === "string" && /^(false|no|off)$/i.test(v) ? false : undefined);
export const list = <T = Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
export const ints = (v: unknown): number[] => list<unknown>(v).map((x) => Math.round(num(x, -1))).filter((x) => x >= 0);

export interface TileRect { x0: number; y0: number; x1: number; y1: number }

/** A tile rect from `x0,y0,x1,y1` clamped to the map; the whole map when nothing is given. */
export function rectOf(input: Record<string, unknown>, api: PluginApi): TileRect {
  const info = api.document.info();
  const W = info?.width ?? 0, H = info?.height ?? 0;
  const x0 = Math.max(0, Math.min(W, Math.round(num(input.x0)))), y0 = Math.max(0, Math.min(H, Math.round(num(input.y0))));
  const x1 = Math.max(x0, Math.min(W, Math.round(num(input.x1, W)))), y1 = Math.max(y0, Math.min(H, Math.round(num(input.y1, H))));
  return { x0, y0, x1, y1 };
}

export const hasRect = (input: Record<string, unknown>) => input.x0 !== undefined || input.x1 !== undefined || input.y0 !== undefined || input.y1 !== undefined;

export const rectSchema = { x0: { type: "integer", description: "left tile" }, y0: { type: "integer", description: "top tile" }, x1: { type: "integer", description: "right tile, exclusive" }, y1: { type: "integer", description: "bottom tile, exclusive" } };

export const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", properties, ...(required.length ? { required } : {}) });

/** JSON for a tool result, cut to the cap with a note. */
export function capResult(value: unknown, cap = RESULT_CAP): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length <= cap ? s : `${s.slice(0, cap)}\n… cut: ${s.length - cap} more characters. Ask with a narrower filter.`;
}

/** The 1-based player number a tool uses for a 0-based owner. */
export function ownerName(o: number): string {
  return o < 8 ? `Player ${o + 1}` : o === 11 ? "Neutral" : `owner ${o + 1}`;
}

/** A tool's 1-based player (12 = neutral) as a 0-based owner; `d` when missing. */
export function ownerOf(v: unknown, d = 11): number {
  if (typeof v === "string" && /neutral/i.test(v)) return 11;
  const n = num(v, d + 1);
  if (n >= 12) return 11;
  return Math.max(0, Math.round(n) - 1);
}

/** The 1-based player as a 0-based slot 0–11, or "default" for the settings tables. */
export function slotOf(v: unknown): number | "default" | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && /^default$/i.test(v.trim())) return "default";
  const n = Math.round(num(v, -1));
  return n >= 1 && n <= 12 ? n - 1 : null;
}

/** Case-insensitive match of a name against a labelled list: exact first, then a unique prefix, then a substring. */
export function byName<T extends { label: string; value: number }>(items: T[], name: string): T | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const numeric = /^\d+$/.test(wanted) ? Number(wanted) : null;
  if (numeric !== null) return items.find((i) => i.value === numeric) ?? null;
  const exact = items.find((i) => i.label.toLowerCase() === wanted);
  if (exact) return exact;
  const starts = items.filter((i) => i.label.toLowerCase().startsWith(wanted));
  if (starts.length === 1) return starts[0];
  const within = items.filter((i) => i.label.toLowerCase().includes(wanted));
  return within.length >= 1 ? within[0] : null;
}

const UNIT_ALIASES: Record<string, string> = {
  "mineral field": "Mineral Field (Type 1)", minerals: "Mineral Field (Type 1)", "mineral patch": "Mineral Field (Type 1)", mineral: "Mineral Field (Type 1)",
  geyser: "Vespene Geyser", gas: "Vespene Geyser", start: "Start Location", "start location": "Start Location",
  marine: "Terran Marine", zergling: "Zerg Zergling", zealot: "Protoss Zealot", scv: "Terran SCV", drone: "Zerg Drone", probe: "Protoss Probe",
  "command center": "Terran Command Center", hatchery: "Zerg Hatchery", nexus: "Protoss Nexus",
};

/** A units.dat id by StarEdit name (or id), case-insensitively, with the common short names. */
export function unitIdByName(api: PluginApi, name: string): number | null {
  const alias = UNIT_ALIASES[name.trim().toLowerCase()];
  const items = api.names.units().filter((u) => u.value < 228);
  return byName(items, alias ?? name)?.value ?? null;
}

export function upgradeIdByName(api: PluginApi, name: string): number | null {
  return byName(api.names.upgrades(), name)?.value ?? null;
}

export function techIdByName(api: PluginApi, name: string): number | null {
  return byName(api.names.techs(), name)?.value ?? null;
}

/** A doodad of the open tileset by name (a category name picks any of its doodads) or by id. */
export function doodadByName(api: PluginApi, name: string): { id: number; name: string; category: string; width: number; height: number } | null {
  const wanted = name.trim().toLowerCase();
  const all = api.palette.doodadCategories().flatMap((c) => c.doodads);
  if (/^\d+$/.test(wanted)) return all.find((d) => d.id === Number(wanted)) ?? null;
  const exact = all.find((d) => d.name.toLowerCase() === wanted);
  if (exact) return exact;
  const within = all.filter((d) => d.name.toLowerCase().includes(wanted));
  if (within.length) return within[Math.floor(Math.random() * within.length)];
  const cat = api.palette.doodadCategories().find((c) => c.name.toLowerCase() === wanted || c.name.toLowerCase().includes(wanted));
  return cat && cat.doodads.length ? cat.doodads[Math.floor(Math.random() * cat.doodads.length)] : null;
}

/** A sprite by name (the palette's) or id, for the given kind; a unit name picks the unit sprite. */
export function spriteByName(api: PluginApi, kind: "pure" | "unit", name: string): number | null {
  const wanted = name.trim().toLowerCase();
  if (/^\d+$/.test(wanted)) return Number(wanted);
  if (kind === "unit") return unitIdByName(api, name);
  const ids = api.palette.spriteGroups().flatMap((g) => g.ids);
  const named = ids.map((id) => ({ value: id, label: api.palette.spriteName("pure", id) }));
  return byName(named, name)?.value ?? null;
}

/** COLR indices by the names the game uses for them. */
export const PLAYER_COLOR_NAMES = ["Red", "Blue", "Teal", "Purple", "Orange", "Brown", "White", "Yellow", "Green", "Pale Yellow", "Tan", "Dark Aqua", "Pale Green", "Bluish Grey", "Pale Yellow 2", "Cyan"];

export function colorIndexOf(v: unknown): number | null {
  if (typeof v === "number") return v >= 0 && v < 256 ? Math.round(v) : null;
  const s = str(v).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const i = PLAYER_COLOR_NAMES.findIndex((n) => n.toLowerCase() === s);
  return i >= 0 ? i : null;
}

/** A tool result as agent content. */
export function toContent(toolUseId: string, result: ToolResult, isError = false): AgentContent {
  if (typeof result === "string") return { type: "tool_result", toolUseId, content: result, isError };
  const parts: ({ type: "text"; text: string } | { type: "image"; source: ImageInput })[] = [];
  if (result.text) parts.push({ type: "text", text: result.text });
  if (result.image) parts.push({ type: "image", source: result.image });
  return { type: "tool_result", toolUseId, content: parts.length ? parts : "Done.", isError };
}

/** One line describing a call, for the transcript. */
export function describeCall(name: string, input: Record<string, unknown>): string {
  const args = Object.entries(input).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : Array.isArray(v) ? `[${v.length}]` : typeof v === "object" && v ? "{…}" : String(v)}`).join(", ");
  return `${name}(${args})`;
}

/** The first line of a result, for the transcript row's tooltip. */
export function summarizeResult(result: ToolResult): string {
  const text = typeof result === "string" ? result : result.text ?? (result.image ? "(picture)" : "Done.");
  const line = text.split("\n")[0];
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
