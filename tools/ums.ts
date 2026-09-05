/**
 * The assistant's way into the toolkit and the guides: `guide` reads a genre guide,
 * `ums_kinds` lists what the toolkit builds, `ums_build` builds one system into the
 * map's triggers. The same builders the Scenario workflow runs, so an assistant asked
 * "add kill to cash" and a design that lists it produce the same triggers.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { guideById, guideFor, guideIndex } from "../guides";
import { buildSystem, dcUnitsFrom, kindsText, ToolkitError, type Params, type ToolkitContext } from "../ums";
import { capResult, obj, str, type Tool } from "./common";

/** Who is human and who is computer on the open map, and which death-counter units and locations it has. */
export function toolkitContext(api: PluginApi, options: { hyper?: boolean; extraLocations?: string[] } = {}): ToolkitContext {
  const players = api.settings.players();
  const humans = players.filter((p) => /human/i.test(p.typeName)).map((p) => p.slot + 1);
  const computers = players.filter((p) => /computer/i.test(p.typeName)).map((p) => p.slot + 1);
  const hyper = options.hyper ?? api.triggers.list().some((t) => t.actions.filter((a) => a.type === api.consts.triggers.action.Wait && a.time <= 1).length >= 8);
  const locations = [...usedLocationNames(api), ...(options.extraLocations ?? [])];
  return { humans: humans.length ? humans : [1], computers, hyper, dcUnits: dcUnitsFrom(api.names.units().map((u) => u.label)), locations };
}

/** The names of the locations in use on the open map (a slot with an area or a name), Anywhere included. */
export function usedLocationNames(api: PluginApi): string[] {
  const scn = api.document.scenario();
  if (!scn) return [];
  const out: string[] = [];
  scn.locations.forEach((l, i) => { if (l.left !== l.right || l.top !== l.bottom || l.nameIndex > 0) out.push(api.names.location(i)); });
  return out;
}

/** Build a system and append its triggers to the map, in one settings transaction. */
export function addSystem(api: PluginApi, kind: string, params: Params, ctx: ToolkitContext, label = `AI: ${kind}`): { count: number; notes: string[] } {
  const built = buildSystem(kind, params, ctx);
  const parsed = api.triggers.text.parse(built.text, { briefing: false });
  api.document.update(label, (tx) => { for (const t of parsed) tx.triggers.add(t.trigger); });
  return { count: parsed.length, notes: built.notes };
}

export function umsTools(): Tool[] {
  return [
    {
      def: { name: "guide", description: "Read a genre guide before designing or judging a scenario: how a madness map, a defense, an RPG, a bound, a diplomacy map, an arena or a survival map is built, its players and forces, the trigger systems it runs on (by toolkit kind), and the pitfalls. `id` is one of the guides, or a free description of the map to pick the nearest; no id lists them. `basics` is death counters, hyper triggers, locations and the game's limits.", inputSchema: obj({ id: { type: "string" } }) },
      writes: false,
      run: (input) => {
        const id = str(input.id);
        if (!id) return `The guides:\n${guideIndex()}\n\nAsk for one by id, or describe the map.`;
        const g = guideById(id) ?? guideFor(id);
        return g ? g.text : `No guide matches "${id}". The guides:\n${guideIndex()}`;
      },
    },
    {
      def: { name: "ums_kinds", description: "The toolkit of trigger systems the editor builds by itself — hyper triggers, spawns, kill-to-cash, income, waves, lives, shops, heal, respawn, teleport, kill zones, leaderboards, countdowns, last standing, alliances — with each kind's parameters. Use ums_build for these instead of writing the triggers by hand.", inputSchema: obj({}) },
      writes: false,
      run: () => kindsText(),
    },
    {
      def: { name: "ums_build", description: "Build one trigger system from the toolkit (see ums_kinds) and append its triggers to the map. `params` are the kind's parameters as strings — a location or unit by name, a number as digits, a list comma-separated; `{p}` in a location name means the player number. Problems are reported and nothing is added. Not undoable.", inputSchema: obj({ kind: { type: "string" }, params: { type: "object", additionalProperties: { type: "string" } } }, ["kind"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const kind = str(input.kind);
        const raw = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {};
        const params: Params = {};
        for (const [k, v] of Object.entries(raw)) params[k] = Array.isArray(v) ? v.join(", ") : String(v);
        try {
          const r = addSystem(api, kind, params, toolkitContext(api));
          return capResult({ added: r.count, triggers: api.triggers.list().length, notes: r.notes });
        } catch (err) {
          if (err instanceof ToolkitError) return `Not built:\n${err.problems.map((p) => `- ${p}`).join("\n")}`;
          return `Not built: ${(err as Error).message}`;
        }
      },
    },
  ];
}
