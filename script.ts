/**
 * The Trigger Script plugin's commands, typed: what the editor's `api.script` used to be
 * before the Script Editor became a plugin of its own. Plugins activate in no fixed
 * order and the user may have it switched off, so every use goes through `scriptBridge`
 * and says `NO_SCRIPT_PLUGIN` when it answers null.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { TriggerRecord } from "@scm-js/plugin-api";

export const SCRIPT_PLUGIN = "trigger-script";
export const NO_SCRIPT_PLUGIN = "The Trigger Script plugin is off. Turn it on under Plugins ▸ Manage Plugins… to write, compile or build trigger scripts.";

export interface ScriptDiagnostic {
  /** 1-based. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  source: "typescript" | "compiler";
}

export interface CompileResult {
  triggers: TriggerRecord[];
  /** Per trigger, the 1-based line of its `trigger(` call or of the statement it came from. */
  lines: number[];
  diagnostics: ScriptDiagnostic[];
  variables: { name: string; kind: "number" | "boolean"; storage: string }[];
  program: { owner: number; start: number; count: number; hyperTriggers: boolean } | null;
  ok: boolean;
}

export interface ScriptBlock {
  start: number;
  count: number;
  lines: number[];
}

export interface ScriptState {
  source: string | null;
  block: ScriptBlock | null;
  /** A build exists but its records were edited or removed. */
  stale: boolean;
  /** The source differs from what the block was built from (or was never built). */
  unbuilt: boolean;
}

export interface ScriptSimulation {
  cycles: number;
  events: { cycle: number; trigger: number; action: { type: number }; text?: string }[];
  switches: number[];
}

export interface ScriptBridge {
  state(): ScriptState | null;
  declarations(): string;
  compile(source: string): Promise<CompileResult>;
  build(source: string, options?: { takeOver?: boolean }): Promise<{ compiled: CompileResult; block: ScriptBlock | null }>;
  print(triggers: TriggerRecord[]): string;
  simulate(triggers: TriggerRecord[], cycles: number, options?: { player?: number }): ScriptSimulation;
  triggerAtLine(line: number): number | null;
  /** Open the Script Editor, on a line. */
  open(line?: number): void;
}

export function hasScriptPlugin(api: PluginApi): boolean {
  return api.commands.has(`${SCRIPT_PLUGIN}.compile`);
}

/** The bridge, or null while the Trigger Script plugin is off. */
export function scriptBridge(api: PluginApi): ScriptBridge | null {
  if (!hasScriptPlugin(api)) return null;
  const run = (name: string, ...args: unknown[]) => api.commands.run(`${SCRIPT_PLUGIN}.${name}`, ...args);
  const async = async <T>(name: string, ...args: unknown[]): Promise<T> => {
    const r = run(name, ...args);
    if (r === undefined) throw new Error(NO_SCRIPT_PLUGIN);
    return (await r) as T;
  };
  return {
    state: () => (run("state") as ScriptState | null | undefined) ?? null,
    declarations: () => String(run("declarations") ?? ""),
    compile: (source) => async("compile", source),
    build: (source, options) => async("build", source, options ?? {}),
    print: (triggers) => String(run("print", triggers) ?? ""),
    simulate: (triggers, cycles, options) => (run("simulate", triggers, cycles, options ?? {}) as ScriptSimulation | undefined) ?? { cycles: 0, events: [], switches: [] },
    triggerAtLine: (line) => (run("triggerAtLine", line) as number | null | undefined) ?? null,
    open: (line) => { run("open", line ? { line } : {}); },
  };
}
