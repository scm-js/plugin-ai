/**
 * The assistant's tools: what the model may ask the plugin to do on its behalf. Each
 * has a JSON schema the server forwards and an executor that runs here, in the
 * browser, against the open map. Reads answer JSON; writes go through one
 * `document.edit` / `document.update` each with an "AI: …" label, so every step is
 * its own undo entry. A screenshot answers with an image, so the model can look.
 */
import type { PluginApi } from "./plugin-api/plugins/api";
import type { AgentContent, AgentTool, ImageInput } from "./protocol";
import { imageInput, unitIdByName } from "./facts";
import { sampleGrid } from "./grid";
import { terrainAtTile } from "./dialogs/region";
import { TILE } from "./layout";
import type { Ctx } from "./ui";

export const RESULT_CAP = 8_000;

export type ToolResult = string | { text?: string; image?: ImageInput };

export interface Tool {
  def: AgentTool;
  /** Whether it changes the map (shown differently in the transcript). */
  writes: boolean;
  run(input: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> | ToolResult;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);

function rectOf(input: Record<string, unknown>, api: PluginApi) {
  const info = api.document.info();
  const W = info?.width ?? 0, H = info?.height ?? 0;
  const x0 = Math.max(0, Math.min(W, Math.round(num(input.x0)))), y0 = Math.max(0, Math.min(H, Math.round(num(input.y0))));
  const x1 = Math.max(x0, Math.min(W, Math.round(num(input.x1, W)))), y1 = Math.max(y0, Math.min(H, Math.round(num(input.y1, H))));
  return { x0, y0, x1, y1 };
}

const rectSchema = { x0: { type: "integer", description: "left tile" }, y0: { type: "integer", description: "top tile" }, x1: { type: "integer", description: "right tile, exclusive" }, y1: { type: "integer", description: "bottom tile, exclusive" } };

/** JSON for a tool result, cut to the cap with a note. */
export function capResult(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length <= RESULT_CAP ? s : `${s.slice(0, RESULT_CAP)}\n… cut: ${s.length - RESULT_CAP} more characters. Ask with a narrower filter.`;
}

function ownerName(o: number): string {
  return o < 8 ? `Player ${o + 1}` : o === 11 ? "Neutral" : `owner ${o}`;
}

export function tools(): Tool[] {
  return [
    {
      def: { name: "map_info", description: "The open map: name, description, size, tileset, version, players (type, race, force, whether they have a start location).", inputSchema: { type: "object", properties: {} } },
      writes: false,
      run: (_i, { api }) => {
        const info = api.document.info();
        if (!info) return "No map is open.";
        const scn = api.document.scenario()!;
        const starts = new Set(api.query.startLocations().map((s) => s.owner));
        return capResult({
          ...info,
          players: Array.from({ length: 8 }, (_, slot) => ({ slot: slot + 1, type: api.names.playerType(scn.playerTypes[slot] ?? 0), race: api.names.race(scn.playerRaces[slot] ?? 0), force: (scn.forces.playerForce[slot] ?? 0) + 1, hasStart: starts.has(slot) })),
          script: api.script.state()?.source ? "the map has a trigger script" : "no trigger script",
        });
      },
    },
    {
      def: { name: "statistics", description: "Tools ▸ Statistics: counts of units, resources, doodads, sprites, locations, triggers, strings, terrain by type.", inputSchema: { type: "object", properties: {} } },
      writes: false,
      run: (_i, { api }) => capResult(api.query.statistics() ?? "no map"),
    },
    {
      def: { name: "list_terrains", description: "The tileset's terrain types: id, name, height (0 low, 1 high, 2 higher), buildable. Use the ids with paint_terrain.", inputSchema: { type: "object", properties: {} } },
      writes: false,
      run: (_i, { api }) => capResult(api.terrain.types().map((t) => ({ id: t.id, name: t.name, height: t.height, buildable: t.buildable }))),
    },
    {
      def: { name: "list_doodad_categories", description: "Doodad categories the tileset offers, with how many doodads each has, for scatter_doodads.", inputSchema: { type: "object", properties: {} } },
      writes: false,
      run: (_i, { api }) => capResult(api.palette.doodadCategories().map((c) => ({ name: c.name, count: c.doodads.length }))),
    },
    {
      def: { name: "list_units", description: "Units on the map: index, name, owner, tile x/y, resource amount for minerals and geysers. Filter by owner (1-based player, 12 neutral), by name (substring), or by a tile rect.", inputSchema: { type: "object", properties: { owner: { type: "integer" }, name: { type: "string" }, ...rectSchema, limit: { type: "integer", description: "at most this many, default 200" } } } },
      writes: false,
      run: (input, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return "No map is open.";
        const owner = input.owner === undefined ? null : num(input.owner) >= 12 ? 11 : num(input.owner) - 1;
        const name = str(input.name).toLowerCase();
        const rect = input.x0 !== undefined || input.x1 !== undefined ? rectOf(input, api) : null;
        const limit = Math.max(1, Math.min(1000, num(input.limit, 200)));
        const out: unknown[] = [];
        scn.units.forEach((u, index) => {
          if (owner !== null && u.owner !== owner) return;
          const n = api.names.unit(u.unitId);
          if (name && !n.toLowerCase().includes(name)) return;
          const tx = Math.floor(u.x / TILE), ty = Math.floor(u.y / TILE);
          if (rect && (tx < rect.x0 || ty < rect.y0 || tx >= rect.x1 || ty >= rect.y1)) return;
          if (out.length >= limit) return;
          out.push({ index, name: n, owner: ownerName(u.owner), x: tx, y: ty, ...(u.resourceAmount ? { amount: u.resourceAmount } : {}) });
        });
        return capResult({ count: out.length, total: scn.units.length, units: out });
      },
    },
    {
      def: { name: "list_locations", description: "The map's locations: slot index, name, tile rect.", inputSchema: { type: "object", properties: {} } },
      writes: false,
      run: (_i, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return "No map is open.";
        const out: unknown[] = [];
        scn.locations.forEach((l, i) => {
          if (i === 63 || (l.left === 0 && l.top === 0 && l.right === 0 && l.bottom === 0)) return;
          out.push({ index: i, name: api.names.location(i), x0: Math.floor(Math.min(l.left, l.right) / TILE), y0: Math.floor(Math.min(l.top, l.bottom) / TILE), x1: Math.ceil(Math.max(l.left, l.right) / TILE), y1: Math.ceil(Math.max(l.top, l.bottom) / TILE) });
        });
        return capResult(out);
      },
    },
    {
      def: { name: "list_triggers_text", description: "The map's triggers in the editor's text format, from index `from` to `to` (1-based, inclusive; default the first 20). Also the mission briefing with briefing=true.", inputSchema: { type: "object", properties: { from: { type: "integer" }, to: { type: "integer" }, briefing: { type: "boolean" } } } },
      writes: false,
      run: (input, { api }) => {
        const briefing = input.briefing === true;
        const list = briefing ? api.triggers.briefing() : api.triggers.list();
        if (list.length === 0) return briefing ? "The map has no mission briefing." : "The map has no triggers.";
        const from = Math.max(1, num(input.from, 1)), to = Math.min(list.length, num(input.to, from + 19));
        return capResult(`${list.length} in all. Showing ${from}–${to}:\n\n${api.triggers.text.print(list.slice(from - 1, to), { briefing })}`);
      },
    },
    {
      def: { name: "find", description: "Edit ▸ Find: search units, locations, sprites, strings or triggers for text.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["units", "locations", "sprites", "strings", "triggers"] }, text: { type: "string" } }, required: ["kind", "text"] } },
      writes: false,
      run: (input, { api }) => capResult(api.query.find({ kind: str(input.kind, "strings") as "strings", query: str(input.text), limit: 100 })),
    },
    {
      def: { name: "validate", description: "Tools ▸ Check Map: problems the editor finds with the map.", inputSchema: { type: "object", properties: {} } },
      writes: false,
      run: (_i, { api }) => { const issues = api.query.validate(); return issues.length ? capResult(issues.map((i) => ({ level: i.level, text: i.text, where: i.where }))) : "Check Map finds nothing wrong."; },
    },
    {
      def: { name: "terrain_at", description: "What is under a tile: the terrain type, height, buildable, walkable, and the doodad there if any. Or a coarse grid of an area (cells of `cellSize` tiles) when a rect is given.", inputSchema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, ...rectSchema, cellSize: { type: "integer" } } } },
      writes: false,
      run: (input, ctx) => {
        const { api } = ctx;
        if (input.x1 !== undefined) {
          const rect = rectOf(input, api);
          const cell = Math.max(1, Math.min(16, num(input.cellSize, Math.ceil(Math.max(rect.x1 - rect.x0, rect.y1 - rect.y0) / 48))));
          const g = sampleGrid(terrainAtTile(ctx), rect, cell);
          const names = Object.fromEntries(Object.entries(g.legend).map(([ch, id]) => [ch, api.terrain.types().find((t) => t.id === id)?.name ?? id]));
          return capResult({ originX: g.originX, originY: g.originY, cellSize: cell, legend: names, grid: g.grid });
        }
        const x = Math.round(num(input.x)), y = Math.round(num(input.y));
        const scn = api.document.scenario();
        if (!scn || x < 0 || y < 0 || x >= scn.width || y >= scn.height) return "Off the map.";
        const t = api.terrain.tileInfo(scn.tiles[y * scn.width + x]);
        const d = api.query.doodadAt(x, y);
        return capResult({ x, y, terrain: api.names.tile(scn.tiles[y * scn.width + x]), kind: t?.kind, height: t?.height, buildable: t?.buildable, walkableMinitiles: t?.walkable, doodad: d >= 0 ? api.palette.doodadInfo(scn.doodads[d]?.doodadId ?? -1)?.name ?? d : null });
      },
    },
    {
      def: { name: "placement_ok", description: "Whether a unit could be placed with its centre at a tile: the editor's own placement check.", inputSchema: { type: "object", properties: { unit: { type: "string" }, x: { type: "integer" }, y: { type: "integer" } }, required: ["unit", "x", "y"] } },
      writes: false,
      run: (input, { api }) => {
        const id = unitIdByName(api, str(input.unit));
        if (id === null) return `No unit is called "${str(input.unit)}".`;
        const v = api.query.placement(id, num(input.x) * TILE + TILE / 2, num(input.y) * TILE + TILE / 2);
        return v.problem ? `No: ${v.problem}${v.blocker >= 0 ? ` (blocked by unit ${v.blocker})` : ""}.` : "Yes.";
      },
    },
    {
      def: { name: "screenshot", description: "A picture of an area of the map (or the whole map when no rect is given) at `pixelsPerTile` (default 8; 32 is the game's art, 2 is a minimap). Look before and after changing things.", inputSchema: { type: "object", properties: { ...rectSchema, pixelsPerTile: { type: "integer" } } } },
      writes: false,
      run: async (input, { api }) => {
        const info = api.document.info();
        if (!info) return "No map is open.";
        const rect = input.x1 !== undefined ? rectOf(input, api) : { x0: 0, y0: 0, x1: info.width, y1: info.height };
        let ppt = Math.max(1, Math.min(32, num(input.pixelsPerTile, 8)));
        while (ppt > 1 && (rect.x1 - rect.x0) * ppt * (rect.y1 - rect.y0) * ppt > 1_200_000) ppt = ppt > 8 ? ppt / 2 : ppt - 1;
        await api.tileset.load();
        const blob = await api.graphics.renderRect(rect, { pixelsPerTile: ppt, units: true, sprites: true, locations: true, locationNames: true, startLocations: true, grid: 0 });
        if (!blob) return "The map cannot be rendered (tileset graphics missing).";
        return { text: `Tiles ${rect.x0},${rect.y0} to ${rect.x1},${rect.y1} at ${ppt} px per tile: tile x = ${rect.x0} + px / ${ppt}, y = ${rect.y0} + py / ${ppt}.`, image: await imageInput(blob) };
      },
    },
    {
      def: { name: "script_state", description: "The map's trigger script: whether there is one, its source, whether the built block is intact.", inputSchema: { type: "object", properties: {} } },
      writes: false,
      run: (_i, { api }) => { const s = api.script.state(); return s ? capResult({ hasScript: !!s.source, stale: s.stale, unbuilt: s.unbuilt, block: s.block, source: s.source }) : "No map is open."; },
    },
    {
      def: { name: "script_declarations", description: "The script language's declarations for this map (a .d.ts): every unit, location, switch, player and every condition and action function. Long; read once before writing a script.", inputSchema: { type: "object", properties: {} } },
      writes: false,
      run: (_i, { api }) => { const d = api.script.declarations(); return d.length > 60_000 ? `${d.slice(0, 60_000)}\n… cut.` : d; },
    },

    /* ── writes ─────────────────────────────────────────── */
    {
      def: { name: "paint_terrain", description: "Paint a tile rect with a terrain type id (see list_terrains) using the isometric brush, so cliffs and shores form on their own. One undo step.", inputSchema: { type: "object", properties: { ...rectSchema, terrain: { type: "integer" } }, required: ["x0", "y0", "x1", "y1", "terrain"] } },
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        const terrain = num(input.terrain);
        if (!api.terrain.types().some((t) => t.id === terrain)) return `Terrain ${terrain} is not one of this tileset's types; call list_terrains.`;
        const r = api.document.edit(`AI: paint ${api.terrain.types().find((t) => t.id === terrain)?.name ?? terrain}`, (tx) => {
          if (api.terrain.hasIsom() && api.tileset.isLoaded()) {
            let refused = 0;
            for (const d of api.terrain.diamondsIn(rect)) if (!tx.paintIsom(d, terrain, 1)) refused++;
            if (refused) tx.note(`${refused} diamonds refused`);
          } else tx.stampTerrain(rect, terrain);
        });
        return capResult({ changed: r.changed, tiles: r.tiles, isom: r.isom, notes: r.notes });
      },
    },
    {
      def: { name: "place_units", description: "Place units by StarEdit name at tile centres for a 1-based player (12 neutral); `amount` sets a mineral field's or geyser's resources. Refused positions are reported, not forced. One undo step.", inputSchema: { type: "object", properties: { units: { type: "array", items: { type: "object", properties: { unit: { type: "string" }, player: { type: "integer" }, x: { type: "integer" }, y: { type: "integer" }, amount: { type: "integer" } }, required: ["unit", "player", "x", "y"] } } }, required: ["units"] } },
      writes: true,
      run: (input, { api }) => {
        const list = Array.isArray(input.units) ? (input.units as Record<string, unknown>[]) : [];
        const placed: unknown[] = [];
        const refused: string[] = [];
        api.document.edit("AI: place units", (tx) => {
          for (const u of list) {
            const id = unitIdByName(api, str(u.unit));
            if (id === null) { refused.push(`no unit called "${str(u.unit)}"`); continue; }
            const px = num(u.x) * TILE + TILE / 2, py = num(u.y) * TILE + TILE / 2;
            const owner = num(u.player, 12) >= 12 ? 11 : Math.max(0, num(u.player, 1) - 1);
            if (!tx.canPlaceUnit(id, px, py)) { refused.push(`${str(u.unit)} at ${num(u.x)},${num(u.y)}: ${api.query.placement(id, px, py).problem ?? "refused"}`); continue; }
            const index = tx.placeUnit(id, owner, px, py);
            if (u.amount !== undefined) tx.updateUnits([index], (rec) => ({ resourceAmount: num(u.amount), validStates: rec.validStates | 16 }));
            placed.push({ index, unit: api.names.unit(id), x: num(u.x), y: num(u.y) });
          }
        });
        return capResult({ placed, refused });
      },
    },
    {
      def: { name: "remove_units", description: "Remove units by index (from list_units). One undo step.", inputSchema: { type: "object", properties: { indices: { type: "array", items: { type: "integer" } } }, required: ["indices"] } },
      writes: true,
      run: (input, { api }) => {
        const indices = Array.isArray(input.indices) ? (input.indices as unknown[]).map((v) => num(v, -1)).filter((v) => v >= 0) : [];
        const r = api.document.edit("AI: remove units", (tx) => { tx.removeUnits(indices); });
        return `Removed ${r.units} unit${r.units === 1 ? "" : "s"}.`;
      },
    },
    {
      def: { name: "move_units", description: "Move units by index to new tile centres. One undo step.", inputSchema: { type: "object", properties: { moves: { type: "array", items: { type: "object", properties: { index: { type: "integer" }, x: { type: "integer" }, y: { type: "integer" } }, required: ["index", "x", "y"] } } }, required: ["moves"] } },
      writes: true,
      run: (input, { api }) => {
        const moves = Array.isArray(input.moves) ? (input.moves as Record<string, unknown>[]) : [];
        let n = 0;
        api.document.edit("AI: move units", (tx) => {
          for (const m of moves) {
            const index = num(m.index, -1);
            if (index < 0 || index >= tx.scenario.units.length) continue;
            n += tx.updateUnits([index], () => ({ x: num(m.x) * TILE + TILE / 2, y: num(m.y) * TILE + TILE / 2 }));
          }
        });
        return `Moved ${n} unit${n === 1 ? "" : "s"}.`;
      },
    },
    {
      def: { name: "add_location", description: "Add a named location over a tile rect. One undo step.", inputSchema: { type: "object", properties: { name: { type: "string" }, ...rectSchema }, required: ["name", "x0", "y0", "x1", "y1"] } },
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        let index = -1;
        api.document.edit(`AI: location ${str(input.name)}`, (tx) => { index = tx.addLocation({ left: rect.x0 * TILE, top: rect.y0 * TILE, right: rect.x1 * TILE, bottom: rect.y1 * TILE }, str(input.name, "Location")); });
        return index < 0 ? "No free location slot." : `Added location ${index} "${str(input.name)}".`;
      },
    },
    {
      def: { name: "remove_locations", description: "Remove locations by slot index. One undo step.", inputSchema: { type: "object", properties: { indices: { type: "array", items: { type: "integer" } } }, required: ["indices"] } },
      writes: true,
      run: (input, { api }) => {
        const indices = Array.isArray(input.indices) ? (input.indices as unknown[]).map((v) => num(v, -1)).filter((v) => v >= 0 && v !== 63) : [];
        const r = api.document.edit("AI: remove locations", (tx) => { tx.removeLocations(indices); });
        return `Removed ${r.locations} location${r.locations === 1 ? "" : "s"}.`;
      },
    },
    {
      def: { name: "set_properties", description: "Set the scenario's name and/or description.", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } } } },
      writes: true,
      run: (input, { api }) => {
        const patch: { name?: string; description?: string } = {};
        if (typeof input.name === "string") patch.name = input.name;
        if (typeof input.description === "string") patch.description = input.description;
        const r = api.document.update("AI: properties", (tx) => { tx.properties(patch); });
        return r.changed ? "Done." : "Nothing changed.";
      },
    },
    {
      def: { name: "add_triggers_text", description: "Append triggers written in the editor's text format (the same format list_triggers_text shows). Parse errors are reported and nothing is added.", inputSchema: { type: "object", properties: { text: { type: "string" }, briefing: { type: "boolean" } }, required: ["text"] } },
      writes: true,
      run: (input, { api }) => {
        try {
          const parsed = api.triggers.text.parse(str(input.text), { briefing: input.briefing === true });
          const r = api.document.update("AI: add triggers", (tx) => { for (const t of parsed) (input.briefing === true ? tx.briefing : tx.triggers).add(t.trigger); });
          return `Added ${parsed.length} trigger${parsed.length === 1 ? "" : "s"}${r.changed ? "" : " (nothing changed)"}.`;
        } catch (err) {
          return `Parse error: ${(err as Error).message}`;
        }
      },
    },
    {
      def: { name: "compile_script", description: "Type-check a trigger script (the editor's TypeScript-subset language; read script_declarations first) without building it. Returns diagnostics or the trigger count.", inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] } },
      writes: false,
      run: async (input, { api }) => {
        const r = await api.script.compile(str(input.source));
        return r.ok ? `Compiles: ${r.triggers.length} triggers${r.program ? `, structured program of ${r.program.count}` : ""}.` : capResult({ errors: r.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`) });
      },
    },
    {
      def: { name: "build_script", description: "Compile a trigger script and, when it is clean, build it into the map (replacing the script's previous block; `takeOver` replaces every trigger). Stores the source with the map.", inputSchema: { type: "object", properties: { source: { type: "string" }, takeOver: { type: "boolean" } }, required: ["source"] } },
      writes: true,
      run: async (input, { api }) => {
        const r = await api.script.build(str(input.source), { takeOver: input.takeOver === true });
        return r.block ? `Built ${r.block.count} triggers at #${r.block.start + 1}.` : capResult({ errors: r.compiled.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`) });
      },
    },
    {
      def: { name: "scatter_doodads", description: "Scatter doodads of a category over a tile rect at a density 0–1, skipping spots that do not fit. One undo step.", inputSchema: { type: "object", properties: { category: { type: "string" }, ...rectSchema, density: { type: "number" } }, required: ["category", "x0", "y0", "x1", "y1"] } },
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        const cat = api.palette.doodadCategories().find((c) => c.name.toLowerCase() === str(input.category).toLowerCase());
        if (!cat || cat.doodads.length === 0) return `No doodad category called "${str(input.category)}"; call list_doodad_categories.`;
        const density = Math.max(0, Math.min(1, num(input.density, 0.3)));
        const want = Math.round(density * ((rect.x1 - rect.x0) * (rect.y1 - rect.y0)) / 12);
        let placed = 0;
        api.document.edit(`AI: scatter ${cat.name}`, (tx) => {
          for (let attempt = 0; attempt < want * 5 && placed < want; attempt++) {
            const d = cat.doodads[Math.floor(Math.random() * cat.doodads.length)];
            const tx0 = rect.x0 + Math.floor(Math.random() * Math.max(1, rect.x1 - rect.x0 - d.width));
            const ty0 = rect.y0 + Math.floor(Math.random() * Math.max(1, rect.y1 - rect.y0 - d.height));
            if (tx.placeDoodad(d.id, tx0, ty0) >= 0) placed++;
          }
        });
        return `Placed ${placed} of ${want} wanted.`;
      },
    },
    {
      def: { name: "set_fog", description: "Fog of war over a tile rect for 1-based players: mode \"fog\" (starts unexplored) or \"clear\". One undo step.", inputSchema: { type: "object", properties: { ...rectSchema, players: { type: "array", items: { type: "integer" } }, mode: { type: "string", enum: ["fog", "clear"] } }, required: ["x0", "y0", "x1", "y1", "players", "mode"] } },
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        const players = Array.isArray(input.players) ? (input.players as unknown[]).map((v) => num(v, 0)).filter((p) => p >= 1 && p <= 8) : [];
        const mask = players.reduce((m, p) => m | (1 << (p - 1)), 0);
        const r = api.document.edit("AI: fog of war", (tx) => { tx.setFog(rect, mask, str(input.mode) === "clear" ? "clear" : "fog"); });
        return `Changed ${r.fog} tiles.`;
      },
    },
    {
      def: { name: "undo", description: "Undo the last change (yours or the user's). Returns what was undone.", inputSchema: { type: "object", properties: {} } },
      writes: true,
      run: (_i, { api }) => { const label = api.document.undo(); return label ? `Undid: ${label}.` : "Nothing to undo."; },
    },
    {
      def: { name: "go_to", description: "Scroll the user's view to a tile.", inputSchema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } },
      writes: false,
      run: (input, { api }) => { api.view.goTo({ kind: "tile", x: Math.round(num(input.x)), y: Math.round(num(input.y)) }); return "Done."; },
    },
  ];
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
