/** Reads: the map's facts, lists, lookups, the picture, and what the person is doing. */
import { sampleGrid } from "../grid";
import { scriptBridge } from "../script";
import { imageInput } from "../facts";
import { terrainAtTile } from "../dialogs/region";
import { byName, capResult, hasRect, num, obj, ownerName, ownerOf, plural, rectOf, rectSchema, str, TILE, unitIdByName, type Tool } from "./common";

export function readTools(): Tool[] {
  return [
    {
      def: { name: "map_info", description: "The open map: name, description, size, tileset, revision, the players (type, race, colour, force, start location) and the forces, whether it has a trigger script.", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => {
        const info = api.document.info();
        if (!info) return "No map is open.";
        const starts = new Set(api.query.startLocations().map((s) => s.owner));
        return capResult({
          name: info.name, description: info.description, width: info.width, height: info.height, tileset: info.tileset, fileName: info.fileName, modified: info.modified,
          revision: api.settings.version()?.label,
          players: api.settings.players().map((p) => ({ player: p.slot + 1, type: p.typeName, race: p.raceName, ...(p.colorHex ? { color: p.colorHex } : {}), ...(p.force !== null ? { force: p.force + 1, forceName: p.forceName } : {}), hasStart: starts.has(p.slot) })),
          forces: api.settings.forces().map((f) => ({ force: f.force + 1, name: f.name, players: f.players.map((s) => s + 1), allied: f.allied, alliedVictory: f.alliedVictory, sharedVision: f.sharedVision, randomStart: f.randomStart })),
          script: scriptBridge(api)?.state()?.source ? "the map has a trigger script" : "no trigger script",
          history: api.document.history(),
        });
      },
    },
    {
      def: { name: "statistics", description: "Tools ▸ Statistics: counts of units, resources, doodads, sprites, locations, triggers, strings, terrain by type.", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => capResult(api.query.statistics() ?? "no map"),
    },
    {
      def: { name: "list_terrains", description: "The tileset's terrain types: id, name, height (0 low, 1 mid, 2 high), buildable. Use the ids with paint_terrain. (Also in the reference.)", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => capResult(api.terrain.types().map((t) => ({ id: t.id, name: t.name, height: t.height, buildable: t.buildable }))),
    },
    {
      def: { name: "list_doodad_categories", description: "Doodad categories the tileset offers, with how many doodads each has, for scatter_doodads. `category` lists that category's doodads with sizes.", inputSchema: obj({ category: { type: "string" } }) },
      writes: false,
      run: (input, { api }) => {
        const cats = api.palette.doodadCategories();
        const want = str(input.category).toLowerCase();
        if (want) {
          const c = cats.find((x) => x.name.toLowerCase() === want || x.name.toLowerCase().includes(want));
          return c ? capResult(c.doodads.map((d) => ({ id: d.id, name: d.name, width: d.width, height: d.height }))) : `No category called "${str(input.category)}".`;
        }
        return capResult(cats.map((c) => ({ name: c.name, count: c.doodads.length })));
      },
    },
    {
      def: { name: "list_units", description: "Units on the map: index, name, owner, tile x/y, resource amount for minerals and geysers. Filter by owner (1-based player, 12 neutral), by name (substring), or by a tile rect. `details` adds every record field (hit points %, shields %, energy %, hangar, state flags, serial).", inputSchema: obj({ owner: { type: "integer" }, name: { type: "string" }, ...rectSchema, limit: { type: "integer", description: "at most this many, default 200" }, details: { type: "boolean" }, indices: { type: "array", items: { type: "integer" }, description: "only these unit indices" } }) },
      writes: false,
      run: (input, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return "No map is open.";
        const owner = input.owner === undefined ? null : ownerOf(input.owner);
        const name = str(input.name).toLowerCase();
        const rect = hasRect(input) ? rectOf(input, api) : null;
        const only = Array.isArray(input.indices) ? new Set((input.indices as unknown[]).map((v) => num(v, -1))) : null;
        const limit = Math.max(1, Math.min(1000, num(input.limit, 200)));
        const details = input.details === true;
        const out: unknown[] = [];
        scn.units.forEach((u, index) => {
          if (only && !only.has(index)) return;
          if (owner !== null && u.owner !== owner) return;
          const n = api.names.unit(u.unitId);
          if (name && !n.toLowerCase().includes(name)) return;
          const tx = Math.floor(u.x / TILE), ty = Math.floor(u.y / TILE);
          if (rect && (tx < rect.x0 || ty < rect.y0 || tx >= rect.x1 || ty >= rect.y1)) return;
          if (out.length >= limit) return;
          const row: Record<string, unknown> = { index, name: n, owner: ownerName(u.owner), x: tx, y: ty };
          if (u.resourceAmount) row.amount = u.resourceAmount;
          if (details) Object.assign(row, { px: u.x, py: u.y, hitPointsPercent: u.hitPointsPercent, shieldPercent: u.shieldPercent, energyPercent: u.energyPercent, hangar: u.hangarUnits, cloaked: !!(u.stateFlags & 1), burrowed: !!(u.stateFlags & 2), inTransit: !!(u.stateFlags & 4), hallucinated: !!(u.stateFlags & 8), invincible: !!(u.stateFlags & 16), serial: u.serial });
          out.push(row);
        });
        return capResult({ count: out.length, total: scn.units.length, units: out });
      },
    },
    {
      def: { name: "list_doodads", description: "Doodads placed on the map: index, name, category, top-left tile, size. Optionally within a tile rect.", inputSchema: obj({ ...rectSchema, limit: { type: "integer" } }) },
      writes: false,
      run: (input, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return "No map is open.";
        const rect = hasRect(input) ? rectOf(input, api) : null;
        const limit = Math.max(1, Math.min(2000, num(input.limit, 300)));
        const out: unknown[] = [];
        scn.doodads.forEach((d, index) => {
          const info = api.palette.doodadInfo(d.doodadId);
          const tx = Math.floor(d.x / TILE) - Math.floor((info?.width ?? 1) / 2), ty = Math.floor(d.y / TILE) - Math.floor((info?.height ?? 1) / 2);
          if (rect && (tx + (info?.width ?? 1) <= rect.x0 || ty + (info?.height ?? 1) <= rect.y0 || tx >= rect.x1 || ty >= rect.y1)) return;
          if (out.length >= limit) return;
          out.push({ index, id: d.doodadId, name: info?.name ?? `doodad ${d.doodadId}`, category: info?.category, x: tx, y: ty, width: info?.width, height: info?.height });
        });
        return capResult({ count: out.length, total: scn.doodads.length, doodads: out });
      },
    },
    {
      def: { name: "list_sprites", description: "Sprites (THG2) on the map: index, kind (pure sprite or unit sprite), name, owner, tile. Optionally within a tile rect.", inputSchema: obj({ ...rectSchema, limit: { type: "integer" } }) },
      writes: false,
      run: (input, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return "No map is open.";
        const rect = hasRect(input) ? rectOf(input, api) : null;
        const limit = Math.max(1, Math.min(2000, num(input.limit, 300)));
        const out: unknown[] = [];
        scn.sprites.forEach((s, index) => {
          const kind = (s.flags & api.consts.sprite.flags.PureSprite) !== 0 ? "pure" : "unit";
          const tx = Math.floor(s.x / TILE), ty = Math.floor(s.y / TILE);
          if (rect && (tx < rect.x0 || ty < rect.y0 || tx >= rect.x1 || ty >= rect.y1)) return;
          if (out.length >= limit) return;
          out.push({ index, kind, id: s.spriteId, name: api.palette.spriteName(kind, s.spriteId), owner: ownerName(s.owner), x: tx, y: ty, flipped: (s.flags & api.consts.sprite.flags.Flipped) !== 0, disabled: (s.flags & api.consts.sprite.flags.Disabled) !== 0 });
        });
        return capResult({ count: out.length, total: scn.sprites.length, sprites: out });
      },
    },
    {
      def: { name: "list_locations", description: "The map's locations: slot index, name, tile rect, elevation flags (which heights it excludes).", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return "No map is open.";
        const out: unknown[] = [];
        scn.locations.forEach((l, i) => {
          if (i === api.consts.location.anywhere || (l.left === 0 && l.top === 0 && l.right === 0 && l.bottom === 0)) return;
          out.push({ index: i, name: api.names.location(i), x0: Math.floor(Math.min(l.left, l.right) / TILE), y0: Math.floor(Math.min(l.top, l.bottom) / TILE), x1: Math.ceil(Math.max(l.left, l.right) / TILE), y1: Math.ceil(Math.max(l.top, l.bottom) / TILE), ...(l.elevationFlags ? { excludes: l.elevationFlags } : {}) });
        });
        return capResult({ count: out.length, locations: out, note: "Slot 63 is Anywhere and cannot be edited." });
      },
    },
    {
      def: { name: "list_strings", description: "The string table: index and text, with what uses each (map name, location, trigger …). `query` filters by substring; `unused` lists only strings nothing references.", inputSchema: obj({ query: { type: "string" }, unused: { type: "boolean" }, limit: { type: "integer" } }) },
      writes: false,
      run: (input, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return "No map is open.";
        const usage = api.query.stringUsage();
        const unused = new Set(api.query.unusedStrings());
        const q = str(input.query).toLowerCase();
        const limit = Math.max(1, Math.min(2000, num(input.limit, 200)));
        const out: unknown[] = [];
        for (let i = 1; i < scn.strings.strings.length && out.length < limit; i++) {
          const text = api.names.string(i);
          if (text === null || text === "") continue;
          if (input.unused === true && !unused.has(i)) continue;
          if (q && !text.toLowerCase().includes(q)) continue;
          out.push({ index: i, text: text.length > 200 ? `${text.slice(0, 200)}…` : text, usedBy: (usage.get(i) ?? []).slice(0, 6).map((u) => `${u.kind}${"index" in u && u.index !== undefined ? ` ${u.index}` : ""}`) });
        }
        return capResult({ count: out.length, slots: scn.strings.strings.length, strings: out });
      },
    },
    {
      def: { name: "list_switches", description: "The 256 switches that have a name or are used by triggers: index (0-based; the text format says \"Switch N\" 1-based), name, how many conditions and actions use it.", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => {
        const names = api.triggers.switchNames();
        const usage = api.triggers.switchUsage();
        const out = names.map((name, index) => ({ index, name, uses: usage[index] ?? 0 })).filter((s) => s.name || s.uses > 0);
        return capResult({ count: out.length, switches: out });
      },
    },
    {
      def: { name: "list_sounds", description: "The WAV table: slot, path, whether the file is in the archive, its size, what plays it.", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => capResult(api.settings.sounds().map((s) => ({ slot: s.slot, path: s.path, present: s.present, size: s.size, usedBy: s.usedBy }))),
    },
    {
      def: { name: "list_triggers_text", description: "The map's triggers in the editor's text format, from index `from` to `to` (1-based, inclusive; default the first 20). Also the mission briefing with briefing=true.", inputSchema: obj({ from: { type: "integer" }, to: { type: "integer" }, briefing: { type: "boolean" } }) },
      writes: false,
      run: (input, { api }) => {
        const briefing = input.briefing === true;
        const all = briefing ? api.triggers.briefing() : api.triggers.list();
        if (all.length === 0) return briefing ? "No briefing triggers." : "No triggers.";
        const from = Math.max(1, Math.round(num(input.from, 1)));
        const to = Math.min(all.length, Math.round(num(input.to, from + 19)));
        const slice = all.slice(from - 1, to);
        const text = slice.map((t, i) => `// #${from + i}\n${api.triggers.text.one(t, { briefing })}`).join("\n\n");
        return capResult(`${all.length} trigger${all.length === 1 ? "" : "s"} in all; showing ${from}–${to}.\n\n${text}`, 30_000);
      },
    },
    {
      def: { name: "find", description: "Edit ▸ Find: search units, locations, sprites, strings or triggers for text.", inputSchema: obj({ kind: { type: "string", enum: ["units", "locations", "sprites", "strings", "triggers"] }, text: { type: "string" } }, ["kind", "text"]) },
      writes: false,
      run: (input, { api }) => capResult(api.query.find({ kind: str(input.kind, "strings") as "strings", query: str(input.text), limit: 100 })),
    },
    {
      def: { name: "validate", description: "Tools ▸ Check Map: problems the editor finds with the map.", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => { const issues = api.query.validate(); return issues.length ? capResult(issues.map((i) => ({ level: i.level, text: i.text, where: i.where, target: i.target }))) : "Check Map finds nothing wrong."; },
    },
    {
      def: { name: "terrain_at", description: "What is under a tile: the terrain type, height, buildable, walkable, and the doodad there if any. Or a coarse grid of an area (cells of `cellSize` tiles) when a rect is given.", inputSchema: obj({ x: { type: "integer" }, y: { type: "integer" }, ...rectSchema, cellSize: { type: "integer" } }) },
      writes: false,
      run: (input, ctx) => {
        const { api } = ctx;
        if (hasRect(input)) {
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
        return capResult({ x, y, terrain: api.names.tile(scn.tiles[y * scn.width + x]), terrainId: api.terrain.terrainAt(x, y), kind: t?.kind, height: t?.height, buildable: t?.buildable, walkableMinitiles: t?.walkable, doodad: d >= 0 ? api.palette.doodadInfo(scn.doodads[d]?.doodadId ?? -1)?.name ?? d : null, fogged: scn.mask ? Array.from({ length: 8 }, (_, p) => (scn.mask![y * scn.width + x] >> p) & 1).map((b, p) => (b ? p + 1 : 0)).filter(Boolean) : "everyone (no MASK section)" });
      },
    },
    {
      def: { name: "fog_at", description: "Fog of war over a tile rect for a 1-based player, as a coarse grid of cells (`#` = starts unexplored, `.` = explored).", inputSchema: obj({ ...rectSchema, player: { type: "integer" }, cellSize: { type: "integer" } }, ["player"]) },
      writes: false,
      run: (input, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return "No map is open.";
        const rect = rectOf(input, api);
        const p = Math.max(1, Math.min(8, Math.round(num(input.player, 1)))) - 1;
        if (!scn.mask) return "The map has no MASK section: every tile starts unexplored for everyone.";
        const cell = Math.max(1, Math.min(16, num(input.cellSize, Math.ceil(Math.max(rect.x1 - rect.x0, rect.y1 - rect.y0) / 64))));
        const rows: string[] = [];
        for (let y = rect.y0; y < rect.y1; y += cell) {
          let row = "";
          for (let x = rect.x0; x < rect.x1; x += cell) {
            let fog = 0, n = 0;
            for (let yy = y; yy < Math.min(rect.y1, y + cell); yy++) for (let xx = x; xx < Math.min(rect.x1, x + cell); xx++) { n++; if ((scn.mask[yy * scn.width + xx] >> p) & 1) fog++; }
            row += fog * 2 >= n ? "#" : ".";
          }
          rows.push(row);
        }
        return capResult({ originX: rect.x0, originY: rect.y0, cellSize: cell, player: p + 1, grid: rows });
      },
    },
    {
      def: { name: "placement_ok", description: "Whether a unit could be placed with its centre at a tile: the editor's own placement check.", inputSchema: obj({ unit: { type: "string" }, x: { type: "integer" }, y: { type: "integer" } }, ["unit", "x", "y"]) },
      writes: false,
      run: (input, { api }) => {
        const id = unitIdByName(api, str(input.unit));
        if (id === null) return `No unit is called "${str(input.unit)}".`;
        const v = api.query.placement(id, num(input.x) * TILE + TILE / 2, num(input.y) * TILE + TILE / 2);
        if (!v) return "No map is open.";
        return v.problem ? `No: ${v.reason ?? v.problem}${v.blocker >= 0 ? ` (unit index ${v.blocker})` : ""}.` : "Yes.";
      },
    },
    {
      def: { name: "screenshot", description: "A picture of an area of the map (or the whole map when no rect is given) at `pixelsPerTile` (default 8; 32 is the game's art, 2 is a minimap). Look before and after changing things.", inputSchema: obj({ ...rectSchema, pixelsPerTile: { type: "integer" } }) },
      writes: false,
      run: async (input, { api }) => {
        const info = api.document.info();
        if (!info) return "No map is open.";
        const rect = hasRect(input) ? rectOf(input, api) : { x0: 0, y0: 0, x1: info.width, y1: info.height };
        let ppt = Math.max(1, Math.min(32, num(input.pixelsPerTile, 8)));
        while (ppt > 1 && (rect.x1 - rect.x0) * ppt * (rect.y1 - rect.y0) * ppt > 1_200_000) ppt = ppt > 8 ? ppt / 2 : ppt - 1;
        await api.tileset.load();
        const blob = await api.graphics.renderRect(rect, { pixelsPerTile: ppt, units: true, sprites: true, locations: true, locationNames: true, startLocations: true, grid: 0 });
        if (!blob) return "The map cannot be rendered (tileset graphics missing).";
        return { text: `Tiles ${rect.x0},${rect.y0} to ${rect.x1},${rect.y1} at ${ppt} px per tile: tile x = ${rect.x0} + px / ${ppt}, y = ${rect.y0} + py / ${ppt}.`, image: await imageInput(blob) };
      },
    },
    {
      def: { name: "selection", description: "What the person has selected or marked right now: the marked area, selected units / sprites / doodads / locations, the active layer, the visible area and the cursor tile.", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => {
        const scn = api.document.scenario();
        if (!scn) return "No map is open.";
        const units = api.selection.units().map((i) => ({ index: i, name: api.names.unit(scn.units[i]?.unitId ?? 0), owner: ownerName(scn.units[i]?.owner ?? 11), x: Math.floor((scn.units[i]?.x ?? 0) / TILE), y: Math.floor((scn.units[i]?.y ?? 0) / TILE) }));
        return capResult({
          layer: api.selection.layer(),
          markedArea: api.selection.markedArea(),
          units,
          sprites: api.selection.sprites(),
          doodads: api.selection.doodads().map((i) => ({ index: i, name: api.palette.doodadInfo(scn.doodads[i]?.doodadId ?? -1)?.name })),
          locations: api.selection.locations().map((i) => ({ index: i, name: api.names.location(i) })),
          visible: api.view.visible(),
          zoom: api.view.zoom(),
          cursor: api.view.cursorTile(),
        });
      },
    },
    {
      def: { name: "lookup", description: "Look a name up in the game data: kind \"unit\" (id, size, cost, hp, weapons, the map's own settings), \"doodad\", \"sprite\", \"upgrade\", \"tech\", \"weapon\", \"ai_script\", \"condition\" or \"action\" (the argument list). `query` is a name or part of one; several matches are listed.", inputSchema: obj({ kind: { type: "string", enum: ["unit", "doodad", "sprite", "upgrade", "tech", "weapon", "ai_script", "condition", "action"] }, query: { type: "string" } }, ["kind", "query"]) },
      writes: false,
      run: (input, { api }) => {
        const kind = str(input.kind), q = str(input.query).toLowerCase();
        const matches = <T extends { label: string; value: number }>(items: T[]) => items.filter((i) => i.label.toLowerCase().includes(q) || String(i.value) === q).slice(0, 25);
        switch (kind) {
          case "unit": {
            const hits = matches(api.names.units().filter((u) => u.value < 228));
            return hits.length ? capResult(hits.map((u) => { const t = api.settings.unitType(u.value); const s = api.palette.unitSize(u.value); return { id: u.value, name: u.label, race: api.data.race(u.value), width: s.width, height: s.height, building: s.building, flyer: s.flyer, ...(t ? { useDefault: t.useDefault, hitPoints: t.hitPoints, shields: t.shields, armor: t.armor, buildTime: t.buildTime, minerals: t.mineralCost, gas: t.gasCost, weapons: t.weapons, customName: t.customName || undefined } : {}) }; })) : `No unit matches "${q}".`;
          }
          case "doodad": { const all = api.palette.doodadCategories().flatMap((c) => c.doodads.map((d) => ({ ...d }))); const hits = all.filter((d) => d.name.toLowerCase().includes(q) || d.category.toLowerCase().includes(q) || String(d.id) === q).slice(0, 40); return hits.length ? capResult(hits) : `No doodad matches "${q}".`; }
          case "sprite": { const ids = api.palette.spriteGroups().flatMap((g) => g.ids.map((id) => ({ value: id, label: api.palette.spriteName("pure", id), group: g.label }))); const hits = ids.filter((s) => s.label.toLowerCase().includes(q) || String(s.value) === q).slice(0, 40); return hits.length ? capResult(hits.map((s) => ({ id: s.value, name: s.label, group: s.group }))) : `No sprite matches "${q}".`; }
          case "upgrade": { const hits = matches(api.names.upgrades()); return hits.length ? capResult(hits.map((u) => api.settings.upgrade(u.value) ?? u)) : `No upgrade matches "${q}".`; }
          case "tech": { const hits = matches(api.names.techs()); return hits.length ? capResult(hits.map((t) => api.settings.tech(t.value) ?? t)) : `No technology matches "${q}".`; }
          case "weapon": { const hits = matches(api.names.weapons()); return hits.length ? capResult(hits.map((w) => ({ id: w.value, name: w.label, damage: api.data.weapons()?.damage[w.value], bonus: api.data.weapons()?.bonus[w.value] }))) : `No weapon matches "${q}".`; }
          case "ai_script": { const hits = api.triggers.defs.choices("aiScript").filter((c) => c.label.toLowerCase().includes(q) || (c.aliases ?? []).some((a) => a.toLowerCase().includes(q))).slice(0, 40); return hits.length ? capResult(hits.map((c) => ({ label: c.label, aliases: c.aliases }))) : `No AI script matches "${q}".`; }
          case "condition": { const hits = api.triggers.defs.conditions().filter((c) => c.name.toLowerCase().includes(q)); return hits.length ? capResult(hits.map((c) => ({ name: c.name, args: c.args.map((a) => `${a.label}: ${a.kind}`) }))) : `No condition matches "${q}".`; }
          case "action": { const hits = [...api.triggers.defs.actions(false).map((a) => ({ ...a, briefing: false })), ...api.triggers.defs.actions(true).map((a) => ({ ...a, briefing: true }))].filter((c) => c.name.toLowerCase().includes(q)); return hits.length ? capResult(hits.map((c) => ({ name: c.name, briefing: c.briefing, args: c.args.map((a) => `${a.label}: ${a.kind}`) }))) : `No action matches "${q}".`; }
          default: return `Unknown kind "${kind}".`;
        }
      },
    },
    {
      def: { name: "history", description: "The undo and redo stacks: the labels on top and how deep each is.", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => { const h = api.document.history(); return `${plural(h.undoDepth, "undo step")}${h.undo ? ` (top: ${h.undo})` : ""}, ${plural(h.redoDepth, "redo step")}${h.redo ? ` (top: ${h.redo})` : ""}.`; },
    },
    {
      def: { name: "unit_type", description: "This map's settings for a unit type (Unit Settings dialog): whether it uses the game's defaults, hit points, shields, armor, build time, cost, weapon damage, custom name, and who may build it. Names are matched loosely; \"marine\" works.", inputSchema: obj({ unit: { type: "string" } }, ["unit"]) },
      writes: false,
      run: (input, { api }) => { const id = unitIdByName(api, str(input.unit)); if (id === null) return `No unit is called "${str(input.unit)}".`; const t = api.settings.unitType(id); return t ? capResult({ ...t, availability: { defaultAvailable: t.availability.defaultAvailable, players: Object.fromEntries(t.availability.players.map((v, p) => [`player ${p + 1}`, v])) } }) : "No map is open."; },
    },
    {
      def: { name: "upgrade", description: "This map's settings for an upgrade (Upgrade Settings dialog): costs, factors, time and each player's start and maximum level.", inputSchema: obj({ upgrade: { type: "string" } }, ["upgrade"]) },
      writes: false,
      run: (input, { api }) => { const hit = byName(api.names.upgrades(), str(input.upgrade)); if (!hit) return `No upgrade is called "${str(input.upgrade)}".`; const u = api.settings.upgrade(hit.value); return u ? capResult({ ...u, levels: { defaultStart: u.levels.defaultStart, defaultMax: u.levels.defaultMax, players: Object.fromEntries(u.levels.players.map((v, p) => [`player ${p + 1}`, v])) } }) : "No map is open."; },
    },
    {
      def: { name: "tech", description: "This map's settings for a technology (Technology Settings dialog): costs, research time, energy, and each player's available / researched state.", inputSchema: obj({ tech: { type: "string" } }, ["tech"]) },
      writes: false,
      run: (input, { api }) => { const hit = byName(api.names.techs(), str(input.tech)); if (!hit) return `No technology is called "${str(input.tech)}".`; const t = api.settings.tech(hit.value); return t ? capResult({ ...t, state: { defaultAvailable: t.state.defaultAvailable, defaultResearched: t.state.defaultResearched, players: Object.fromEntries(t.state.players.map((v, p) => [`player ${p + 1}`, v])) } }) : "No map is open."; },
    },
  ];
}
