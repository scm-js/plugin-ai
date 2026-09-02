/**
 * The server client: one `run` per recipe over `POST /v1/recipes/<name>` with
 * `Accept: text/event-stream`, an SSE parser that copes with frames split across
 * chunks, the error codes turned into sentences a person can act on, and a ledger of
 * what the session has cost. The transport is `fetch`; nothing is sent until `run` or
 * `info` is called.
 */
import type { AccountResponse, Allowance, AuthStartResponse, CheckoutResponse, ErrorBody, ErrorCode, InfoResponse, RecipeEvent, RecipeInputs, RecipeName, RecipeOptions, RecipeOutputs, RecipeRequest, RecipeResponse, TrialResponse, Usage } from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";

/** How the caller identifies itself: a server-issued session (trial or signed-in account), an operator's token, or their own key. */
export type AccessMode = "account" | "token" | "key";

export interface Credentials {
  serverUrl: string;
  access: AccessMode;
  /** The session the server issued (`account` mode). */
  session: string;
  /** An access token the server's operator issued (`token` mode). */
  token: string;
  /** The user's own Anthropic key, forwarded and never stored by the server (`key` mode). */
  ownKey: string;
}

export interface RunHooks {
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
  onProgress?: (elapsedMs: number) => void;
  onStart?: (model: string) => void;
  signal?: AbortSignal;
}

export interface RunResult<N extends RecipeName> {
  output: RecipeOutputs[N];
  usage: Usage;
  remaining?: RecipeResponse["remaining"];
}

export class AiError extends Error {
  readonly code: ErrorCode | "network" | "aborted" | "protocol";
  readonly retryAfterSec?: number;
  readonly status?: number;
  constructor(code: AiError["code"], message: string, extra: { retryAfterSec?: number; status?: number } = {}) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.retryAfterSec = extra.retryAfterSec;
    this.status = extra.status;
  }
}

/** The sentence a dialog shows for a failure, with what to do about it. */
export function describeError(err: unknown): string {
  if (err instanceof AiError) {
    const retry = err.retryAfterSec ? ` Try again in ${err.retryAfterSec >= 90 ? `${Math.ceil(err.retryAfterSec / 60)} minutes` : `${err.retryAfterSec} seconds`}.` : "";
    switch (err.code) {
      case "unauthorized": return `The server did not accept the credentials: ${err.message} See AI Settings.`;
      case "forbidden": return `The server refused: ${err.message}`;
      case "rate_limited": return `Too many requests for now.${retry}`;
      case "too_busy": return `The server is busy.${retry || " Try again in a moment."}`;
      case "budget_exceeded": return `The spending allowance is used up: ${err.message}`;
      case "recipe_disabled": return "The server has this feature turned off.";
      case "model_not_allowed": return `The server does not allow that model: ${err.message} Pick another in AI Settings.`;
      case "refused": return `The model declined this request. ${err.message}`.trim();
      case "invalid_input": return `The server rejected the request: ${err.message}`;
      case "upstream": return `The model service failed: ${err.message}`;
      case "network": return `The server could not be reached: ${err.message} Check the address in AI Settings.`;
      case "aborted": return "Stopped.";
      case "protocol": return `The server answered in a form this plugin does not understand: ${err.message}`;
      default: return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/* ── SSE ────────────────────────────────────────────────── */

/**
 * A server-sent-events parser fed chunk by chunk: frames are separated by a blank
 * line, a frame's `data:` lines are joined with newlines, and a frame with no data is
 * ignored (a comment line `:` is what a heartbeat looks like). Bytes of a frame that
 * has not ended yet wait for the next chunk.
 */
export class SseParser {
  private buffer = "";

  feed(chunk: string): string[] {
    this.buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const out: string[] = [];
    let at: number;
    while ((at = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
      if (data.length > 0) out.push(data.join("\n"));
    }
    return out;
  }

  /** Whatever is left when the stream ends: a last frame with no trailing blank line. */
  end(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest.trim()) return [];
    const data = rest.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
    return data.length > 0 ? [data.join("\n")] : [];
  }
}

/* ── Ledger ─────────────────────────────────────────────── */

export interface LedgerTotals {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** What the session has spent so far, shown at the foot of every dialog. */
export class Ledger {
  readonly totals: LedgerTotals = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  private readonly listeners = new Set<() => void>();

  add(usage: Usage) {
    this.totals.calls++;
    this.totals.costUsd += usage.costUsd;
    this.totals.inputTokens += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    this.totals.outputTokens += usage.outputTokens;
    for (const l of this.listeners) l();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  summary(): string {
    const t = this.totals;
    if (t.calls === 0) return "Nothing spent this session.";
    return `Session: ${formatUsd(t.costUsd)} over ${t.calls} call${t.calls === 1 ? "" : "s"}`;
  }
}

export function formatUsd(v: number): string {
  if (v < 0.005) return v === 0 ? "$0.00" : "<$0.01";
  return `$${v.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/** `$0.18 · 14 s · 6.2k in / 1.1k out`. */
export function formatUsage(u: Usage): string {
  const secs = u.durationMs >= 1000 ? `${Math.round(u.durationMs / 1000)} s` : `${u.durationMs} ms`;
  const inTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return `${formatUsd(u.costUsd)} · ${secs} · ${formatTokens(inTokens)} in / ${formatTokens(u.outputTokens)} out`;
}

/* ── Client ─────────────────────────────────────────────── */

export class AiClient {
  readonly ledger = new Ledger();
  /** Runs before every recipe call — the account manager uses it to obtain a trial session first. */
  prepare: (() => Promise<void>) | null = null;
  /** Hears the allowance that came back with a result. */
  onRemaining: ((remaining: Allowance) => void) | null = null;
  private readonly credentials: () => Credentials;
  private readonly fetchImpl: typeof fetch;
  constructor(credentials: () => Credentials, fetchImpl: typeof fetch = (...args) => fetch(...args)) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
  }

  base(): string {
    const url = this.credentials().serverUrl.trim().replace(/\/+$/, "");
    if (!url) throw new AiError("network", "no server address is set.");
    return url;
  }

  private headers(json: boolean): Record<string, string> {
    const c = this.credentials();
    const h: Record<string, string> = { Accept: json ? "application/json" : "text/event-stream" };
    const bearer = c.access === "account" ? c.session : c.access === "token" ? c.token : "";
    if (bearer.trim()) h.Authorization = `Bearer ${bearer.trim()}`;
    if (c.access === "key" && c.ownKey.trim()) h["X-Anthropic-Key"] = c.ownKey.trim();
    return h;
  }

  /** One JSON POST under the base, with the credentials; errors as `AiError`. */
  private async postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base()}${path}`, { method: "POST", headers: { ...this.headers(true), "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as T;
  }

  /** `POST /v1/trial`: a session with the free trial on it, once per device id. */
  trial(deviceId: string): Promise<TrialResponse> {
    return this.postJson<TrialResponse>("/v1/trial", { deviceId });
  }

  /** `POST /v1/auth/start`: where to send the popup; the callback posts the session back to `returnOrigin`. */
  authStart(provider: string, returnOrigin: string): Promise<AuthStartResponse> {
    return this.postJson<AuthStartResponse>("/v1/auth/start", { provider, returnOrigin });
  }

  /** `POST /v1/auth/logout`: ends the session the credentials carry. */
  logout(): Promise<unknown> {
    return this.postJson("/v1/auth/logout", {});
  }

  /** `GET /v1/account`: the balance and the ledger behind the session. */
  async account(signal?: AbortSignal): Promise<AccountResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base()}/v1/account`, { headers: this.headers(true), signal });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as AccountResponse;
  }

  /** `POST /v1/billing/checkout`: the payment page for a pack. */
  checkout(pack: string): Promise<CheckoutResponse> {
    return this.postJson<CheckoutResponse>("/v1/billing/checkout", { pack });
  }

  /** `GET /v1/info`: what the server offers and what the caller has left. */
  async info(signal?: AbortSignal): Promise<InfoResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base()}/v1/info`, { headers: this.headers(true), signal });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await errorOf(res);
    const info = (await res.json()) as InfoResponse;
    if (info.protocol !== PROTOCOL_VERSION) throw new AiError("protocol", `it speaks protocol ${info.protocol}, this plugin speaks ${PROTOCOL_VERSION}.`);
    return info;
  }

  /** Run one recipe, streaming events to the hooks; resolves with the output and what it cost. */
  async run<N extends RecipeName>(name: N, input: RecipeInputs[N], hooks: RunHooks = {}, options?: RecipeOptions): Promise<RunResult<N>> {
    if (this.prepare) await this.prepare();
    const body: RecipeRequest<N> = { protocol: PROTOCOL_VERSION, input, options };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base()}/v1/recipes/${name}`, {
        method: "POST",
        headers: { ...this.headers(false), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: hooks.signal,
      });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (!res.ok) throw await errorOf(res);
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream")) {
      // A JSON answer (a server that does not stream): one result.
      const r = (await res.json()) as RecipeResponse<N>;
      this.ledger.add(r.usage);
      if (r.remaining) this.onRemaining?.(r.remaining);
      return { output: r.output, usage: r.usage, remaining: r.remaining };
    }
    if (!res.body) throw new AiError("protocol", "the stream had no body.");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let result: RunResult<N> | null = null;
    const handle = (data: string) => {
      let ev: RecipeEvent<N>;
      try { ev = JSON.parse(data) as RecipeEvent<N>; } catch { return; }
      switch (ev.event) {
        case "start": hooks.onStart?.(ev.model); break;
        case "progress": hooks.onProgress?.(ev.elapsedMs); break;
        case "thinking": hooks.onThinking?.(ev.text); break;
        case "delta": hooks.onDelta?.(ev.text); break;
        case "result": result = { output: ev.output, usage: ev.usage, remaining: ev.remaining }; break;
        case "error": throw new AiError(ev.error.code, ev.error.message, { retryAfterSec: ev.error.retryAfterSec });
        case "done": break;
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const data of parser.feed(decoder.decode(value, { stream: true }))) handle(data);
      }
      for (const data of parser.end()) handle(data);
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw toNetworkError(err);
    }
    if (!result) throw new AiError("protocol", "the stream ended without a result.");
    const r: RunResult<N> = result;
    this.ledger.add(r.usage);
    if (r.remaining) this.onRemaining?.(r.remaining);
    return r;
  }
}

function toNetworkError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof DOMException && err.name === "AbortError") return new AiError("aborted", "stopped");
  const message = err instanceof Error ? err.message : String(err);
  return new AiError("network", message.endsWith(".") ? message : `${message}.`);
}

async function errorOf(res: Response): Promise<AiError> {
  let body: ErrorBody | null = null;
  try { body = (await res.json()) as ErrorBody; } catch { /* not JSON */ }
  if (body?.error?.code) return new AiError(body.error.code, body.error.message, { retryAfterSec: body.error.retryAfterSec, status: res.status });
  const retry = Number(res.headers.get("retry-after"));
  if (res.status === 401) return new AiError("unauthorized", `HTTP ${res.status}.`, { status: res.status });
  if (res.status === 429) return new AiError("rate_limited", `HTTP ${res.status}.`, { status: res.status, retryAfterSec: retry || undefined });
  return new AiError("upstream", `HTTP ${res.status} ${res.statusText}`.trim() + ".", { status: res.status });
}
