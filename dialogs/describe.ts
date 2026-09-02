/**
 * Tools ▸ AI ▸ Name and Describe… and Write Briefing…: text from the map's facts.
 * The first offers three name/description pairs and writes the picked one into the
 * scenario's properties; the second writes a mission briefing — the objectives into
 * a Mission Objectives action, each narration line into a Text Message — as one
 * briefing trigger for every player.
 */
import type { BriefingOutput, DescribeOutput } from "../protocol";
import { mapFacts } from "../facts";
import { h, ledgerLine, Runner, runRecipe, styled, textarea, type Ctx } from "../ui";

export function openDescribe(ctx: Ctx) {
  const { api } = ctx;
  const w = api.ui.widgets;

  api.ui.dialog({
    title: "Name and Describe",
    size: "md",
    mount(body) {
      const root = styled(body);
      const runner = new Runner(ctx);
      const info = api.document.info();
      const promptField = textarea({ placeholder: "Tone, length, language — or leave it to the facts. (\"short and grim\", \"in German\", \"mention the gold expansion\")", rows: 2 });
      const list = h("div", { className: "ai-list" });
      const current = h("div", { className: "ai-hint" }, `Now: "${info?.name ?? ""}" — ${info?.description || "(no description)"}`);
      let picked: { name: string; description: string } | null = null;
      const applyButton = w.button("Use this", { primary: true, disabled: true, onClick: () => {
        if (!picked) return;
        const p = picked;
        api.document.update("AI: name and description", (tx) => { tx.properties({ name: p.name, description: p.description }); });
        current.textContent = `Now: "${p.name}" — ${p.description}`;
        runner.idle("Written into Scenario ▸ Map Properties. It is not an undo step; write the old one back the same way if you change your mind.");
      } });

      const show = (out: DescribeOutput) => {
        list.replaceChildren();
        picked = null;
        applyButton.disabled = true;
        const options = [{ name: out.name, description: out.description }, ...out.alternatives];
        const rows: HTMLElement[] = [];
        options.forEach((o) => {
          const row = h("div", { className: "ai-item", onClick: () => { picked = o; applyButton.disabled = false; rows.forEach((r) => r.classList.toggle("is-picked", r === row)); } },
            h("div", { className: "ai-grow" }, h("div", { className: "ai-gold" }, o.name), h("div", { className: "ai-dim" }, o.description)));
          rows.push(row);
          list.append(row);
        });
      };

      root.append(
        current,
        promptField,
        h("div", { className: "ai-btns" }, w.button("Suggest", { primary: true, onClick: async () => {
          const r = await runRecipe(ctx, runner, "describe", { facts: mapFacts(api), prompt: promptField.value.trim() || undefined });
          if (r) show(r.output);
        } })),
        runner.el, list, h("div", { className: "ai-btns" }, applyButton), ledgerLine(ctx),
      );
      return () => runner.dispose();
    },
    buttons: [{ label: "Close" }],
  });
}

export function openBriefing(ctx: Ctx) {
  const { api } = ctx;
  const w = api.ui.widgets;

  api.ui.dialog({
    title: "Write Briefing",
    size: "md",
    mount(body) {
      const root = styled(body);
      const runner = new Runner(ctx);
      const promptField = textarea({ placeholder: "Who is speaking, what is at stake, how long — or leave it to the triggers and the map. (\"a terse Terran commander\", \"three lines\", \"in Spanish\")", rows: 2 });
      const objectives = textarea({ rows: 4, placeholder: "Objectives, one per line." });
      const lines = textarea({ rows: 8, placeholder: "The narration, one message per line." });
      const seconds = w.number({ value: 8, min: 1, max: 60 });
      const replace = w.checkbox("Replace the map's existing briefing", { value: true });
      const writeButton = w.button("Write into the map", { primary: true, disabled: true, onClick: () => {
        const obj = objectives.value.split("\n").map((s) => s.trim()).filter(Boolean);
        const msgs = lines.value.split("\n").map((s) => s.trim()).filter(Boolean);
        if (obj.length === 0 && msgs.length === 0) return;
        const actions = api.names.actions(true);
        const typeOf = (label: string, fallback: number) => actions.find((a) => a.label.toLowerCase() === label)?.value ?? fallback;
        const objectivesType = typeOf("mission objectives", 4);
        const messageType = typeOf("text message", 3);
        const ms = Math.max(1, Number(seconds.value) || 8) * 1000;
        const r = api.document.update("AI: mission briefing", (tx) => {
          const t = api.triggers.newTrigger([0, 1, 2, 3, 4, 5, 6, 7]);
          t.actions = [];
          if (obj.length) {
            const a = api.triggers.newAction(objectivesType, true);
            a.text = tx.strings.intern(obj.join("\n"));
            t.actions.push(a);
          }
          for (const m of msgs) {
            const a = api.triggers.newAction(messageType, true);
            a.text = tx.strings.intern(m);
            a.time = ms;
            t.actions.push(a);
          }
          if (replace.input.checked) tx.briefing.set([t]);
          else tx.briefing.add(t);
        });
        runner.idle(r.changed ? `Written: ${obj.length} objective${obj.length === 1 ? "" : "s"} and ${msgs.length} message${msgs.length === 1 ? "" : "s"} in one briefing trigger for all players. Triggers ▸ Mission Briefing shows it.` : "Nothing changed.");
      } });

      const show = (out: BriefingOutput) => {
        objectives.value = out.objectives.join("\n");
        lines.value = out.lines.join("\n");
        writeButton.disabled = false;
      };

      root.append(
        promptField,
        h("div", { className: "ai-btns" }, w.button("Write", { primary: true, onClick: async () => {
          const r = await runRecipe(ctx, runner, "briefing", { facts: mapFacts(api), prompt: promptField.value.trim() || undefined });
          if (r) show(r.output);
        } })),
        runner.el,
        w.group("Objectives", objectives),
        w.group("Narration", lines, w.form([{ label: "Seconds each", field: seconds }]), replace),
        h("div", { className: "ai-btns" }, writeButton),
        ledgerLine(ctx),
      );
      return () => runner.dispose();
    },
    buttons: [{ label: "Close" }],
  });
}
