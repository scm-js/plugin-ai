/**
 * Tools ▸ AI ▸ Explain Triggers…: the map's triggers (or a range of them) in plain
 * language, streamed as it is written; an optional question instead of a walkthrough.
 */
import { renderMarkdown } from "../markdown";
import { h, ledgerLine, Runner, runRecipe, styled, textarea, type Ctx } from "../ui";

export function openExplain(ctx: Ctx) {
  const { api } = ctx;
  const w = api.ui.widgets;
  const list = api.triggers.list();
  const briefingList = api.triggers.briefing();

  api.ui.dialog({
    title: "Explain Triggers",
    size: "lg",
    tall: true,
    mount(body) {
      const root = styled(body);
      const runner = new Runner(ctx);
      const which = w.select([
        { value: "triggers", label: `Triggers (${list.length})` },
        { value: "briefing", label: `Mission briefing (${briefingList.length})`, disabled: briefingList.length === 0 },
      ], { value: "triggers" });
      const from = w.number({ value: 1, min: 1, max: Math.max(1, list.length) });
      const to = w.number({ value: list.length, min: 1, max: Math.max(1, list.length) });
      const question = textarea({ placeholder: "A question, or leave empty for a walkthrough of what happens in play.", rows: 2 });
      const out = h("div", null);
      let text = "";

      const ask = async () => {
        const briefing = which.value === "briefing";
        const source = briefing ? briefingList : list;
        if (source.length === 0) { runner.idle("There are no triggers to explain."); return; }
        const a = Math.max(1, Math.min(source.length, Number(from.value) || 1)) - 1;
        const b = Math.max(a + 1, Math.min(source.length, Number(to.value) || source.length));
        const slice = source.slice(a, b);
        text = "";
        out.replaceChildren(h("div", { className: "ai-hint" }, "Writing…"));
        const r = await runRecipe(ctx, runner, "explain-triggers", {
          text: api.triggers.text.print(slice, { briefing }).slice(0, 120_000),
          question: question.value.trim() || undefined,
          briefing,
        }, {
          onDelta: (t) => { text += t; out.replaceChildren(renderMarkdown(text)); out.scrollTop = out.scrollHeight; },
        });
        if (r) { text = r.output.text || text; out.replaceChildren(renderMarkdown(text)); }
      };

      root.append(
        w.group("Which",
          w.form([
            { label: "List", field: which },
            { label: "From – to", field: h("div", { className: "ai-btns" }, from, "–", to) },
          ]),
          question,
          h("div", { className: "ai-btns" }, w.button("Explain", { primary: true, onClick: () => void ask() }), w.button("Copy", { ghost: true, onClick: () => { void navigator.clipboard?.writeText(text); } })),
        ),
        runner.el,
        h("div", { className: "ai-scroll" }, out),
        ledgerLine(ctx),
      );
      return () => runner.dispose();
    },
    buttons: [{ label: "Close" }],
  });
}
