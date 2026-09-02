/**
 * The AI Assistant: a floating panel with a conversation about the open map. A
 * message goes to the server's `agent` recipe with the tools in `tools.ts`; every
 * tool call the model makes runs here, all of a turn's calls answered together, and
 * the loop continues while the model keeps calling tools, up to a limit per message.
 * The transcript shows calls as compact rows and screenshots inline; the history is
 * trimmed from the front, keeping each tool call with its result.
 */
import type { AgentContent, AgentMessage } from "./protocol";
import { AiError, describeError, formatUsd } from "./client";
import { mapFacts } from "./facts";
import { renderMarkdown } from "./markdown";
import { capResult, describeCall, toContent, tools, type Tool } from "./tools";
import { append, h, recipeOptions, requireServer, styled, type Ctx } from "./ui";

const MAX_ROUNDS = 12;
const KEEP_MESSAGES = 40;

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

export interface AssistantState {
  messages: AgentMessage[];
}

export function openAssistant(ctx: Ctx, state: AssistantState) {
  const { api } = ctx;
  const w = api.ui.widgets;
  const toolList = tools();
  const byName = new Map(toolList.map((t) => [t.def.name, t]));
  let running: AbortController | null = null;
  let spent = 0;

  const handle = api.ui.panel({
    title: "AI Assistant",
    width: 380,
    mount(body, panel) {
      const root = styled(body);
      const chat = h("div", { className: "ai-chat" });
      const input = h("textarea", { rows: 3, placeholder: "Ask about the map, or say what to change. Shift+Enter for a new line." });
      const status = h("div", { className: "ai-hint" }, "Nothing sent yet.");
      const send = w.button("Send", { primary: true, onClick: () => void submit() });
      const stop = w.button("Stop", { ghost: true, onClick: () => running?.abort() });
      stop.hidden = true;
      const clearButton = w.button("Clear", { ghost: true, onClick: () => { state.messages = []; chat.replaceChildren(); status.textContent = "Cleared."; } });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } });

      const scroll = () => { chat.scrollTop = chat.scrollHeight; };
      const addUser = (text: string) => { chat.append(h("div", { className: "ai-msg is-user" }, text)); scroll(); };
      const addAssistant = (text: string) => { const el = h("div", { className: "ai-msg is-assistant" }, renderMarkdown(text)); chat.append(el); scroll(); return el; };
      // The model's reasoning summary, when the server returned one; shown folded, never its signature.
      const addThinking = (text: string) => { if (!text.trim() || !ctx.settings().showThinking) return; chat.append(h("details", null, h("summary", null, "Reasoning"), h("div", { className: "ai-body" }, text))); scroll(); };
      const addTool = (tool: Tool | undefined, call: string) => {
        const mark = h("span", null, "…");
        const row = h("div", { className: "ai-tool", title: call }, h("span", { className: tool?.writes ? "ai-gold" : "ai-dim" }, tool?.writes ? "✎" : "▸"), h("code", null, call), mark);
        chat.append(row);
        scroll();
        return { row, mark };
      };

      // Replay what the panel already holds.
      for (const m of state.messages) {
        for (const c of m.content) {
          if (c.type === "text") { if (m.role === "user") addUser(c.text); else addAssistant(c.text); }
          else if (c.type === "thinking") addThinking(c.thinking);
          else if (c.type === "tool_use") addTool(byName.get(c.name), describeCall(c.name, c.input)).mark.textContent = "✓";
        }
      }

      const submit = async () => {
        const text = input.value.trim();
        if (!text || running) return;
        if (!requireServer(ctx)) return;
        input.value = "";
        addUser(text);
        state.messages.push({ role: "user", content: [{ type: "text", text }] });
        running = new AbortController();
        send.disabled = true;
        stop.hidden = false;
        const started = Date.now();
        try {
          for (let round = 0; round < MAX_ROUNDS; round++) {
            status.textContent = `Asking the model… (${round === 0 ? "first" : `round ${round + 1}`}, ${Math.round((Date.now() - started) / 1000)} s)`;
            const r = await ctx.client.run("agent", {
              messages: trimHistory(state.messages),
              tools: toolList.map((t) => t.def),
              facts: mapFacts(api, { triggers: false }),
            }, {
              signal: running.signal,
              onProgress: () => { status.textContent = `Asking the model… (${Math.round((Date.now() - started) / 1000)} s)`; },
            }, recipeOptions(ctx.settings()));
            spent += r.usage.costUsd;
            // Kept exactly as returned — thinking blocks included — and sent back unchanged next
            // turn, since the model refuses to continue a tool-using turn without them.
            const content = r.output.content;
            state.messages.push({ role: "assistant", content });
            for (const c of content) {
              if (c.type === "thinking") addThinking(c.thinking);
              else if (c.type === "text" && c.text.trim()) addAssistant(c.text);
            }
            const calls = content.filter((c): c is Extract<AgentContent, { type: "tool_use" }> => c.type === "tool_use");
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
              } catch (err) {
                results.push(toContent(call.id, `Error: ${(err as Error).message}`, true));
                mark.textContent = "✗";
                row.classList.add("ai-bad");
              }
            }
            state.messages.push({ role: "user", content: results });
            if (round === MAX_ROUNDS - 1) status.textContent = `Stopped after ${MAX_ROUNDS} rounds of tool calls; say "continue" to go on.`;
          }
          if (!status.textContent.startsWith("Stopped") && !status.textContent.startsWith("The model")) status.textContent = `Done in ${Math.round((Date.now() - started) / 1000)} s · ${formatUsd(spent)} in this panel · ${ctx.ledger.summary()}`;
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

      append(root, [
        chat,
        input,
        h("div", { className: "ai-btns" }, send, stop, clearButton, h("span", { className: "ai-hint", style: "flex: 1" }, "Every change is its own undo step.")),
        status,
      ]);
      input.focus();
      void panel;
      return () => { running?.abort(); };
    },
  });
  return handle;
}
