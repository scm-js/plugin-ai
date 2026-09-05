/**
 * AI — a plugin for the scmJS map editor (https://github.com/jeany55/scm-js).
 *
 * Experimental tools that use a language model through an ai-server
 * (https://github.com/scm-js/ai-server): a map laid out from a prompt, an area redone,
 * triggers written and explained, a name and a briefing, a review, string rewrites, and
 * an assistant that edits the map with you. The server holds the model's key and the
 * prompts; this plugin gathers what the model needs from the open map, applies what
 * comes back through the editor's own transactions, and never sends anything until
 * you press the button. Out of the box it talks to api.scmjs.dev: a free trial with no
 * sign-in, then a weekly allowance behind a Discord sign-in (`account.ts`); a token or
 * your own Anthropic key are the other two ways in.
 *
 * `protocol.ts` is the wire contract shared with the server; `plan.ts` / `grid.ts`
 * turn the layout language into brush strokes; `render.ts` applies a plan as one undo
 * step; `tools.ts` and `assistant.ts` are the tool-using conversation; the dialogs are
 * under `dialogs/`; `slots.ts` is what the plugin puts inside the editor's own dialogs, `ums.ts`
 * the toolkit of trigger systems and `guides.ts` the genre guides behind Make Scenario and the
 * assistant. `@scm-js/plugin-api` is the editor's type declarations, a devDependency
 * generated from its own `src/plugins/api.ts`; the host erases the type-only import.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import { AccountManager } from "./account";
import { openAssistant, type AssistantHandle, type AssistantState } from "./assistant";
import { AiClient } from "./client";
import { openBriefing, openDescribe } from "./dialogs/describe";
import { openExplain } from "./dialogs/explain";
import { openGenerate } from "./dialogs/generate";
import { openRegion } from "./dialogs/region";
import { openReview } from "./dialogs/review";
import { openScenario } from "./dialogs/scenario";
import { openStrings } from "./dialogs/strings";
import { openTriggers } from "./dialogs/triggers";
import { installDialogSlots } from "./slots";
import { openSettings, settingsStore } from "./settings";
import type { Ctx } from "./ui";

export default function activate(api: PluginApi) {
  const store = settingsStore(api);
  const client = new AiClient(() => { const s = store.get(); return { serverUrl: s.serverUrl, access: s.access, session: s.session, token: s.token, ownKey: s.ownKey }; });
  const account = new AccountManager(store, client);
  const ctx: Ctx = { api, settings: () => store.get(), client, ledger: client.ledger, account, openSettings: () => openSettings(ctx, store), presence: null };
  const assistant: AssistantState = { messages: [] };
  let assistantPanel: AssistantHandle | null = null;
  const open = () => api.document.isOpen();
  const showAssistant = () => { if (!assistantPanel?.isOpen()) assistantPanel = openAssistant(ctx, assistant); return assistantPanel; };
  const toggleAssistant = () => {
    if (assistantPanel?.isOpen()) { assistantPanel.close(); assistantPanel = null; return; }
    assistantPanel = openAssistant(ctx, assistant);
  };
  // The plugin's cell in the status bar: "AI" when idle, the assistant's phase while it works, a click opens the panel.
  ctx.presence = api.ui.statusItem({ text: "AI", title: "AI Assistant (Ctrl+Shift+A)", onClick: toggleAssistant });

  api.commands.register({ id: "generate", title: "AI: Generate Map", run: () => openGenerate(ctx) });
  api.commands.register({ id: "scenario", title: "AI: Make Scenario", run: (prompt?: unknown) => openScenario(ctx, typeof prompt === "string" ? prompt : undefined) });
  api.commands.register({ id: "assistant", title: "AI: Assistant", run: toggleAssistant });
  api.commands.register({ id: "ask", title: "AI: Ask about this", run: (text?: unknown) => { showAssistant().ask(typeof text === "string" ? text : "", false); } });
  api.commands.register({ id: "settings", title: "AI: Settings", run: () => ctx.openSettings() });

  const menu = "Tools/AI" as const;
  api.menu.add(menu, { label: "Make Scenario…", icon: "plugin", command: "scenario" });
  api.menu.add(menu, { label: "Generate Map…", icon: "plugin", command: "generate" });
  api.menu.add(menu, { label: "Redo Area…", icon: "plugin", enabled: open, run: () => void openRegion(ctx) });
  api.menu.add(menu, { label: "Write Triggers…", icon: "plugin", enabled: open, run: () => openTriggers(ctx) });
  api.menu.add(menu, { label: "Explain Triggers…", icon: "plugin", enabled: open, run: () => openExplain(ctx) });
  api.menu.add(menu, { label: "Name and Describe…", icon: "plugin", enabled: open, run: () => openDescribe(ctx) });
  api.menu.add(menu, { label: "Write Briefing…", icon: "plugin", enabled: open, run: () => openBriefing(ctx) });
  api.menu.add(menu, { label: "Review Map…", icon: "plugin", enabled: open, run: () => openReview(ctx) });
  api.menu.add(menu, { label: "Rewrite Strings…", icon: "plugin", enabled: open, run: () => openStrings(ctx) });
  api.menu.add(menu, { label: "Assistant", shortcut: "Ctrl+Shift+A", icon: "plugin", enabled: open, separator: true, command: "assistant" });
  api.menu.add(menu, { label: "Settings…", icon: "plugin", separator: true, command: "settings" });

  api.contextMenu.add("viewport", {
    label: "Redo this area with AI…",
    visible: (c) => c.markedArea !== null,
    run: (c) => void openRegion(ctx, c.markedArea),
  });
  api.contextMenu.add("viewport", {
    label: (c) => (c.markedArea ? "Ask AI about this area…" : api.selection.units().length || api.selection.locations().length || api.selection.sprites().length || api.selection.doodads().length ? "Ask AI about the selection…" : "Ask AI about this spot…"),
    enabled: open,
    run: (c) => {
      const where = c.markedArea
        ? `the marked area, tiles ${Math.min(c.markedArea.x0, c.markedArea.x1)},${Math.min(c.markedArea.y0, c.markedArea.y1)} to ${Math.max(c.markedArea.x0, c.markedArea.x1)},${Math.max(c.markedArea.y0, c.markedArea.y1)}`
        : api.selection.units().length || api.selection.locations().length || api.selection.sprites().length || api.selection.doodads().length ? "what I have selected"
        : c.tile ? `the spot at tile ${c.tile.x},${c.tile.y}` : "here";
      showAssistant().ask(`About ${where}: `, false);
    },
  });

  api.hotkeys.add("Ctrl+Shift+A", { command: "assistant" });

  // The buttons inside the editor's own dialogs: Map Properties, the trigger editors, the String Editor, Player Settings, Mission Briefing.
  installDialogSlots(ctx, { assistant: (text) => showAssistant().ask(text, false), explain: () => openExplain(ctx), triggers: () => openTriggers(ctx), strings: () => openStrings(ctx), briefing: () => openBriefing(ctx) });

  return () => { assistantPanel?.close(); ctx.presence?.remove(); };
}
