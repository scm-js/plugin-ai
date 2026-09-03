/** The trigger script, the view, the history and the selection. */
import { capResult, ints, num, obj, rectOf, str, TILE, type Tool } from "./common";
import { NO_SCRIPT_PLUGIN, scriptBridge } from "../script";

export function scriptTools(): Tool[] {
  return [
    {
      def: { name: "script_state", description: "The map's trigger script: whether there is one, its source, whether the built block is intact.", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => { const script = scriptBridge(api); if (!script) return NO_SCRIPT_PLUGIN; const s = script.state(); return s ? capResult({ hasScript: !!s.source, stale: s.stale, unbuilt: s.unbuilt, block: s.block, source: s.source }, 60_000) : "No map is open."; },
    },
    {
      def: { name: "script_declarations", description: "The script language's declarations for this map (a .d.ts): every unit, location, switch, player and every condition and action function. Long; read once before writing a script.", inputSchema: obj({}) },
      writes: false,
      run: (_i, { api }) => { const script = scriptBridge(api); if (!script) return NO_SCRIPT_PLUGIN; const d = script.declarations(); return d.length > 60_000 ? `${d.slice(0, 60_000)}\n… cut.` : d; },
    },
    {
      def: { name: "compile_script", description: "Type-check a trigger script (the Trigger Script plugin's TypeScript-subset language; read script_declarations first) without building it. Returns diagnostics or the trigger count.", inputSchema: obj({ source: { type: "string" } }, ["source"]) },
      writes: false,
      run: async (input, { api }) => {
        const script = scriptBridge(api);
        if (!script) return NO_SCRIPT_PLUGIN;
        const r = await script.compile(str(input.source));
        return r.ok ? `Compiles: ${r.triggers.length} triggers${r.program ? `, structured program of ${r.program.count}` : ""}.` : capResult({ errors: r.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`) });
      },
    },
    {
      def: { name: "build_script", description: "Compile a trigger script and, when it is clean, build it into the map (replacing the script's previous block; `takeOver` replaces every trigger — ask first). Stores the source with the map. Not undoable.", inputSchema: obj({ source: { type: "string" }, takeOver: { type: "boolean" } }, ["source"]) },
      writes: true,
      settings: true,
      run: async (input, { api }) => {
        const script = scriptBridge(api);
        if (!script) return NO_SCRIPT_PLUGIN;
        const r = await script.build(str(input.source), { takeOver: input.takeOver === true });
        return r.block ? `Built ${r.block.count} triggers at #${r.block.start + 1}.` : capResult({ errors: r.compiled.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`) });
      },
    },
    {
      def: { name: "undo", description: "Undo the last change (yours or the user's). Returns what was undone.", inputSchema: obj({}) },
      writes: true,
      run: (_i, { api }) => { const label = api.document.undo(); return label ? `Undid: ${label}.` : "Nothing to undo."; },
    },
    {
      def: { name: "redo", description: "Redo the last undone change. Returns what was redone.", inputSchema: obj({}) },
      writes: true,
      run: (_i, { api }) => { const label = api.document.redo(); return label ? `Redid: ${label}.` : "Nothing to redo."; },
    },
    {
      def: { name: "go_to", description: "Scroll the user's view to a tile, or to a unit / location by index.", inputSchema: obj({ x: { type: "integer" }, y: { type: "integer" }, unit: { type: "integer" }, location: { type: "integer" } }) },
      writes: false,
      run: (input, { api }) => {
        if (input.unit !== undefined) api.view.goTo({ kind: "unit", index: Math.round(num(input.unit)) });
        else if (input.location !== undefined) api.view.goTo({ kind: "location", index: Math.round(num(input.location)) });
        else api.view.goTo({ kind: "tile", x: Math.round(num(input.x)), y: Math.round(num(input.y)) });
        return "Done.";
      },
    },
    {
      def: { name: "select", description: "Show the user something: select units, sprites, doodads or locations by index (switching to that layer), or mark a tile rect. Pass an empty list to clear.", inputSchema: obj({ units: { type: "array", items: { type: "integer" } }, sprites: { type: "array", items: { type: "integer" } }, doodads: { type: "array", items: { type: "integer" } }, locations: { type: "array", items: { type: "integer" } }, x0: { type: "integer" }, y0: { type: "integer" }, x1: { type: "integer" }, y1: { type: "integer" } }) },
      writes: false,
      run: (input, { api }) => {
        const done: string[] = [];
        if (Array.isArray(input.units)) { api.selection.setLayer("units"); api.selection.setUnits(ints(input.units)); done.push(`${ints(input.units).length} units`); }
        if (Array.isArray(input.sprites)) { api.selection.setLayer("sprites"); api.selection.setSprites(ints(input.sprites)); done.push(`${ints(input.sprites).length} sprites`); }
        if (Array.isArray(input.doodads)) { api.selection.setLayer("doodads"); api.selection.setDoodads(ints(input.doodads)); done.push(`${ints(input.doodads).length} doodads`); }
        if (Array.isArray(input.locations)) { api.selection.setLayer("locations"); api.selection.setLocations(ints(input.locations)); done.push(`${ints(input.locations).length} locations`); }
        if (input.x0 !== undefined && input.x1 !== undefined) { const r = rectOf(input, api); api.selection.markArea(r); api.view.center((r.x0 + r.x1) / 2 * TILE, (r.y0 + r.y1) / 2 * TILE); done.push(`area ${r.x0},${r.y0}–${r.x1},${r.y1}`); }
        return done.length ? `Selected ${done.join(", ")}.` : "Nothing to select.";
      },
    },
  ];
}
