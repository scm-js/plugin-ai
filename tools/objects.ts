/** Writes on objects: units, doodads, sprites, locations, fog. Each is one undo step. */
import type { PluginApi } from "@scm-js/plugin-api";
import { bool, capResult, doodadByName, ints, list, num, obj, ownerOf, plural, rectOf, rectSchema, spriteByName, str, TILE, unitIdByName, type Tool } from "./common";

/**
 * The special-property tick each input key sets: the `stateFlags` bit and the
 * `validProperties` bit that says the game should read it. They are the same numbers, but
 * they are different fields, so the pair is spelled out rather than reused.
 */
const STATE_BITS = (c: PluginApi["consts"]) => [
  ["cloaked", c.unit.state.Cloaked, c.unit.valid.Cloak],
  ["burrowed", c.unit.state.Burrowed, c.unit.valid.Burrow],
  ["inTransit", c.unit.state.InTransit, c.unit.valid.InTransit],
  ["hallucinated", c.unit.state.Hallucinated, c.unit.valid.Hallucinated],
  ["invincible", c.unit.state.Invincible, c.unit.valid.Invincible],
] as const;

/** The elevations a location can exclude, by input key. A *set* bit excludes that height. */
const ELEVATION_BITS = (c: PluginApi["consts"]) => [
  ["excludeLowGround", c.location.elevation.LowGround],
  ["excludeMediumGround", c.location.elevation.MediumGround],
  ["excludeHighGround", c.location.elevation.HighGround],
  ["excludeLowAir", c.location.elevation.LowAir],
  ["excludeMediumAir", c.location.elevation.MediumAir],
  ["excludeHighAir", c.location.elevation.HighAir],
] as const;

export function objectTools(): Tool[] {
  return [
    {
      def: { name: "place_units", description: "Place units by name at tile centres for a 1-based player (12 neutral); `amount` sets a mineral field's or geyser's resources. Refused positions are reported, not forced. One undo step.", inputSchema: obj({ units: { type: "array", items: obj({ unit: { type: "string" }, player: { type: "integer" }, x: { type: "integer" }, y: { type: "integer" }, amount: { type: "integer" } }, ["unit", "player", "x", "y"]) } }, ["units"]) },
      writes: true,
      run: (input, { api }) => {
        const wanted = list(input.units);
        const placed: unknown[] = [];
        const refused: string[] = [];
        api.document.edit("AI: place units", (tx) => {
          for (const u of wanted) {
            const id = unitIdByName(api, str(u.unit));
            if (id === null) { refused.push(`no unit called "${str(u.unit)}"`); continue; }
            const px = num(u.x) * TILE + TILE / 2, py = num(u.y) * TILE + TILE / 2;
            const owner = ownerOf(u.player, 0);
            if (!tx.canPlaceUnit(id, px, py)) { refused.push(`${api.names.unit(id)} at ${num(u.x)},${num(u.y)}: ${api.query.placement(id, px, py)?.reason ?? "refused"}`); continue; }
            const index = tx.placeUnit(id, owner, px, py);
            if (u.amount !== undefined) tx.updateUnits([index], (rec) => ({ resourceAmount: num(u.amount), validStates: rec.validStates | api.consts.unit.used.Resources }));
            placed.push({ index, unit: api.names.unit(id), x: num(u.x), y: num(u.y) });
          }
        });
        return capResult({ placed, refused });
      },
    },
    {
      def: { name: "remove_units", description: "Remove units by index (from list_units). One undo step.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } } }, ["indices"]) },
      writes: true,
      run: (input, { api }) => { const r = api.document.edit("AI: remove units", (tx) => { tx.removeUnits(ints(input.indices)); }); return `Removed ${plural(r.units, "unit")}.`; },
    },
    {
      def: { name: "move_units", description: "Move units by index to new tile centres. One undo step.", inputSchema: obj({ moves: { type: "array", items: obj({ index: { type: "integer" }, x: { type: "integer" }, y: { type: "integer" } }, ["index", "x", "y"]) } }, ["moves"]) },
      writes: true,
      run: (input, { api }) => {
        let n = 0;
        api.document.edit("AI: move units", (tx) => {
          for (const m of list(input.moves)) {
            const index = num(m.index, -1);
            if (index < 0 || index >= tx.scenario.units.length) continue;
            n += tx.updateUnits([index], () => ({ x: num(m.x) * TILE + TILE / 2, y: num(m.y) * TILE + TILE / 2 }));
          }
        });
        return `Moved ${plural(n, "unit")}.`;
      },
    },
    {
      def: { name: "update_units", description: "Change fields of existing units by index (Unit Properties): owner (1-based player), hitPoints / shields / energy as percent, resources (minerals or gas in a field), hangar (interceptors / scarabs), and the flags cloaked, burrowed, inTransit (lifted off), hallucinated, invincible. Only the fields given change. One undo step.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } }, owner: { type: "integer" }, hitPoints: { type: "integer" }, shields: { type: "integer" }, energy: { type: "integer" }, resources: { type: "integer" }, hangar: { type: "integer" }, cloaked: { type: "boolean" }, burrowed: { type: "boolean" }, inTransit: { type: "boolean" }, hallucinated: { type: "boolean" }, invincible: { type: "boolean" } }, ["indices"]) },
      writes: true,
      run: (input, { api }) => {
        const indices = ints(input.indices);
        const used0 = api.consts.unit.used;
        const pct = (v: unknown) => Math.max(0, Math.min(100, Math.round(num(v))));
        let n = 0;
        api.document.edit("AI: unit properties", (tx) => {
          n = tx.updateUnits(indices, (rec) => {
            const patch: Record<string, number> = {};
            let used = rec.validStates;
            let flags = rec.stateFlags;
            let valid = rec.validProperties;
            if (input.owner !== undefined) { patch.owner = ownerOf(input.owner, rec.owner); used |= used0.Owner; }
            if (input.hitPoints !== undefined) { patch.hitPointsPercent = pct(input.hitPoints); used |= used0.HitPoints; }
            if (input.shields !== undefined) { patch.shieldPercent = pct(input.shields); used |= used0.Shields; }
            if (input.energy !== undefined) { patch.energyPercent = pct(input.energy); used |= used0.Energy; }
            if (input.resources !== undefined) { patch.resourceAmount = Math.max(0, Math.round(num(input.resources))); used |= used0.Resources; }
            if (input.hangar !== undefined) { patch.hangarUnits = Math.max(0, Math.round(num(input.hangar))); used |= used0.Hangar; }
            for (const [key, stateBit, validBit] of STATE_BITS(api.consts)) {
              const v = bool(input[key]);
              if (v === undefined) continue;
              flags = v ? flags | stateBit : flags & ~stateBit;
              valid |= validBit;
              used |= used0.State;
            }
            return { ...patch, validStates: used, stateFlags: flags, validProperties: valid };
          });
        });
        return `Updated ${plural(n, "unit")}.`;
      },
    },
    {
      def: { name: "place_doodads", description: "Place doodads by name (or id, or a category name for any of its doodads) with their top-left corner at a tile. A doodad that does not fit its footprint is refused, not forced. One undo step.", inputSchema: obj({ doodads: { type: "array", items: obj({ doodad: { type: "string" }, x: { type: "integer" }, y: { type: "integer" } }, ["doodad", "x", "y"]) } }, ["doodads"]) },
      writes: true,
      run: (input, { api }) => {
        const placed: unknown[] = [];
        const refused: string[] = [];
        api.document.edit("AI: place doodads", (tx) => {
          for (const d of list(input.doodads)) {
            const def = doodadByName(api, str(d.doodad));
            if (!def) { refused.push(`no doodad called "${str(d.doodad)}"`); continue; }
            const index = tx.placeDoodad(def.id, Math.round(num(d.x)), Math.round(num(d.y)));
            if (index < 0) refused.push(`${def.name} at ${num(d.x)},${num(d.y)} does not fit`);
            else placed.push({ index, name: def.name, x: num(d.x), y: num(d.y), width: def.width, height: def.height });
          }
        });
        return capResult({ placed, refused });
      },
    },
    {
      def: { name: "remove_doodads", description: "Remove doodads by index (from list_doodads); the ground under them is restored. One undo step.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } } }, ["indices"]) },
      writes: true,
      run: (input, { api }) => { const r = api.document.edit("AI: remove doodads", (tx) => { tx.removeDoodads(ints(input.indices)); }); return `Removed ${plural(r.doodads, "doodad")}.`; },
    },
    {
      def: { name: "scatter_doodads", description: "Scatter doodads of a category over a tile rect at a density 0–1, skipping spots that do not fit. One undo step.", inputSchema: obj({ category: { type: "string" }, ...rectSchema, density: { type: "number" } }, ["category", "x0", "y0", "x1", "y1"]) },
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        const cat = api.palette.doodadCategories().find((c) => c.name.toLowerCase() === str(input.category).toLowerCase()) ?? api.palette.doodadCategories().find((c) => c.name.toLowerCase().includes(str(input.category).toLowerCase()));
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
      def: { name: "place_sprites", description: "Place sprites at tile centres: kind \"pure\" (a sprites.dat image by the palette's name or id — lookup sprite) or \"unit\" (a unit drawn as a sprite, by unit name). `player` is 1-based. One undo step.", inputSchema: obj({ sprites: { type: "array", items: obj({ kind: { type: "string", enum: ["pure", "unit"] }, sprite: { type: "string" }, player: { type: "integer" }, x: { type: "integer" }, y: { type: "integer" }, flipped: { type: "boolean" }, disabled: { type: "boolean" } }, ["kind", "sprite", "x", "y"]) } }, ["sprites"]) },
      writes: true,
      run: (input, { api }) => {
        const placed: unknown[] = [];
        const refused: string[] = [];
        api.document.edit("AI: place sprites", (tx) => {
          for (const s of list(input.sprites)) {
            const kind = str(s.kind) === "unit" ? "unit" : "pure";
            const id = spriteByName(api, kind, str(s.sprite));
            if (id === null) { refused.push(`no ${kind} sprite called "${str(s.sprite)}"`); continue; }
            const index = tx.placeSprite(kind, id, ownerOf(s.player, 0), num(s.x) * TILE + TILE / 2, num(s.y) * TILE + TILE / 2, { flipped: bool(s.flipped) ?? false, disabled: bool(s.disabled) ?? (kind === "unit") });
            placed.push({ index, kind, name: api.palette.spriteName(kind, id), x: num(s.x), y: num(s.y) });
          }
        });
        return capResult({ placed, refused });
      },
    },
    {
      def: { name: "remove_sprites", description: "Remove sprites by index (from list_sprites). One undo step.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } } }, ["indices"]) },
      writes: true,
      run: (input, { api }) => { const r = api.document.edit("AI: remove sprites", (tx) => { tx.removeSprites(ints(input.indices)); }); return `Removed ${plural(r.sprites, "sprite")}.`; },
    },
    {
      def: { name: "add_location", description: "Add a named location over a tile rect. One undo step.", inputSchema: obj({ name: { type: "string" }, ...rectSchema }, ["name", "x0", "y0", "x1", "y1"]) },
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        let index = -1;
        api.document.edit(`AI: location ${str(input.name)}`, (tx) => { index = tx.addLocation({ left: rect.x0 * TILE, top: rect.y0 * TILE, right: rect.x1 * TILE, bottom: rect.y1 * TILE }, str(input.name, "Location")); });
        return index < 0 ? "No free location slot." : `Added location ${index} "${str(input.name)}".`;
      },
    },
    {
      def: { name: "edit_location", description: "Rename, move or resize a location by slot index (a tile rect), or set which heights it excludes (`excludeLowGround` … `excludeHighAir`). One undo step.", inputSchema: obj({ index: { type: "integer" }, name: { type: "string" }, ...rectSchema, excludeLowGround: { type: "boolean" }, excludeMediumGround: { type: "boolean" }, excludeHighGround: { type: "boolean" }, excludeLowAir: { type: "boolean" }, excludeMediumAir: { type: "boolean" }, excludeHighAir: { type: "boolean" } }, ["index"]) },
      writes: true,
      run: (input, { api }) => {
        const index = Math.round(num(input.index, -1));
        const scn = api.document.scenario();
        if (!scn || index < 0 || index >= scn.locations.length || index === api.consts.location.anywhere) return "No such location (slot 63 is Anywhere).";
        const patch: Record<string, unknown> = {};
        if (typeof input.name === "string") patch.name = input.name;
        if (input.x0 !== undefined && input.x1 !== undefined) { const r = rectOf(input, api); Object.assign(patch, { left: r.x0 * TILE, top: r.y0 * TILE, right: r.x1 * TILE, bottom: r.y1 * TILE }); }
        const bits = ELEVATION_BITS(api.consts);
        if (bits.some(([k]) => input[k] !== undefined)) {
          let flags = scn.locations[index].elevationFlags;
          for (const [k, bit] of bits) { const v = bool(input[k]); if (v !== undefined) flags = v ? flags | bit : flags & ~bit; }
          patch.elevationFlags = flags;
        }
        let ok = false;
        api.document.edit(`AI: edit location ${api.names.location(index)}`, (tx) => { ok = tx.editLocation(index, patch); });
        return ok ? `Edited location ${index}.` : "Nothing changed.";
      },
    },
    {
      def: { name: "remove_locations", description: "Remove locations by slot index. One undo step.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } } }, ["indices"]) },
      writes: true,
      run: (input, { api }) => { const r = api.document.edit("AI: remove locations", (tx) => { tx.removeLocations(ints(input.indices).filter((i) => i !== api.consts.location.anywhere)); }); return `Removed ${plural(r.locations, "location")}.`; },
    },
    {
      def: { name: "set_fog", description: "Fog of war over a tile rect for 1-based players: mode \"fog\" (starts unexplored) or \"clear\". One undo step.", inputSchema: obj({ ...rectSchema, players: { type: "array", items: { type: "integer" } }, mode: { type: "string", enum: ["fog", "clear"] } }, ["x0", "y0", "x1", "y1", "players", "mode"]) },
      writes: true,
      run: (input, { api }) => {
        const rect = rectOf(input, api);
        const players = ints(input.players).filter((p) => p >= 1 && p <= 8);
        const mask = players.reduce((m, p) => m | (1 << (p - 1)), 0);
        const r = api.document.edit("AI: fog of war", (tx) => { tx.setFog(rect, mask, str(input.mode) === "clear" ? "clear" : "fog"); });
        return `Changed ${plural(r.fog, "tile")}.`;
      },
    },
  ];
}
