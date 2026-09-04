/**
 * The reference block: what the assistant needs to know about *this* map's game data
 * that does not change from turn to turn — the tileset's terrains, the doodads, the
 * unit table with sizes and costs, upgrades and technologies, the trigger vocabulary
 * with every enumerated argument's labels, the text trigger format, and the script
 * language in short. The server caches it as a system block, so `gatherReference`
 * memoises per scenario object and `buildReference` is deterministic over its input.
 */
import type { PluginApi, Scenario } from "@scm-js/plugin-api";
import { scriptBridge } from "./script";

export interface ReferenceParts {
  mapName: string;
  width: number;
  height: number;
  tileset: string;
  versionLabel: string;
  terrains: { id: number; name: string; height: number; buildable: boolean }[];
  doodadCategories: { name: string; doodads: { id: number; name: string; width: number; height: number }[] }[];
  units: { id: number; name: string; race: string; width: number; height: number; building: boolean; flyer: boolean; hitPoints: number; shields: number; armor: number; minerals: number; gas: number; buildTime: number; weapons: string }[];
  upgrades: { id: number; name: string }[];
  techs: { id: number; name: string }[];
  conditions: { name: string; args: { label: string; kind: string }[] }[];
  actions: { name: string; args: { label: string; kind: string }[] }[];
  briefingActions: { name: string; args: { label: string; kind: string }[] }[];
  choices: { kind: string; labels: string[] }[];
  aiScripts: string[];
  sprites: { label: string; count: number }[];
  hasScript: boolean;
}

const ENUM_KINDS = ["player", "comparison", "modifier", "unitState", "order", "alliance", "resource", "score", "switchState", "switchAction", "textFlags"] as const;

export function gatherReference(api: PluginApi): ReferenceParts {
  const info = api.document.info();
  const defs = api.triggers.defs;
  const races: Record<string, string> = { zerg: "Z", terran: "T", protoss: "P" };
  const units: ReferenceParts["units"] = [];
  for (const t of api.settings.unitTypes()) {
    const size = api.palette.unitSize(t.id);
    const d = t.defaults ?? t;
    units.push({
      id: t.id, name: t.customName ? `${t.name} [${api.names.unit(t.id)}]` : t.name, race: races[String(api.data.race(t.id)).toLowerCase()] ?? "-",
      width: size.width, height: size.height, building: size.building, flyer: size.flyer,
      hitPoints: d.hitPoints, shields: d.shields, armor: d.armor, minerals: d.mineralCost, gas: d.gasCost, buildTime: d.buildTime,
      weapons: d.weapons.map((w) => `${w.name} ${w.damage}${w.bonus ? `+${w.bonus}` : ""}`).join("; "),
    });
  }
  const sig = (name: string, args: { label: string; kind: string }[]) => ({ name, args: args.map((a) => ({ label: a.label, kind: a.kind })) });
  return {
    mapName: info?.name ?? "",
    width: info?.width ?? 0,
    height: info?.height ?? 0,
    tileset: api.tileset.name(),
    versionLabel: api.settings.version()?.label ?? "",
    terrains: api.terrain.types().map((t) => ({ id: t.id, name: t.name, height: t.height, buildable: t.buildable })),
    doodadCategories: api.palette.doodadCategories().map((c) => ({ name: c.name, doodads: c.doodads.map((d) => ({ id: d.id, name: d.name, width: d.width, height: d.height })) })),
    units,
    upgrades: api.names.upgrades().map((u) => ({ id: u.value, name: u.label })),
    techs: api.names.techs().map((t) => ({ id: t.value, name: t.label })),
    conditions: defs.conditions().map((c) => sig(c.name, c.args)),
    actions: defs.actions(false).map((a) => sig(a.name, a.args)),
    briefingActions: defs.actions(true).map((a) => sig(a.name, a.args)),
    choices: ENUM_KINDS.map((kind) => ({ kind, labels: defs.choices(kind).map((c) => c.label) })),
    aiScripts: defs.choices("aiScript").map((c) => c.label),
    sprites: api.palette.spriteGroups().map((g) => ({ label: g.label, count: g.ids.length })),
    hasScript: !!scriptBridge(api)?.state()?.source,
  };
}

const TEXT_FORMAT = `Trigger("Player 1", "Force 2"){
Conditions:
  Bring("Current Player", "Any unit", "Beacon Alpha", At least, 1);
  Switch("Switch 3", set);
Actions:
  Display Text Message(Always Display, "You found it!");
  Create Unit(1, "Zerg Zergling", 4, "Spawn", "Player 2");
  Set Deaths("Player 1", "Terran Marine", Add, 5);
  ; Set Switch("Switch 3", clear);
  Preserve Trigger();
}`;

const SCRIPT_SHORT = `const beacon = Bring(CurrentPlayer, Units.AnyUnit, Locations["Beacon Alpha"], "At least", 1);
trigger([P1, Players.Force2], [beacon], [DisplayText("Always Display", "You found it!"), PreserveTrigger()], ["Preserve"]);

let wave = 0;                       // a death counter
while (true) {                       // structured code compiles to death-counter triggers
  if (Bring(P1, Units.AnyUnit, Locations.Beacon, ">=", 1)) { CreateUnit(P2, Units.ZergZergling, 4, Locations.Spawn); wave += 1; }
  if (wave >= 10) Defeat();
  Wait(2000);
}`;

/** The block, as Markdown-ish plain text. Deterministic over its input. */
export function buildReference(p: ReferenceParts): string {
  const out: string[] = [];
  out.push(`# Reference for "${p.mapName || "this map"}" — ${p.width} × ${p.height} tiles, tileset ${p.tileset}, ${p.versionLabel}`);
  out.push("");
  out.push("## Conventions");
  out.push("- Tools take tile coordinates (x right, y down, 0-based) and tile rects x0,y0 inclusive to x1,y1 exclusive. A unit's position is its centre.");
  out.push("- Players in tools are 1–8; 12 is Neutral (resources, critters). Settings tools also take \"default\" for a table's default column.");
  out.push("- Names are the editor's: units and terrains as listed below, locations and switches as the map names them. Ids are accepted where names are.");
  out.push("- Every writing tool is one undo step (settings changes are transactions outside undo). Prefer one tool call per thing asked for, several calls per turn when they are independent.");
  out.push("");
  out.push("## Terrains of this tileset (paint_terrain ids; height 0 low, 1 mid, 2 high)");
  for (const t of p.terrains) out.push(`- ${t.id}: ${t.name} — height ${t.height}${t.buildable ? ", buildable" : ", not buildable"}`);
  out.push("");
  out.push("## Doodads (place_doodads takes a name or id; scatter_doodads takes a category)");
  for (const c of p.doodadCategories) {
    const names = c.doodads.slice(0, 60).map((d) => `${d.name} ${d.width}×${d.height}`);
    out.push(`- ${c.name} (${c.doodads.length}): ${names.join(", ")}${c.doodads.length > 60 ? ", …" : ""}`);
  }
  if (p.sprites.length) out.push(`- Pure sprites (place_sprites kind "pure"): ${p.sprites.map((g) => `${g.label} (${g.count})`).join(", ")}`);
  out.push("");
  out.push("## Units (id: name | race | size in tiles | kind | hp/shields/armor | minerals/gas | build frames | weapons). units.dat values; unit_type shows the map's own.");
  for (const u of p.units) {
    const kind = u.building ? "building" : u.flyer ? "flyer" : "ground";
    out.push(`${u.id}: ${u.name} | ${u.race} | ${u.width}×${u.height} | ${kind} | ${u.hitPoints}/${u.shields}/${u.armor} | ${u.minerals}/${u.gas} | ${u.buildTime}${u.weapons ? ` | ${u.weapons}` : ""}`);
  }
  out.push("");
  out.push("## Upgrades (set_upgrade)");
  out.push(p.upgrades.map((u) => `${u.id} ${u.name}`).join("; "));
  out.push("");
  out.push("## Technologies (set_tech)");
  out.push(p.techs.map((t) => `${t.id} ${t.name}`).join("; "));
  out.push("");
  out.push("## Trigger conditions (name(argument: kind, …))");
  for (const c of p.conditions) out.push(`- ${c.name}(${c.args.map((a) => `${a.label}: ${a.kind}`).join(", ")})`);
  out.push("");
  out.push("## Trigger actions");
  for (const a of p.actions) out.push(`- ${a.name}(${a.args.map((x) => `${x.label}: ${x.kind}`).join(", ")})`);
  out.push("");
  out.push("## Briefing actions");
  for (const a of p.briefingActions) out.push(`- ${a.name}(${a.args.map((x) => `${x.label}: ${x.kind}`).join(", ")})`);
  out.push("");
  out.push("## Argument values by kind");
  for (const c of p.choices) if (c.labels.length) out.push(`- ${c.kind}: ${c.labels.join(", ")}`);
  out.push("- unit: a unit name from the table above, or the groups Any unit, Men, Buildings, Factories");
  out.push("- location: a location name of this map (list_locations); switch: a switch name or \"Switch N\" (1-based); text / wav: a string; number / amount / count / duration / percent: an integer (duration in milliseconds, 1000 per second at Fastest is about 24 frames)");
  if (p.aiScripts.length) { out.push(""); out.push(`## AI scripts (Run AI Script): ${p.aiScripts.join("; ")}`); }
  out.push("");
  out.push("## Text trigger format (list_triggers_text, add_triggers_text, replace_trigger)");
  out.push("One Trigger block per trigger: the players it runs for in the header, conditions and actions one per line ending in a semicolon, names in double quotes, enumerated values bare. A leading `;` disables a line. Example:");
  out.push("```");
  out.push(TEXT_FORMAT);
  out.push("```");
  out.push("");
  out.push("## Trigger script (compile_script, build_script)");
  out.push(`A TypeScript subset. Read script_declarations once for this map's names (Units.*, Locations.*, Switches.*, Players.*, every condition and action as a function). Raw triggers are trigger(players, conditions, actions, flags?); any other top-level code (let, if, while, functions) is lowered to death-counter triggers. Every argument must be a compile-time constant; there is no Math and no arrays beyond literals. ${p.hasScript ? "This map already has a script: build_script replaces its block, so send the whole script back with your changes." : "This map has no script yet."}`);
  out.push("```ts");
  out.push(SCRIPT_SHORT);
  out.push("```");
  return out.join("\n");
}

const cache = new WeakMap<Scenario, { tileset: string; text: string }>();

/** The block for the open map, built once per scenario object and tileset. */
export function referenceFor(api: PluginApi): string | undefined {
  const scn = api.document.scenario();
  if (!scn) return undefined;
  const tileset = api.tileset.name();
  const hit = cache.get(scn);
  if (hit && hit.tileset === tileset) return hit.text;
  const text = buildReference(gatherReference(api));
  cache.set(scn, { tileset, text });
  return text;
}
