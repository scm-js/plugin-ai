/**
 * Tools ▸ AI ▸ Redo Area…: one area of the open map laid out again from a prompt. The
 * area comes from the marked selection or a pick on the map; the model sees it (and a
 * margin round it) in the layout language plus a picture, and answers with a plan for
 * just that rectangle, which Apply renders in place — terrain and objects inside the
 * area replaced, one undo step.
 */
import type { Rect } from "../plugin-api/plugins/api";
import type { LayoutPlan, RegionPlanInput } from "../protocol";
import { doodadCategoryNames, imageInput, terrainVocab, unitNames } from "../facts";
import { sampleGrid, terrainOfGroup } from "../grid";
import { renderPlan, summarizeRender } from "../render";
import { h, hex, ledgerLine, noteList, Runner, runRecipe, styled, textarea, type Ctx } from "../ui";

const MAX_CELLS = 64;
const MARGIN = 4;

/** Tiles per cell so the area is at most `MAX_CELLS` cells a side. */
export function regionCellSize(rect: Rect): number {
  const longest = Math.max(rect.x1 - rect.x0, rect.y1 - rect.y0);
  return Math.max(1, Math.ceil(longest / MAX_CELLS));
}

/** A tile's terrain id under the open map, or null for a cliff piece, a doodad tile or an unknown one. */
export function terrainAtTile(ctx: Ctx): (tx: number, ty: number) => number | null {
  const { api } = ctx;
  const scn = api.document.scenario();
  const terrains = api.terrain.types();
  if (!scn) return () => null;
  const cache = new Map<number, number | null>();
  return (tx, ty) => {
    if (tx < 0 || ty < 0 || tx >= scn.width || ty >= scn.height) return null;
    const id = scn.tiles[ty * scn.width + tx];
    let hit = cache.get(id);
    if (hit === undefined) {
      const info = api.terrain.tileInfo(id);
      hit = info && info.kind === "terrain" ? terrainOfGroup(info.group, terrains) : null;
      cache.set(id, hit);
    }
    return hit;
  };
}

export async function openRegion(ctx: Ctx, preset?: Rect | null) {
  const { api } = ctx;
  const w = api.ui.widgets;
  const info = api.document.info();
  if (!info) return;
  let rect = preset ?? api.selection.markedArea();
  if (!rect) {
    rect = await api.ui.pickArea({ prompt: "Drag over the area to redo" });
    if (!rect) return;
  }
  rect = { x0: Math.max(0, Math.min(rect.x0, rect.x1)), y0: Math.max(0, Math.min(rect.y0, rect.y1)), x1: Math.min(info.width, Math.max(rect.x0, rect.x1)), y1: Math.min(info.height, Math.max(rect.y0, rect.y1)) };
  if (rect.x1 - rect.x0 < 2 || rect.y1 - rect.y0 < 2) { api.ui.status("AI: the area is too small to redo."); return; }
  const area: Rect = rect;
  const state = { prompt: "", plan: null as LayoutPlan | null, applied: false };

  api.ui.dialog({
    title: `Redo Area ${area.x0},${area.y0} – ${area.x1},${area.y1}`,
    size: "lg",
    tall: true,
    mount(body) {
      const root = styled(body);
      const runner = new Runner(ctx);
      const promptField = textarea({ placeholder: "What should this area become? (\"a lake with a bridge\", \"a plateau with one ramp to the south\", \"a forest with a path through it\")", rows: 3 });
      promptField.addEventListener("input", () => { state.prompt = promptField.value; });
      const keepUnits = w.checkbox("Keep the units, sprites and doodads that are there now", { value: false });
      const preview = h("div", null);
      const applyButton = w.button("Apply", { primary: true, onClick: () => apply() });
      const afterwards = h("div", { className: "ai-btns", hidden: true }, applyButton, h("span", { className: "ai-hint" }, "One undo step."));
      const cellSize = regionCellSize(area);

      const showPlan = (plan: LayoutPlan, findings: string[] = []) => {
        preview.replaceChildren();
        const grid = h("div", { className: "ai-grid" });
        for (const row of plan.grid) {
          const line = h("div", null);
          for (const ch of row) {
            const id = plan.legend[ch];
            line.append(h("span", { className: "ai-cell", style: `background:${id === undefined ? "#000" : hex(api.terrain.terrainColor(id) ?? 0x444444)}`, title: ch }));
          }
          grid.append(line);
        }
        const terrains = api.terrain.types();
        const legendRow = h("div", { className: "ai-legend" }, ...Object.entries(plan.legend).map(([ch, id]) => h("span", null, h("i", { style: `background:${hex(api.terrain.terrainColor(id) ?? 0x444444)}` }), `${ch} ${terrains.find((t) => t.id === id)?.name ?? id}`)));
        preview.append(w.group("The plan",
          grid, legendRow,
          plan.notes.length ? noteList(plan.notes) : null,
          h("div", { className: "ai-hint" }, `${plan.bases.length} bases, ${plan.ramps.length} ramps, ${plan.doodads.length} decoration rules, ${plan.units.length} units, ${plan.locations.length} locations.`),
          findings.length ? h("details", { open: true }, h("summary", null, `${findings.length} thing${findings.length === 1 ? "" : "s"} to know`), h("div", { className: "ai-body" }, noteList(findings))) : null,
        ));
        afterwards.hidden = false;
      };

      const generate = async () => {
        if (!state.prompt.trim()) { promptField.focus(); runner.idle("Say what the area should become first."); return; }
        await api.tileset.load();
        const margin = { x0: Math.max(0, area.x0 - MARGIN), y0: Math.max(0, area.y0 - MARGIN), x1: Math.min(info.width, area.x1 + MARGIN), y1: Math.min(info.height, area.y1 + MARGIN) };
        const current = sampleGrid(terrainAtTile(ctx), margin, cellSize);
        const blob = await api.graphics.renderRect(margin, { pixelsPerTile: 8, units: true, sprites: true, locations: false, grid: 0 });
        const input: RegionPlanInput = {
          prompt: state.prompt,
          width: info.width,
          height: info.height,
          tileset: info.tileset,
          terrains: terrainVocab(api),
          doodadCategories: doodadCategoryNames(api),
          unitNames: unitNames(api),
          rect: { x0: area.x0, y0: area.y0, x1: area.x1, y1: area.y1 },
          cellSize,
          current: { legend: current.legend, grid: current.grid, originX: current.originX, originY: current.originY },
          image: blob ? await imageInput(blob) : undefined,
        };
        const r = await runRecipe(ctx, runner, "region-plan", input);
        if (!r) return;
        state.plan = r.output;
        state.applied = false;
        showPlan(r.output);
      };

      const apply = () => {
        if (!state.plan) return;
        if (state.applied) api.document.undo();
        const rendered = renderPlan(api, state.plan, { originX: area.x0, originY: area.y0, label: "AI: redo area", clearArea: !keepUnits.input.checked });
        if (!rendered) return;
        state.applied = true;
        showPlan(state.plan, rendered.findings);
        runner.idle(`Applied: ${summarizeRender(rendered)}. Edit ▸ Undo takes it back.`);
        api.ui.status(`AI: ${summarizeRender(rendered)}`);
      };

      root.append(
        w.group("What to make of it",
          promptField,
          keepUnits,
          h("div", { className: "ai-hint" }, `${area.x1 - area.x0} × ${area.y1 - area.y0} tiles, ${cellSize} tile${cellSize === 1 ? "" : "s"} per cell. The model is shown the area with ${MARGIN} tiles of margin so the edges join.`),
          h("div", { className: "ai-btns" }, w.button("Generate", { primary: true, onClick: () => void generate() })),
        ),
        runner.el, preview, afterwards, ledgerLine(ctx),
      );
      promptField.focus();
      return () => runner.dispose();
    },
    buttons: [{ label: "Close" }],
  });
}
