/**
 * Tools ▸ AI ▸ Write Triggers…: a trigger script from a description. The model gets
 * the map's own `.d.ts` (every unit, location, switch and player by name) and writes
 * the Trigger Script plugin's TypeScript-subset script; the dialog compiles it there, sends the
 * compiler's complaints back for up to two repair rounds, shows the script, and
 * Build installs it the way the Script Editor's Build does.
 */
import type { TriggersInput } from "../protocol";
import { NO_SCRIPT_PLUGIN, scriptBridge, type CompileResult } from "../script";
import { h, ledgerLine, noteList, Runner, runRecipe, styled, textarea, type Ctx } from "../ui";

const REPAIR_ROUNDS = 2;

export function openTriggers(ctx: Ctx) {
  const { api } = ctx;
  const bridge = scriptBridge(api);
  if (!bridge) { void api.ui.alert(NO_SCRIPT_PLUGIN, { title: "Write Triggers" }); return; }
  const w = api.ui.widgets;
  const state = { prompt: "", script: "", summary: "", compiled: null as CompileResult | null };

  api.ui.dialog({
    title: "Write Triggers",
    size: "lg",
    tall: true,
    mount(body) {
      const root = styled(body);
      const runner = new Runner(ctx);
      const existing = bridge.state();
      const hasScript = !!existing?.source;
      const promptField = textarea({ placeholder: "What should happen? (\"each player gets 10 marines at their start every 30 seconds until minute 5\", \"victory when a player has 50 kills\", \"a countdown that ends the game in a draw\")", rows: 4 });
      promptField.addEventListener("input", () => { state.prompt = promptField.value; });
      const extend = w.checkbox("Extend the map's current script", { value: hasScript, disabled: !hasScript });
      const takeOver = w.checkbox("Replace every trigger on the map with the script (the hand-made ones are folded into it first)", { value: false });
      const scriptField = textarea({ rows: 14, code: true, placeholder: "The script appears here. Edit it before building if you like." });
      scriptField.addEventListener("input", () => { state.script = scriptField.value; state.compiled = null; diagnostics.replaceChildren(); });
      const summary = h("div", { className: "ai-hint" });
      const diagnostics = h("div", null);
      const buildButton = w.button("Build", { primary: true, onClick: () => void build() });
      const checkButton = w.button("Check", { onClick: () => void check() });
      const openEditor = w.button("Open Script Editor", { ghost: true, onClick: () => bridge.open() });
      const after = h("div", { className: "ai-btns", hidden: true }, buildButton, checkButton, openEditor);

      const showDiagnostics = (r: CompileResult) => {
        diagnostics.replaceChildren();
        if (r.ok) { diagnostics.append(h("div", { className: "ai-ok" }, `Compiles: ${r.triggers.length} trigger${r.triggers.length === 1 ? "" : "s"}${r.program ? `, a structured program of ${r.program.count} triggers` : ""}.`)); return; }
        diagnostics.append(h("div", { className: "ai-bad" }, `${r.diagnostics.length} error${r.diagnostics.length === 1 ? "" : "s"}:`), noteList(r.diagnostics.map((d) => `line ${d.line}:${d.column} — ${d.message}`), "ai-bad"));
      };

      const check = async (): Promise<CompileResult | null> => {
        try {
          const r = await bridge.compile(state.script);
          state.compiled = r;
          showDiagnostics(r);
          return r;
        } catch (err) {
          diagnostics.replaceChildren(h("div", { className: "ai-bad" }, `Compiler: ${(err as Error).message}`));
          return null;
        }
      };

      const generate = async () => {
        if (!state.prompt.trim()) { promptField.focus(); runner.idle("Say what the triggers should do first."); return; }
        const declarations = bridge.declarations();
        const hand = api.triggers.list().filter((_, i) => !(existing?.block && i >= existing.block.start && i < existing.block.start + existing.block.count));
        const input: TriggersInput = {
          prompt: state.prompt,
          declarations,
          script: extend.input.checked && existing?.source ? existing.source : undefined,
          existingTriggers: hand.length > 0 ? api.triggers.text.print(hand).slice(0, 30_000) : undefined,
        };
        let r = await runRecipe(ctx, runner, "triggers", input);
        if (!r) return;
        let script = r.output.script;
        state.summary = r.output.summary;
        state.script = script;
        scriptField.value = script;
        summary.textContent = state.summary;
        let compiled = await check();
        for (let round = 0; compiled && !compiled.ok && round < REPAIR_ROUNDS; round++) {
          runner.idle(`The script has ${compiled.diagnostics.length} error${compiled.diagnostics.length === 1 ? "" : "s"}; asking for a repair (${round + 1} of ${REPAIR_ROUNDS})…`);
          r = await runRecipe(ctx, runner, "triggers", { ...input, repair: { script, diagnostics: compiled.diagnostics.map((d) => ({ line: d.line, column: d.column, message: d.message })) } });
          if (!r) return;
          script = r.output.script;
          state.script = script;
          state.summary = r.output.summary || state.summary;
          scriptField.value = script;
          summary.textContent = state.summary;
          compiled = await check();
        }
        after.hidden = false;
        if (compiled && !compiled.ok) runner.idle("The script still has errors. Fix them here or in the Script Editor, then Build.");
      };

      const build = async () => {
        if (!state.script.trim()) return;
        const r = await bridge.build(state.script, { takeOver: takeOver.input.checked });
        state.compiled = r.compiled;
        showDiagnostics(r.compiled);
        if (r.block) {
          runner.idle(`Built ${r.block.count} trigger${r.block.count === 1 ? "" : "s"} into the map (#${r.block.start + 1}–#${r.block.start + r.block.count}). The source is kept with the map; the Script Editor shows it.`);
          api.ui.status(`AI: built ${r.block.count} triggers from the script.`);
        } else runner.idle("Not built: the script has errors.");
      };

      root.append(
        w.group("What the triggers should do",
          promptField, extend, takeOver,
          h("div", { className: "ai-hint" }, `The model is given this map's names: ${api.query.startLocations().length} start locations, ${api.triggers.list().length} existing triggers, and every unit, location and switch as it is called here.`),
          h("div", { className: "ai-btns" }, w.button("Write", { primary: true, onClick: () => void generate() })),
        ),
        runner.el,
        w.group("The script", summary, scriptField, diagnostics, after),
        ledgerLine(ctx),
      );
      promptField.focus();
      return () => runner.dispose();
    },
    buttons: [{ label: "Close" }],
  });
}
