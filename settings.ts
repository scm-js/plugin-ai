/**
 * The plugin's settings — where the server is, how the caller identifies itself, and
 * which model and effort to ask for — persisted through `api.storage`, plus the
 * Settings dialog with a Test button that calls `GET /v1/info` and says what came back.
 * The user's own Anthropic key is kept in the browser's storage like the rest; the
 * dialog says so next to the field.
 */
import type { PluginApi } from "./plugin-api/plugins/api";
import type { InfoResponse } from "./protocol";
import { AiClient, describeError, formatUsd } from "./client";
import { h, styled, type Ctx } from "./ui";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Settings {
  serverUrl: string;
  token: string;
  ownKey: string;
  /** Empty for the server's default. */
  model: string;
  /** Empty for the recipe's default. */
  effort: Effort | "";
  showThinking: boolean;
}

export const DEFAULT_SETTINGS: Settings = { serverUrl: "", token: "", ownKey: "", model: "", effort: "", showThinking: true };

const KEY = "settings";

export function loadSettings(api: PluginApi): Settings {
  const stored = api.storage.get<Partial<Settings>>(KEY, {});
  return { ...DEFAULT_SETTINGS, ...stored };
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
  return {
    get: () => current,
    set: (patch) => { current = { ...current, ...patch }; saveSettings(api, current); },
  };
}

/* ── The dialog ─────────────────────────────────────────── */

export function openSettings(ctx: Ctx, store: SettingsStore) {
  const { api } = ctx;
  const w = api.ui.widgets;
  api.ui.dialog({
    title: "AI Settings",
    size: "md",
    mount(body) {
      const root = styled(body);
      const s = { ...store.get() };
      let info: InfoResponse | null = null;

      const serverField = w.text({ value: s.serverUrl, placeholder: "https://ai.example.org", onChange: (v) => { s.serverUrl = v.trim(); } });
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

      const status = h("div", { className: "ai-hint" }, "Press Test to see what the server offers and what you have left.");
      const fillModels = (models: InfoResponse["models"]) => {
        const keep = modelSelect.value;
        while (modelSelect.options.length > 1) modelSelect.remove(1);
        for (const m of models) modelSelect.add(new Option(m.default ? `${m.id} (default)` : m.id, m.id));
        modelSelect.value = models.some((m) => m.id === keep) || keep === "" ? keep : "";
      };
      if (s.model) { modelSelect.add(new Option(s.model, s.model)); modelSelect.value = s.model; }

      const test = w.button("Test", {
        onClick: async () => {
          status.textContent = "Asking the server…";
          status.className = "ai-hint";
          const client = new AiClient(() => ({ serverUrl: s.serverUrl, token: s.token, ownKey: s.ownKey }));
          try {
            info = await client.info();
            fillModels(info.models);
            const r = info.caller.remaining;
            const left: string[] = [];
            if (r.budgetUsd !== undefined) left.push(`${formatUsd(r.budgetUsd)} left today`);
            if (r.requestsPerDay !== undefined) left.push(`${r.requestsPerDay} requests left today`);
            if (r.requestsPerMinute !== undefined) left.push(`${r.requestsPerMinute} this minute`);
            const who = info.caller.kind === "token" ? `token${info.caller.name ? ` "${info.caller.name}"` : ""}` : info.caller.kind === "byok" ? "your own key" : "no credentials";
            const on = info.recipes.filter((x) => x.enabled).length;
            status.textContent = `${info.name} (v${info.version}) — using ${who}; ${on} of ${info.recipes.length} features on; ${left.length ? left.join(", ") : "no limits reported"}.${info.motd ? ` ${info.motd}` : ""}`;
            status.className = "ai-hint ai-ok";
          } catch (err) {
            status.textContent = describeError(err);
            status.className = "ai-hint ai-bad";
          }
        },
      });

      root.append(
        w.group("Server",
          w.form([
            { label: "Address", field: serverField },
            { label: "Access token", field: tokenField },
            { label: "Own Anthropic key", field: keyField },
          ]),
          h("div", { className: "ai-hint" }, "One of the two is enough when the server accepts it. The token is what the server's operator handed out; a key of your own is forwarded to Anthropic and not kept by the server. Both are stored in this browser, under the editor's own storage, and go nowhere else."),
          h("div", { className: "ai-btns" }, test, status),
        ),
        w.group("Model",
          w.form([
            { label: "Model", field: modelSelect },
            { label: "Effort", field: effortSelect },
          ]),
          thinkingBox,
          h("div", { className: "ai-hint" }, "Effort trades thoroughness for time and cost. The features that lay out maps and write triggers default to high; the rest to low or medium."),
        ),
      );

      // Save on close, whatever button.
      return () => { store.set(s); };
    },
    buttons: [{ label: "Close", primary: true }],
  });
}
