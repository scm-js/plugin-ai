/**
 * The AI Assistant: a floating panel with a conversation about the open map. A
 * message goes to the server's `agent` recipe with the tools in `tools.ts`, the map's
 * facts (what is selected, where the view is) and the per-map reference block; every
 * tool call the model makes runs here, all of a turn's calls answered together, and the
 * loop continues while the model keeps calling tools, up to the rounds the settings
 * allow. The transcript shows calls as compact rows with their results on hover,
 * screenshots inline, and after a turn that changed the map a line with what changed
 * and a button that undoes that turn's edits. The history is trimmed from the front,
 * keeping each tool call with its result.
 */
import type { AgentContent, AgentMessage, ImageInput } from "./protocol";
import { AiError, describeError, formatUsd } from "./client";
import { imageInput, mapFacts, selectionLines } from "./facts";
import { renderMarkdown } from "./markdown";
import { referenceFor } from "./reference";
import { capResult, describeCall, summarizeResult, toContent, tools, type Tool } from "./tools";
import { append, h, recipeOptions, requireServer, styled, type Ctx } from "./ui";

const KEEP_MESSAGES = 60;

/**
 * Drop the oldest messages past the limit — whole exchanges from the front, so a
 * tool call is never parted from its results and an assistant turn keeps the thinking
 * blocks it came with. The kept history always starts on a plain user message.
 */
export function trimHistory(messages: AgentMessage[], keep = KEEP_MESSAGES): AgentMessage[] {
  if (messages.length <= keep) return messages;
  let start = messages.length - keep;
  while (start < messages.length && (messages[start].role !== "user" || messages[start].content.some((c) => c.type === "tool_result"))) start++;
  return messages.slice(start);
}

/** The prompts offered as chips above the input. */
export const QUICK_PROMPTS: { label: string; text: string }[] = [
  { label: "Describe", text: "Describe this map: what kind of map it is, its layout, players and what the triggers do. Look at a screenshot first." },
  { label: "Check", text: "Check the map for problems: run the checker, look at the picture, the players and the triggers, and list what you would fix, most important first. Do not change anything yet." },
  { label: "Balance", text: "Is this melee map fair? Compare every start location's resources, distances and chokes and say what is uneven." },
  { label: "Selection", text: "Tell me about what I have selected." },
  { label: "Triggers", text: "Explain what the triggers do, in play order, briefly." },
];

export interface AssistantState {
  messages: AgentMessage[];
  /** Text to put in the input when the panel opens next (a context-menu ask). */
  prefill?: string;
}

export interface AssistantHandle {
  close(): void;
  isOpen(): boolean;
  /** Put text in the input and focus it (or send it when `send` is true). */
  ask(text: string, send?: boolean): void;
}

/** Whether a message content item is a turn's own text (not tool traffic). */
const isText = (c: AgentContent): c is Extract<AgentContent, { type: "text" }> => c.type === "text";

export function openAssistant(ctx: Ctx, state: AssistantState): AssistantHandle {
  const { api } = ctx;
  const w = api.ui.widgets;
  const toolList = tools();
  const byName = new Map(toolList.map((t) => [t.def.name, t]));
  let running: AbortController | null = null;
  let spent = 0;
  let askLater: ((text: string, send?: boolean) => void) | null = null;

  const handle = api.ui.panel({
    title: "AI Assistant",
    width: 440,
    mount(body) {
      const root = styled(body);
      const chat = h("div", { className: "ai-chat" });
      const input = h("textarea", { rows: 3, placeholder: "Ask about the map, or say what to change. Shift+Enter for a new line." });
      const status = h("div", { className: "ai-hint" }, "Nothing sent yet.");
      const context = h("div", { className: "ai-context" });
      const send = w.button("Send", { primary: true, onClick: () => void submit() });
      const stop = w.button("Stop", { ghost: true, onClick: () => running?.abort() });
      stop.hidden = true;
      const more = w.button("Continue", { onClick: () => void submit("Continue.") });
      more.hidden = true;
      const clearButton = w.button("Clear", { ghost: true, title: "Forget the conversation", onClick: () => { state.messages = []; chat.replaceChildren(); status.textContent = "Cleared."; more.hidden = true; } });
      const copyButton = w.button("Copy", { ghost: true, title: "Copy the transcript as text", onClick: () => { void navigator.clipboard?.writeText(transcript()).then(() => { status.textContent = "Transcript copied."; }); } });
      const attach = w.checkbox("Picture", { value: ctx.settings().attachView, title: "Send a picture of the visible area with the message" });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } });

      const transcript = () => state.messages.map((m) => m.content.filter(isText).map((c) => `${m.role === "user" ? "You" : "Assistant"}: ${c.text}`).join("\n")).filter(Boolean).join("\n\n");
      const scroll = () => { chat.scrollTop = chat.scrollHeight; };
      const addUser = (text: string) => { chat.append(h("div", { className: "ai-msg is-user" }, text)); scroll(); };
      const addAssistant = (text: string) => { const el = h("div", { className: "ai-msg is-assistant" }, renderMarkdown(text)); chat.append(el); scroll(); return el; };
      // The model's reasoning summary, when the server returned one; shown folded, never its signature.
      const addThinking = (text: string) => { if (!text.trim() || !ctx.settings().showThinking) return; chat.append(h("details", null, h("summary", null, "Reasoning"), h("div", { className: "ai-body" }, text))); scroll(); };
      const addTool = (tool: Tool | undefined, call: string) => {
        const mark = h("span", null, "…");
        const row = h("div", { className: "ai-tool", title: call }, h("span", { className: tool?.writes ? (tool.settings ? "ai-gold" : "ai-gold") : "ai-dim", title: tool?.writes ? (tool.settings ? "changes the map (a settings transaction, not undoable)" : "changes the map (one undo step)") : "reads" }, tool?.writes ? (tool.settings ? "✎" : "✎") : "▸"), h("code", null, call), mark);
        chat.append(row);
        scroll();
        return { row, mark };
      };
      const addNote = (text: string, ...extra: HTMLElement[]) => { chat.append(h("div", { className: "ai-turn" }, h("span", { className: "ai-grow" }, text), ...extra)); scroll(); };

      const refreshContext = () => {
        const lines = api.document.isOpen() ? selectionLines(api) : [];
        context.replaceChildren(h("span", { className: "ai-dim" }, lines.length ? `The model sees: ${lines.join(" · ")}` : "The model sees the map's state, your selection and the view with every message."));
      };
      refreshContext();
      const offSel = api.events.on("selection", refreshContext);
      const offClip = api.events.on("clipboard", refreshContext);
      const offDoc = api.events.on("document", () => { refreshContext(); });

      // Replay what the panel already holds.
      for (const m of state.messages) {
        for (const c of m.content) {
          if (c.type === "text") { if (m.role === "user") addUser(c.text); else addAssistant(c.text); }
          else if (c.type === "thinking") addThinking(c.thinking);
          else if (c.type === "tool_use") addTool(byName.get(c.name), describeCall(c.name, c.input)).mark.textContent = "✓";
        }
      }

      const viewPicture = async (): Promise<ImageInput | null> => {
        const v = api.view.visible();
        const info = api.document.info();
        if (!info) return null;
        const rect = { x0: Math.max(0, Math.floor(v.x0)), y0: Math.max(0, Math.floor(v.y0)), x1: Math.min(info.width, Math.ceil(v.x1)), y1: Math.min(info.height, Math.ceil(v.y1)) };
        let ppt = 8;
        while (ppt > 1 && (rect.x1 - rect.x0) * ppt * (rect.y1 - rect.y0) * ppt > 1_200_000) ppt = ppt > 8 ? ppt / 2 : ppt - 1;
        const blob = await api.graphics.renderRect(rect, { pixelsPerTile: ppt, units: true, sprites: true, locations: true, locationNames: true, startLocations: true, grid: 0 });
        return blob ? imageInput(blob) : null;
      };

      const submit = async (preset?: string) => {
        const text = (preset ?? input.value).trim();
        if (!text || running) return;
        if (!requireServer(ctx)) return;
        if (!api.document.isOpen()) { status.textContent = "Open a map first."; return; }
        if (!preset) input.value = "";
        more.hidden = true;
        addUser(text);
        const content: AgentContent[] = [{ type: "text", text }];
        if (attach.input.checked) {
          const picture = await viewPicture();
          if (picture) {
            content.unshift({ type: "image", source: picture });
            const v = api.view.visible();
            content[1] = { type: "text", text: `${text}\n\n(The picture is the visible area, tiles ${Math.floor(v.x0)},${Math.floor(v.y0)} to ${Math.ceil(v.x1)},${Math.ceil(v.y1)}.)` };
          }
        }
        state.messages.push({ role: "user", content });
        running = new AbortController();
        send.disabled = true;
        stop.hidden = false;
        const started = Date.now();
        const historyBefore = api.document.history().undoDepth;
        const edits: string[] = [];
        const settingsWrites: string[] = [];
        const maxRounds = Math.max(1, ctx.settings().maxRounds || 24);
        let stoppedAtLimit = false;
        try {
          for (let round = 0; round < maxRounds; round++) {
            status.textContent = `Asking the model… (${round === 0 ? "first" : `round ${round + 1}`}, ${Math.round((Date.now() - started) / 1000)} s)`;
            const r = await ctx.client.run("agent", {
              messages: trimHistory(state.messages),
              tools: toolList.map((t) => t.def),
              facts: mapFacts(api, { triggers: false, assistant: true }),
              reference: referenceFor(api),
            }, {
              signal: running.signal,
              onProgress: () => { status.textContent = `Asking the model… (${Math.round((Date.now() - started) / 1000)} s)`; },
            }, recipeOptions(ctx.settings()));
            spent += r.usage.costUsd;
            // Kept exactly as returned — thinking blocks included — and sent back unchanged next
            // turn, since the model refuses to continue a tool-using turn without them.
            const answer = r.output.content;
            state.messages.push({ role: "assistant", content: answer });
            for (const c of answer) {
              if (c.type === "thinking") addThinking(c.thinking);
              else if (c.type === "text" && c.text.trim()) addAssistant(c.text);
            }
            const calls = answer.filter((c): c is Extract<AgentContent, { type: "tool_use" }> => c.type === "tool_use");
            if (r.output.stopReason === "refusal") { status.textContent = "The model declined."; break; }
            if (calls.length === 0 || r.output.stopReason !== "tool_use") break;
            const results: AgentContent[] = [];
            for (const call of calls) {
              const tool = byName.get(call.name);
              const { mark, row } = addTool(tool, describeCall(call.name, call.input));
              status.textContent = `Running ${call.name}…`;
              try {
                if (!tool) throw new Error(`no tool called ${call.name}`);
                const out = await tool.run(call.input ?? {}, ctx);
                if (typeof out !== "string" && out.image) {
                  const img = h("img", { src: `data:${out.image.mediaType};base64,${out.image.data}`, alt: "screenshot" });
                  chat.append(h("div", { className: "ai-shot" }, img));
                  scroll();
                }
                results.push(toContent(call.id, typeof out === "string" ? capResult(out) : out));
                mark.textContent = "✓";
                row.title = `${describeCall(call.name, call.input)}\n→ ${summarizeResult(out)}`;
                if (tool.writes) (tool.settings ? settingsWrites : edits).push(call.name);
              } catch (err) {
                results.push(toContent(call.id, `Error: ${(err as Error).message}`, true));
                mark.textContent = "✗";
                row.classList.add("ai-bad");
                row.title = `${describeCall(call.name, call.input)}\n✗ ${(err as Error).message}`;
              }
            }
            state.messages.push({ role: "user", content: results });
            if (round === maxRounds - 1) stoppedAtLimit = true;
          }
          const secs = Math.round((Date.now() - started) / 1000);
          if (stoppedAtLimit) { status.textContent = `Stopped after ${maxRounds} rounds of tool calls (AI Settings sets the limit).`; more.hidden = false; }
          else if (!status.textContent.startsWith("The model")) status.textContent = `Done in ${secs} s · ${formatUsd(spent)} in this panel · ${ctx.ledger.summary()}`;
          const undoSteps = Math.max(0, api.document.history().undoDepth - historyBefore);
          if (edits.length || settingsWrites.length) {
            const parts: string[] = [];
            if (edits.length) parts.push(`${edits.length} edit${edits.length === 1 ? "" : "s"}`);
            if (settingsWrites.length) parts.push(`${settingsWrites.length} settings change${settingsWrites.length === 1 ? "" : "s"} (not undoable)`);
            const undoButton = undoSteps > 0 ? w.button(`Undo ${undoSteps === 1 ? "it" : `these ${undoSteps}`}`, { ghost: true, title: "Undo the edits this turn made, newest first", onClick: (e) => {
              let n = 0;
              for (let i = 0; i < undoSteps; i++) { const label = api.document.history().undo; if (!label || !label.startsWith("AI:")) break; if (!api.document.undo()) break; n++; }
              (e.currentTarget as HTMLButtonElement).disabled = true;
              status.textContent = `Undid ${n} edit${n === 1 ? "" : "s"}.`;
            } }) : null;
            addNote(`This turn: ${parts.join(", ")}.`, ...(undoButton ? [undoButton] : []));
          }
        } catch (err) {
          const aborted = err instanceof AiError && err.code === "aborted";
          status.textContent = aborted ? "Stopped." : describeError(err);
          // Keep the history consistent: drop a user message the model never answered.
          const last = state.messages[state.messages.length - 1];
          if (last?.role === "user") state.messages.pop();
          if (!aborted) chat.append(h("div", { className: "ai-msg is-assistant ai-bad" }, describeError(err)));
        } finally {
          running = null;
          send.disabled = false;
          stop.hidden = true;
          input.focus();
        }
      };

      const chipRow = h("div", { className: "ai-chips" }, ...QUICK_PROMPTS.map((q) => h("button", { type: "button", className: "ai-chip", title: q.text, onClick: () => { input.value = q.text; input.focus(); } }, q.label)));

      append(root, [
        chat,
        context,
        chipRow,
        input,
        h("div", { className: "ai-btns" }, send, stop, more, attach, h("span", { style: "flex: 1" }), copyButton, clearButton),
        status,
      ]);
      askLater = (text, sendNow) => { input.value = text; input.focus(); if (sendNow) void submit(); };
      if (state.prefill) { const t = state.prefill; state.prefill = undefined; askLater(t); }
      else input.focus();
      return () => { running?.abort(); offSel.dispose(); offClip.dispose(); offDoc.dispose(); askLater = null; };
    },
  });
  return {
    close: () => handle.close(),
    isOpen: () => handle.isOpen(),
    ask: (text, sendNow) => { if (askLater) askLater(text, sendNow); else state.prefill = text; },
  };
}
