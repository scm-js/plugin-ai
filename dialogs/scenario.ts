/**
 * Tools ▸ AI ▸ Make Scenario…: "a madness map", "an RPG about a marine lost on a Zerg
 * world" — a whole scenario from a sentence, in steps the person can see and stop:
 *
 * 1. **Design.** The `ums-design` recipe writes the design document — genre, premise,
 *    players and forces, the trigger systems (by toolkit kind), the layout brief, the
 *    objectives and the briefing — once, at high effort, with the genre guide and the
 *    toolkit's catalogue in front of it. The document is shown and can be edited.
 * 2. **Build**, step by step, each step a row that runs, passes or fails on its own: the
 *    map (new or the open one); the terrain and the named locations through `map-plan`
 *    and the plan renderer; players and forces; every system — the toolkit's kinds
 *    instantly, `custom` ones through the `triggers` recipe with the compile loop; the
 *    objectives and the briefing; the name; Check Map.
 * 3. Review it, or hand it to the assistant to iterate.
 *
 * The model's effort is spent where it counts (the design, the layout, the custom
 * triggers) and the mechanics every scenario shares come from code, so a build is a few
 * calls rather than a long conversation — and what it did is a list, not a transcript.
 */
import type { TilesetId } from "@scm-js/plugin-api";
import type { DesignSystem, MapPlanInput, UmsDesign, UmsDesignInput } from "../protocol";
import { doodadCategoryNames, terrainVocab, unitNames } from "../facts";
import { guideFor } from "../guides";
import { START_LOCATION, TILE, centreOf } from "../layout";
import { renderPlan, summarizeRender } from "../render";
import { hasScriptPlugin, scriptBridge, type CompileResult } from "../script";
import { toolkitContext, addSystem } from "../tools/ums";
import { paramsOf, systemKinds, ToolkitError } from "../ums";
import { chips, h, ledgerLine, noteList, Runner, runRecipe, styled, textarea, type Ctx } from "../ui";
import { cellSizeFor } from "./generate";
import { openReview } from "./review";

const SIZES = [64, 96, 128, 160, 192, 256];
const TILESETS: { id: string; label: string }[] = [
  { id: "badlands", label: "Badlands" }, { id: "platform", label: "Space Platform" }, { id: "install", label: "Installation" }, { id: "ashworld", label: "Ashworld" },
  { id: "jungle", label: "Jungle" }, { id: "desert", label: "Desert" }, { id: "ice", label: "Ice" }, { id: "twilight", label: "Twilight" },
];
const EXAMPLES: Record<string, string> = {
  "a madness map": "A four-player madness map: each player in a walled corner base, zerglings and marines spawning every few seconds and charging the centre, kills paid in minerals, last base standing wins.",
  "an RPG": "An RPG about a marine lost on a Zerg world: a town with a shop and a healer, three regions of rising danger joined by narrow paths, a brood mother at the end. Two players, permadeath off.",
  "a tower defense": "A two-lane tower defense for up to four players: waves walk from the north spawns down the lanes to the goal at the south; players build turrets beside the lanes; twenty waves, shared lives.",
};
const REPAIR_ROUNDS = 2;

type StepState = "pending" | "running" | "done" | "failed" | "skipped";

interface Step {
  label: string;
  run: () => Promise<string>;
}

/** The `map-plan` prompt a design's layout brief becomes: the brief, then every location the systems need, then the scenario rule. */
export function layoutPrompt(design: UmsDesign): string {
  const lines = [design.layoutBrief.trim(), ""];
  if (design.locations.length) {
    lines.push("Locations to create, by name (the triggers refer to them — every one must be in the plan's `locations`):");
    for (const l of design.locations) lines.push(`- ${l.name}: ${l.purpose}`);
    lines.push("");
  }
  const humans = design.players.filter((p) => p.type === "human");
  lines.push(`This is a scenario (UMS), genre ${design.genre}: follow the brief rather than the melee rules. ${humans.length} human player${humans.length === 1 ? "" : "s"} (${humans.map((p) => `player ${p.slot}`).join(", ")}), each needing a start location where the brief puts it; no mining bases unless the brief asks for them.`);
  return lines.join("\n");
}

/** `key=value; key=value` for the editable field, and back. */
export function paramsToText(params: { key: string; value: string }[]): string {
  return params.map((p) => `${p.key}=${p.value}`).join("; ");
}
export function textToParams(text: string): { key: string; value: string }[] {
  return text.split(";").map((s) => s.trim()).filter(Boolean).map((s) => { const at = s.indexOf("="); return at < 0 ? { key: s, value: "" } : { key: s.slice(0, at).trim(), value: s.slice(at + 1).trim() }; });
}

export function openScenario(ctx: Ctx, presetPrompt?: string) {
  const { api } = ctx;
  const w = api.ui.widgets;
  const info = api.document.info();
  const state = {
    prompt: presetPrompt ?? "",
    width: info?.width ?? 128,
    height: info?.height ?? 128,
    tileset: (info?.tileset as string | undefined) ?? "jungle",
    players: 4,
    target: (info ? "open" : "new") as "new" | "open",
    design: null as UmsDesign | null,
    refine: "",
    built: false,
  };

  api.ui.dialog({
    title: "Make Scenario",
    size: "lg",
    tall: true,
    mount(body, dialog) {
      const root = styled(body);
      const runner = new Runner(ctx);

      /* ── 1. what to make ── */
      const promptField = textarea({ value: state.prompt, placeholder: "What kind of scenario? A genre and a sentence of story is enough: \"a madness map\", \"an RPG about a lost marine\", \"a four-player tower defense with two lanes\".", rows: 3 });
      promptField.addEventListener("input", () => { state.prompt = promptField.value; });
      const widthSel = w.select(SIZES.map((s) => ({ value: s, label: String(s) })), { value: state.width, onChange: (v) => { state.width = Number(v); syncTarget(); } });
      const heightSel = w.select(SIZES.map((s) => ({ value: s, label: String(s) })), { value: state.height, onChange: (v) => { state.height = Number(v); syncTarget(); } });
      const tilesetSel = w.select(TILESETS.map((t) => ({ value: t.id, label: t.label })), { value: state.tileset, onChange: (v) => { state.tileset = v; syncTarget(); } });
      const playersSel = w.select([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: String(n) })), { value: state.players, onChange: (v) => { state.players = Number(v); } });
      const targetSel = w.select([{ value: "new", label: "A new map" }, { value: "open", label: "The open map" }], { value: state.target, onChange: (v) => { state.target = v as "new" | "open"; } });
      const targetHint = h("div", { className: "ai-hint" });
      const syncTarget = () => {
        const cur = api.document.info();
        const same = !!cur && cur.width === state.width && cur.height === state.height && cur.tileset === state.tileset;
        (targetSel.options[1] as HTMLOptionElement).disabled = !same;
        if (!same && state.target === "open") { state.target = "new"; targetSel.value = "new"; }
        targetHint.textContent = same
          ? "Into the open map: its terrain and objects are replaced by the plan, and the triggers are appended to what is there."
          : "A new blank map of this size and tileset is made first. An open map with unsaved changes asks before it goes.";
      };
      syncTarget();
      const designButton = w.button("Design", { primary: true, onClick: () => void design(false) });
      const scriptNote = h("div", { className: "ai-hint" }, hasScriptPlugin(api) ? "The Trigger Script plugin is on: systems the toolkit cannot build are written as scripts." : "The Trigger Script plugin is off: the design will use only the toolkit's systems (hyper triggers, spawns, kill-to-cash, waves, lives, shops, …). Turn it on under Plugins ▸ Manage Plugins… for custom mechanics.");

      /* ── 2. the design ── */
      const designBox = h("div", { hidden: true });
      const refineField = textarea({ placeholder: "What should change in the design? (\"make it two players\", \"add a boss\", \"less income\")", rows: 2 });
      refineField.addEventListener("input", () => { state.refine = refineField.value; });
      const redesignButton = w.button("Design again", { onClick: () => void design(true) });
      const buildButton = w.button("Build", { primary: true, onClick: () => void build() });

      const showDesign = (d: UmsDesign) => {
        designBox.replaceChildren();
        const nameField = w.text({ value: d.name, onChange: (v) => { d.name = v; } });
        const descField = textarea({ value: d.description, rows: 2 });
        descField.addEventListener("input", () => { d.description = descField.value; });
        const briefField = textarea({ value: d.layoutBrief, rows: 6 });
        briefField.addEventListener("input", () => { d.layoutBrief = briefField.value; });
        const objectivesField = textarea({ value: d.objectives, rows: 3 });
        objectivesField.addEventListener("input", () => { d.objectives = objectivesField.value; });
        const briefingField = textarea({ value: d.briefing.join("\n"), rows: 4 });
        briefingField.addEventListener("input", () => { d.briefing = briefingField.value.split("\n").map((s) => s.trim()).filter(Boolean); });
        const players = noteList(d.players.map((p) => `Player ${p.slot}: ${p.type}, ${p.race}, force ${p.force} — ${p.role}`));
        const forces = noteList(d.forces.map((f) => `Force ${f.index} "${f.name}"${f.allied ? ", allied" : ""}${f.alliedVictory ? ", allied victory" : ""}${f.sharedVision ? ", shared vision" : ""}`));
        const locations = noteList(d.locations.map((l) => `${l.name} — ${l.purpose}`));
        const systemRows = h("div", { className: "ai-list" });
        const kinds = new Set(systemKinds().map((k) => k.kind));
        d.systems.forEach((s, i) => {
          const params = w.text({ value: paramsToText(s.params), placeholder: "key=value; key=value", onChange: (v) => { s.params = textToParams(v); } });
          const remove = w.button("Remove", { ghost: true, onClick: () => { d.systems.splice(i, 1); showDesign(d); } });
          systemRows.append(h("div", { className: "ai-item" },
            h("span", { className: kinds.has(s.kind) ? "ai-ok" : s.kind === "custom" ? "ai-gold" : "ai-bad", style: "width: 96px; flex: none;", title: kinds.has(s.kind) ? "built by the toolkit" : s.kind === "custom" ? "written as a trigger script" : "not a kind the toolkit has" }, s.kind),
            h("div", { className: "ai-grow" }, h("div", null, s.name), h("div", { className: "ai-dim" }, s.description), s.kind === "custom" ? null : params),
            remove,
          ));
        });
        const parts: (HTMLElement | null)[] = [
          w.group(`${d.genre}: ${d.name}`,
            w.form([{ label: "Name", field: nameField }, { label: "Description", field: descField }]),
            h("div", { className: "ai-hint" }, d.premise),
          ),
          w.group("Players and forces", players, forces),
          w.group(`Systems (${d.systems.length})`, systemRows, h("div", { className: "ai-hint" }, "Green: the toolkit builds it from the parameters. Gold: written as a trigger script from the description. Edit the parameters here; a location or unit by name, numbers as digits.")),
          w.group(`Layout brief and ${d.locations.length} locations`, briefField, h("details", null, h("summary", null, "Locations the brief must place"), h("div", { className: "ai-body" }, locations))),
          w.group("Objectives and briefing", objectivesField, briefingField),
          d.notes.length ? h("details", null, h("summary", null, "Designer's notes"), h("div", { className: "ai-body" }, noteList(d.notes))) : null,
          h("div", { className: "ai-btns" }, buildButton, refineField, redesignButton),
        ];
        for (const part of parts) if (part) designBox.append(part);
        designBox.hidden = false;
      };

      /* ── 3. building ── */
      const stepsBox = h("div", { className: "ai-steps", hidden: true });
      const afterBox = h("div", { className: "ai-btns", hidden: true });
      const findingsBox = h("div", null);
      const addStep = (label: string) => {
        const mark = h("span", { className: "ai-step-mark" }, "○");
        const detail = h("span", { className: "ai-dim" }, "");
        const row = h("div", { className: "ai-step is-pending" }, mark, h("span", { className: "ai-grow" }, label), detail);
        stepsBox.append(row);
        return {
          set(s: StepState, text = "") {
            row.className = `ai-step is-${s}`;
            mark.className = s === "running" ? "ai-step-mark ai-spin" : "ai-step-mark";
            mark.textContent = s === "running" ? "" : s === "done" ? "✓" : s === "failed" ? "✗" : s === "skipped" ? "–" : "○";
            detail.textContent = text;
            detail.title = text;
          },
        };
      };

      const ensureMap = async (): Promise<boolean> => {
        if (state.target === "open" && api.document.isOpen()) return true;
        const ok = await api.document.create({ width: state.width, height: state.height, tileset: state.tileset as TilesetId, name: "Untitled Scenario" });
        if (!ok) { runner.idle("Kept the open map."); return false; }
        state.target = "open";
        targetSel.value = "open";
        syncTarget();
        return true;
      };

      const design = async (refine: boolean) => {
        if (!state.prompt.trim()) { promptField.focus(); runner.idle("Say what kind of scenario you want first."); return; }
        if (!(await ensureMap())) return;
        await api.tileset.load();
        const prompt = refine && state.refine.trim() && state.design
          ? `${state.prompt}\n\nThe previous design was:\n${JSON.stringify(state.design)}\n\nChange this: ${state.refine.trim()}`
          : state.prompt;
        const input: UmsDesignInput = {
          prompt,
          width: api.document.info()!.width,
          height: api.document.info()!.height,
          tileset: api.document.info()!.tileset,
          players: state.players,
          terrains: terrainVocab(api),
          unitNames: unitNames(api),
          systemKinds: systemKinds(),
          scriptPlugin: hasScriptPlugin(api),
          guide: guideFor(state.prompt)?.text,
        };
        designButton.disabled = true;
        redesignButton.disabled = true;
        try {
          const r = await runRecipe(ctx, runner, "ums-design", input);
          if (!r) return;
          state.design = r.output;
          state.built = false;
          stepsBox.hidden = true;
          afterBox.hidden = true;
          findingsBox.replaceChildren();
          showDesign(r.output);
          designBox.scrollIntoView({ block: "nearest" });
        } finally {
          designButton.disabled = false;
          redesignButton.disabled = false;
        }
      };

      /** Write one custom system as a trigger script: the recipe, the compile loop, the build (extending the map's script). */
      const writeCustom = async (system: DesignSystem, d: UmsDesign): Promise<string> => {
        const bridge = scriptBridge(api);
        if (!bridge) throw new Error("the Trigger Script plugin is off");
        const existing = bridge.state();
        const prompt = `System "${system.name}" of the scenario "${d.name}" (${d.genre}). ${system.description}\n\nThe scenario's premise: ${d.premise}\nLocations on the map: ${d.locations.map((l) => `${l.name} (${l.purpose})`).join("; ")}.\nHyper triggers ${d.systems.some((s) => s.kind === "hyper") ? "are" : "are not"} on the map. Write only this system; the other systems already exist as ordinary triggers.`;
        const hand = api.triggers.list().filter((_, i) => !(existing?.block && i >= existing.block.start && i < existing.block.start + existing.block.count));
        const input = { prompt, declarations: bridge.declarations(), script: existing?.source ?? undefined, existingTriggers: hand.length > 0 ? api.triggers.text.print(hand).slice(0, 30_000) : undefined };
        let r = await runRecipe(ctx, runner, "triggers", input);
        if (!r) throw new Error("the model did not answer");
        let script = r.output.script;
        let compiled: CompileResult = await bridge.compile(script);
        for (let round = 0; !compiled.ok && round < REPAIR_ROUNDS; round++) {
          r = await runRecipe(ctx, runner, "triggers", { ...input, repair: { script, diagnostics: compiled.diagnostics.map((x) => ({ line: x.line, column: x.column, message: x.message })) } });
          if (!r) throw new Error("the model did not answer the repair");
          script = r.output.script;
          compiled = await bridge.compile(script);
        }
        if (!compiled.ok) throw new Error(`the script has ${compiled.diagnostics.length} error${compiled.diagnostics.length === 1 ? "" : "s"} after ${REPAIR_ROUNDS} repairs; open the Script Editor to fix it`);
        const built = await bridge.build(script, {});
        if (!built.block) throw new Error("the build failed");
        return `${built.block.count} triggers from a script: ${r.output.summary}`;
      };

      const build = async () => {
        const d = state.design;
        if (!d || !(await ensureMap())) return;
        await api.tileset.load();
        buildButton.disabled = true;
        redesignButton.disabled = true;
        stepsBox.replaceChildren();
        stepsBox.hidden = false;
        afterBox.hidden = true;
        findingsBox.replaceChildren();
        const findings: string[] = [];
        const cur = api.document.info()!;
        const humans = d.players.filter((p) => p.type === "human").map((p) => p.slot);
        const hyper = d.systems.some((s) => s.kind === "hyper");
        const locationNames = d.locations.map((l) => l.name);
        const kinds = new Set(systemKinds().map((k) => k.kind));

        const steps: Step[] = [];
        steps.push({
          label: "Terrain and locations",
          run: async () => {
            const input: MapPlanInput = {
              prompt: layoutPrompt(d), width: cur.width, height: cur.height, tileset: cur.tileset,
              terrains: terrainVocab(api), doodadCategories: doodadCategoryNames(api), unitNames: unitNames(api),
              players: Math.max(1, humans.length), symmetry: ["madness", "arena", "diplomacy"].includes(d.genre) ? "auto" : "none", cellSize: cellSizeFor(cur.width, cur.height),
            };
            const r = await runRecipe(ctx, runner, "map-plan", input);
            if (!r) throw new Error("no plan came back");
            const rendered = renderPlan(api, r.output, { originX: 0, originY: 0, label: `AI: ${d.name} terrain`, clearArea: true });
            if (!rendered) throw new Error("the plan could not be rendered");
            findings.push(...rendered.findings.filter((f) => !f.startsWith("Check Map:")));
            // A location the design needs that the plan did not make is put at the centre, named, and reported — the systems still build.
            const have = new Set(api.document.scenario()!.locations.map((_, i) => api.names.location(i).toLowerCase()));
            const missing = locationNames.filter((n) => !have.has(n.toLowerCase()));
            if (missing.length) {
              api.document.edit("AI: missing locations", (tx) => {
                missing.forEach((name, i) => {
                  const cx = Math.floor(cur.width / 2) + (i % 4) * 5 - 8, cy = Math.floor(cur.height / 2) + Math.floor(i / 4) * 5 - 8;
                  tx.addLocation({ left: cx * TILE, top: cy * TILE, right: (cx + 4) * TILE, bottom: (cy + 4) * TILE }, name);
                });
              });
              findings.push(`${missing.length} location${missing.length === 1 ? "" : "s"} the plan did not place (${missing.join(", ")}) were put near the centre as 4×4 boxes; move them where they belong`);
            }
            return summarizeRender(rendered);
          },
        });
        steps.push({
          label: "Players and forces",
          run: async () => {
            const typeOf = (label: string) => api.names.playerTypes().find((t) => t.label.toLowerCase() === label)?.value;
            const raceOf = (label: string) => api.names.races().find((r) => r.label.toLowerCase() === label)?.value;
            const races: Record<string, string> = { terran: "terran", zerg: "zerg", protoss: "protoss", random: "random", userSelect: "user selectable" };
            let changed = 0;
            api.document.update("AI: players and forces", (tx) => {
              for (let slot = 0; slot < 8; slot++) {
                const p = d.players.find((x) => x.slot === slot + 1);
                if (!p) { if (tx.players.set(slot, { type: typeOf("inactive") ?? 0 })) changed++; continue; }
                if (tx.players.set(slot, { type: typeOf(p.type) ?? 6, race: raceOf(races[p.race] ?? p.race) ?? 5, force: Math.max(0, Math.min(3, p.force - 1)) })) changed++;
              }
              for (const f of d.forces) {
                if (tx.forces.set(f.index - 1, { name: f.name, allied: f.allied, alliedVictory: f.alliedVictory, sharedVision: f.sharedVision })) changed++;
              }
            });
            // Every human needs a start location; one the plan did not place goes at a location named for the player, else spread near the centre.
            const starts = new Set(api.query.startLocations().map((s) => s.owner + 1));
            const missing = humans.filter((p) => !starts.has(p));
            if (missing.length) {
              const scn = api.document.scenario()!;
              api.document.edit("AI: start locations", (tx) => {
                missing.forEach((p, i) => {
                  const named = scn.locations.findIndex((l, li) => new RegExp(`\\b(start|spawn|base|home)\\s*${p}\\b`, "i").test(api.names.location(li)) && (l.left !== l.right));
                  const loc = named >= 0 ? scn.locations[named] : null;
                  const c = loc ? centreOf({ x: Math.floor(Math.min(loc.left, loc.right) / TILE), y: Math.floor(Math.min(loc.top, loc.bottom) / TILE), w: Math.max(1, Math.round(Math.abs(loc.right - loc.left) / TILE)), h: Math.max(1, Math.round(Math.abs(loc.bottom - loc.top) / TILE)) }) : { x: (Math.floor(cur.width / 2) + (i - missing.length / 2) * 6) * TILE, y: Math.floor(cur.height / 2) * TILE };
                  tx.placeUnit(START_LOCATION, p - 1, c.x, c.y);
                });
              });
              findings.push(`start locations for player${missing.length === 1 ? "" : "s"} ${missing.join(", ")} were placed by the editor; check where`);
            }
            return `${changed} setting${changed === 1 ? "" : "s"} written, ${humans.length} human player${humans.length === 1 ? "" : "s"}`;
          },
        });
        for (const s of d.systems) {
          steps.push({
            label: `${s.kind === "custom" ? "Script" : "System"}: ${s.name}`,
            run: async () => {
              if (s.kind === "custom") return writeCustom(s, d);
              if (!kinds.has(s.kind)) throw new Error(`the toolkit has no kind "${s.kind}"`);
              try {
                const r = addSystem(api, s.kind, paramsOf(s.params), toolkitContext(api, { hyper, extraLocations: locationNames }), `AI: ${s.name}`);
                findings.push(...r.notes.map((n) => `${s.name}: ${n}`));
                return `${r.count} trigger${r.count === 1 ? "" : "s"}`;
              } catch (err) {
                if (err instanceof ToolkitError) throw new Error(err.problems.join("; "));
                throw err;
              }
            },
          });
        }
        if (!d.systems.some((s) => s.kind === "objectives") && d.objectives.trim()) {
          steps.push({ label: "Objectives", run: async () => { const r = addSystem(api, "objectives", { text: d.objectives.replace(/\n/g, "\\n") }, toolkitContext(api, { hyper, extraLocations: locationNames }), "AI: objectives"); return `${r.count} trigger`; } });
        }
        if (d.briefing.length) {
          steps.push({
            label: "Mission briefing",
            run: async () => {
              const actions = api.names.actions(true);
              const typeOf = (label: string, fallback: number) => actions.find((a) => a.label.toLowerCase() === label)?.value ?? fallback;
              api.document.update("AI: mission briefing", (tx) => {
                const t = api.triggers.newTrigger(humans.map((p) => p - 1));
                t.actions = [];
                if (d.objectives.trim()) { const a = api.triggers.newAction(typeOf("mission objectives", 4), true); a.text = tx.strings.intern(d.objectives); t.actions.push(a); }
                for (const line of d.briefing) { const a = api.triggers.newAction(typeOf("text message", 3), true); a.text = tx.strings.intern(line); a.time = 8000; t.actions.push(a); }
                tx.briefing.set([t]);
              });
              return `${d.briefing.length} line${d.briefing.length === 1 ? "" : "s"}`;
            },
          });
        }
        steps.push({ label: "Name and description", run: async () => { api.document.update("AI: name and description", (tx) => { tx.properties({ name: d.name, description: d.description }); }); return d.name; } });
        steps.push({
          label: "Check Map",
          run: async () => {
            const issues = api.query.validate().filter((i) => i.level !== "info");
            for (const i of issues) findings.push(`Check Map: ${i.text}`);
            return issues.length ? `${issues.length} thing${issues.length === 1 ? "" : "s"} to look at` : "nothing wrong";
          },
        });

        const rows = steps.map((s) => addStep(s.label));
        let failed = 0;
        for (let i = 0; i < steps.length; i++) {
          rows[i].set("running");
          try {
            const text = await steps[i].run();
            rows[i].set("done", text);
          } catch (err) {
            failed++;
            rows[i].set("failed", (err as Error).message);
            findings.push(`${steps[i].label}: ${(err as Error).message}`);
            if (i === 0) { for (let j = 1; j < steps.length; j++) rows[j].set("skipped", "not run"); break; }
          }
        }
        state.built = true;
        buildButton.disabled = false;
        redesignButton.disabled = false;
        if (findings.length) findingsBox.replaceChildren(h("details", { open: failed > 0 }, h("summary", null, `${findings.length} thing${findings.length === 1 ? "" : "s"} to know`), h("div", { className: "ai-body" }, noteList(findings))));
        afterBox.replaceChildren(
          w.button("Review it…", { onClick: () => { dialog.close(); openReview(ctx); } }),
          w.button("Open the assistant", { onClick: () => { dialog.close(); api.commands.run("ai.ask", `I just built the scenario "${d.name}" (${d.genre}) from a design: ${d.systems.map((s) => s.name).join(", ")}. Look it over and tell me what to fix first.`); } }),
          h("span", { className: "ai-hint" }, failed ? `${failed} step${failed === 1 ? "" : "s"} failed; the rest went in. Every edit is an undo step, the settings and triggers are not.` : "Built. Every edit is an undo step; the settings and triggers are transactions outside undo, as in StarEdit."),
        );
        afterBox.hidden = false;
        runner.idle(failed ? `Built with ${failed} failed step${failed === 1 ? "" : "s"}.` : `Built ${d.name}.`);
        api.ui.status(`AI: built ${d.name}`);
      };

      root.append(
        w.group("What to make",
          promptField,
          chips(Object.keys(EXAMPLES), (label) => { promptField.value = EXAMPLES[label]; state.prompt = promptField.value; }),
          w.form([
            { label: "Size", field: h("div", { className: "ai-btns" }, widthSel, "×", heightSel) },
            { label: "Tileset", field: tilesetSel },
            { label: "Players", field: playersSel },
            { label: "Into", field: targetSel },
          ]),
          targetHint,
          scriptNote,
          h("div", { className: "ai-btns" }, designButton),
        ),
        runner.el,
        designBox,
        stepsBox,
        findingsBox,
        afterBox,
        ledgerLine(ctx),
      );
      promptField.focus();
      return () => { runner.dispose(); };
    },
    buttons: [{ label: "Close" }],
  });
}
