/**
 * The wire contract between scm-js's AI plugin (`scm-js/plugin-ai`) and its server
 * (`scm-js/ai-server`). One copy lives in each repository; keep them identical.
 *
 * The server is thin on purpose: it holds the Anthropic key, the prompt *recipes*, the
 * access rules and the budgets, and never any game data. Everything that makes a map a
 * map — tile ids, ISOM, placement, undo — stays in the editor. So a recipe takes the
 * facts the plugin gathered (terrain vocabulary, statistics, a rendered picture, the
 * trigger script's declarations) and returns a *plan* or *text* the plugin applies.
 *
 * Transport: `POST /v1/recipes/<name>` with a JSON `RecipeRequest`. With
 * `Accept: text/event-stream` (the plugin's default) the answer is a stream of
 * `RecipeEvent`s — `progress` heartbeats while the model thinks, `delta` text as it
 * arrives for the text recipes, one `result`, then `done`; a JSON `Accept` gets one
 * `RecipeResponse`. Errors are `ErrorBody` with the HTTP status (and, on a stream that
 * already started, an `error` event). `GET /v1/info` describes the server and the
 * caller's remaining allowance; `GET /health` is the liveness check.
 *
 * Auth: `Authorization: Bearer <access token>` for a token the operator issued, and/or
 * `X-Anthropic-Key: <key>` to bring your own Anthropic key (the server forwards it and
 * never stores it). Which of the two the server accepts is in `/v1/info`.
 */

export const PROTOCOL_VERSION = 1;

/* ── Recipes ────────────────────────────────────────────── */

export type RecipeName =
  /** A whole map from a prompt: terrain layout, bases, name and description. */
  | "map-plan"
  /** A layout for one area of an existing map. */
  | "region-plan"
  /** A trigger script (the editor's TypeScript-subset language) from a description. */
  | "triggers"
  /** Plain-language explanation of triggers given as the editor's text format. */
  | "explain-triggers"
  /** A name and description for the map from its facts. */
  | "describe"
  /** Mission briefing text from the map's facts and triggers. */
  | "briefing"
  /** A critique of the map from a picture and its statistics. */
  | "review"
  /** Rewrite the string table under an instruction (translate, fix spelling, retone). */
  | "strings"
  /** One turn of the assistant: a tool-using conversation about the open map. */
  | "agent";

export const RECIPE_NAMES: readonly RecipeName[] = [
  "map-plan", "region-plan", "triggers", "explain-triggers", "describe", "briefing", "review", "strings", "agent",
];

export interface RecipeInputs {
  "map-plan": MapPlanInput;
  "region-plan": RegionPlanInput;
  "triggers": TriggersInput;
  "explain-triggers": ExplainTriggersInput;
  "describe": DescribeInput;
  "briefing": BriefingInput;
  "review": ReviewInput;
  "strings": StringsInput;
  "agent": AgentInput;
}

export interface RecipeOutputs {
  "map-plan": MapPlan;
  "region-plan": LayoutPlan;
  "triggers": TriggersOutput;
  "explain-triggers": TextOutput;
  "describe": DescribeOutput;
  "briefing": BriefingOutput;
  "review": ReviewOutput;
  "strings": StringsOutput;
  "agent": AgentOutput;
}

/** Per-request knobs the caller may set; the server clamps them to its config. */
export interface RecipeOptions {
  /** One of the models the server lists in `/v1/info`. */
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Ask for the model's reasoning summary in `thinking` events. */
  thinking?: boolean;
}

export interface RecipeRequest<N extends RecipeName = RecipeName> {
  protocol: typeof PROTOCOL_VERSION;
  input: RecipeInputs[N];
  options?: RecipeOptions;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The server's estimate from its price table. */
  costUsd: number;
  /** Wall-clock milliseconds the upstream call took. */
  durationMs: number;
}

export interface RecipeResponse<N extends RecipeName = RecipeName> {
  id: string;
  recipe: N;
  output: RecipeOutputs[N];
  usage: Usage;
  /** The caller's allowance after this call, when the server tracks one. */
  remaining?: Allowance;
}

export type RecipeEvent<N extends RecipeName = RecipeName> =
  | { event: "start"; id: string; recipe: N; model: string }
  /** A heartbeat while nothing else is arriving, so a proxy does not time the stream out. */
  | { event: "progress"; elapsedMs: number }
  /** The model's reasoning summary, when `options.thinking` asked for it. */
  | { event: "thinking"; text: string }
  /** Text as it arrives — only the recipes whose output is prose stream it. */
  | { event: "delta"; text: string }
  | { event: "result"; output: RecipeOutputs[N]; usage: Usage; remaining?: Allowance }
  | { event: "error"; error: ErrorBody["error"] }
  | { event: "done" };

/* ── Errors ─────────────────────────────────────────────── */

export type ErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "budget_exceeded"
  | "too_busy"
  | "recipe_disabled"
  | "model_not_allowed"
  /** The model declined; `message` carries its category when there is one. */
  | "refused"
  | "upstream"
  | "internal";

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** For `rate_limited` / `too_busy`: when to try again. */
    retryAfterSec?: number;
  };
}

/* ── Info ───────────────────────────────────────────────── */

export interface Allowance {
  /** Requests left in the current minute / day; absent when unlimited. */
  requestsPerMinute?: number;
  requestsPerDay?: number;
  /** Dollars left today; absent when unlimited. */
  budgetUsd?: number;
}

export interface InfoResponse {
  protocol: typeof PROTOCOL_VERSION;
  /** The server's package version. */
  version: string;
  /** What the operator wrote in the config — shown in the plugin's settings. */
  name: string;
  motd?: string;
  models: { id: string; default: boolean }[];
  recipes: { name: RecipeName; enabled: boolean; model: string }[];
  access: {
    /** Requests with no credentials are served. */
    anonymous: boolean;
    /** `X-Anthropic-Key` is honoured. */
    byok: boolean;
  };
  caller: {
    kind: "anonymous" | "token" | "byok";
    /** The token's label, when the operator gave it one. */
    name?: string;
    remaining: Allowance;
  };
}

/* ── Shared shapes ──────────────────────────────────────── */

/** A terrain the tileset has — `api.terrain.types()` in the editor. */
export interface TerrainVocab {
  id: number;
  name: string;
  height: 0 | 1 | 2;
  buildable: boolean;
}

export type SymmetryMode = "none" | "mirror-x" | "mirror-y" | "rot180" | "rot90" | "diag" | "antidiag" | "quad" | "octo";

export const SYMMETRY_MODES: readonly SymmetryMode[] = ["none", "mirror-x", "mirror-y", "rot180", "rot90", "diag", "antidiag", "quad", "octo"];

export type Direction = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** A player slot as the plugin sees it. */
export interface PlayerFact {
  /** 0-based. */
  slot: number;
  /** `Human`, `Computer`, `Neutral`, … (the editor's own labels). */
  type: string;
  race: string;
  force: number;
  /** Whether the slot has a start location. */
  hasStart: boolean;
}

/** What every fact-based recipe gets to know about the open map. */
export interface MapFacts {
  name: string;
  description: string;
  width: number;
  height: number;
  tileset: string;
  players: PlayerFact[];
  /** `api.query.statistics()` flattened to the lines the Statistics dialog shows. */
  statistics: string[];
  /** Units on the map by type and owner: "Terran Marine × 12 (Player 1)". */
  units: string[];
  /** Location names in slot order (Anywhere excluded). */
  locations: string[];
  /** Number of triggers, briefing triggers and named switches. */
  triggerCount: number;
  briefingCount: number;
  /** The triggers as the editor prints them, cut to the server's input limit by the plugin. */
  triggersText?: string;
}

/* ── map-plan / region-plan ─────────────────────────────── */

/**
 * The layout language: a coarse grid of *cells*, each `cellSize` × `cellSize` tiles,
 * written as rows of single characters that a `legend` maps to terrain ids. It reads as
 * ASCII art, which is what makes the model good at it, and the plugin turns it into
 * isometric brush strokes, so cliffs and shores draw themselves. Ramps between heights
 * are listed separately because the tilesets keep them as doodads.
 */
export interface LayoutPlan {
  /** Tiles per cell, as requested. */
  cellSize: number;
  columns: number;
  rows: number;
  /** Character → terrain id from the vocabulary. */
  legend: Record<string, number>;
  /** `rows` strings of `columns` characters each. */
  grid: string[];
  bases: BasePlan[];
  ramps: RampPlan[];
  /** Decoration by category name, scattered over the cells whose legend characters are listed. */
  doodads: DoodadPlan[];
  /** Units by StarEdit name. */
  units: UnitPlan[];
  locations: LocationPlan[];
  /** What the designer intended, for the person reading the result. */
  notes: string[];
}

export interface MapPlan extends LayoutPlan {
  name: string;
  description: string;
  symmetry: SymmetryMode;
}

export interface BasePlan {
  kind: "main" | "natural" | "third" | "expansion" | "island";
  /** Tile of the town hall's top-left corner. */
  x: number;
  y: number;
  /** Where the mineral line lies, seen from the hall. */
  mineralDirection: Direction;
  minerals: number;
  geysers: number;
  /**
   * 1-based player for a `main` (its start location); omitted for expansions. Under a
   * symmetry the plugin mirrors every base and numbers the mains in order, so a plan
   * lists only the canonical set.
   */
  player?: number;
}

export interface RampPlan {
  /** Tile at the ramp's centre. */
  x: number;
  y: number;
  /** Which way the ramp goes *down*. */
  direction: Direction;
}

export interface DoodadPlan {
  /** A category the plugin listed — `Trees`, `Rocks`, … */
  category: string;
  /** Legend characters of the cells to decorate. */
  on: string;
  /** 0 (none) … 1 (as many as fit). */
  density: number;
}

export interface UnitPlan {
  /** StarEdit's unit name. */
  unit: string;
  /** 1-based player; 12 is neutral. */
  player: number;
  /** Tile coordinates of the unit's centre. */
  x: number;
  y: number;
  /** For resources. */
  amount?: number;
}

export interface LocationPlan {
  name: string;
  /** Tiles, exclusive at the far edges. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MapPlanInput {
  prompt: string;
  width: number;
  height: number;
  tileset: string;
  terrains: TerrainVocab[];
  /** Doodad category names the tileset offers. */
  doodadCategories: string[];
  /** Unit names the plugin can resolve, for `units`. */
  unitNames: string[];
  /** How many players to lay mains for (2 … 8). */
  players: number;
  symmetry: SymmetryMode | "auto";
  /** Tiles per cell; the plugin picks 4 for a 128 map. */
  cellSize: number;
  /** A refinement round: the previous plan, what the plugin found rendering it, and a picture. */
  previous?: {
    plan: MapPlan;
    /** Problems the editor found — placement refusals, validation issues, unresolved ramps. */
    findings: string[];
    image?: ImageInput;
  };
}

export interface RegionPlanInput {
  prompt: string;
  width: number;
  height: number;
  tileset: string;
  terrains: TerrainVocab[];
  doodadCategories: string[];
  unitNames: string[];
  /** The area to redo, in tiles (exclusive far edges). */
  rect: { x0: number; y0: number; x1: number; y1: number };
  cellSize: number;
  /** The area and a margin around it, as it is now, in the same legend language. */
  current: { legend: Record<string, number>; grid: string[]; originX: number; originY: number };
  image?: ImageInput;
}

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** Base64, no data-URL prefix. */
  data: string;
}

/* ── triggers ───────────────────────────────────────────── */

export interface TriggersInput {
  prompt: string;
  /** The editor's generated `.d.ts` for this map: every unit, location, switch and player by name. */
  declarations: string;
  /** The map's current script, when it has one; the model extends or edits it. */
  script?: string;
  /** The hand triggers outside the script, printed, so the model does not duplicate them. */
  existingTriggers?: string;
  /** A repair round: the script the model wrote and what the compiler said. */
  repair?: {
    script: string;
    diagnostics: { line: number; column: number; message: string }[];
  };
}

export interface TriggersOutput {
  /** The complete script to build. */
  script: string;
  /** What it does, in a few sentences. */
  summary: string;
}

/* ── explain-triggers ───────────────────────────────────── */

export interface ExplainTriggersInput {
  /** Triggers in the editor's text format. */
  text: string;
  /** What the person wants to know; a walkthrough when absent. */
  question?: string;
  briefing?: boolean;
}

export interface TextOutput {
  /** Markdown. */
  text: string;
}

/* ── describe / briefing ────────────────────────────────── */

export interface DescribeInput {
  facts: MapFacts;
  /** Tone, length, language, anything. */
  prompt?: string;
}

export interface DescribeOutput {
  name: string;
  description: string;
  /** Two more pairs to pick from. */
  alternatives: { name: string; description: string }[];
}

export interface BriefingInput {
  facts: MapFacts;
  prompt?: string;
}

export interface BriefingOutput {
  /** One objective line per entry, shown in the briefing's objectives box. */
  objectives: string[];
  /** The narration, one text message each. */
  lines: string[];
}

/* ── review ─────────────────────────────────────────────── */

export interface ReviewInput {
  facts: MapFacts;
  image: ImageInput;
  /** `api.query.validate()` as text lines. */
  issues: string[];
  /** Melee balance, a UMS's readability, or a free question. */
  prompt?: string;
}

export interface ReviewFinding {
  severity: "info" | "warning" | "problem";
  title: string;
  detail: string;
  /** A tile to look at, when the finding is somewhere in particular. */
  x?: number;
  y?: number;
}

export interface ReviewOutput {
  /** Markdown. */
  summary: string;
  findings: ReviewFinding[];
}

/* ── strings ────────────────────────────────────────────── */

export interface StringsInput {
  /** "Translate to German", "fix the spelling", … */
  instruction: string;
  strings: {
    index: number;
    /** Bytes below 0x20 shown as `<XX>`, exactly as the String Editor does; the model keeps them. */
    text: string;
    /** Where it is used: "scenario name", "trigger 4 text", … */
    usage: string[];
  }[];
}

export interface StringsOutput {
  strings: { index: number; text: string }[];
}

/* ── agent ──────────────────────────────────────────────── */

/**
 * The assistant is a plain tool-use loop with the tools defined — and run — by the
 * plugin. The server adds the system prompt, forwards the conversation, and hands back
 * the assistant's turn; the plugin executes any tool calls and sends the results as the
 * next user message. The plugin keeps the history and trims it.
 */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the input. */
  inputSchema: Record<string, unknown>;
}

export type AgentContent =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageInput }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string | ({ type: "text"; text: string } | { type: "image"; source: ImageInput })[]; isError?: boolean }
  /**
   * The model's reasoning, opaque: `thinking` is a summary or empty, `signature` binds it to
   * the conversation. The plugin keeps these in the history and sends them back unchanged —
   * a tool-using turn is refused by the API without them — and never shows `signature`.
   */
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface AgentMessage {
  role: "user" | "assistant";
  content: AgentContent[];
}

export interface AgentInput {
  /** The conversation so far, ending with a user message (a question or tool results). */
  messages: AgentMessage[];
  tools: AgentTool[];
  /** Facts about the open map, refreshed every turn. */
  facts: MapFacts;
}

export interface AgentOutput {
  content: AgentContent[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
}
