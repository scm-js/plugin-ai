import { describe, expect, it } from "vitest";
import { AccountManager } from "../account";
import { AiClient, AiError } from "../client";
import type { Settings, SettingsStore } from "../settings";
import { DEFAULT_SETTINGS } from "../settings";

function store(patch: Partial<Settings> = {}): SettingsStore & { s: Settings } {
  const o = { s: { ...DEFAULT_SETTINGS, deviceId: "device-0001", ...patch }, get() { return o.s; }, set(p: Partial<Settings>) { o.s = { ...o.s, ...p }; } };
  return o;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const trialView = { kind: "trial", role: "trial", balanceUsd: 0.5, weeklyUsd: 0, creditUsd: 0.5, providers: [] };

describe("account manager", () => {
  it("starts the trial before the first call and sends the session after", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const st = store();
    const client = new AiClient(() => ({ serverUrl: st.s.serverUrl, access: st.s.access, session: st.s.session, token: "", ownKey: "" }), async (u, init) => {
      calls.push({ url: String(u), headers: init!.headers as Record<string, string>, body: String(init!.body ?? "") });
      if (String(u).endsWith("/v1/trial")) return json({ session: "sess_abc", account: trialView });
      return json({ id: "1", recipe: "describe", output: { text: "x" }, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1, durationMs: 1 }, remaining: { balanceUsd: 0.4 } });
    });
    const account = new AccountManager(st, client);
    expect(account.summary()).toBe("First use starts a free trial.");
    await client.run("explain-triggers", { text: "t" });
    expect(calls.map((c) => c.url)).toEqual(["https://api.scmjs.dev/v1/trial", "https://api.scmjs.dev/v1/recipes/explain-triggers"]);
    expect(JSON.parse(calls[0]!.body)).toEqual({ deviceId: "device-0001" });
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(calls[1]!.headers.Authorization).toBe("Bearer sess_abc");
    expect(st.s.session).toBe("sess_abc");
    expect(account.current()?.balanceUsd).toBe(0.4);
    expect(account.summary()).toContain("$0.40 left");
    // A second call does not ask for another trial.
    await client.run("explain-triggers", { text: "t" });
    expect(calls.filter((c) => c.url.endsWith("/v1/trial"))).toHaveLength(1);
  });

  it("turns a refused trial into a budget error that points at signing in, and is inert in the other modes", async () => {
    const st = store();
    const client = new AiClient(() => ({ serverUrl: st.s.serverUrl, access: st.s.access, session: st.s.session, token: "", ownKey: "" }), async () => json({ error: { code: "forbidden", message: "This browser has had its free trial. Sign in to keep a balance." } }, 403));
    new AccountManager(st, client);
    await expect(client.run("explain-triggers", { text: "t" })).rejects.toMatchObject({ code: "budget_exceeded", message: /Sign in/ });
    expect(st.s.session).toBe("");

    const keyed = store({ access: "key", ownKey: "sk" });
    let hit = 0;
    const c2 = new AiClient(() => ({ serverUrl: keyed.s.serverUrl, access: keyed.s.access, session: "", token: "", ownKey: keyed.s.ownKey }), async (u, init) => {
      hit++;
      expect(String(u)).not.toContain("/v1/trial");
      expect((init!.headers as Record<string, string>)["X-Anthropic-Key"]).toBe("sk");
      return json({ id: "1", recipe: "describe", output: { text: "x" }, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1, durationMs: 1 } });
    });
    const m2 = new AccountManager(keyed, c2);
    expect(m2.active()).toBe(false);
    expect(m2.summary()).toBeNull();
    await c2.run("explain-triggers", { text: "t" });
    expect(hit).toBe(1);
  });

  it("drops a session the server no longer knows on refresh, and signs out locally even when the server is down", async () => {
    const st = store({ session: "sess_old" });
    const client = new AiClient(() => ({ serverUrl: st.s.serverUrl, access: st.s.access, session: st.s.session, token: "", ownKey: "" }), async (u) => {
      if (String(u).endsWith("/v1/account")) return json({ error: { code: "unauthorized", message: "gone" } }, 401);
      throw new TypeError("offline");
    });
    const account = new AccountManager(st, client);
    expect(await account.refresh()).toBeNull();
    expect(st.s.session).toBe("");
    st.set({ session: "sess_x" });
    await account.signOut();
    expect(st.s.session).toBe("");
    expect(() => { throw new AiError("aborted", "x"); }).toThrow();
  });

  it("follows the scmjs.dev plugin's service while it is there, and goes back to its own when it leaves", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const st = store({ session: "own_session" });
    let account: AccountManager;
    const client = new AiClient(() => { const m = account.managedBy(); return { serverUrl: m?.serverUrl() ?? st.s.serverUrl, access: st.s.access, session: m?.session() ?? st.s.session, token: "", ownKey: "" }; }, async (u, init) => {
      calls.push({ url: String(u), headers: init!.headers as Record<string, string> });
      return json({ id: "1", recipe: "describe", output: { text: "x" }, usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1, durationMs: 1 }, remaining: { balanceUsd: 0.9 } });
    });
    account = new AccountManager(st, client);
    let listener: (() => void) | null = null;
    const log: string[] = [];
    const state = { kind: "account" as const, account: { kind: "account" as const, name: "Zerg", role: "free", balanceUsd: 1, weeklyUsd: 1, creditUsd: 0, providers: ["discord"] }, storage: null, offers: null };
    const service = {
      state: () => state,
      onChange: (l: () => void) => { listener = l; return () => { listener = null; }; },
      serverUrl: () => "https://other.example",
      session: () => "shared_session",
      headers: () => ({ Authorization: "Bearer shared_session" }),
      ensureSession: async () => { log.push("ensure"); },
      signIn: async () => { log.push("signIn"); return state.account; },
      signOut: async () => { log.push("signOut"); },
      refresh: async () => state.account,
      openAccount: () => { log.push("open"); },
      noteBalance: (usd: number) => { log.push(`balance ${usd}`); },
    };
    let changes = 0;
    account.onChange(() => changes++);
    account.setProvider(service);
    expect(account.managed()).toBe(true);
    expect(account.signedIn()).toBe(true);
    expect(account.current()?.name).toBe("Zerg");
    expect(account.summary()).toBe("Zerg: $1.00 left");
    await client.run("explain-triggers", { text: "t" });
    // The call went to the service's server with the service's session, and the balance went back to it.
    expect(calls[0]!.url).toBe("https://other.example/v1/recipes/explain-triggers");
    expect(calls[0]!.headers.Authorization).toBe("Bearer shared_session");
    expect(log).toEqual(["ensure", "balance 0.9"]);
    expect(st.s.session).toBe("own_session");
    await account.signIn("discord");
    account.openAccountPage();
    await account.signOut();
    expect(log.slice(2)).toEqual(["signIn", "open", "signOut"]);
    // The service's changes reach this plugin's listeners.
    const before = changes;
    listener!();
    expect(changes).toBe(before + 1);
    // In token mode the service is not consulted.
    st.set({ access: "token", token: "tok" });
    expect(account.managed()).toBe(false);
    expect(account.summary()).toBeNull();
    st.set({ access: "account" });
    // The plugin leaving: back to the plugin's own session.
    account.setProvider(null);
    expect(account.managed()).toBe(false);
    expect(listener).toBeNull();
    await client.run("explain-triggers", { text: "t" });
    expect(calls[1]!.url).toBe("https://api.scmjs.dev/v1/recipes/explain-triggers");
    expect(calls[1]!.headers.Authorization).toBe("Bearer own_session");
  });
});
