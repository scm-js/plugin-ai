/**
 * `MapFacts`: what the fact-based recipes get to know about the open map, gathered
 * from the API — players from the scenario's slots, the Statistics dialog's numbers as
 * lines, units by type and owner, location names, and the triggers printed and cut to
 * a byte budget. Also the vocabulary the layout recipes need: terrains, doodad
 * categories and unit names.
 */
import type { PluginApi } from "./plugin-api/plugins/api";
import type { ImageInput, MapFacts, PlayerFact, TerrainVocab } from "./protocol";

/** Bytes of printed triggers a request carries at most; the rest is summarised in one line. */
export const TRIGGER_TEXT_BUDGET = 60_000;

export function players(api: PluginApi): PlayerFact[] {
  const scn = api.document.scenario();
  if (!scn) return [];
  const starts = new Set(api.query.startLocations().map((s) => s.owner));
  const out: PlayerFact[] = [];
  for (let slot = 0; slot < 8; slot++) {
    out.push({
      slot,
      type: api.names.playerType(scn.playerTypes[slot] ?? 0),
      race: api.names.race(scn.playerRaces[slot] ?? 0),
      force: scn.forces.playerForce[slot] ?? 0,
      hasStart: starts.has(slot),
    });
  }
  return out;
}

export function statisticsLines(api: PluginApi): string[] {
  const s = api.query.statistics();
  if (!s) return [];
  const lines: string[] = [];
  lines.push(`${s.width} × ${s.height} tiles, ${s.tileset}, ${s.revision}`);
  lines.push(`${s.units.total} units${s.units.buildings !== null ? ` (${s.units.buildings} buildings)` : ""}, ${s.unownedUnits} with no owner`);
  lines.push(`resources: ${s.resources.fields} mineral fields (${s.resources.minerals} minerals), ${s.resources.geysers} geysers (${s.resources.gas} gas)`);
  lines.push(`${s.doodads} doodads, ${s.sprites.pure + s.sprites.unit} sprites, ${s.locations} locations`);
  lines.push(`${s.triggers.count} triggers (${s.triggers.conditions} conditions, ${s.triggers.actions} actions, ${s.triggers.preserved} preserved, ${s.triggers.disabled} disabled), ${s.briefings} briefing triggers, ${s.switchesNamed} named switches, ${s.sounds} sounds`);
  lines.push(`strings: ${s.strings.set} of ${s.strings.slots} slots set${s.strings.extended ? " (extended table)" : ""}`);
  for (const p of s.players) if (p.units > 0 || p.startLocations > 0) lines.push(`player ${p.slot + 1}: ${p.type}, ${p.race}, ${p.units} units${p.buildings !== null ? ` (${p.buildings} buildings)` : ""}, ${p.startLocations} start location${p.startLocations === 1 ? "" : "s"}`);
  if (s.terrain) lines.push(`terrain: ${s.terrain.slice(0, 8).map((t) => `${t.name} ${Math.round((t.tiles / (s.width * s.height)) * 100)}%`).join(", ")}`);
  return lines;
}

export function unitLines(api: PluginApi): string[] {
  const scn = api.document.scenario();
  if (!scn) return [];
  const counts = new Map<string, number>();
  for (const u of scn.units) {
    const key = `${api.names.unit(u.unitId)}|${u.owner}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80)
    .map(([key, n]) => {
      const [name, owner] = key.split("|");
      const o = Number(owner);
      return `${name} × ${n} (${o < 8 ? `Player ${o + 1}` : o === 11 ? "Neutral" : `owner ${o}`})`;
    });
}

export function locationNames(api: PluginApi): string[] {
  const scn = api.document.scenario();
  if (!scn) return [];
  const out: string[] = [];
  scn.locations.forEach((l, i) => {
    if (i === 63) return;
    if (l.left === 0 && l.top === 0 && l.right === 0 && l.bottom === 0) return;
    out.push(`${api.names.location(i)} (${Math.floor(Math.min(l.left, l.right) / 32)},${Math.floor(Math.min(l.top, l.bottom) / 32)}–${Math.ceil(Math.max(l.left, l.right) / 32)},${Math.ceil(Math.max(l.top, l.bottom) / 32)})`);
  });
  return out;
}

/** The triggers printed, cut to the budget with a line saying how many were left out. */
export function triggersText(api: PluginApi, budget = TRIGGER_TEXT_BUDGET): string | undefined {
  const list = api.triggers.list();
  if (list.length === 0) return undefined;
  const text = api.triggers.text.print(list);
  if (text.length <= budget) return text;
  // Cut at a trigger boundary: count the triggers that fit whole.
  let kept = 0;
  let out = "";
  for (let i = 0; i < list.length; i++) {
    const one = api.triggers.text.one(list[i]);
    if (out.length + one.length + 2 > budget) break;
    out += (out ? "\n\n" : "") + one;
    kept++;
  }
  return `${out}\n\n… ${list.length - kept} more trigger${list.length - kept === 1 ? "" : "s"} not shown.`;
}

/** What the person has selected or marked, one line each, for the assistant's state block. */
export function selectionLines(api: PluginApi): string[] {
  const scn = api.document.scenario();
  if (!scn) return [];
  const out: string[] = [];
  const area = api.selection.markedArea();
  if (area) out.push(`marked area: tiles ${Math.min(area.x0, area.x1)},${Math.min(area.y0, area.y1)} to ${Math.max(area.x0, area.x1)},${Math.max(area.y0, area.y1)}`);
  const units = api.selection.units();
  if (units.length) {
    const shown = units.slice(0, 12).map((i) => { const u = scn.units[i]; return u ? `#${i} ${api.names.unit(u.unitId)} (${u.owner < 8 ? `P${u.owner + 1}` : "neutral"}) at ${Math.floor(u.x / 32)},${Math.floor(u.y / 32)}` : `#${i}`; });
    out.push(`${units.length} unit${units.length === 1 ? "" : "s"} selected: ${shown.join("; ")}${units.length > 12 ? "; …" : ""}`);
  }
  const locations = api.selection.locations();
  if (locations.length) out.push(`${locations.length} location${locations.length === 1 ? "" : "s"} selected: ${locations.map((i) => `#${i} ${api.names.location(i)}`).join("; ")}`);
  const sprites = api.selection.sprites();
  if (sprites.length) out.push(`${sprites.length} sprite${sprites.length === 1 ? "" : "s"} selected: indices ${sprites.slice(0, 20).join(", ")}`);
  const doodads = api.selection.doodads();
  if (doodads.length) out.push(`${doodads.length} doodad${doodads.length === 1 ? "" : "s"} selected: ${doodads.slice(0, 12).map((i) => `#${i} ${api.palette.doodadInfo(scn.doodads[i]?.doodadId ?? -1)?.name ?? ""}`).join("; ")}`);
  return out;
}

/** Where the person is looking. */
export function viewLine(api: PluginApi): string {
  const v = api.view.visible();
  const c = api.view.cursorTile();
  return `layer ${api.selection.layer()}; visible tiles ${Math.floor(v.x0)},${Math.floor(v.y0)} to ${Math.ceil(v.x1)},${Math.ceil(v.y1)} at zoom ${api.view.zoom().toFixed(2)}; cursor at ${c.x},${c.y}`;
}

export function historyLine(api: PluginApi): string {
  const h = api.document.history();
  return `${h.undoDepth} undo step${h.undoDepth === 1 ? "" : "s"}${h.undo ? ` (last: ${h.undo})` : ""}, ${h.redoDepth} redo`;
}

export function mapFacts(api: PluginApi, options: { triggers?: boolean; assistant?: boolean } = {}): MapFacts {
  const info = api.document.info();
  const scn = api.document.scenario();
  if (options.assistant && scn) {
    return { ...mapFacts(api, { triggers: options.triggers }), selection: selectionLines(api), view: viewLine(api), history: historyLine(api) };
  }
  return {
    name: info?.name ?? "",
    description: info?.description ?? "",
    width: info?.width ?? 0,
    height: info?.height ?? 0,
    tileset: api.tileset.name(),
    players: players(api),
    statistics: statisticsLines(api),
    units: unitLines(api),
    locations: locationNames(api),
    triggerCount: scn?.triggers.length ?? 0,
    briefingCount: scn?.briefing.length ?? 0,
    triggersText: options.triggers === false ? undefined : triggersText(api),
  };
}

/* ── Vocabulary ─────────────────────────────────────────── */

export function terrainVocab(api: PluginApi): TerrainVocab[] {
  return api.terrain.types().map((t) => ({ id: t.id, name: t.name, height: t.height, buildable: t.buildable }));
}

export function doodadCategoryNames(api: PluginApi): string[] {
  return api.palette.doodadCategories().map((c) => c.name);
}

/** Unit names the model may use; the resources and start location first so they are not missed. */
export function unitNames(api: PluginApi): string[] {
  const all = api.names.units().filter((u) => u.value < 228).map((u) => u.label);
  const first = ["Start Location", "Mineral Field (Type 1)", "Mineral Field (Type 2)", "Mineral Field (Type 3)", "Vespene Geyser"];
  return [...first.filter((n) => all.includes(n)), ...all.filter((n) => !first.includes(n))];
}

/** A unit id by StarEdit name, case-insensitively, with a few aliases for the resources. */
export function unitIdByName(api: PluginApi, name: string): number | null {
  const wanted = name.trim().toLowerCase();
  const aliases: Record<string, string> = { "mineral field": "mineral field (type 1)", minerals: "mineral field (type 1)", "mineral patch": "mineral field (type 1)", geyser: "vespene geyser", "start location": "start location" };
  const target = aliases[wanted] ?? wanted;
  for (const u of api.names.units()) if (u.label.toLowerCase() === target) return u.value;
  for (const u of api.names.units()) if (u.label.toLowerCase().includes(target)) return u.value;
  return null;
}

/* ── Images ─────────────────────────────────────────────── */

/** A `Blob` as the protocol's base64 image. */
export async function imageInput(blob: Blob): Promise<ImageInput> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) s += String.fromCharCode(...buf.subarray(i, i + chunk));
  const mediaType = blob.type === "image/jpeg" || blob.type === "image/webp" ? blob.type : "image/png";
  return { mediaType, data: btoa(s) };
}

/** A scale that keeps a picture of `w × h` tiles under roughly `maxPixels`. */
export function pixelsPerTileFor(w: number, h: number, wanted: number, maxPixels = 2_000_000): number {
  let ppt = wanted;
  while (ppt > 1 && w * ppt * h * ppt > maxPixels) ppt = ppt > 8 ? ppt / 2 : ppt - 1;
  return Math.max(1, Math.round(ppt));
}
