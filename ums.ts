/**
 * The UMS toolkit: the trigger systems a scenario runs on, built by code rather than
 * written by the model. Each *kind* — hyper triggers, a spawn cycle, kill-to-cash, lives,
 * waves, a shop, a last-standing victory… — has a catalogue entry (`SystemKindSpec`, sent
 * to the server with every design request so the model designs against what exists) and a
 * builder that turns parameters into triggers in the editor's text format, which
 * `api.triggers.text.parse` then turns into records. Tokens are spent on the creative
 * part of a map; the mechanics every madness or defense map shares are here, once, and
 * tested. Everything is pure: a builder gets a `ToolkitContext` (who the humans and
 * computers are, whether hyper triggers run, which death-counter units are free) and
 * answers text plus notes.
 *
 * Timing: without hyper triggers the game runs the trigger list about every two seconds;
 * with them, about twelve times a second. A death-counter timer counts trigger cycles, so
 * `cyclesFor(seconds)` depends on `ctx.hyper` — which is why a design that spawns every
 * few seconds must list a `hyper` system, and why the server's prompt says so.
 */
import type { SystemKindSpec } from "./protocol";

export interface ToolkitContext {
  /** Human players, 1-based. */
  humans: number[];
  /** Computer players, 1-based. */
  computers: number[];
  /** Whether hyper triggers are (or will be) on the map. */
  hyper: boolean;
  /** Unit names the toolkit may use as death counters, in the order to hand them out. */
  dcUnits: string[];
  /** Location names on the map (or that the layout will make), for a check before use; empty = do not check. */
  locations?: string[];
}

export interface BuiltSystem {
  /** Triggers in the text format, ready for `api.triggers.text.parse`. */
  text: string;
  /** How many triggers the text holds. */
  count: number;
  /** What was assumed or left out. */
  notes: string[];
  /** Death-counter units this system took. */
  dcUsed: string[];
}

export class ToolkitError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("; "));
    this.name = "ToolkitError";
    this.problems = problems;
  }
}

export type Params = Record<string, string>;

/** The unused unit types the game never places, which scenarios use as death counters. */
export const DEFAULT_DC_UNITS = [
  "Cave (Unused)", "Cave-in (Unused)", "Cantina (Unused)", "Mining Platform (Unused)", "Independent Command Center (Unused)",
  "Independent Starport (Unused)", "Independent Jump Gate (Unused)", "Ruins (Unused)", "Khaydarin Crystal Formation (Unused)",
  "Zerg Marker", "Terran Marker", "Protoss Marker", "Map Revealer", "Scanner Sweep", "Data Disk", "Khaydarin Crystal", "Uraj Crystal", "Khalis Crystal",
];

/** Trigger cycles for a number of seconds, at the map's trigger rate. */
export function cyclesFor(seconds: number, hyper: boolean): number {
  return Math.max(1, Math.round(hyper ? seconds * 12 : seconds / 2));
}

/* ── Text helpers ───────────────────────────────────────── */

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
const player = (p: number | string) => (typeof p === "number" ? `Player ${p}` : p);

/** One trigger in the text format. */
export function trigger(owners: (number | string)[], conditions: string[], actions: string[]): string {
  const lines = [`Trigger(${owners.map((o) => q(player(o))).join(", ")}){`, "Conditions:"];
  for (const c of conditions.length ? conditions : ["Always()"]) lines.push(`\t${c};`);
  lines.push("Actions:");
  for (const a of actions) lines.push(`\t${a};`);
  lines.push("}", "");
  return lines.join("\n");
}

const CUR = "Current Player";
const c = {
  always: () => "Always()",
  deaths: (p: number | string, unit: string, cmp: string, n: number) => `Deaths(${q(player(p))}, ${q(unit)}, ${cmp}, ${n})`,
  bring: (p: number | string, unit: string, loc: string, cmp: string, n: number) => `Bring(${q(player(p))}, ${q(unit)}, ${q(loc)}, ${cmp}, ${n})`,
  command: (p: number | string, unit: string, cmp: string, n: number) => `Command(${q(player(p))}, ${q(unit)}, ${cmp}, ${n})`,
  kill: (p: number | string, unit: string, cmp: string, n: number) => `Kill(${q(player(p))}, ${q(unit)}, ${cmp}, ${n})`,
  score: (p: number | string, score: string, cmp: string, n: number) => `Score(${q(player(p))}, ${score}, ${cmp}, ${n})`,
  accumulate: (p: number | string, cmp: string, n: number, res: string) => `Accumulate(${q(player(p))}, ${cmp}, ${n}, ${res})`,
  elapsed: (cmp: string, s: number) => `Elapsed Time(${cmp}, ${s})`,
  countdown: (cmp: string, s: number) => `Countdown Timer(${cmp}, ${s})`,
  opponents: (p: number | string, cmp: string, n: number) => `Opponents(${q(player(p))}, ${cmp}, ${n})`,
  switch: (name: string, state: "set" | "not set") => `Switch(${q(name)}, ${state})`,
};
const a = {
  preserve: () => "Preserve Trigger()",
  wait: (ms: number) => `Wait(${ms})`,
  create: (p: number | string, unit: string, n: number, loc: string) => `Create Unit(${q(player(p))}, ${q(unit)}, ${n}, ${q(loc)})`,
  setDeaths: (p: number | string, unit: string, mod: "Set To" | "Add" | "Subtract", n: number) => `Set Deaths(${q(player(p))}, ${q(unit)}, ${mod}, ${n})`,
  setResources: (p: number | string, mod: "Set To" | "Add" | "Subtract", n: number, res: "ore" | "gas") => `Set Resources(${q(player(p))}, ${mod}, ${n}, ${res})`,
  setScore: (p: number | string, mod: "Set To" | "Add" | "Subtract", n: number, score: string) => `Set Score(${q(player(p))}, ${mod}, ${n}, ${score})`,
  text: (s: string) => `Display Text Message(Always Display, ${q(s)})`,
  objectives: (s: string) => `Set Mission Objectives(${q(s)})`,
  victory: () => "Victory()",
  defeat: () => "Defeat()",
  killAt: (p: number | string, unit: string, n: number | "All", loc: string) => `Kill Unit At Location(${q(player(p))}, ${q(unit)}, ${n}, ${q(loc)})`,
  removeAt: (p: number | string, unit: string, n: number | "All", loc: string) => `Remove Unit At Location(${q(player(p))}, ${q(unit)}, ${n}, ${q(loc)})`,
  move: (p: number | string, unit: string, n: number | "All", from: string, to: string) => `Move Unit(${q(player(p))}, ${q(unit)}, ${n}, ${q(from)}, ${q(to)})`,
  order: (p: number | string, unit: string, from: string, to: string, order: "move" | "patrol" | "attack") => `Order(${q(player(p))}, ${q(unit)}, ${q(from)}, ${q(to)}, ${order})`,
  hp: (p: number | string, unit: string, pct: number, n: number | "All", loc: string) => `Modify Unit Hit Points(${q(player(p))}, ${q(unit)}, ${pct}, ${n}, ${q(loc)})`,
  shields: (p: number | string, unit: string, pct: number, n: number | "All", loc: string) => `Modify Unit Shield Points(${q(player(p))}, ${q(unit)}, ${pct}, ${n}, ${q(loc)})`,
  lbKills: (label: string, unit: string) => `Leader Board Kills(${q(label)}, ${q(unit)})`,
  lbControl: (label: string, unit: string) => `Leader Board Control(${q(label)}, ${q(unit)})`,
  lbResources: (label: string, res: string) => `Leader Board Resources(${q(label)}, ${res})`,
  lbPoints: (label: string, score: string) => `Leader Board Points(${q(label)}, ${score})`,
  countdown: (mod: "Set To" | "Add" | "Subtract", s: number) => `Set Countdown Timer(${mod}, ${s})`,
  alliance: (p: number | string, status: "Enemy" | "Ally" | "Allied Victory") => `Set Alliance Status(${q(player(p))}, ${status})`,
  give: (from: number | string, to: number | string, unit: string, n: number | "All", loc: string) => `Give Units to Player(${q(player(from))}, ${q(player(to))}, ${q(unit)}, ${n}, ${q(loc)})`,
  ping: (loc: string) => `Minimap Ping(${q(loc)})`,
  center: (loc: string) => `Center View(${q(loc)})`,
  setSwitch: (name: string, action: "set" | "clear") => `Set Switch(${q(name)}, ${action})`,
  invincible: (p: number | string, unit: string, loc: string, state: "enable" | "disable") => `Set Invincibility(${q(player(p))}, ${q(unit)}, ${q(loc)}, ${state})`,
};

/* ── Parameter reading ─────────────────────────────────── */

class Reader {
  readonly problems: string[] = [];
  readonly notes: string[] = [];
  private readonly seen = new Set<string>();
  private readonly kind: SystemKindSpec;
  private readonly params: Params;
  private readonly ctx: ToolkitContext;
  constructor(kind: SystemKindSpec, params: Params, ctx: ToolkitContext) {
    this.kind = kind;
    this.params = params;
    this.ctx = ctx;
  }

  private raw(name: string): string | undefined {
    this.seen.add(name);
    const v = this.params[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  }
  str(name: string, fallback?: string): string {
    const v = this.raw(name);
    if (v !== undefined) return v;
    if (fallback !== undefined) return fallback;
    this.problems.push(`"${name}" is required`);
    return "";
  }
  int(name: string, fallback: number, lo = 0, hi = 1_000_000): number {
    const v = this.raw(name);
    if (v === undefined) return fallback;
    const cleaned = v.replace(/[^0-9.-]/g, "");
    const n = cleaned === "" ? NaN : Number(cleaned);
    if (!Number.isFinite(n)) { this.problems.push(`"${name}" should be a number, not "${v}"`); return fallback; }
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }
  bool(name: string, fallback: boolean): boolean {
    const v = this.raw(name);
    if (v === undefined) return fallback;
    if (/^(true|yes|on|1)$/i.test(v)) return true;
    if (/^(false|no|off|0)$/i.test(v)) return false;
    this.problems.push(`"${name}" should be yes or no, not "${v}"`);
    return fallback;
  }
  /** A location name, checked against the context when it lists any. */
  location(name: string, fallback?: string): string {
    const v = this.str(name, fallback);
    if (v && this.ctx.locations && this.ctx.locations.length > 0 && v.toLowerCase() !== "anywhere" && !this.ctx.locations.some((l) => l.toLowerCase() === v.toLowerCase())) {
      this.problems.push(`"${name}" names location "${v}", which the map does not have`);
    }
    return v;
  }
  /** Players: "humans" (default), "computers", "all", or a list like "1, 2, 5". 1-based. */
  players(name: string, fallback: "humans" | "computers" | "all" = "humans"): number[] {
    const v = this.raw(name) ?? fallback;
    if (/^humans?$/i.test(v)) return this.ctx.humans;
    if (/^computers?$/i.test(v)) return this.ctx.computers;
    if (/^all$/i.test(v)) return [...this.ctx.humans, ...this.ctx.computers];
    const list = v.split(/[,\s]+/).map((s) => Number(s.replace(/^p(?:layer)?\s*/i, ""))).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
    if (list.length === 0) this.problems.push(`"${name}" should be humans, computers, all, or player numbers, not "${v}"`);
    return list;
  }
  /** One player: a number 1–12, or "computer" for the first computer slot; `fallback` may be "computer" too. */
  onePlayer(name: string, fallback?: number | "computer"): number {
    let v = this.raw(name);
    if (v === undefined) {
      if (typeof fallback === "number") return fallback;
      if (fallback === "computer") v = "computer";
      else { this.problems.push(`"${name}" is required`); return 12; }
    }
    if (/^computer$/i.test(v)) { if (this.ctx.computers[0]) return this.ctx.computers[0]; this.problems.push(`"${name}" says computer, but the map has no computer player`); return 12; }
    if (/^neutral$/i.test(v)) return 12;
    const n = Number(v.replace(/^p(?:layer)?\s*/i, ""));
    if (!Number.isInteger(n) || n < 1 || n > 12) { this.problems.push(`"${name}" should be a player number 1–12, not "${v}"`); return 12; }
    return n;
  }
  /** Comma-separated names. */
  list(name: string, fallback: string[] = []): string[] {
    const v = this.raw(name);
    return v === undefined ? fallback : v.split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean);
  }
  /** Complain about parameters the kind does not take. */
  finish() {
    for (const k of Object.keys(this.params)) if (!this.seen.has(k) && !this.kind.params.some((p) => p.name === k)) this.problems.push(`"${k}" is not a parameter of ${this.kind.kind}`);
    if (this.problems.length > 0) throw new ToolkitError(this.problems.map((p) => `${this.kind.kind}: ${p}`));
  }
}

/** Hands out death-counter units, one per counter, from the context's list. */
export class Counters {
  private next = 0;
  readonly used: string[] = [];
  private readonly ctx: ToolkitContext;
  constructor(ctx: ToolkitContext) {
    this.ctx = ctx;
  }
  take(what: string): string {
    const unit = this.ctx.dcUnits[this.next++];
    if (!unit) throw new ToolkitError([`no death-counter unit left for ${what} (the toolkit knows ${this.ctx.dcUnits.length})`]);
    this.used.push(unit);
    return unit;
  }
}

/* ── The kinds ──────────────────────────────────────────── */

interface Kind {
  spec: SystemKindSpec;
  build(r: Reader, ctx: ToolkitContext, dc: Counters): { triggers: string[]; notes?: string[] };
}

const P = (name: string, description: string, required = false) => ({ name, description, required });

const KINDS: Kind[] = [
  {
    spec: {
      kind: "hyper",
      description: "Hyper triggers: make the whole trigger list run about twelve times a second instead of every two seconds. Needed by anything that spawns, counts or reacts faster than that. Three copies of a preserved trigger of 62 Wait(0)s.",
      params: [P("owner", "who runs them: a player number that is always in the game, or All Players (the default)")],
    },
    build(r) {
      const owner = r.str("owner", "All Players");
      const own = /^\d+$/.test(owner) ? Number(owner) : owner;
      const t = trigger([own], [], [...Array.from({ length: 62 }, () => a.wait(0)), a.preserve()]);
      return { triggers: [t, t, t] };
    },
  },
  {
    spec: {
      kind: "spawn",
      description: "Spawn units on a timer at a location, for one or every player. With `players: humans` and a location like `Spawn {p}`, each human gets a trigger with {p} replaced by their number; `owner: each` gives the units to that player, `owner: computer` to the first computer slot.",
      params: [P("location", "the spawn location; may contain {p} for the player number", true), P("unit", "the unit to create", true), P("count", "units per spawn (default 1)"), P("every", "seconds between spawns (default 10)"), P("players", "humans (default), computers, all, or player numbers"), P("owner", "each (default), computer, or a player number"), P("limit", "stop spawning while the owner commands at least this many of the unit (default none)"), P("attack", "a location to order the spawned units to attack-move to (default none)")],
    },
    build(r, ctx, dc) {
      const location = r.str("location");
      const unit = r.str("unit");
      const count = r.int("count", 1, 1, 200);
      const every = r.int("every", 10, 1, 3600);
      const players = r.players("players");
      const ownerRaw = r.str("owner", "each");
      const limit = r.int("limit", 0, 0, 1700);
      const attack = r.str("attack", "");
      const cycles = cyclesFor(every, ctx.hyper);
      const counter = dc.take("the spawn timer");
      const triggers: string[] = [];
      for (const p of players) {
        const loc = location.replace(/\{p\}/g, String(p));
        if (attack) r.location("attack", attack);
        const owner = /^each$/i.test(ownerRaw) ? p : /^computer$/i.test(ownerRaw) ? (ctx.computers[0] ?? p) : Number(ownerRaw) || p;
        const conditions = [c.deaths(p, counter, "At least", cycles)];
        if (limit > 0) conditions.push(c.command(owner, unit, "At most", limit - 1));
        const actions = [a.setDeaths(p, counter, "Set To", 0), a.create(owner, unit, count, loc)];
        if (attack) actions.push(a.order(owner, unit, loc, attack, "attack"));
        actions.push(a.preserve());
        triggers.push(trigger([p], conditions, actions));
        triggers.push(trigger([p], [], [a.setDeaths(p, counter, "Add", 1), a.preserve()]));
      }
      return { triggers, notes: [`spawn timer: ${cycles} trigger cycles ≈ ${every} s ${ctx.hyper ? "with" : "without"} hyper triggers`] };
    },
  },
  {
    spec: {
      kind: "kill-to-cash",
      description: "Pay minerals (and gas) for kills. Watches the player's kill score and pays each time it passes `scorePerKill`, subtracting that much score — so units worth more kill score pay more often. Kill score is roughly the unit's cost (a Marine 100, a Zergling 50, a Hydralisk 175).",
      params: [P("minerals", "minerals per payment (default 10)"), P("gas", "gas per payment (default 0)"), P("scorePerKill", "kill score per payment (default 100)"), P("players", "humans (default), all, or player numbers"), P("message", "text shown on each payment (default none)")],
    },
    build(r) {
      const minerals = r.int("minerals", 10, 0);
      const gas = r.int("gas", 0, 0);
      const per = r.int("scorePerKill", 100, 1);
      const players = r.players("players");
      const message = r.str("message", "");
      const actions = [a.setScore(CUR, "Subtract", per, "Kills")];
      if (minerals > 0) actions.push(a.setResources(CUR, "Add", minerals, "ore"));
      if (gas > 0) actions.push(a.setResources(CUR, "Add", gas, "gas"));
      if (message) actions.push(a.text(message));
      actions.push(a.preserve());
      return { triggers: [trigger(players, [c.score(CUR, "Kills", "At least", per)], actions)] };
    },
  },
  {
    spec: {
      kind: "income",
      description: "Resources on a timer for players: `minerals` every `every` seconds.",
      params: [P("minerals", "minerals per tick (default 50)"), P("gas", "gas per tick (default 0)"), P("every", "seconds between ticks (default 30)"), P("players", "humans (default), all, or player numbers"), P("perUnit", "a unit or building each player must command at least one of, or no income (default none)")],
    },
    build(r, ctx, dc) {
      const minerals = r.int("minerals", 50, 0);
      const gas = r.int("gas", 0, 0);
      const every = r.int("every", 30, 1, 3600);
      const players = r.players("players");
      const perUnit = r.str("perUnit", "");
      const cycles = cyclesFor(every, ctx.hyper);
      const counter = dc.take("the income timer");
      const conditions = [c.deaths(CUR, counter, "At least", cycles)];
      if (perUnit) conditions.push(c.command(CUR, perUnit, "At least", 1));
      const actions = [a.setDeaths(CUR, counter, "Set To", 0)];
      if (minerals > 0) actions.push(a.setResources(CUR, "Add", minerals, "ore"));
      if (gas > 0) actions.push(a.setResources(CUR, "Add", gas, "gas"));
      actions.push(a.preserve());
      return { triggers: [trigger(players, conditions, actions), trigger(players, [], [a.setDeaths(CUR, counter, "Add", 1), a.preserve()])] };
    },
  },
  {
    spec: {
      kind: "last-standing",
      description: "The melee ending for a scenario: a player who commands none of `unit` is defeated; a player with no opponents left wins. Use `unit: Buildings` for a base game, a hero's name for a hero game, `Any unit` otherwise.",
      params: [P("unit", "what a player must keep to stay in (default Any unit)"), P("players", "humans (default) or player numbers"), P("grace", "seconds before elimination can happen, so a slow start is not a loss (default 10)")],
    },
    build(r) {
      const unit = r.str("unit", "Any unit");
      const players = r.players("players");
      const grace = r.int("grace", 10, 0, 3600);
      return {
        triggers: [
          trigger(players, [c.command(CUR, unit, "Exactly", 0), c.elapsed("At least", grace)], [a.defeat()]),
          trigger(players, [c.opponents(CUR, "Exactly", 0), c.elapsed("At least", grace)], [a.victory()]),
        ],
        notes: ["Opponents counts players who are neither allied for victory nor gone; allies in a force with Allied Victory win together"],
      };
    },
  },
  {
    spec: {
      kind: "defeat-when-lost",
      description: "A player is defeated when they command none of `unit` (a hero, a base building).",
      params: [P("unit", "the unit that must survive", true), P("players", "humans (default) or player numbers"), P("grace", "seconds before it can happen (default 5)"), P("message", "text shown to everyone when it happens (default none)")],
    },
    build(r) {
      const unit = r.str("unit");
      const players = r.players("players");
      const grace = r.int("grace", 5, 0, 3600);
      const message = r.str("message", "");
      const actions = message ? [a.text(message), a.defeat()] : [a.defeat()];
      return { triggers: [trigger(players, [c.command(CUR, unit, "Exactly", 0), c.elapsed("At least", grace)], actions)] };
    },
  },
  {
    spec: {
      kind: "victory-on-kills",
      description: "Victory for a player who has killed `count` of `unit`; everyone else is defeated.",
      params: [P("count", "kills needed", true), P("unit", "what counts (default Any unit)"), P("players", "humans (default) or player numbers")],
    },
    build(r) {
      const count = r.int("count", 0, 1);
      if (count <= 0) r.problems.push('"count" must be at least 1');
      const unit = r.str("unit", "Any unit");
      const players = r.players("players");
      const others = players.length > 1;
      return {
        triggers: [
          trigger(players, [c.kill(CUR, unit, "At least", count)], [a.victory()]),
          ...(others ? [trigger(players, [c.kill("Foes", unit, "At least", count)], [a.defeat()])] : []),
        ],
        notes: others ? ["the losers see Defeat when a foe reaches the count"] : [],
      };
    },
  },
  {
    spec: {
      kind: "countdown",
      description: "A countdown timer from the start; when it ends, victory or defeat, or a draw. `onEnd` is `victory:humans`, `victory:Force 2`, `victory:1,3`, `defeat:humans` or `draw`.",
      params: [P("seconds", "how long", true), P("onEnd", "what happens at zero (default draw)"), P("message", "text shown when it ends (default none)")],
    },
    build(r, ctx) {
      const seconds = r.int("seconds", 0, 1, 86400);
      const onEnd = r.str("onEnd", "draw");
      const message = r.str("message", "");
      const triggers = [trigger(["All Players"], [], [a.countdown("Set To", seconds)])];
      const m = /^(victory|defeat)\s*:\s*(.+)$/i.exec(onEnd);
      const end = (owners: (number | string)[], act: string) => trigger(owners, [c.countdown("Exactly", 0)], message ? [a.text(message), act] : [act]);
      if (!m) {
        triggers.push(end(["All Players"], "Draw()"));
      } else {
        const who = m[2].trim();
        const owners: (number | string)[] = /^humans?$/i.test(who) ? ctx.humans : /^computers?$/i.test(who) ? ctx.computers : /^force\s*[1-4]$/i.test(who) ? [`Force ${who.replace(/\D/g, "")}`] : who.split(/[,\s]+/).map(Number).filter((n) => n >= 1 && n <= 12);
        const winners = m[1].toLowerCase() === "victory";
        triggers.push(end(owners, winners ? a.victory() : a.defeat()));
        const rest = ctx.humans.filter((p) => !owners.includes(p) && !(typeof owners[0] === "string"));
        if (winners && rest.length > 0) triggers.push(end(rest, a.defeat()));
      }
      return { triggers };
    },
  },
  {
    spec: {
      kind: "objectives",
      description: "Set Mission Objectives for the players at the start.",
      params: [P("text", "the objectives, lines separated by \\n", true), P("players", "humans (default), all, or player numbers")],
    },
    build(r) {
      const text = r.str("text").replace(/\\n/g, "\n");
      const players = r.players("players");
      return { triggers: [trigger(players, [], [a.objectives(text)])] };
    },
  },
  {
    spec: {
      kind: "message",
      description: "Show a text message to players at a moment: at the start, after `after` seconds, or when a player brings a unit to `location`.",
      params: [P("text", "what to show", true), P("after", "seconds from the start (default 0)"), P("location", "show it when the player brings a unit here instead (default none)"), P("players", "humans (default), all, or player numbers"), P("once", "yes (default) or no: show it every time")],
    },
    build(r) {
      const text = r.str("text");
      const after = r.int("after", 0, 0, 86400);
      const location = r.str("location", "");
      const players = r.players("players");
      const once = r.bool("once", true);
      const conditions = location ? [c.bring(CUR, "Any unit", r.location("location"), "At least", 1)] : after > 0 ? [c.elapsed("At least", after)] : [];
      return { triggers: [trigger(players, conditions, once ? [a.text(text)] : [a.text(text), a.preserve()])] };
    },
  },
  {
    spec: {
      kind: "lives",
      description: "Shared lives for a defense map: an enemy unit reaching `goal` is removed and costs a life; at zero lives the players are defeated. The count is a death counter on the enemy slot.",
      params: [P("lives", "how many (default 20)", true), P("goal", "the location the enemies try to reach", true), P("enemy", "the player whose units leak (default computer)"), P("unit", "what counts as a leak (default Any unit)"), P("players", "who is defeated at zero (default humans)")],
    },
    build(r, _ctx, dc) {
      const lives = r.int("lives", 20, 1, 1000);
      const goal = r.location("goal");
      const enemy = r.onePlayer("enemy", "computer");
      const unit = r.str("unit", "Any unit");
      const players = r.players("players");
      const counter = dc.take("the lives counter");
      return {
        triggers: [
          trigger([enemy], [], [a.setDeaths(enemy, counter, "Set To", lives)]),
          trigger([enemy], [c.bring(enemy, unit, goal, "At least", 1)], [a.removeAt(enemy, unit, "All", goal), a.setDeaths(enemy, counter, "Subtract", 1), a.preserve()]),
          trigger(players, [c.deaths(enemy, counter, "Exactly", 0), c.elapsed("At least", 5)], [a.text("No lives left."), a.defeat()]),
        ],
        notes: ["several leaks in one cycle cost one life; the lives counter is not shown — add a `leaderboard` of kind points or a `message` if the players should see it"],
      };
    },
  },
  {
    spec: {
      kind: "waves",
      description: "Defense waves: every `interval` seconds the enemy spawns a wave at `spawn` and attack-moves it to `goal`; each wave is bigger than the last and cycles through `units`. Victory for the players when the last wave is dead.",
      params: [P("spawn", "where waves appear", true), P("goal", "where they attack toward", true), P("units", "unit names, comma-separated, one per wave in turn", true), P("waves", "how many (default 10)"), P("interval", "seconds between waves (default 45)"), P("count", "units in the first wave (default 6)"), P("growth", "more units per wave (default 2)"), P("enemy", "the spawning player (default computer)"), P("players", "who wins at the end (default humans)"), P("announce", "yes (default) or no: show \"Wave N\"")],
    },
    build(r, _ctx, dc) {
      const spawn = r.location("spawn");
      const goal = r.location("goal");
      const units = r.list("units");
      if (units.length === 0) r.problems.push('"units" needs at least one unit name');
      const waves = r.int("waves", 10, 1, 100);
      const interval = r.int("interval", 45, 5, 3600);
      const count = r.int("count", 6, 1, 200);
      const growth = r.int("growth", 2, 0, 100);
      const enemy = r.onePlayer("enemy", "computer");
      const players = r.players("players");
      const announce = r.bool("announce", true);
      const counter = dc.take("the wave counter");
      const triggers: string[] = [];
      for (let k = 1; k <= waves; k++) {
        const unit = units[(k - 1) % Math.max(1, units.length)] ?? "Zerg Zergling";
        const n = Math.min(200, count + growth * (k - 1));
        const actions = [a.setDeaths(enemy, counter, "Set To", k), a.create(enemy, unit, n, spawn), a.order(enemy, "Any unit", spawn, goal, "attack")];
        if (announce) actions.unshift(a.text(`Wave ${k}: ${n} ${unit}`));
        triggers.push(trigger([enemy], [c.elapsed("At least", interval * k), c.deaths(enemy, counter, "Exactly", k - 1)], actions));
      }
      triggers.push(trigger(players, [c.deaths(enemy, counter, "At least", waves), c.command(enemy, "Any unit", "Exactly", 0), c.elapsed("At least", interval * waves + 10)], [a.text("The last wave is dead."), a.victory()]));
      return { triggers, notes: [`${waves} waves, the last at ${interval * waves} s; the enemy player must own nothing else, or the victory never comes`] };
    },
  },
  {
    spec: {
      kind: "shop",
      description: "Buy a unit: a player who brings `buyer` to `location` with `price` minerals pays and gets `unit` at `deliver`.",
      params: [P("location", "the shop's beacon location", true), P("unit", "what is sold", true), P("price", "minerals (default 100)"), P("gas", "gas (default 0)"), P("buyer", "which unit must stand on the beacon (default Any unit)"), P("deliver", "where the bought unit appears (default the shop location)"), P("players", "humans (default) or player numbers")],
    },
    build(r) {
      const location = r.location("location");
      const unit = r.str("unit");
      const price = r.int("price", 100, 0);
      const gas = r.int("gas", 0, 0);
      const buyer = r.str("buyer", "Any unit");
      const deliver = r.location("deliver", location);
      const players = r.players("players");
      const conditions = [c.bring(CUR, buyer, location, "At least", 1)];
      if (price > 0) conditions.push(c.accumulate(CUR, "At least", price, "ore"));
      if (gas > 0) conditions.push(c.accumulate(CUR, "At least", gas, "gas"));
      const actions: string[] = [];
      if (price > 0) actions.push(a.setResources(CUR, "Subtract", price, "ore"));
      if (gas > 0) actions.push(a.setResources(CUR, "Subtract", gas, "gas"));
      actions.push(a.create(CUR, unit, 1, deliver), a.move(CUR, buyer, "All", location, deliver), a.preserve());
      return { triggers: [trigger(players, conditions, actions)], notes: ["the buyer is moved off the beacon after the purchase so one visit buys one unit"] };
    },
  },
  {
    spec: {
      kind: "heal",
      description: "A heal spot: a player's units standing on `location` are restored to full hit points (and shields).",
      params: [P("location", "where", true), P("unit", "what is healed (default Any unit)"), P("players", "humans (default) or player numbers")],
    },
    build(r) {
      const location = r.location("location");
      const unit = r.str("unit", "Any unit");
      const players = r.players("players");
      return { triggers: [trigger(players, [c.bring(CUR, unit, location, "At least", 1)], [a.hp(CUR, unit, 100, "All", location), a.shields(CUR, unit, 100, "All", location), a.preserve()])] };
    },
  },
  {
    spec: {
      kind: "respawn",
      description: "When a player has none of `unit` left, a new one appears at `location` (optionally a limited number of times).",
      params: [P("unit", "the hero", true), P("location", "where it comes back", true), P("lives", "how many respawns before it stops (default unlimited)"), P("players", "humans (default) or player numbers"), P("message", "text on respawn (default none)")],
    },
    build(r, _ctx, dc) {
      const unit = r.str("unit");
      const location = r.location("location");
      const lives = r.int("lives", 0, 0, 1000);
      const players = r.players("players");
      const message = r.str("message", "");
      const conditions = [c.command(CUR, unit, "Exactly", 0), c.elapsed("At least", 3)];
      const actions = [a.create(CUR, unit, 1, location)];
      if (message) actions.push(a.text(message));
      if (lives > 0) {
        const counter = dc.take("the respawn counter");
        conditions.push(c.deaths(CUR, counter, "At most", lives - 1));
        actions.push(a.setDeaths(CUR, counter, "Add", 1));
      }
      actions.push(a.preserve());
      return { triggers: [trigger(players, conditions, actions)] };
    },
  },
  {
    spec: {
      kind: "leaderboard",
      description: "The in-game leaderboard: `kind` kills, control (units owned), resources or points.",
      params: [P("kind", "kills (default), control, resources or points"), P("label", "the heading (default by kind)"), P("unit", "for kills and control: which unit (default Any unit)"), P("players", "humans (default), all, or player numbers")],
    },
    build(r) {
      const kind = r.str("kind", "kills").toLowerCase();
      const unit = r.str("unit", "Any unit");
      const players = r.players("players");
      let action: string;
      switch (kind) {
        case "control": action = a.lbControl(r.str("label", "Units"), unit); break;
        case "resources": action = a.lbResources(r.str("label", "Minerals"), "ore"); break;
        case "points": action = a.lbPoints(r.str("label", "Score"), "Total"); break;
        case "kills": action = a.lbKills(r.str("label", "Kills"), unit); break;
        default: r.problems.push(`"kind" should be kills, control, resources or points, not "${kind}"`); action = a.lbKills("Kills", unit);
      }
      return { triggers: [trigger(players, [], [action])] };
    },
  },
  {
    spec: {
      kind: "teleport",
      description: "A unit brought to `from` is moved to `to`.",
      params: [P("from", "the entry location", true), P("to", "the exit location", true), P("unit", "what moves (default Any unit)"), P("players", "humans (default), all, or player numbers")],
    },
    build(r) {
      const from = r.location("from");
      const to = r.location("to");
      const unit = r.str("unit", "Any unit");
      const players = r.players("players");
      return { triggers: [trigger(players, [c.bring(CUR, unit, from, "At least", 1)], [a.move(CUR, unit, "All", from, to), a.preserve()])] };
    },
  },
  {
    spec: {
      kind: "kill-zone",
      description: "Units entering `location` die (a pit, lava, the edge of a bound).",
      params: [P("location", "where", true), P("unit", "what dies (default Any unit)"), P("players", "whose units (default all)")],
    },
    build(r) {
      const location = r.location("location");
      const unit = r.str("unit", "Any unit");
      const players = r.players("players", "all");
      return { triggers: [trigger(players, [c.bring(CUR, unit, location, "At least", 1)], [a.killAt(CUR, unit, "All", location), a.preserve()])] };
    },
  },
  {
    spec: {
      kind: "alliance",
      description: "Set alliances at the start: `players` treat `with` as `status` (Ally, Enemy or Allied Victory).",
      params: [P("players", "who is setting it (default humans)"), P("with", "toward whom: a player number, computer, humans, or Force N", true), P("status", "Ally (default), Enemy or Allied Victory")],
    },
    build(r, ctx) {
      const players = r.players("players");
      const withRaw = r.str("with");
      const status = r.str("status", "Ally");
      const st = /victory/i.test(status) ? "Allied Victory" : /enemy/i.test(status) ? "Enemy" : "Ally";
      const targets: (number | string)[] = /^humans?$/i.test(withRaw) ? ctx.humans : /^computers?$/i.test(withRaw) ? ctx.computers : /^force\s*[1-4]$/i.test(withRaw) ? [`Force ${withRaw.replace(/\D/g, "")}`] : withRaw.split(/[,\s]+/).map(Number).filter((n) => n >= 1 && n <= 12);
      if (targets.length === 0) r.problems.push(`"with" should name players, not "${withRaw}"`);
      return { triggers: [trigger(players, [], targets.map((t) => a.alliance(t, st)))] };
    },
  },
  {
    spec: {
      kind: "auto-attack",
      description: "Keep a player's units moving: every cycle, order all of `unit` at `from` to attack-move to `to`. What makes a madness map's spawns fight by themselves.",
      params: [P("owner", "whose units (a player number or computer)", true), P("from", "where they are (Anywhere for all of them)", true), P("to", "where they go", true), P("unit", "which units (default Any unit)"), P("order", "attack (default), move or patrol")],
    },
    build(r) {
      const owner = r.onePlayer("owner");
      const from = r.location("from");
      const to = r.location("to");
      const unit = r.str("unit", "Any unit");
      const order = r.str("order", "attack").toLowerCase();
      const ord = order === "move" || order === "patrol" ? order : "attack";
      return { triggers: [trigger([owner], [], [a.order(owner, unit, from, to, ord), a.preserve()])] };
    },
  },
  {
    spec: {
      kind: "give",
      description: "Units of `unit` that `from` owns at `location` are given to the player who brings a unit there (rescue by touch, a hired unit).",
      params: [P("location", "where", true), P("from", "the owner giving them (default computer)"), P("unit", "what is given (default Any unit)"), P("players", "who can take them (default humans)"), P("touch", "the unit that must be brought to take them (default Any unit)")],
    },
    build(r) {
      const location = r.location("location");
      const from = r.onePlayer("from", "computer");
      const unit = r.str("unit", "Any unit");
      const players = r.players("players");
      const touch = r.str("touch", "Any unit");
      return { triggers: [trigger(players, [c.bring(CUR, touch, location, "At least", 1), c.bring(from, unit, location, "At least", 1)], [a.give(from, CUR, unit, "All", location), a.preserve()])] };
    },
  },
];

/** The catalogue, as sent to the server with a design request. */
export function systemKinds(): SystemKindSpec[] {
  return KINDS.map((k) => k.spec);
}

export function kindByName(kind: string): SystemKindSpec | null {
  return KINDS.find((k) => k.spec.kind === kind)?.spec ?? null;
}

/**
 * Build one system. Throws `ToolkitError` naming every problem — a missing parameter, an
 * unknown location, a kind that does not exist — so a design can be repaired rather than
 * half built. `dc` carries the death-counter allocation across the systems of one build.
 */
export function buildSystem(kind: string, params: Params, ctx: ToolkitContext, dc: Counters = new Counters(ctx)): BuiltSystem {
  const k = KINDS.find((x) => x.spec.kind === kind);
  if (!k) throw new ToolkitError([`no system kind called "${kind}" (the toolkit has ${KINDS.map((x) => x.spec.kind).join(", ")})`]);
  const reader = new Reader(k.spec, params, ctx);
  const before = dc.used.length;
  const out = k.build(reader, ctx, dc);
  reader.finish();
  const text = out.triggers.join("\n");
  return { text, count: out.triggers.length, notes: [...reader.notes, ...(out.notes ?? [])], dcUsed: dc.used.slice(before) };
}

/** Build several systems in one go, sharing the death-counter allocation. */
export function buildSystems(systems: { kind: string; params: Params }[], ctx: ToolkitContext): BuiltSystem[] {
  const dc = new Counters(ctx);
  return systems.map((s) => buildSystem(s.kind, s.params, ctx, dc));
}

/** `params` as the wire form `{ key, value }[]` back to a record. */
export function paramsOf(list: { key: string; value: string }[]): Params {
  const out: Params = {};
  for (const p of list) out[p.key] = p.value;
  return out;
}

/** A death-counter list from what the open map calls its units: the defaults that exist, in order. */
export function dcUnitsFrom(unitNames: string[]): string[] {
  const have = new Set(unitNames.map((n) => n.toLowerCase()));
  return DEFAULT_DC_UNITS.filter((n) => have.has(n.toLowerCase()));
}

/** The catalogue as text for a tool answer or a prompt. */
export function kindsText(): string {
  return KINDS.map((k) => `${k.spec.kind}: ${k.spec.description}\n${k.spec.params.map((p) => `  - ${p.name}${p.required ? " (required)" : ""}: ${p.description}`).join("\n")}`).join("\n\n");
}
