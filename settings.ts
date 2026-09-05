/**
 * The plugin's settings — where the server is, how the caller identifies itself, and
 * which model and effort to ask for — persisted through `api.storage`, plus the
 * Settings dialog. Three ways in: a *scmjs.dev account* (the default: a free trial with
 * no sign-in, then sign in with Discord for a weekly allowance, top up when needed), an
 * *access token* from whoever runs a server, or *your own Anthropic key*. The session,
 * the token and the key are all kept in the browser's storage like the rest; the dialog
 * says so next to the fields.
 */
import type { PluginApi } from "@scm-js/plugin-api";
import type { InfoResponse } from "./protocol";
import { AiClient, describeError, formatUsd, type AccessMode } from "./client";
import { append, clear, h, styled, type Ctx } from "./ui";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The server the plugin talks to unless told otherwise. */
export const DEFAULT_SERVER_URL = "https://api.scmjs.dev";

export interface Settings {
  serverUrl: string;
  access: AccessMode;
  /** The session the server issued in account mode (a trial's or a signed-in account's). */
  session: string;
  /** A random id made once, for the one free trial a browser gets. */
  deviceId: string;
  token: string;
  ownKey: string;
  /** Empty for the server's default. */
  model: string;
  /** Empty for the recipe's default. */
  effort: Effort | "";
  showThinking: boolean;
  /** Rounds of tool calls the assistant may make for one message before it stops and asks. */
  maxRounds: number;
  /** Send a picture of the visible area with every assistant message. */
  attachView: boolean;
  /** The assistant floats over the map (the default) or lives in the right dock under the built-in panels. */
  dockAssistant: boolean;
}

export const DEFAULT_SETTINGS: Settings = { serverUrl: DEFAULT_SERVER_URL, access: "account", session: "", deviceId: "", token: "", ownKey: "", model: "", effort: "", showThinking: true, maxRounds: 24, attachView: false, dockAssistant: false };

const KEY = "settings";

function newDeviceId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function loadSettings(api: PluginApi): Settings {
  const stored = api.storage.get<Partial<Settings>>(KEY, {});
  const s: Settings = { ...DEFAULT_SETTINGS, ...stored };
  // Settings from before there were accounts: keep the way they were connecting.
  if (!stored.access) s.access = stored.token ? "token" : stored.ownKey ? "key" : "account";
  if (!s.serverUrl.trim()) s.serverUrl = DEFAULT_SERVER_URL;
  if (!s.deviceId) s.deviceId = newDeviceId();
  return s;
}

export function saveSettings(api: PluginApi, s: Settings) {
  api.storage.set(KEY, s);
}

export interface SettingsStore {
  get(): Settings;
  set(patch: Partial<Settings>): void;
}

export function settingsStore(api: PluginApi): SettingsStore {
  let current = loadSettings(api);
  saveSettings(api, current);
  return {
    get: () => current,
    set: (patch) => { current = { ...current, ...patch }; saveSettings(api, current); },
  };
}

/* ── The dialog ─────────────────────────────────────────── */

export function openSettings(ctx: Ctx, store: SettingsStore) {
  const { api, account } = ctx;
  const w = api.ui.widgets;
  api.ui.dialog({
    title: "AI Settings",
    size: "md",
    mount(body) {
      const root = styled(body);
      const s = { ...store.get() };
      let info: InfoResponse | null = null;
      /** The dialog's own client, over the values being edited, so Test and sign-in use them before they are saved. */
      const client = new AiClient(() => ({ serverUrl: s.serverUrl, access: s.access, session: store.get().session, token: s.token, ownKey: s.ownKey }));

      const accessSelect = w.select([
        { value: "account", label: "scmjs.dev account — free trial, then sign in" },
        { value: "token", label: "Access token from a server's operator" },
        { value: "key", label: "My own Anthropic key" },
      ], { value: s.access, onChange: (v) => { s.access = v as AccessMode; store.set({ access: s.access }); showPane(); void connect(); } });
      const serverField = w.text({ value: s.serverUrl, placeholder: DEFAULT_SERVER_URL, onChange: (v) => { s.serverUrl = v.trim() || DEFAULT_SERVER_URL; } });
      const tokenField = w.text({ value: s.token, password: true, placeholder: "given out by whoever runs the server", onChange: (v) => { s.token = v.trim(); } });
      const keyField = w.text({ value: s.ownKey, password: true, placeholder: "sk-ant-…", onChange: (v) => { s.ownKey = v.trim(); } });
      const modelSelect = w.select([{ value: "", label: "Server default" }], { value: s.model, onChange: (v) => { s.model = v; } });
      const effortSelect = w.select([
        { value: "", label: "Recipe default" },
        { value: "low", label: "Low — quick and cheap" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Very high" },
        { value: "max", label: "Maximum — slow, thorough, dear" },
      ], { value: s.effort, onChange: (v) => { s.effort = v as Effort | ""; } });
      const thinkingBox = w.checkbox("Show the model's reasoning summary while it works", { value: s.showThinking, onChange: (v) => { s.showThinking = v; } });
      const dockBox = w.checkbox("Dock the assistant at the right, under the Properties panel, instead of floating over the map", { value: s.dockAssistant, onChange: (v) => { s.dockAssistant = v; } });
      const roundsField = w.number({ value: s.maxRounds, min: 1, max: 100, step: 1, onChange: (v) => { s.maxRounds = Math.max(1, Math.min(100, Math.round(v || 24))); } });
      const attachBox = w.checkbox("Send a picture of the visible area with every message", { value: s.attachView, onChange: (v) => { s.attachView = v; } });

      const status = h("div", { className: "ai-hint" }, "Connecting…");
      const say = (text: string, cls = "ai-hint") => { status.textContent = text; status.className = cls; };
      const fillModels = (models: InfoResponse["models"]) => {
        const keep = modelSelect.value;
        while (modelSelect.options.length > 1) modelSelect.remove(1);
        for (const m of models) modelSelect.add(new Option(m.default ? `${m.id} (default)` : m.id, m.id));
        modelSelect.value = models.some((m) => m.id === keep) || keep === "" ? keep : "";
      };
      if (s.model) { modelSelect.add(new Option(s.model, s.model)); modelSelect.value = s.model; }

      /* The account pane: what the server offers, what this browser has, and the buttons. */
      const accountBox = h("div", { className: "ai-account" });
      const renderAccount = () => {
        clear(accountBox);
        const offers = account.offers();
        const view = account.current();
        const signedIn = view?.kind === "account";
        if (info && !offers) {
          append(accountBox, [h("div", { className: "ai-hint ai-bad" }, "This server has no accounts. Use an access token or your own key.")]);
          return;
        }
        const line = h("div", { className: "ai-hint" }, account.summary() ?? "");
        const buttons: HTMLElement[] = [];
        if (offers && !signedIn) {
          for (const p of offers.providers) {
            buttons.push(w.button(`Sign in with ${p.name}`, { primary: true, onClick: async () => {
              say(`Waiting for ${p.name}…`);
              try {
                const v = await account.signIn(p.id);
                say(`Signed in as ${v.name ?? "you"}. ${formatUsd(v.balanceUsd)} on the account.`, "ai-hint ai-ok");
                void connect();
              } catch (err) { say(describeError(err), "ai-hint ai-bad"); }
            } }));
          }
        }
        if (signedIn) {
          if (offers?.packs.length) {
            const packSelect = w.select(offers.packs.map((p) => ({ value: p.id, label: `${formatUsd(p.priceUsd)} for ${formatUsd(p.creditUsd)} of credit` })), { value: offers.packs[0]!.id });
            buttons.push(packSelect, w.button("Top up…", { onClick: async () => {
              try { await account.topUp(packSelect.value); say("The payment page opened in a new tab. The credit lands once it is paid."); }
              catch (err) { say(describeError(err), "ai-hint ai-bad"); }
            } }));
          }
          buttons.push(w.button("Account page", { onClick: () => account.openAccountPage() }));
          buttons.push(w.button("Sign out", { onClick: async () => { await account.signOut(); renderAccount(); say("Signed out."); } }));
        } else if (offers && !view && !store.get().session) {
          buttons.push(w.button("Start the free trial", { onClick: async () => {
            try { await account.ensureSession(); renderAccount(); say(`Trial started: ${formatUsd(account.current()?.balanceUsd ?? 0)} to spend.`, "ai-hint ai-ok"); }
            catch (err) { say(describeError(err), "ai-hint ai-bad"); }
          } }));
        }
        append(accountBox, [
          line,
          h("div", { className: "ai-btns" }, ...buttons),
          h("div", { className: "ai-hint" }, offers
            ? `A free trial of ${formatUsd(offers.trialUsd)} needs no sign-in. Signing in${offers.providers.length ? ` with ${offers.providers.map((p) => p.name).join(" or ")}` : ""} gives ${formatUsd(offers.weeklyUsd)} a week, refilled every Monday${offers.packs.length ? ", and credit can be bought at cost when that runs out" : ""}. The server keeps your provider id, display name and a ledger of what your calls cost, nothing else; the account page can delete all of it.`
            : "The server has not answered yet."),
        ]);
      };
      const offAccount = account.onChange(renderAccount);

      const panes = {
        account: h("div", null, accountBox),
        token: h("div", null, w.form([{ label: "Access token", field: tokenField }]), h("div", { className: "ai-hint" }, "What the server's operator handed out. Stored in this browser, sent only to the server above.")),
        key: h("div", null, w.form([{ label: "Anthropic key", field: keyField }]), h("div", { className: "ai-hint" }, "Forwarded to Anthropic by the server and not kept there; stored in this browser under the editor's own keys.")),
      };
      const paneHost = h("div", null);
      const showPane = () => { clear(paneHost); paneHost.append(panes[s.access]); };
      showPane();

      /** `GET /v1/info` with the values being edited: fills the models, the account offers and the status line. */
      const connect = async () => {
        say("Connecting…");
        try {
          info = await client.info();
          fillModels(info.models);
          account.setInfo(info.accounts, info.caller.account);
          const r = info.caller.remaining;
          const left: string[] = [];
          if (r.balanceUsd !== undefined) left.push(`${formatUsd(r.balanceUsd)} on the account`);
          else if (r.budgetUsd !== undefined) left.push(`${formatUsd(r.budgetUsd)} left today`);
          if (r.requestsPerDay !== undefined) left.push(`${r.requestsPerDay} requests left today`);
          const who = info.caller.kind === "user" ? (info.caller.account?.kind === "trial" ? "the free trial" : `the account of ${info.caller.name ?? "you"}`)
            : info.caller.kind === "token" ? `token${info.caller.name ? ` "${info.caller.name}"` : ""}` : info.caller.kind === "byok" ? "your own key" : "no credentials";
          const on = info.recipes.filter((x) => x.enabled).length;
          say(`${info.name} (v${info.version}) — ${who}; ${on} of ${info.recipes.length} features on${left.length ? `; ${left.join(", ")}` : ""}.${info.motd ? ` ${info.motd}` : ""}`, "ai-hint ai-ok");
          renderAccount();
        } catch (err) {
          say(describeError(err), "ai-hint ai-bad");
          renderAccount();
        }
      };
      const test = w.button("Test", { onClick: () => void connect() });

      root.append(
        w.group("Access",
          w.form([{ label: "Use", field: accessSelect }]),
          paneHost,
        ),
        w.group("Server",
          w.form([{ label: "Address", field: serverField }]),
          h("div", { className: "ai-hint" }, `${DEFAULT_SERVER_URL} unless you run an ai-server of your own.`),
          h("div", { className: "ai-btns" }, test, status),
        ),
        w.group("Model",
          w.form([
            { label: "Model", field: modelSelect },
            { label: "Effort", field: effortSelect },
          ]),
          thinkingBox,
          h("div", { className: "ai-hint" }, "Effort trades thoroughness for time and cost. The features that lay out maps and write triggers default to high; the rest to low or medium. Changing the model, the effort or the reasoning tick in the middle of an assistant conversation makes the server re-read the whole conversation once; the next message is a little dearer."),
        ),
        w.group("Assistant",
          w.form([{ label: "Rounds per message", field: roundsField }]),
          attachBox,
          dockBox,
          h("div", { className: "ai-hint" }, "A round is one answer from the model followed by the tool calls it asked for. The assistant stops at the limit and offers to continue. A picture costs about as much as a page of text each time. The dock setting applies the next time the assistant opens."),
        ),
      );
      void connect();

      // Save on close, whatever button; the session is the account manager's and is not overwritten from the copy.
      return () => { offAccount(); const { session: _s, ...rest } = s; void _s; store.set(rest); };
    },
    buttons: [{ label: "Close", primary: true }],
  });
}
