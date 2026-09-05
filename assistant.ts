/**
 * The AI Assistant: a conversation about the open map, in a panel docked beside it (or
 * floating, by Settings). A message goes to the server's `agent` recipe with the tools in
 * `tools.ts`, the map's facts (what is selected, where the view is) and the per-map
 * reference block; every tool call the model makes runs here, all of a turn's calls
 * answered together, and the loop continues while the model keeps calling tools, up to
 * the rounds the settings allow.
 *
 * What the person sees while it works is the point of this file. A *state strip* names
 * the phase — waiting, thinking, writing, running a tool — with the seconds and the cost;
 * the model's words stream in as they arrive; a tool call shows as a pending row the
 * moment the model commits to it and fills in when it runs; the map shows the call's
 * footprint in teal while it runs (an overlay) and flashes the result in gold
 * (`api.view.flash`); the status bar carries the same state so the panel can be closed;
 * Escape stops. After a turn that changed the map a line says what changed with a button
 * that undoes that turn's edits. The history is trimmed from the front in chunks, keeping
 * each tool call with its result — a chunk rather than one message at a time, because
 * every trim invalidates the server's cache of the conversation.
 */
import type { EditorLayer, OverlayHandle, PluginApi } from "@scm-js/plugin-api";
import type { AgentContent, AgentMessage, ImageInput } from "./protocol";
import { AiError, describeError, formatUsd } from "./client";
import { imageInput, mapFacts, selectionLines } from "./facts";
import { footprintEmpty, footprintOf, type Footprint } from "./intent";
import { renderMarkdown } from "./markdown";
import { referenceFor } from "./reference";
import { capResult, describeCall, summarizeResult, toContent, tools, type Tool } from "./tools";
import { append, h, recipeOptions, requireServer, styled, type Ctx } from "./ui";

/** Past this many messages the history is trimmed… */
export const KEEP_MESSAGES = 60;
/** …down to this many, so the cache is rebuilt once per chunk rather than once per message. */
export const TRIM_TO = 40;
/** Pictures older than this many kept ones are dropped from the history (each is re-sent every round). */
export const KEEP_IMAGES = 2;

/**
 * Drop the oldest messages past the limit — down to `to`, whole exchanges from the front,
 * so a tool call is never parted from its results and an assistant turn keeps the thinking
 * blocks it came with. The kept history always starts on a plain user message. Older
 * pictures go with the trim: a screenshot the model took twenty rounds ago is a few
 * hundred kilobytes re-uploaded on every round for nothing, and the request body has a cap.
 */
export function trimHistory(messages: AgentMessage[], keep = KEEP_MESSAGES, to = TRIM_TO): AgentMessage[] {
  if (messages.length <= keep) return messages;
  let start = Math.max(0, messages.length - Math.min(to, keep));
  while (start < messages.length && (messages[start].role !== "user" || messages[start].content.some((c) => c.type === "tool_result"))) start++;
  return pruneImages(messages.slice(start), KEEP_IMAGES);
}

/** Replace every picture but the last `keepLast` with a note, copying only the messages that change. */
export function pruneImages(messages: AgentMessage[], keepLast: number): AgentMessage[] {
  let seen = 0;
  const out: AgentMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    let changed = false;
    const content = m.content.map((c): AgentContent => {
      if (c.type === "image") { seen++; if (seen > keepLast) { changed = true; return { type: "text", text: "(a picture that was here is no longer kept)" }; } return c; }
      if (c.type === "tool_result" && Array.isArray(c.content)) {
        let inner = false;
        const parts = c.content.map((p) => { if (p.type === "image") { seen++; if (seen > keepLast) { inner = true; return { type: "text" as const, text: "(picture no longer kept)" }; } } return p; });
        if (inner) { changed = true; return { ...c, content: parts }; }
      }
      return c;
    });
    out.unshift(changed ? { ...m, content } : m);
  }
  return out;
}

/** The prompts offered as chips above the input, by what the person is doing. */
export function chipsFor(layer: EditorLayer | string, selected: number, triggers: number): { label: string; text: string }[] {
  const chips: { label: string; text: string }[] = [
    { label: "Describe", text: "Describe this map: what kind of map it is, its layout, players and what the triggers do. Look at a screenshot first." },
    { label: "Check", text: "Check the map for problems: run the checker, look at the picture, the players and the triggers, and list what you would fix, most important first. Do not change anything yet." },
  ];
  if (selected > 0) chips.push({ label: "Selection", text: "Tell me about what I have selected." });
  switch (layer) {
    case "terrain": chips.push({ label: "Terrain", text: "Look at the terrain in view: heights, chokes, dead ends, and what you would change." }); break;
    case "units": chips.push(selected > 0 ? { label: "Balance", text: "Is this melee map fair? Compare every start location's resources, distances and chokes and say what is uneven." } : { label: "Bases", text: "List the bases: each start location with its mineral count, geysers and the nearest expansion." }); break;
    case "locations": chips.push({ label: "Locations", text: "List the locations and which triggers use each; point out any that nothing uses." }); break;
    case "fog": chips.push({ label: "Fog", text: "Which players start with which parts of the map explored? Is it even?" }); break;
    default: break;
  }
  if (triggers > 0) chips.push({ label: "Triggers", text: "Explain what the triggers do, in play order, briefly." });
  else chips.push({ label: "Scenario", text: "I want to turn this into a scenario. Read the guide for the genre I name, then propose the players, locations and systems before changing anything." });
  return chips;
}

/** The chips a fresh map on the terrain layer gets. */
export const QUICK_PROMPTS = chipsFor("terrain", 0, 0);

export interface AssistantState {
  messages: AgentMessage[];
  /** Text to put in the input when the panel opens next (a context-menu ask). */
  prefill?: string;
  /** What this panel has cost, across opens. */
  spent?: number;
}

export interface AssistantHandle {
  close(): void;
  isOpen(): boolean;
  /** Put text in the input and focus it (or send it when `send` is true). */
  ask(text: string, send?: boolean): void;
}

type Phase = "idle" | "waiting" | "thinking" | "writing" | "tools" | "stopped" | "failed";

const PHASE_LABELS: Record<Phase, string> = { idle: "Ready", waiting: "Waiting for the model", thinking: "Thinking", writing: "Writing", tools: "Working on the map", stopped: "Stopped", failed: "Failed" };

/** Whether a message content item is a turn's own text (not tool traffic). */
const isText = (c: AgentContent): c is Extract<AgentContent, { type: "text" }> => c.type === "text";

/** The teal outline of what the assistant is about to touch, drawn by an overlay while a tool runs. */
function intentOverlay(api: PluginApi): { handle: OverlayHandle; show(f: Footprint | null): void } {
  let footprint: Footprint | null = null;
  const handle = api.ui.overlay({
    name: "AI activity",
    above: "objects",
    visible: true,
    draw(ctx, view) {
      if (!footprint) return;
      const scn = api.document.scenario();
      const boxes: { l: number; t: number; r: number; b: number }[] = footprint.rects.map((r) => ({ l: r.x0 * 32, t: r.y0 * 32, r: r.x1 * 32, b: r.y1 * 32 }));
      if (scn) {
        for (const i of footprint.units) { const u = scn.units[i]; if (u) boxes.push({ l: u.x - 16, t: u.y - 16, r: u.x + 16, b: u.y + 16 }); }
        for (const i of footprint.locations) { const l = scn.locations[i]; if (l && i !== 63) boxes.push({ l: Math.min(l.left, l.right), t: Math.min(l.top, l.bottom), r: Math.max(l.left, l.right), b: Math.max(l.top, l.bottom) }); }
      }
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = -((Date.now() / 40) % 10);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(79, 209, 197, 0.95)";
      ctx.fillStyle = "rgba(79, 209, 197, 0.10)";
      for (const b of boxes) {
        const x = view.x(b.l), y = view.y(b.t), w = (b.r - b.l) * view.zoom, hgt = (b.b - b.t) * view.zoom;
        ctx.fillRect(x, y, w, hgt);
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(hgt) - 1);
      }
      ctx.restore();
    },
  });
  return { handle, show: (f) => { footprint = f && !footprintEmpty(f) ? f : null; handle.redraw(); } };
}

export function openAssistant(ctx: Ctx, state: AssistantState): AssistantHandle {
  const { api } = ctx;
  const w = api.ui.widgets;
  const toolList = tools();
  const byName = new Map(toolList.map((t) => [t.def.name, t]));
  let running: AbortController | null = null;
  let askLater: ((text: string, send?: boolean) => void) | null = null;
  const dock = ctx.settings().dockAssistant;

  const handle = api.ui.panel({
    title: "AI Assistant",
    width: 440,
    dock: dock ? "right" : "float",
    grow: true,
    mount(body) {
      const root = styled(body);
      root.classList.add("ai-assistant");
      const intent = intentOverlay(api);

      /* ── the state strip ── */
      const phaseLabel = h("span", { className: "ai-phase" }, "Ready");
      const phaseDetail = h("span", { className: "ai-dim ai-grow ai-phase-detail" }, "");
      const clock = h("span", { className: "ai-dim ai-mono" }, "");
      const cost = h("span", { className: "ai-pill", title: "What this panel has cost · what the session has cost" }, "");
      const shimmer = h("div", { className: "ai-shimmer", hidden: true }, h("i"));
      const strip = h("div", { className: "ai-state is-idle" }, h("div", { className: "ai-state-line" }, phaseLabel, phaseDetail, clock, cost), shimmer);
      let phase: Phase = "idle";
      let startedAt = 0;
      let clockTimer: number | null = null;
      const setCost = () => { cost.textContent = state.spent ? `${formatUsd(state.spent)} here · ${formatUsd(ctx.ledger.totals.costUsd)} session` : ctx.ledger.totals.calls ? `${formatUsd(ctx.ledger.totals.costUsd)} session` : ""; };
      const tickClock = () => { clock.textContent = startedAt ? `${Math.round((Date.now() - startedAt) / 1000)} s` : ""; };
      const setPhase = (next: Phase, detail = "") => {
        phase = next;
        strip.className = `ai-state is-${next}`;
        phaseLabel.textContent = PHASE_LABELS[next];
        phaseDetail.textContent = detail;
        const busy = next === "waiting" || next === "thinking" || next === "writing" || next === "tools";
        shimmer.hidden = !busy;
        if (busy && clockTimer === null) { tickClock(); clockTimer = window.setInterval(tickClock, 1000); }
        if (!busy && clockTimer !== null) { window.clearInterval(clockTimer); clockTimer = null; clock.textContent = ""; }
        ctx.presence?.set({ text: busy ? `AI · ${PHASE_LABELS[next].toLowerCase()}${detail ? ` · ${detail}` : ""}` : state.spent ? `AI · ${formatUsd(state.spent)}` : "AI", busy, warn: next === "failed" });
        setCost();
      };
      setCost();

      /* ── the transcript ── */
      const chat = h("div", { className: "ai-chat" });
      const scroll = () => { chat.scrollTop = chat.scrollHeight; };
      const addUser = (text: string) => { chat.append(h("div", { className: "ai-msg is-user" }, text)); scroll(); };
      const addAssistant = (text: string) => { const el = h("div", { className: "ai-msg is-assistant" }, renderMarkdown(text)); chat.append(el); scroll(); return el; };
      // The model's reasoning summary, streamed while it thinks; shown folded, never its signature.
      const addThinking = (): ((text: string) => void) => {
        if (!ctx.settings().showThinking) return () => {};
        let fold: HTMLDetailsElement | null = null;
        let foldBody: HTMLElement | null = null;
        return (text) => {
          if (!text) return;
          if (!fold) { foldBody = h("div", { className: "ai-body" }); fold = h("details", null, h("summary", null, "Reasoning"), foldBody); chat.append(fold); }
          foldBody!.append(document.createTextNode(text));
          scroll();
        };
      };
      const addTool = (tool: Tool | undefined, call: string, pending: boolean) => {
        const mark = h("span", { className: pending ? "ai-tool-mark ai-spin" : "ai-tool-mark" }, pending ? "" : "…");
        const code = h("code", null, call);
        const row = h("div", { className: `ai-tool${pending ? " is-pending" : ""}`, title: call },
          h("span", { className: tool?.writes ? "ai-gold" : "ai-dim", title: tool?.writes ? (tool.settings ? "changes the map (a settings transaction, not undoable)" : "changes the map (one undo step)") : "reads" }, tool?.writes ? "✎" : "▸"),
          code, mark);
        chat.append(row);
        scroll();
        return { row, mark, code };
      };
      const addNote = (text: string, ...extra: HTMLElement[]) => { chat.append(h("div", { className: "ai-turn" }, h("span", { className: "ai-grow" }, text), ...extra)); scroll(); };

      /* ── what the model sees, and the chips ── */
      const context = h("div", { className: "ai-context" });
      const chipRow = h("div", { className: "ai-chips" });
      const input = h("textarea", { rows: 3, placeholder: "Ask about the map, or say what to change. Enter sends, Shift+Enter for a new line, Esc stops." });
      const refreshContext = () => {
        const open = api.document.isOpen();
        const lines = open ? selectionLines(api) : [];
        context.replaceChildren(h("span", { className: "ai-dim" }, lines.length ? `The model sees: ${lines.join(" · ")}` : "The model sees the map's state, your selection and the view with every message."));
        const selected = open ? api.selection.units().length + api.selection.locations().length + api.selection.sprites().length + api.selection.doodads().length + (api.selection.markedArea() ? 1 : 0) : 0;
        chipRow.replaceChildren(...chipsFor(open ? api.selection.layer() : "terrain", selected, open ? api.triggers.list().length : 0).map((q) => h("button", { type: "button", className: "ai-chip", title: q.text, onClick: () => { input.value = q.text; input.focus(); } }, q.label)));
      };
      refreshContext();
      const offs = [api.events.on("selection", refreshContext), api.events.on("clipboard", refreshContext), api.events.on("document", refreshContext), api.events.on("layer", refreshContext), api.events.on("triggers", refreshContext)];

      /* ── buttons ── */
      const send = w.button("Send", { primary: true, onClick: () => void submit() });
      const stop = w.button("Stop", { ghost: true, onClick: () => running?.abort() });
      stop.hidden = true;
      const more = w.button("Continue", { onClick: () => void submit("Continue.") });
      more.hidden = true;
      const clearButton = w.button("Clear", { ghost: true, title: "Forget the conversation", onClick: () => { state.messages = []; chat.replaceChildren(); more.hidden = true; setPhase("idle"); } });
      const copyButton = w.button("Copy", { ghost: true, title: "Copy the transcript as text", onClick: () => { void navigator.clipboard?.writeText(transcript()).then(() => { phaseDetail.textContent = "Transcript copied."; }); } });
      const attach = w.checkbox("Picture", { value: ctx.settings().attachView, title: "Send a picture of the visible area with the message" });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
        if (e.key === "Escape" && running) { e.preventDefault(); running.abort(); }
      });
      root.addEventListener("keydown", (e) => { if (e.key === "Escape" && running && e.target !== input) { e.preventDefault(); running.abort(); } });

      const transcript = () => state.messages.map((m) => m.content.filter(isText).map((c) => `${m.role === "user" ? "You" : "Assistant"}: ${c.text}`).join("\n")).filter(Boolean).join("\n\n");

      // Replay what the panel already holds.
      for (const m of state.messages) {
        for (const c of m.content) {
          if (c.type === "text") { if (m.role === "user") addUser(c.text); else addAssistant(c.text); }
          else if (c.type === "thinking") addThinking()(c.thinking);
          else if (c.type === "tool_use") addTool(byName.get(c.name), describeCall(c.name, c.input), false).mark.textContent = "✓";
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

      /** Run one tool call, showing its footprint while it runs and flashing what it touched after. */
      const runTool = async (call: Extract<AgentContent, { type: "tool_use" }>, row: ReturnType<typeof addTool>): Promise<{ result: AgentContent; tool: Tool | undefined; failed: boolean }> => {
        const tool = byName.get(call.name);
        const described = describeCall(call.name, call.input ?? {});
        row.code.textContent = described;
        row.row.title = described;
        row.row.classList.remove("is-pending");
        row.mark.className = "ai-tool-mark ai-spin";
        row.mark.textContent = "";
        setPhase("tools", call.name.replace(/_/g, " "));
        const footprint = footprintOf(api, call.name, call.input ?? {});
        intent.show(footprint);
        try {
          if (!tool) throw new Error(`no tool called ${call.name}`);
          const out = await tool.run(call.input ?? {}, ctx);
          if (typeof out !== "string" && out.image) {
            chat.append(h("div", { className: "ai-shot" }, h("img", { src: `data:${out.image.mediaType};base64,${out.image.data}`, alt: "screenshot" })));
            scroll();
          }
          row.mark.className = "ai-tool-mark";
          row.mark.textContent = "✓";
          row.row.title = `${described}\n→ ${summarizeResult(out)}`;
          if (!footprintEmpty(footprint)) {
            const kind = tool.writes ? "change" : "attention";
            for (const r of footprint.rects) api.view.flash({ rect: r, kind, ms: tool.writes ? 700 : 400 });
            if (footprint.units.length) api.view.flash({ units: footprint.units, kind });
            if (footprint.locations.length) api.view.flash({ locations: footprint.locations, kind });
          }
          return { result: toContent(call.id, typeof out === "string" ? capResult(out) : out), tool, failed: false };
        } catch (err) {
          row.mark.className = "ai-tool-mark";
          row.mark.textContent = "✗";
          row.row.classList.add("ai-bad");
          row.row.title = `${described}\n✗ ${(err as Error).message}`;
          return { result: toContent(call.id, `Error: ${(err as Error).message}`, true), tool, failed: true };
        } finally {
          intent.show(null);
        }
      };

      const submit = async (preset?: string) => {
        const text = (preset ?? input.value).trim();
        if (!text || running) return;
        if (!requireServer(ctx)) return;
        if (!api.document.isOpen()) { setPhase("failed", "Open a map first."); return; }
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
        startedAt = Date.now();
        const historyBefore = api.document.history().undoDepth;
        const edits: string[] = [];
        const settingsWrites: string[] = [];
        const maxRounds = Math.max(1, ctx.settings().maxRounds || 24);
        let stoppedAtLimit = false;
        try {
          for (let round = 0; round < maxRounds; round++) {
            setPhase("waiting", round === 0 ? "" : `round ${round + 1}`);
            // What streams in: the words into a message that grows, the reasoning into its fold, tool starts into pending rows.
            let streamed = "";
            const stream: { el: HTMLElement | null } = { el: null };
            let renderQueued = false;
            const think = addThinking();
            const pendingRows = new Map<string, ReturnType<typeof addTool>>();
            const paint = () => { renderQueued = false; if (stream.el) { stream.el.replaceChildren(renderMarkdown(streamed), h("span", { className: "ai-caret" })); scroll(); } };
            state.messages = trimHistory(state.messages);
            const r = await ctx.client.run("agent", {
              messages: state.messages,
              tools: toolList.map((t) => t.def),
              facts: mapFacts(api, { triggers: false, assistant: true }),
              reference: referenceFor(api),
            }, {
              signal: running.signal,
              onThinking: (t) => { if (phase === "waiting") setPhase("thinking"); think(t); },
              onDelta: (t) => {
                if (phase !== "writing") setPhase("writing");
                streamed += t;
                if (!stream.el) { stream.el = h("div", { className: "ai-msg is-assistant" }); chat.append(stream.el); }
                if (!renderQueued) { renderQueued = true; requestAnimationFrame(paint); }
              },
              onToolUse: (id, name) => { setPhase("tools", `${name.replace(/_/g, " ")}…`); pendingRows.set(id, addTool(byName.get(name), `${name}(…)`, true)); },
              onProgress: () => { if (phase === "waiting" || phase === "thinking") tickClock(); },
            }, recipeOptions(ctx.settings()));
            state.spent = (state.spent ?? 0) + r.usage.costUsd;
            setCost();
            // Kept exactly as returned — thinking blocks included — and sent back unchanged next
            // turn, since the model refuses to continue a tool-using turn without them.
            const answer = r.output.content;
            state.messages.push({ role: "assistant", content: answer });
            const finalText = answer.filter(isText).map((c) => c.text).join("\n\n").trim();
            if (stream.el) { if (finalText) stream.el.replaceChildren(renderMarkdown(finalText)); else stream.el.remove(); }
            else if (finalText) addAssistant(finalText);
            const calls = answer.filter((c): c is Extract<AgentContent, { type: "tool_use" }> => c.type === "tool_use");
            if (r.output.stopReason === "refusal") { setPhase("failed", "The model declined."); break; }
            if (calls.length === 0 || r.output.stopReason !== "tool_use") break;
            const results: AgentContent[] = [];
            for (const call of calls) {
              const row = pendingRows.get(call.id) ?? addTool(byName.get(call.name), describeCall(call.name, call.input ?? {}), false);
              pendingRows.delete(call.id);
              const { result, tool, failed } = await runTool(call, row);
              results.push(result);
              if (tool?.writes && !failed) (tool.settings ? settingsWrites : edits).push(call.name);
            }
            for (const row of pendingRows.values()) { row.mark.className = "ai-tool-mark"; row.mark.textContent = "✗"; row.row.title = "The model named this tool but did not call it."; }
            state.messages.push({ role: "user", content: results });
            if (round === maxRounds - 1) stoppedAtLimit = true;
          }
          const secs = Math.round((Date.now() - startedAt) / 1000);
          if (stoppedAtLimit) { setPhase("stopped", `after ${maxRounds} rounds of tool calls; AI Settings sets the limit`); more.hidden = false; }
          else if (phase !== "failed") setPhase("idle", `Done in ${secs} s`);
          const undoSteps = Math.max(0, api.document.history().undoDepth - historyBefore);
          if (edits.length || settingsWrites.length) {
            const parts: string[] = [];
            if (edits.length) parts.push(`${edits.length} edit${edits.length === 1 ? "" : "s"}`);
            if (settingsWrites.length) parts.push(`${settingsWrites.length} settings change${settingsWrites.length === 1 ? "" : "s"} (not undoable)`);
            const undoButton = undoSteps > 0 ? w.button(`Undo ${undoSteps === 1 ? "it" : `these ${undoSteps}`}`, { ghost: true, title: "Undo the edits this turn made, newest first", onClick: (e) => {
              let count = 0;
              for (let i = 0; i < undoSteps; i++) { const label = api.document.history().undo; if (!label || !label.startsWith("AI:")) break; if (!api.document.undo()) break; count++; }
              (e.currentTarget as HTMLButtonElement).disabled = true;
              phaseDetail.textContent = `Undid ${count} edit${count === 1 ? "" : "s"}.`;
            } }) : null;
            addNote(`This turn: ${parts.join(", ")}.`, ...(undoButton ? [undoButton] : []));
          }
        } catch (err) {
          const aborted = err instanceof AiError && err.code === "aborted";
          setPhase(aborted ? "stopped" : "failed", aborted ? "" : describeError(err));
          // Keep the history consistent: drop a user message the model never answered.
          const last = state.messages[state.messages.length - 1];
          if (last?.role === "user") state.messages.pop();
          if (!aborted) chat.append(h("div", { className: "ai-msg is-assistant ai-bad" }, describeError(err)));
        } finally {
          running = null;
          startedAt = 0;
          send.disabled = false;
          stop.hidden = true;
          intent.show(null);
          input.focus();
        }
      };

      append(root, [
        strip,
        chat,
        context,
        chipRow,
        input,
        h("div", { className: "ai-btns" }, send, stop, more, attach, h("span", { style: "flex: 1" }), copyButton, clearButton),
      ]);
      askLater = (text, sendNow) => { input.value = text; input.focus(); if (sendNow) void submit(); };
      if (state.prefill) { const t = state.prefill; state.prefill = undefined; askLater(t); }
      else input.focus();
      return () => {
        running?.abort();
        for (const o of offs) o.dispose();
        intent.handle.remove();
        if (clockTimer !== null) window.clearInterval(clockTimer);
        ctx.presence?.set({ text: state.spent ? `AI · ${formatUsd(state.spent)}` : "AI", busy: false, warn: false });
        askLater = null;
      };
    },
  });
  return {
    close: () => handle.close(),
    isOpen: () => handle.isOpen(),
    ask: (text, sendNow) => { if (askLater) askLater(text, sendNow); else state.prefill = text; },
  };
}
