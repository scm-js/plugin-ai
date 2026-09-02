/**
 * Tools ▸ AI ▸ Generate Map…: a whole map from a prompt. The model returns a plan in
 * the layout language; the dialog shows it as a coloured grid with the designer's
 * notes and the bases, and Apply renders it onto a new map (made first, so the model
 * can be told which terrains the tileset has) or the open one when it is the same
 * size. Afterwards the same dialog refines: what to change, plus a picture of the
 * result and what the editor found wrong, go back to the model for a revised plan.
 */
import type { TilesetId } from "../plugin-api/plugins/api";
import type { MapPlan, MapPlanInput, SymmetryMode } from "../protocol";
import { SYMMETRY_MODES } from "../protocol";
import { doodadCategoryNames, imageInput, pixelsPerTileFor, terrainVocab, unitNames } from "../facts";
import { renderPlan, summarizeRender, type Rendered } from "../render";
import { chips, h, hex, ledgerLine, noteList, Runner, runRecipe, styled, textarea, type Ctx } from "../ui";
import { openReview } from "./review";

const SIZES = [64, 96, 128, 160, 192, 256];
const EXAMPLES = [
  "A two-player jungle map with mains on high ground in opposite corners, a natural below each with one ramp, and a wide open centre with two island expansions.",
  "Four players, rotational symmetry, a lake in the middle with four bridges, thirds along the edges, dense trees around the mains.",
  "A tight two-player badlands map: narrow chokes, three tiers of height, a contested gold expansion in the centre.",
];

const TILESETS: { id: string; label: string }[] = [
  { id: "badlands", label: "Badlands" }, { id: "platform", label: "Space Platform" }, { id: "install", label: "Installation" }, { id: "ashworld", label: "Ashworld" },
  { id: "jungle", label: "Jungle" }, { id: "desert", label: "Desert" }, { id: "ice", label: "Ice" }, { id: "twilight", label: "Twilight" },
];

const SYMMETRY_LABELS: Record<SymmetryMode | "auto", string> = {
  auto: "Let the model choose", none: "None", "mirror-x": "Mirror left ↔ right", "mirror-y": "Mirror top ↔ bottom", rot180: "Rotate 180°",
  rot90: "Rotate 90° (square)", diag: "Diagonal mirror (square)", antidiag: "Other diagonal (square)", quad: "Mirror both ways", octo: "Eight-fold (square)",
};

/** Tiles per cell for a map: 32-ish cells along the longer side. */
export function cellSizeFor(width: number, height: number): number {
  return Math.max(2, Math.round(Math.max(width, height) / 32));
}

export function openGenerate(ctx: Ctx) {
  const { api } = ctx;
  const w = api.ui.widgets;
  const info = api.document.info();
  const state = {
    prompt: "",
    width: info?.width ?? 128,
    height: info?.height ?? 128,
    tileset: (info?.tileset as string | undefined) ?? "jungle",
    players: 2,
    symmetry: "auto" as SymmetryMode | "auto",
    target: (info ? "open" : "new") as "new" | "open",
    plan: null as MapPlan | null,
    rendered: null as Rendered | null,
    touchedSince: false,
    refine: "",
  };
  const stopListening: (() => void)[] = [];

  api.ui.dialog({
    title: "Generate Map",
    size: "lg",
    tall: true,
    mount(body, dialog) {
      const root = styled(body);
      const runner = new Runner(ctx);

      const promptField = textarea({ placeholder: "What kind of map? Say how many players, the feel of the terrain, where the bases go, anything the layout should have.", rows: 4 });
      promptField.addEventListener("input", () => { state.prompt = promptField.value; });
      const widthSel = w.select(SIZES.map((s) => ({ value: s, label: String(s) })), { value: state.width, onChange: (v) => { state.width = Number(v); syncTarget(); } });
      const heightSel = w.select(SIZES.map((s) => ({ value: s, label: String(s) })), { value: state.height, onChange: (v) => { state.height = Number(v); syncTarget(); } });
      const tilesetSel = w.select(TILESETS.map((t) => ({ value: t.id, label: t.label })), { value: state.tileset, onChange: (v) => { state.tileset = v; syncTarget(); } });
      const playersSel = w.select([2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: String(n) })), { value: state.players, onChange: (v) => { state.players = Number(v); } });
      const symSel = w.select((["auto", ...SYMMETRY_MODES] as (SymmetryMode | "auto")[]).map((m) => ({ value: m, label: SYMMETRY_LABELS[m] })), { value: state.symmetry, onChange: (v) => { state.symmetry = v as SymmetryMode | "auto"; } });
      const targetSel = w.select([{ value: "new", label: "A new map" }, { value: "open", label: "The open map" }], { value: state.target, onChange: (v) => { state.target = v as "new" | "open"; } });
      const targetHint = h("div", { className: "ai-hint" });
      const syncTarget = () => {
        const cur = api.document.info();
        const same = !!cur && cur.width === state.width && cur.height === state.height && cur.tileset === state.tileset;
        (targetSel.options[1] as HTMLOptionElement).disabled = !same;
        if (!same && state.target === "open") { state.target = "new"; targetSel.value = "new"; }
        targetHint.textContent = same
          ? "Into the open map: its terrain and objects inside the plan's area are replaced. One undo step."
          : "A new blank map of this size and tileset is made first, so the model can be told which terrains it has. An open map with unsaved changes asks before it goes.";
      };
      syncTarget();

      const preview = h("div", null);
      const afterwards = h("div", { className: "ai-btns", hidden: true });
      const applyButton = w.button("Apply", { primary: true, onClick: () => void apply() });
      const refineField = textarea({ placeholder: "What should change? (\"more room around the naturals\", \"swap the lake for a plateau\")", rows: 2 });
      refineField.addEventListener("input", () => { state.refine = refineField.value; });
      const refineButton = w.button("Refine", { onClick: () => void generate(true) });
      const reviewButton = w.button("Review it…", { onClick: () => { dialog.close(); openReview(ctx); } });
      const refineBox = h("div", { hidden: true }, w.group("Refine", refineField, h("div", { className: "ai-btns" }, refineButton, reviewButton), h("div", { className: "ai-hint" }, "The revised plan replaces the applied one: the previous render is undone first when nothing else was edited in between.")));

      const generateButton = w.button("Generate", { primary: true, onClick: () => void generate(false) });

      const showPlan = (plan: MapPlan, findings: string[] = []) => {
        preview.replaceChildren();
        const terrains = api.terrain.types();
        const legendRow = h("div", { className: "ai-legend" });
        for (const [ch, id] of Object.entries(plan.legend)) {
          const t = terrains.find((x) => x.id === id);
          legendRow.append(h("span", null, h("i", { style: `background:${hex(api.terrain.terrainColor(id) ?? 0x444444)}` }), `${ch} ${t?.name ?? id}`));
        }
        const grid = h("div", { className: "ai-grid" });
        for (const row of plan.grid) {
          const line = h("div", null);
          for (const ch of row) {
            const id = plan.legend[ch];
            line.append(h("span", { className: "ai-cell", style: `background:${id === undefined ? "#000" : hex(api.terrain.terrainColor(id) ?? 0x444444)}`, title: ch }));
          }
          grid.append(line);
        }
        const bases = plan.bases.map((b) => `${b.kind}${b.player ? ` (player ${b.player})` : ""} at ${b.x},${b.y}, minerals to the ${b.mineralDirection}, ${b.minerals} patches, ${b.geysers} geyser${b.geysers === 1 ? "" : "s"}`);
        preview.append(
          w.group(`${plan.name} — ${plan.symmetry === "none" ? "no symmetry" : SYMMETRY_LABELS[plan.symmetry]}`,
            h("div", { className: "ai-hint" }, plan.description),
            grid, legendRow,
            plan.notes.length ? h("details", { open: true }, h("summary", null, "Designer's notes"), h("div", { className: "ai-body" }, noteList(plan.notes))) : null,
            bases.length ? h("details", null, h("summary", null, `${bases.length} base${bases.length === 1 ? "" : "s"} listed (mirrored on apply)`), h("div", { className: "ai-body" }, noteList(bases))) : null,
            plan.ramps.length || plan.doodads.length || plan.units.length || plan.locations.length
              ? h("div", { className: "ai-hint" }, `${plan.ramps.length} ramps, ${plan.doodads.length} decoration rules, ${plan.units.length} units, ${plan.locations.length} locations.`)
              : null,
            findings.length ? h("details", { open: true }, h("summary", null, `${findings.length} thing${findings.length === 1 ? "" : "s"} to know`), h("div", { className: "ai-body" }, noteList(findings))) : null,
          ),
        );
        afterwards.hidden = false;
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

      const generate = async (refine: boolean) => {
        if (!state.prompt.trim() && !refine) { promptField.focus(); runner.idle("Say what kind of map you want first."); return; }
        if (!(await ensureMap())) return;
        await api.tileset.load();
        const cur = api.document.info()!;
        const cellSize = cellSizeFor(cur.width, cur.height);
        const input: MapPlanInput = {
          prompt: refine && state.refine.trim() ? `${state.prompt}\n\nChange this: ${state.refine.trim()}` : state.prompt,
          width: cur.width,
          height: cur.height,
          tileset: cur.tileset,
          terrains: terrainVocab(api),
          doodadCategories: doodadCategoryNames(api),
          unitNames: unitNames(api),
          players: state.players,
          symmetry: state.symmetry,
          cellSize,
        };
        if (refine && state.plan) {
          const findings = state.rendered?.findings ?? [];
          const blob = state.rendered ? await api.document.renderImage({ pixelsPerTile: pixelsPerTileFor(cur.width, cur.height, 4) }) : null;
          input.previous = { plan: state.plan, findings, image: blob ? await imageInput(blob) : undefined };
        }
        generateButton.disabled = true;
        refineButton.disabled = true;
        try {
          const r = await runRecipe(ctx, runner, "map-plan", input);
          if (!r) return;
          state.plan = r.output;
          showPlan(r.output);
          preview.scrollIntoView({ block: "nearest" });
        } finally {
          generateButton.disabled = false;
          refineButton.disabled = false;
        }
      };

      const apply = async () => {
        if (!state.plan || !api.document.isOpen()) return;
        if (state.rendered) {
          if (state.touchedSince && !(await api.ui.confirm("The map was edited since the last plan was applied. Apply the new plan on top of it?", { title: "Generate Map", confirmLabel: "Apply on top" }))) return;
          if (!state.touchedSince) api.document.undo();
        }
        for (const off of stopListening.splice(0)) off();
        const rendered = renderPlan(api, state.plan, { originX: 0, originY: 0, label: `AI: ${state.plan.name}`, clearArea: true });
        if (!rendered) return;
        state.rendered = rendered;
        state.touchedSince = false;
        for (const ev of ["terrain", "units", "doodads", "locations", "sprites"] as const) {
          const d = api.events.on(ev, () => { state.touchedSince = true; });
          stopListening.push(() => d.dispose());
        }
        if (state.plan.name || state.plan.description) {
          api.document.update("AI: name and description", (tx) => { tx.properties({ name: state.plan!.name, description: state.plan!.description }); });
        }
        showPlan(state.plan, rendered.findings);
        refineBox.hidden = false;
        runner.idle(`Applied: ${summarizeRender(rendered)}. Edit ▸ Undo takes it back.`);
        api.ui.status(`AI: ${summarizeRender(rendered)}`);
      };

      root.append(
        w.group("What to make",
          promptField,
          chips(["Example: two-player jungle", "Example: four-player lake", "Example: tight badlands"], (label) => {
            const i = ["two-player jungle", "four-player lake", "tight badlands"].findIndex((k) => label.includes(k));
            promptField.value = EXAMPLES[Math.max(0, i)];
            state.prompt = promptField.value;
          }),
          w.form([
            { label: "Size", field: h("div", { className: "ai-btns" }, widthSel, "×", heightSel) },
            { label: "Tileset", field: tilesetSel },
            { label: "Players", field: playersSel },
            { label: "Symmetry", field: symSel },
            { label: "Into", field: targetSel },
          ]),
          targetHint,
          h("div", { className: "ai-btns" }, generateButton),
        ),
        runner.el,
        preview,
        afterwards,
        refineBox,
        ledgerLine(ctx),
      );
      afterwards.append(applyButton, h("span", { className: "ai-hint" }, "Renders the plan onto the map as one undo step, then names the map after it."));
      promptField.focus();
      return () => { runner.dispose(); for (const off of stopListening.splice(0)) off(); };
    },
    buttons: [{ label: "Close" }],
  });
}
