/** Trigger, string and switch writes: settings-style transactions (not in the undo model). */
import { bool, capResult, ints, num, obj, plural, str, type Tool } from "./common";
import { NO_SCRIPT_PLUGIN, scriptBridge } from "../script";

export function triggerTools(): Tool[] {
  return [
    {
      def: { name: "add_triggers_text", description: "Append triggers written in the editor's text format (the format list_triggers_text shows; grammar in the reference). Parse errors are reported and nothing is added. Not undoable.", inputSchema: obj({ text: { type: "string" }, briefing: { type: "boolean" } }, ["text"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        try {
          const briefing = input.briefing === true;
          const parsed = api.triggers.text.parse(str(input.text), { briefing });
          const r = api.document.update("AI: add triggers", (tx) => { for (const t of parsed) (briefing ? tx.briefing : tx.triggers).add(t.trigger); });
          const count = briefing ? api.triggers.briefing().length : api.triggers.list().length;
          return `Added ${plural(parsed.length, "trigger")}${r.changed ? `; the map now has ${count}` : " (nothing changed)"}.`;
        } catch (err) {
          return `Parse error: ${(err as Error).message}`;
        }
      },
    },
    {
      def: { name: "replace_trigger", description: "Replace one trigger (1-based index, as list_triggers_text numbers them) with one written in the text format. Not undoable.", inputSchema: obj({ index: { type: "integer" }, text: { type: "string" }, briefing: { type: "boolean" } }, ["index", "text"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const briefing = input.briefing === true;
        const index = Math.round(num(input.index)) - 1;
        try {
          const parsed = api.triggers.text.parse(str(input.text), { briefing });
          if (parsed.length !== 1) return `The text holds ${parsed.length} triggers; replace_trigger takes exactly one.`;
          let ok = false;
          api.document.update(`AI: replace trigger ${index + 1}`, (tx) => { ok = (briefing ? tx.briefing : tx.triggers).replace(index, parsed[0].trigger); });
          return ok ? `Replaced trigger ${index + 1}.` : `There is no trigger ${index + 1}.`;
        } catch (err) {
          return `Parse error: ${(err as Error).message}`;
        }
      },
    },
    {
      def: { name: "remove_triggers", description: "Remove triggers by 1-based index. Not undoable.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } }, briefing: { type: "boolean" } }, ["indices"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const briefing = input.briefing === true;
        const indices = ints(input.indices).map((i) => i - 1).filter((i) => i >= 0);
        let n = 0;
        api.document.update("AI: remove triggers", (tx) => { n = (briefing ? tx.briefing : tx.triggers).remove(indices); });
        return `Removed ${plural(n, "trigger")}.`;
      },
    },
    {
      def: { name: "move_trigger", description: "Move a trigger from one 1-based position to another (triggers run in list order). Not undoable.", inputSchema: obj({ from: { type: "integer" }, to: { type: "integer" }, briefing: { type: "boolean" } }, ["from", "to"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const briefing = input.briefing === true;
        let ok = false;
        api.document.update("AI: move trigger", (tx) => { ok = (briefing ? tx.briefing : tx.triggers).move(Math.round(num(input.from)) - 1, Math.round(num(input.to)) - 1); });
        return ok ? "Moved." : "No such trigger.";
      },
    },
    {
      def: { name: "set_trigger_flags", description: "Turn Preserve Trigger on or off for triggers by 1-based index (to disable a condition or action, replace the trigger with a `;` before that line). Not undoable.", inputSchema: obj({ indices: { type: "array", items: { type: "integer" } }, preserved: { type: "boolean" } }, ["indices", "preserved"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const indices = ints(input.indices).map((i) => i - 1).filter((i) => i >= 0);
        const preserved = bool(input.preserved);
        if (preserved === undefined) return "Say whether preserved should be true or false.";
        let n = 0;
        api.document.update("AI: trigger flags", (tx) => {
          const listNow = tx.triggers.list();
          for (const i of indices) {
            const t = listNow[i];
            if (!t) continue;
            if (tx.triggers.replace(i, api.triggers.setPreserved(t, preserved))) n++;
          }
        });
        return `Changed ${plural(n, "trigger")}.`;
      },
    },
    {
      def: { name: "set_string", description: "Overwrite one string in the table by index (everything that points at it shows the new text), or add a new string with index 0 and get its index back. Not undoable.", inputSchema: obj({ index: { type: "integer" }, text: { type: "string" } }, ["index", "text"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const index = Math.round(num(input.index));
        let added = -1;
        const r = api.document.update("AI: string", (tx) => { if (index <= 0) added = tx.strings.intern(str(input.text)); else tx.strings.set(index, str(input.text)); });
        if (index <= 0) return `Added string ${added}.`;
        return r.changed ? `String ${index} set.` : `String ${index} already said that.${r.notes.length ? ` ${r.notes.join(" ")}` : ""}`;
      },
    },
    {
      def: { name: "name_switch", description: "Name a switch (0-based index; \"\" clears the name). Not undoable.", inputSchema: obj({ index: { type: "integer" }, name: { type: "string" } }, ["index", "name"]) },
      writes: true,
      settings: true,
      run: (input, { api }) => { const r = api.document.update("AI: switch name", (tx) => { tx.switches.setName(Math.round(num(input.index)), str(input.name)); }); return r.changed ? "Named." : `Nothing changed.${r.notes.length ? ` ${r.notes.join(" ")}` : ""}`; },
    },
    {
      def: { name: "set_properties", description: "Set the scenario's name and/or description (Map Properties). Not undoable.", inputSchema: obj({ name: { type: "string" }, description: { type: "string" } }) },
      writes: true,
      settings: true,
      run: (input, { api }) => {
        const patch: { name?: string; description?: string } = {};
        if (typeof input.name === "string") patch.name = input.name;
        if (typeof input.description === "string") patch.description = input.description;
        const r = api.document.update("AI: properties", (tx) => { tx.properties(patch); });
        return r.changed ? "Done." : "Nothing changed.";
      },
    },
    {
      def: { name: "simulate_triggers", description: "Run the map's triggers through the Trigger Script plugin's trigger-cycle interpreter for some cycles (Deaths, Switches, Always and Never are modelled; other conditions count as false) and report the actions that fired and the switches set at the end. Reads only.", inputSchema: obj({ cycles: { type: "integer" }, player: { type: "integer" } }) },
      writes: false,
      run: (input, { api }) => { const script = scriptBridge(api); if (!script) return NO_SCRIPT_PLUGIN; const s = script.simulate(api.triggers.list(), Math.max(1, Math.min(200, Math.round(num(input.cycles, 30)))), input.player !== undefined ? { player: Math.round(num(input.player)) - 1 } : undefined); return capResult({ cycles: s.cycles, events: s.events.slice(0, 200), switchesSet: s.switches }); },
    },
  ];
}
