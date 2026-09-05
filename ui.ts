/**
 * What every dialog shares: the context object they are opened with, a DOM helper,
 * the plugin's stylesheet, and the *runner* — the strip that shows the model, a
 * progress bar with a live elapsed counter, the reasoning summary when asked for, a
 * Stop button while a request is out, and the cost once it is back.
 */
import type { PluginApi, StatusItemHandle } from "@scm-js/plugin-api";
import type { RecipeInputs, RecipeName, RecipeOptions, Usage } from "./protocol";
import type { AccountManager } from "./account";
import { AiClient, AiError, describeError, formatUsage, type Ledger, type RunHooks, type RunResult } from "./client";
import type { Settings } from "./settings";

export interface Ctx {
  api: PluginApi;
  settings: () => Settings;
  client: AiClient;
  ledger: Ledger;
  account: AccountManager;
  openSettings: () => void;
  /** The plugin's status bar cell, when the host has one; the assistant reports its phase there. */
  presence?: StatusItemHandle | null;
}

/* ── DOM ────────────────────────────────────────────────── */

export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") el.className = String(v);
      else if (k === "style") el.setAttribute("style", String(v));
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export const STYLE = `
.ai { display: flex; flex-direction: column; gap: 8px; font-size: 12px; min-width: 0; }
.ai .ai-row { display: grid; grid-template-columns: 96px 1fr; align-items: center; gap: 6px; min-height: 22px; }
.ai .ai-row > label { color: var(--text-dim, #99a2b3); }
.ai .ai-row select, .ai .ai-row input[type=text], .ai .ai-row input[type=password] { width: 100%; min-width: 0; box-sizing: border-box; }
.ai textarea { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical; font: inherit; background: var(--bg-0, #0f1115); color: var(--text, #e6e9ef); border: 1px solid var(--border, #333); border-radius: 4px; padding: 6px; }
.ai textarea.ai-code, .ai pre { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.4; }
.ai pre { margin: 0; padding: 6px 8px; overflow: auto; background: var(--bg-0, #0f1115); border: 1px solid var(--border, #333); border-radius: 4px; white-space: pre; }
.ai .ai-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ai .ai-chip { padding: 2px 8px; border: 1px solid var(--border, #333); border-radius: 10px; background: var(--bg-2, #1b1f27); color: var(--text-dim, #99a2b3); cursor: pointer; font-size: 11px; }
.ai .ai-chip:hover { color: var(--text, #e6e9ef); border-color: var(--teal, #4fd1c5); }
.ai .ai-runner { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-1, #14171d); }
.ai .ai-runner-line { display: flex; align-items: center; gap: 8px; min-height: 20px; }
.ai .ai-runner-line .ai-grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai .ai-runner-line .ai-dim { color: var(--text-dim, #99a2b3); }
.ai .ai-bar { height: 4px; border-radius: 2px; background: var(--bg-3, #232833); overflow: hidden; }
.ai .ai-bar > i { display: block; height: 100%; width: 30%; background: var(--teal, #4fd1c5); animation: ai-slide 1.4s ease-in-out infinite; }
@keyframes ai-slide { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }
.ai .ai-bad { color: #ff9f7a; }
.ai .ai-ok { color: var(--teal, #4fd1c5); }
.ai .ai-gold { color: var(--gold, #e6b95c); }
.ai details { border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-1, #14171d); }
.ai details > summary { cursor: pointer; padding: 4px 8px; color: var(--text-dim, #99a2b3); user-select: none; }
.ai details > .ai-body { padding: 6px 8px 8px; border-top: 1px solid var(--border, #333); max-height: 220px; overflow: auto; white-space: pre-wrap; color: var(--text-dim, #99a2b3); font-size: 11px; line-height: 1.4; }
.ai .ai-md { line-height: 1.5; max-height: 50vh; overflow: auto; padding-right: 4px; }
.ai .ai-md p { margin: 0 0 8px; }
.ai .ai-md h3, .ai .ai-md h4, .ai .ai-md h5, .ai .ai-md h6 { margin: 10px 0 4px; color: var(--gold, #e6b95c); font-size: 12px; }
.ai .ai-md ul, .ai .ai-md ol { margin: 0 0 8px; padding-left: 20px; }
.ai .ai-md code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; background: var(--bg-0, #0f1115); padding: 0 3px; border-radius: 3px; }
.ai .ai-md blockquote { margin: 0 0 8px; padding-left: 8px; border-left: 2px solid var(--border, #333); color: var(--text-dim, #99a2b3); }
.ai .ai-md a { color: var(--teal, #4fd1c5); }
.ai .ai-list { display: flex; flex-direction: column; max-height: 260px; overflow: auto; border: 1px solid var(--border, #333); border-radius: 4px; }
.ai .ai-item { display: flex; gap: 8px; align-items: flex-start; padding: 5px 8px; border-bottom: 1px solid var(--border, #333); }
.ai .ai-item:last-child { border-bottom: none; }
.ai .ai-item .ai-grow { flex: 1; min-width: 0; }
.ai .ai-item .ai-dim { color: var(--text-dim, #99a2b3); font-size: 11px; }
.ai .ai-item.is-picked { background: var(--bg-3, #232833); }
.ai .ai-grid { font-family: ui-monospace, Menlo, Consolas, monospace; line-height: 1; overflow: auto; max-height: 40vh; padding: 4px; background: var(--bg-0, #0f1115); border: 1px solid var(--border, #333); border-radius: 4px; }
.ai .ai-grid > div { display: flex; height: 9px; }
.ai .ai-grid .ai-cell { flex: none; width: 9px; height: 9px; }
.ai .ai-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--text-dim, #99a2b3); }
.ai .ai-legend i { display: inline-block; width: 10px; height: 10px; vertical-align: -1px; margin-right: 4px; border: 1px solid rgba(255,255,255,.15); }
.ai .ai-btns { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.ai .ai-hint { color: var(--text-faint, #6b7382); font-size: 11px; line-height: 1.4; }
.ai .check { white-space: normal; height: auto; align-items: flex-start; line-height: 1.35; }
.ai .check input { margin-top: 3px; flex: none; }
.ai table.ai-table { border-collapse: collapse; width: 100%; font-size: 11px; }
.ai table.ai-table th, .ai table.ai-table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border, #333); vertical-align: top; }
.ai table.ai-table td.ai-mono { font-family: ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; }
.ai .ai-scroll { max-height: 40vh; overflow: auto; }
.ai .ai-chat { display: flex; flex-direction: column; gap: 6px; overflow: auto; max-height: 52vh; min-height: 120px; padding: 4px; background: var(--bg-0, #0f1115); border: 1px solid var(--border, #333); border-radius: 4px; }
.ai .ai-msg { padding: 5px 8px; border-radius: 6px; line-height: 1.45; max-width: 100%; box-sizing: border-box; }
.ai .ai-msg.is-user { background: var(--bg-3, #232833); align-self: flex-end; white-space: pre-wrap; }
.ai .ai-msg.is-assistant { background: var(--bg-2, #1b1f27); align-self: stretch; }
.ai .ai-msg.is-assistant .ai-md { max-height: none; }
.ai .ai-tool { display: flex; gap: 6px; align-items: center; font-size: 11px; color: var(--text-dim, #99a2b3); padding: 1px 8px; }
.ai .ai-tool code { font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--text, #e6e9ef); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.ai .ai-tool img { max-width: 100%; border: 1px solid var(--border, #333); border-radius: 3px; margin-top: 3px; }
.ai .ai-shot { padding: 0 8px 4px; }
.ai .ai-context { font-size: 11px; color: var(--text-faint, #6b7382); line-height: 1.35; max-height: 44px; overflow: hidden; text-overflow: ellipsis; }
.ai .ai-turn { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-dim, #99a2b3); padding: 3px 8px; border-top: 1px dashed var(--border, #333); }
.ai .ai-turn .ai-grow { flex: 1; }
.ai .ai-shot img { max-width: 100%; border: 1px solid var(--border, #333); border-radius: 3px; }
.ai.ai-assistant { flex: 1; min-height: 0; }
.ai.ai-assistant .ai-chat { flex: 1; min-height: 160px; max-height: none; }
.ai .ai-state { display: flex; flex-direction: column; gap: 4px; padding: 5px 8px; border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-1, #14171d); font-size: 11px; }
.ai .ai-state-line { display: flex; align-items: center; gap: 8px; min-height: 16px; }
.ai .ai-phase { font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; font-size: 10px; color: var(--text-dim, #99a2b3); }
.ai .ai-state.is-thinking .ai-phase, .ai .ai-state.is-waiting .ai-phase { color: var(--teal, #4fd1c5); }
.ai .ai-state.is-writing .ai-phase { color: var(--text, #e6e9ef); }
.ai .ai-state.is-tools .ai-phase { color: var(--gold, #e6b95c); }
.ai .ai-state.is-failed .ai-phase { color: #ff9f7a; }
.ai .ai-state.is-stopped .ai-phase { color: var(--text-faint, #6b7382); }
.ai .ai-phase-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai .ai-mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
.ai .ai-pill { padding: 0 6px; border-radius: 8px; background: var(--bg-3, #232833); color: var(--text-dim, #99a2b3); font-size: 10px; white-space: nowrap; }
.ai .ai-pill:empty { display: none; }
.ai .ai-shimmer { height: 2px; border-radius: 1px; background: var(--bg-3, #232833); overflow: hidden; }
.ai .ai-shimmer > i { display: block; height: 100%; width: 35%; background: linear-gradient(90deg, transparent, var(--teal, #4fd1c5), transparent); animation: ai-slide 1.6s ease-in-out infinite; }
.ai .ai-state.is-tools .ai-shimmer > i { background: linear-gradient(90deg, transparent, var(--gold, #e6b95c), transparent); }
.ai .ai-caret { display: inline-block; width: 6px; height: 12px; margin-left: 2px; vertical-align: -2px; background: var(--teal, #4fd1c5); animation: ai-blink 1s steps(2) infinite; }
@keyframes ai-blink { to { opacity: 0; } }
.ai .ai-tool.is-pending code { color: var(--text-dim, #99a2b3); }
.ai .ai-tool-mark { flex: none; width: 12px; text-align: center; }
.ai .ai-spin { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--text-faint, #6b7382); border-top-color: var(--teal, #4fd1c5); animation: ai-spin 0.8s linear infinite; }
@keyframes ai-spin { to { transform: rotate(360deg); } }
.ai .ai-steps { display: flex; flex-direction: column; gap: 3px; }
.ai .ai-step { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border-radius: 3px; font-size: 11px; }
.ai .ai-step .ai-step-mark { flex: none; width: 14px; text-align: center; }
.ai .ai-step.is-running { background: var(--bg-3, #232833); }
.ai .ai-step.is-done .ai-step-mark { color: var(--teal, #4fd1c5); }
.ai .ai-step.is-failed .ai-step-mark { color: #ff9f7a; }
.ai .ai-step.is-skipped { color: var(--text-faint, #6b7382); }
.ai .ai-step .ai-grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

let styleCount = 0;

/** The dialog body with the stylesheet attached and a `.ai` root to build in. */
export function styled(body: HTMLElement): HTMLDivElement {
  const style = document.createElement("style");
  style.textContent = STYLE;
  style.dataset.ai = String(++styleCount);
  const root = h("div", { className: "ai" });
  body.append(style, root);
  return root;
}

export function chips(labels: string[], pick: (label: string) => void): HTMLElement {
  return h("div", { className: "ai-chips" }, ...labels.map((l) => h("button", { type: "button", className: "ai-chip", onClick: () => pick(l) }, l)));
}

export function textarea(props: { value?: string; placeholder?: string; rows?: number; code?: boolean; readonly?: boolean }): HTMLTextAreaElement {
  const el = h("textarea", { placeholder: props.placeholder ?? "", rows: props.rows ?? 4, className: props.code ? "ai-code" : "", readOnly: !!props.readonly });
  el.value = props.value ?? "";
  return el;
}

/* ── The runner ─────────────────────────────────────────── */

/** Where a request stands, shown in a strip at the foot of the dialog. */
export class Runner {
  readonly el: HTMLElement;
  private readonly line: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly thinking: HTMLDetailsElement;
  private readonly thinkingBody: HTMLElement;
  private readonly stopButton: HTMLButtonElement;
  private timer: number | null = null;
  private startedAt = 0;
  private controller: AbortController | null = null;
  private model = "";
  private readonly ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    this.line = h("div", { className: "ai-runner-line" }, h("span", { className: "ai-grow ai-dim" }, "Ready."));
    this.bar = h("div", { className: "ai-bar", hidden: true }, h("i"));
    this.thinkingBody = h("div", { className: "ai-body" });
    this.thinking = h("details", { hidden: true }, h("summary", null, "Reasoning"), this.thinkingBody);
    this.stopButton = ctx.api.ui.widgets.button("Stop", { onClick: () => this.abort(), ghost: true });
    this.stopButton.hidden = true;
    this.el = h("div", { className: "ai-runner" }, this.line, this.bar, this.thinking);
  }

  get signal(): AbortSignal | undefined { return this.controller?.signal; }
  get busy(): boolean { return this.controller !== null; }

  private setLine(...children: Child[]) {
    clear(this.line);
    append(this.line, children);
    this.line.append(this.stopButton);
  }

  start(model: string) {
    this.abort();
    this.controller = new AbortController();
    this.model = model;
    this.startedAt = Date.now();
    this.stopButton.hidden = false;
    this.bar.hidden = false;
    clear(this.thinkingBody);
    this.thinking.hidden = !this.ctx.settings().showThinking;
    this.thinking.open = false;
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  private tick() {
    const s = Math.round((Date.now() - this.startedAt) / 1000);
    this.setLine(h("span", { className: "ai-grow" }, `Asking ${this.model || "the model"}…`), h("span", { className: "ai-dim" }, `${s} s`));
  }

  setModel(model: string) { this.model = model; this.tick(); }

  addThinking(text: string) {
    this.thinking.hidden = false;
    this.thinkingBody.append(document.createTextNode(text));
    this.thinkingBody.scrollTop = this.thinkingBody.scrollHeight;
  }

  private settle() {
    if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
    this.controller = null;
    this.stopButton.hidden = true;
    this.bar.hidden = true;
  }

  finish(usage: Usage, note?: string) {
    this.settle();
    this.setLine(
      h("span", { className: "ai-grow" }, note ?? "Done.", " ", h("span", { className: "ai-dim" }, formatUsage(usage))),
      h("span", { className: "ai-dim", title: "What this session has cost so far" }, this.ctx.ledger.summary()),
    );
  }

  fail(err: unknown) {
    this.settle();
    const text = describeError(err);
    const wantsSettings = err instanceof AiError && (err.code === "unauthorized" || err.code === "network" || err.code === "model_not_allowed" || (err.code === "budget_exceeded" && this.ctx.account.active()));
    const settingsLink = wantsSettings
      ? h("a", { href: "#", onClick: (e: Event) => { e.preventDefault(); this.ctx.openSettings(); } }, err instanceof AiError && err.code === "budget_exceeded" ? (this.ctx.account.signedIn() ? "Top up or wait" : "Sign in") : "Open AI Settings")
      : null;
    this.setLine(h("span", { className: "ai-grow ai-bad", title: text }, text), settingsLink);
  }

  idle(text = "Ready.") {
    this.settle();
    this.setLine(h("span", { className: "ai-grow ai-dim" }, text));
  }

  abort() {
    this.controller?.abort();
  }

  dispose() { this.abort(); this.settle(); }
}

/** The per-request knobs from the settings. */
export function recipeOptions(settings: Settings): RecipeOptions {
  const o: RecipeOptions = { thinking: settings.showThinking };
  if (settings.model) o.model = settings.model;
  if (settings.effort) o.effort = settings.effort;
  return o;
}

/**
 * Run a recipe with the runner showing its progress. Resolves with the result, or
 * null after showing the failure in the runner (a missing server address opens
 * Settings first). Streams `delta` / `thinking` through the hooks.
 */
export async function runRecipe<N extends RecipeName>(ctx: Ctx, runner: Runner, name: N, input: RecipeInputs[N], hooks: Omit<RunHooks, "signal"> = {}): Promise<RunResult<N> | null> {
  if (!requireServer(ctx)) return null;
  const settings = ctx.settings();
  runner.start(settings.model || "the server's default model");
  try {
    const r = await ctx.client.run(name, input, {
      ...hooks,
      onStart: (model) => { runner.setModel(model); hooks.onStart?.(model); },
      onThinking: (t) => { runner.addThinking(t); hooks.onThinking?.(t); },
      signal: runner.signal,
    }, recipeOptions(settings));
    runner.finish(r.usage);
    return r;
  } catch (err) {
    runner.fail(err);
    return null;
  }
}

/** Whether a server address is set; opens Settings and says so when not. */
export function requireServer(ctx: Ctx): boolean {
  if (ctx.settings().serverUrl.trim()) return true;
  ctx.api.ui.status("AI: set the server address first.");
  ctx.openSettings();
  return false;
}

/** A line with the session's spend that follows the ledger, and the account's balance when there is one. */
export function ledgerLine(ctx: Ctx): HTMLElement {
  const text = () => { const a = ctx.account.summary(); return a ? `${ctx.ledger.summary()} · ${a}` : ctx.ledger.summary(); };
  const el = h("div", { className: "ai-hint" }, text());
  const off = ctx.ledger.onChange(() => { el.textContent = text(); });
  const offAccount = ctx.account.onChange(() => { el.textContent = text(); });
  // The listeners are cheap; a dialog that closes leaves a dangling text node update at worst.
  (el as HTMLElement & { dispose?: () => void }).dispose = () => { off(); offAccount(); };
  return el;
}

/** A findings/notes list. */
export function noteList(items: string[], className = ""): HTMLElement {
  return h("ul", { className: `ai-notes ${className}`.trim(), style: "margin: 0; padding-left: 18px; line-height: 1.4;" }, ...items.map((t) => h("li", null, t)));
}

/** `#rrggbb` for a packed 0xRRGGBB. */
export function hex(packed: number): string {
  return `#${(packed & 0xffffff).toString(16).padStart(6, "0")}`;
}
