/**
 * Tools ▸ AI ▸ Review Map…: a critique of the map from a picture of it, its facts and
 * what Check Map says. The summary is shown as it is; the findings are a list with a
 * Go to button for the ones that point somewhere.
 */
import type { ReviewFinding } from "../protocol";
import { imageInput, mapFacts, pixelsPerTileFor } from "../facts";
import { renderMarkdown } from "../markdown";
import { h, ledgerLine, Runner, runRecipe, styled, textarea, type Ctx } from "../ui";

const PRESETS = [
  "Review this as a melee map: balance between the starts, expansion layout, chokes and paths, and what a ladder player would complain about.",
  "Review this as a UMS map: is it readable, are the objectives clear from the terrain and the triggers, what would confuse a first-time player?",
  "What would you change first, and why?",
];

export function openReview(ctx: Ctx) {
  const { api } = ctx;
  const w = api.ui.widgets;

  api.ui.dialog({
    title: "Review Map",
    size: "lg",
    tall: true,
    mount(body) {
      const root = styled(body);
      const runner = new Runner(ctx);
      const info = api.document.info();
      const promptField = textarea({ placeholder: "What to look at — or leave empty for a general review.", rows: 2 });
      const summary = h("div", null);
      const findings = h("div", { className: "ai-list", hidden: true });
      const picture = h("div", { className: "ai-hint" });

      const showFindings = (list: ReviewFinding[]) => {
        findings.replaceChildren();
        findings.hidden = list.length === 0;
        for (const f of list) {
          const mark = f.severity === "problem" ? "ai-bad" : f.severity === "warning" ? "ai-gold" : "ai-dim";
          findings.append(h("div", { className: "ai-item" },
            h("span", { className: mark, style: "width: 60px; flex: none;" }, f.severity),
            h("div", { className: "ai-grow" }, h("div", null, f.title), h("div", { className: "ai-dim" }, f.detail)),
            f.x !== undefined && f.y !== undefined ? w.button("Go to", { ghost: true, onClick: () => api.view.goTo({ kind: "tile", x: f.x!, y: f.y! }) }) : null,
          ));
        }
      };

      const review = async () => {
        if (!info) return;
        await api.tileset.load();
        const ppt = pixelsPerTileFor(info.width, info.height, 8, 1_600_000);
        picture.textContent = `Rendering the map at ${ppt} px per tile…`;
        const blob = await api.document.renderImage({ pixelsPerTile: ppt, units: true, sprites: true, locations: true, locationNames: true, startLocations: true, fog: false, grid: 0 });
        if (!blob) { runner.fail(new Error("the map could not be rendered (tileset graphics missing?)")); return; }
        picture.textContent = `Sent a ${info.width * ppt} × ${info.height * ppt} picture (${Math.round(blob.size / 1024)} KB) with the map's facts and ${api.query.validate().length} Check Map lines.`;
        summary.replaceChildren();
        const r = await runRecipe(ctx, runner, "review", {
          facts: mapFacts(api),
          image: await imageInput(blob),
          issues: api.query.validate().map((i) => `${i.level}: ${i.text}${i.where ? ` (${i.where})` : ""}`),
          prompt: promptField.value.trim() || undefined,
        });
        if (!r) return;
        summary.replaceChildren(renderMarkdown(r.output.summary));
        showFindings(r.output.findings);
      };

      root.append(
        w.group("What to look at",
          promptField,
          h("div", { className: "ai-chips" }, ...PRESETS.map((p, i) => h("button", { type: "button", className: "ai-chip", onClick: () => { promptField.value = p; } }, ["Melee balance", "UMS readability", "What to change first"][i]))),
          h("div", { className: "ai-btns" }, w.button("Review", { primary: true, onClick: () => void review() }), picture),
        ),
        runner.el,
        summary,
        findings,
        ledgerLine(ctx),
      );
      return () => runner.dispose();
    },
    buttons: [{ label: "Close" }],
  });
}
