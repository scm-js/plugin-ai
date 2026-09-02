/** The Scenario menu's dialogs: players, forces, unit / upgrade / technology settings, the revision. Transactions outside the undo model. */
import { bool, byName, capResult, colorIndexOf, ints, list, num, obj, plural, slotOf, str, techIdByName, unitIdByName, upgradeIdByName, type Tool } from "./common";

export function settingsTools(): Tool[] {
  return [
    {
      def: { name: "set_players", description: "Player Settings and Player Colors: for each 1-based player, the type (Human, Computer, Rescuable, Neutral, Inactive …), race (Zerg, Terran, Protoss, User Selectable, Random …), colour (a name like Red / Blue / Teal / Purple / Orange / Brown / White / Yellow / Green, or a COLR index, or an RGB triple for a Remastered custom colour) and force (1–4). Only the fields given change. Not undoable.", inputSchema: obj({ players: { type: "array", items: obj({ player: { type: "integer" }, type: { type: "string" }, race: { type: "string" }, color: { type: "string" }, rgb: { type: "array", items: { type: "integer" } }, force: { type: "integer" } }, ["player"]) } }, ["players"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const notes: string[] = [];
        let changed = 0;
        const r = api.document.update("AI: player settings", (tx) => {
          for (const p of list(input.players)) {
            const slot = slotOf(p.player);
            if (slot === null || slot === "default") { notes.push(`player ${str(p.player)}: not a player number`); continue; }
            const patch: { type?: number; race?: number; color?: number; rgb?: [number, number, number] | null; force?: number } = {};
            if (p.type !== undefined) { const t = byName(api.names.playerTypes(), str(p.type)); if (t) patch.type = t.value; else notes.push(`unknown player type "${str(p.type)}"`); }
            if (p.race !== undefined) { const rc = byName(api.names.races(), str(p.race)); if (rc) patch.race = rc.value; else notes.push(`unknown race "${str(p.race)}"`); }
            if (p.color !== undefined) { const c = colorIndexOf(p.color); if (c !== null) { patch.color = c; patch.rgb = null; } else notes.push(`unknown colour "${str(p.color)}"`); }
            if (Array.isArray(p.rgb) && p.rgb.length === 3) patch.rgb = [num(p.rgb[0]), num(p.rgb[1]), num(p.rgb[2])];
            if (p.force !== undefined) patch.force = Math.max(0, Math.min(3, Math.round(num(p.force, 1)) - 1));
            if (tx.players.set(slot, patch)) changed++;
          }
        });
        return capResult({ changed, sections: r.sections, notes });
      },
    },
    {
      def: { name: "set_forces", description: "Force Settings: for each force 1–4, its name, the flags allied / alliedVictory / sharedVision / randomStart, and the 1-based players to put in it. Only the fields given change. Not undoable.", inputSchema: obj({ forces: { type: "array", items: obj({ force: { type: "integer" }, name: { type: "string" }, allied: { type: "boolean" }, alliedVictory: { type: "boolean" }, sharedVision: { type: "boolean" }, randomStart: { type: "boolean" }, players: { type: "array", items: { type: "integer" } } }, ["force"]) } }, ["forces"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        let changed = 0;
        const r = api.document.update("AI: force settings", (tx) => {
          for (const f of list(input.forces)) {
            const force = Math.round(num(f.force, 1)) - 1;
            const patch: { name?: string; allied?: boolean; alliedVictory?: boolean; sharedVision?: boolean; randomStart?: boolean; players?: number[] } = {};
            if (typeof f.name === "string") patch.name = f.name;
            for (const k of ["allied", "alliedVictory", "sharedVision", "randomStart"] as const) { const v = bool(f[k]); if (v !== undefined) patch[k] = v; }
            if (Array.isArray(f.players)) patch.players = ints(f.players).map((p) => p - 1).filter((p) => p >= 0 && p < 8);
            if (tx.forces.set(force, patch)) changed++;
          }
        });
        return capResult({ changed, sections: r.sections, forces: api.settings.forces().map((f) => ({ force: f.force + 1, name: f.name, players: f.players.map((p) => p + 1), allied: f.allied, alliedVictory: f.alliedVictory, sharedVision: f.sharedVision, randomStart: f.randomStart })) });
      },
    },
    {
      def: { name: "set_unit_type", description: "Unit Settings for one unit type: hitPoints (whole points), shields, armor, buildTime (frames), mineralCost, gasCost, weapon damage / bonus by weapon id, a custom name (\"\" restores the default), and availability — who may build it: `available` entries of { player: 1–12 or \"default\", value: true / false / \"default\" }. Setting any number turns \"use default\" off for the type; useDefault: true puts it back on the game's values. Not undoable.", inputSchema: obj({ unit: { type: "string" }, useDefault: { type: "boolean" }, name: { type: "string" }, hitPoints: { type: "integer" }, shields: { type: "integer" }, armor: { type: "integer" }, buildTime: { type: "integer" }, mineralCost: { type: "integer" }, gasCost: { type: "integer" }, weapons: { type: "array", items: obj({ id: { type: "integer" }, damage: { type: "integer" }, bonus: { type: "integer" } }, ["id"]) }, available: { type: "array", items: obj({ player: { type: "string" }, value: { type: "string" } }, ["player", "value"]) } }, ["unit"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const id = unitIdByName(api, str(input.unit));
        if (id === null) return `No unit is called "${str(input.unit)}".`;
        const patch: Record<string, unknown> = {};
        for (const k of ["hitPoints", "shields", "armor", "buildTime", "mineralCost", "gasCost"]) if (input[k] !== undefined) patch[k] = Math.round(num(input[k]));
        if (input.useDefault !== undefined) patch.useDefault = bool(input.useDefault);
        if (typeof input.name === "string") patch.name = input.name;
        if (Array.isArray(input.weapons)) patch.weapons = list(input.weapons).map((w) => ({ id: Math.round(num(w.id)), ...(w.damage !== undefined ? { damage: Math.round(num(w.damage)) } : {}), ...(w.bonus !== undefined ? { bonus: Math.round(num(w.bonus)) } : {}) }));
        if (Array.isArray(input.available)) {
          patch.available = list(input.available).map((a) => { const player = slotOf(a.player); const v = typeof a.value === "string" && /default/i.test(a.value) ? "default" : bool(a.value); return player === null || v === undefined ? null : { player, value: v }; }).filter((x) => x !== null);
        }
        let changed = false;
        api.document.update(`AI: unit settings ${api.names.unit(id)}`, (tx) => { changed = tx.unitTypes.set(id, patch as never); });
        const t = api.settings.unitType(id);
        return capResult({ changed, now: t ? { name: t.name, useDefault: t.useDefault, hitPoints: t.hitPoints, shields: t.shields, armor: t.armor, buildTime: t.buildTime, mineralCost: t.mineralCost, gasCost: t.gasCost, weapons: t.weapons, availability: t.availability } : null });
      },
    },
    {
      def: { name: "set_upgrade", description: "Upgrade Settings for one upgrade: mineralCost / gasCost / timeCost (frames) and their per-level factors, and levels — entries of { player: 1–12 or \"default\", start, max, useDefault } for each player's starting and maximum level. Setting a cost turns \"use default\" off; useDefault: true restores the game's. Not undoable.", inputSchema: obj({ upgrade: { type: "string" }, useDefault: { type: "boolean" }, mineralCost: { type: "integer" }, mineralFactor: { type: "integer" }, gasCost: { type: "integer" }, gasFactor: { type: "integer" }, timeCost: { type: "integer" }, timeFactor: { type: "integer" }, levels: { type: "array", items: obj({ player: { type: "string" }, start: { type: "integer" }, max: { type: "integer" }, useDefault: { type: "boolean" } }, ["player"]) } }, ["upgrade"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const id = upgradeIdByName(api, str(input.upgrade));
        if (id === null) return `No upgrade is called "${str(input.upgrade)}".`;
        const patch: Record<string, unknown> = {};
        for (const k of ["mineralCost", "mineralFactor", "gasCost", "gasFactor", "timeCost", "timeFactor"]) if (input[k] !== undefined) patch[k] = Math.round(num(input[k]));
        if (input.useDefault !== undefined) patch.useDefault = bool(input.useDefault);
        if (Array.isArray(input.levels)) patch.levels = list(input.levels).map((l) => { const player = slotOf(l.player); return player === null ? null : { player, ...(l.start !== undefined ? { start: Math.round(num(l.start)) } : {}), ...(l.max !== undefined ? { max: Math.round(num(l.max)) } : {}), ...(bool(l.useDefault) ? { useDefault: true } : {}) }; }).filter((x) => x !== null);
        let changed = false;
        api.document.update(`AI: upgrade ${api.names.upgrade(id)}`, (tx) => { changed = tx.upgrades.set(id, patch as never); });
        return capResult({ changed, now: api.settings.upgrade(id) });
      },
    },
    {
      def: { name: "set_tech", description: "Technology Settings for one technology: mineralCost / gasCost / researchTime (frames) / energyCost, and state — entries of { player: 1–12 or \"default\", available, researched, useDefault }. Setting a cost turns \"use default\" off; useDefault: true restores the game's. Not undoable.", inputSchema: obj({ tech: { type: "string" }, useDefault: { type: "boolean" }, mineralCost: { type: "integer" }, gasCost: { type: "integer" }, researchTime: { type: "integer" }, energyCost: { type: "integer" }, state: { type: "array", items: obj({ player: { type: "string" }, available: { type: "boolean" }, researched: { type: "boolean" }, useDefault: { type: "boolean" } }, ["player"]) } }, ["tech"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const id = techIdByName(api, str(input.tech));
        if (id === null) return `No technology is called "${str(input.tech)}".`;
        const patch: Record<string, unknown> = {};
        for (const k of ["mineralCost", "gasCost", "researchTime", "energyCost"]) if (input[k] !== undefined) patch[k] = Math.round(num(input[k]));
        if (input.useDefault !== undefined) patch.useDefault = bool(input.useDefault);
        if (Array.isArray(input.state)) patch.state = list(input.state).map((s) => { const player = slotOf(s.player); return player === null ? null : { player, ...(bool(s.available) !== undefined ? { available: bool(s.available) } : {}), ...(bool(s.researched) !== undefined ? { researched: bool(s.researched) } : {}), ...(bool(s.useDefault) ? { useDefault: true } : {}) }; }).filter((x) => x !== null);
        let changed = false;
        api.document.update(`AI: technology ${api.names.tech(id)}`, (tx) => { changed = tx.techs.set(id, patch as never); });
        return capResult({ changed, now: api.settings.tech(id) });
      },
    },
    {
      def: { name: "set_map_version", description: "Scenario ▸ Map Revision: \"original\" (StarCraft 1.00, .scm), \"hybrid\" (1.04, .scm), \"broodwar\" (.scx) or \"remastered\" (.scx, wide string table). Ask before changing it. Not undoable.", inputSchema: obj({ version: { type: "string", enum: ["original", "hybrid", "broodwar", "remastered"] } }, ["version"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const v = str(input.version) as "original" | "hybrid" | "broodwar" | "remastered";
        if (!["original", "hybrid", "broodwar", "remastered"].includes(v)) return "Unknown version.";
        const r = api.document.update("AI: map revision", (tx) => { tx.setVersion(v); });
        return r.changed ? `Now ${api.settings.version()?.label}. Sections touched: ${r.sections.join(", ")}.` : "Already that revision.";
      },
    },
    {
      def: { name: "add_sound", description: "Add a WAV path to the sound table (the file itself must already be in the archive or be added through the Sound Editor). Not undoable.", inputSchema: obj({ path: { type: "string" } }, ["path"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => { let slot = -1; api.document.update("AI: sound", (tx) => { slot = tx.sounds.add(str(input.path)); }); return slot < 0 ? "No free sound slot." : `Sound slot ${slot}: ${api.settings.sounds().find((s) => s.slot === slot)?.path}. ${plural(api.settings.sounds().length, "sound")} listed.`; },
    },
  ];
}
