import { describe, expect, it } from "vitest";
import { AiClient, AiError, describeError, formatUsage, formatUsd, Ledger, SseParser } from "../client";
import type { RecipeEvent, Usage } from "../protocol";

const usage: Usage = { model: "m", inputTokens: 6000, outputTokens: 1100, cacheReadTokens: 200, cacheWriteTokens: 0, costUsd: 0.18, durationMs: 14_200 };

describe("SseParser", () => {
  it("parses frames, joins data lines, ignores comments, and waits for split frames", () => {
    const p = new SseParser();
    expect(p.feed('data: {"a":1}\n\n: heartbeat\n\ndata: {"b":\ndata: 2}\n\ndata: {"c"')).toEqual(['{"a":1}', '{"b":\n2}']);
    expect(p.feed(':3}\n')).toEqual([]);
    expect(p.feed('\n')).toEqual(['{"c":3}']);
    expect(p.feed('event: x\r\ndata: last')).toEqual([]);
    expect(p.end()).toEqual(["last"]);
    expect(p.end()).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats money, tokens and usage", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsage(usage)).toBe("$0.18 · 14 s · 6.2k in / 1.1k out");
  });
  it("the ledger adds up and tells listeners", () => {
    const l = new Ledger();
    let calls = 0;
    const off = l.onChange(() => calls++);
    l.add(usage);
    l.add(usage);
    off();
    l.add(usage);
    expect(calls).toBe(2);
    expect(l.totals).toEqual({ calls: 3, costUsd: 0.54, inputTokens: 18600, outputTokens: 3300 });
    expect(l.summary()).toBe("Session: $0.54 over 3 calls");
  });
  it("describes errors with what to do", () => {
    expect(describeError(new AiError("rate_limited", "slow down", { retryAfterSec: 30 }))).toContain("30 seconds");
    expect(describeError(new AiError("rate_limited", "slow down", { retryAfterSec: 600 }))).toContain("10 minutes");
    expect(describeError(new AiError("unauthorized", "bad token."))).toContain("AI Settings");
    expect(describeError(new Error("boom"))).toBe("boom");
  });
});

function sseResponse(events: RecipeEvent[], chunk = 7): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(at, at + chunk));
      at += chunk;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("AiClient", () => {
  const creds = () => ({ serverUrl: "https://ai.example/", access: "token" as const, session: "", token: "tok", ownKey: "" });

  it("streams a recipe, reporting deltas and thinking, and books the usage", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new AiClient(creds, async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return sseResponse([
        { event: "start", id: "1", recipe: "explain-triggers", model: "claude-opus-5" },
        { event: "progress", elapsedMs: 100 },
        { event: "thinking", text: "hm" },
        { event: "delta", text: "Hello " },
        { event: "delta", text: "world" },
        { event: "result", output: { text: "Hello world" }, usage },
        { event: "done" },
      ]);
    });
    const deltas: string[] = [];
    let model = "";
    let thinking = "";
    const r = await client.run("explain-triggers", { text: "x" }, { onDelta: (t) => deltas.push(t), onStart: (m) => { model = m; }, onThinking: (t) => { thinking += t; } });
    expect(r.output).toEqual({ text: "Hello world" });
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(model).toBe("claude-opus-5");
    expect(thinking).toBe("hm");
    expect(client.ledger.totals.calls).toBe(1);
    expect(seen[0].url).toBe("https://ai.example/v1/recipes/explain-triggers");
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["X-Anthropic-Key"]).toBeUndefined();
    expect(JSON.parse(seen[0].init.body as string)).toMatchObject({ protocol: 1, input: { text: "x" } });
  });

  it("accepts a JSON answer from a server that does not stream", async () => {
    const client = new AiClient(creds, async () => new Response(JSON.stringify({ id: "1", recipe: "describe", output: { name: "N", description: "D", alternatives: [] }, usage }), { status: 200, headers: { "content-type": "application/json" } }));
    const r = await client.run("describe", { facts: {} as never });
    expect(r.output).toMatchObject({ name: "N" });
  });

  it("turns error bodies, error events and network failures into AiErrors", async () => {
    const bodyErr = new AiClient(creds, async () => new Response(JSON.stringify({ error: { code: "budget_exceeded", message: "no more" } }), { status: 402 }));
    await expect(bodyErr.run("describe", { facts: {} as never })).rejects.toMatchObject({ code: "budget_exceeded", message: "no more", status: 402 });

    const eventErr = new AiClient(creds, async () => sseResponse([{ event: "start", id: "1", recipe: "describe", model: "m" }, { event: "error", error: { code: "refused", message: "declined" } }]));
    await expect(eventErr.run("describe", { facts: {} as never })).rejects.toMatchObject({ code: "refused" });

    const noResult = new AiClient(creds, async () => sseResponse([{ event: "done" }]));
    await expect(noResult.run("describe", { facts: {} as never })).rejects.toMatchObject({ code: "protocol" });

    const down = new AiClient(creds, async () => { throw new TypeError("Failed to fetch"); });
    await expect(down.run("describe", { facts: {} as never })).rejects.toMatchObject({ code: "network" });

    const noUrl = new AiClient(() => ({ serverUrl: "", access: "account" as const, session: "", token: "", ownKey: "" }), async () => new Response("{}"));
    await expect(noUrl.info()).rejects.toMatchObject({ code: "network" });

    const plain401 = new AiClient(creds, async () => new Response("nope", { status: 401 }));
    await expect(plain401.info()).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("checks the protocol version on /v1/info and sends the own key when set", async () => {
    let headers: Record<string, string> = {};
    const client = new AiClient(() => ({ serverUrl: "https://x", access: "key" as const, session: "", token: "", ownKey: "sk-ant-1" }), async (_u, init) => { headers = init!.headers as Record<string, string>; return new Response(JSON.stringify({ protocol: 1, version: "0.1.0", name: "n", models: [], recipes: [], access: { anonymous: false, byok: true }, caller: { kind: "byok", remaining: {} } })); });
    const info = await client.info();
    expect(info.caller.kind).toBe("byok");
    expect(headers["X-Anthropic-Key"]).toBe("sk-ant-1");
    expect(headers.Authorization).toBeUndefined();
    const old = new AiClient(creds, async () => new Response(JSON.stringify({ protocol: 2 })));
    await expect(old.info()).rejects.toMatchObject({ code: "protocol" });
  });
});
