/**
 * The account behind the plugin's default access mode: a trial session the first time a
 * feature is used (no sign-in, a small balance), then sign-in through one of the server's
 * providers in a popup for a one-time credit (and a weekly allowance on a role that has one), and top-ups through the server's payment
 * page. Everything here is a thin layer over `AiClient`'s account calls plus the settings
 * that hold the session and the device id; the balance shown in the dialogs follows the
 * `remaining` every result carries.
 */
import type { AccountView, AccountsInfo, Allowance } from "./protocol";
import { AiClient, AiError, formatUsd } from "./client";
import type { ScmjsAccountService } from "./scmjsdev";
import type { SettingsStore } from "./settings";

/** A failure from the scmjs.dev plugin's service, as this plugin's dialogs read it. */
function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  const e = err as { code?: string; message?: string; retryAfterSec?: number } | null;
  const code = (e?.code ?? "network") as AiError["code"];
  return new AiError(code, e?.message ?? String(err), { retryAfterSec: e?.retryAfterSec });
}

export class AccountManager {
  private readonly store: SettingsStore;
  private readonly client: AiClient;
  private view: AccountView | null = null;
  private info: AccountsInfo | null = null;
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  /** The scmjs.dev plugin's sign-in, while that plugin holds it out; then the session and the sign-in are its. */
  private provider: ScmjsAccountService | null = null;
  private offProvider: (() => void) | null = null;

  constructor(store: SettingsStore, client: AiClient) {
    this.store = store;
    this.client = client;
    client.prepare = () => this.ensureSession();
    client.onRemaining = (r) => this.noteRemaining(r);
  }

  /**
   * Follow (or stop following) the scmjs.dev plugin's service. While one is set and the
   * access mode is `account`, everything about the session is asked of it: the session
   * itself, the sign-in, the sign-out, the balance. `null` goes back to this plugin's own.
   */
  setProvider(provider: ScmjsAccountService | null): void {
    if (provider === this.provider) return;
    this.offProvider?.();
    this.offProvider = null;
    this.provider = provider;
    if (provider) this.offProvider = provider.onChange(() => this.changed());
    this.changed();
  }

  /** The service this plugin follows, when the access mode is `account` and the scmjs.dev plugin is there. */
  managedBy(): ScmjsAccountService | null { return this.active() ? this.provider : null; }
  managed(): boolean { return this.managedBy() !== null; }

  /** What the server said it offers, once `info()` or a sign-in fetched it. */
  offers(): AccountsInfo | null { return this.managedBy()?.state().offers ?? this.info; }
  current(): AccountView | null { const m = this.managedBy(); return m ? m.state().account : this.view; }
  active(): boolean { return this.store.get().access === "account"; }
  signedIn(): boolean {
    const m = this.managedBy();
    if (m) return m.state().kind === "account";
    return this.active() && !!this.store.get().session && this.view?.kind === "account";
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed() { for (const l of this.listeners) l(); }

  setInfo(info: AccountsInfo | undefined, view?: AccountView) {
    this.info = info ?? null;
    if (view) this.view = view;
    this.changed();
  }

  private noteRemaining(r: Allowance) {
    if (r.balanceUsd === undefined) return;
    const m = this.managedBy();
    if (m) { m.noteBalance(r.balanceUsd); return; }
    if (!this.view) return;
    const weekly = Math.max(0, Math.min(this.view.weeklyUsd, r.balanceUsd));
    this.view = { ...this.view, balanceUsd: r.balanceUsd, weeklyUsd: weekly, creditUsd: Math.max(0, r.balanceUsd - weekly) };
    this.changed();
  }

  /**
   * Before a call in account mode with no session: start the trial. A browser that has
   * had one is told to sign in — as a `budget_exceeded`, which is what the dialogs show
   * with a link to Settings.
   */
  ensureSession(): Promise<void> {
    const m = this.managedBy();
    if (m) return m.ensureSession().catch((err) => { throw toAiError(err); });
    if (!this.active() || this.store.get().session) return Promise.resolve();
    if (!this.pending) {
      this.pending = this.startTrial().finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  private async startTrial(): Promise<void> {
    const s = this.store.get();
    try {
      const r = await this.client.trial(s.deviceId);
      this.store.set({ session: r.session });
      this.view = r.account;
      this.changed();
    } catch (err) {
      if (err instanceof AiError && (err.code === "forbidden" || err.code === "rate_limited")) {
        throw new AiError("budget_exceeded", err.message);
      }
      throw err;
    }
  }

  /** Re-read the account; a session the server no longer knows is dropped. */
  async refresh(): Promise<AccountView | null> {
    const m = this.managedBy();
    if (m) { try { return await m.refresh(); } catch (err) { throw toAiError(err); } }
    if (!this.active() || !this.store.get().session) { this.view = null; this.changed(); return null; }
    try {
      const r = await this.client.account();
      this.view = r.account;
    } catch (err) {
      if (err instanceof AiError && err.code === "unauthorized") { this.store.set({ session: "" }); this.view = null; }
      else throw err;
    }
    this.changed();
    return this.view;
  }

  /**
   * Sign in through a provider: the popup is opened at once (a click is what lets it
   * open) and pointed at the provider once the server has said where; the callback page
   * posts the session back and the popup closes itself. Rejects when the popup is closed
   * first or nothing arrives in five minutes.
   */
  async signIn(provider: string): Promise<AccountView> {
    const m = this.managedBy();
    if (m) { try { return await m.signIn(provider); } catch (err) { throw toAiError(err); } }
    const origin = new URL(this.client.base()).origin;
    const popup = window.open("", "scmjs-ai-signin", "width=540,height=720,popup=yes");
    if (!popup) throw new AiError("network", "the browser blocked the sign-in window; allow popups for this site and try again.");
    let url: string;
    try {
      url = (await this.client.authStart(provider, window.location.origin)).url;
    } catch (err) {
      popup.close();
      throw err;
    }
    popup.location.href = url;
    return new Promise<AccountView>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => { if (done) return; done = true; window.removeEventListener("message", onMessage); window.clearInterval(watch); window.clearTimeout(limit); fn(); };
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== origin) return;
        const m = e.data as { type?: string; session?: string; account?: AccountView } | null;
        if (!m || m.type !== "scmjs-ai-auth" || typeof m.session !== "string" || !m.account) return;
        this.store.set({ session: m.session, access: "account" });
        this.view = m.account;
        this.changed();
        finish(() => resolve(m.account!));
      };
      window.addEventListener("message", onMessage);
      const watch = window.setInterval(() => { if (popup.closed) finish(() => reject(new AiError("aborted", "the sign-in window was closed."))); }, 500);
      const limit = window.setTimeout(() => { finish(() => { try { popup.close(); } catch { /* gone */ } reject(new AiError("network", "the sign-in did not finish in time.")); }); }, 5 * 60_000);
    });
  }

  async signOut(): Promise<void> {
    const m = this.managedBy();
    if (m) { await m.signOut(); return; }
    if (this.store.get().session) { try { await this.client.logout(); } catch { /* the session is dropped locally regardless */ } }
    this.store.set({ session: "" });
    this.view = null;
    this.changed();
  }

  /** The payment page for a pack, in a new tab. */
  async topUp(pack: string): Promise<void> {
    const { url } = await this.client.checkout(pack);
    window.open(url, "_blank", "noopener");
  }

  openAccountPage(): void {
    const m = this.managedBy();
    if (m) { m.openAccount(); return; }
    const url = this.info?.accountUrl ?? `${this.client.base()}/account`;
    window.open(url, "_blank", "noopener");
  }

  /** One line for the dialogs: what is left and when it refills. */
  summary(): string | null {
    if (!this.active()) return null;
    const m = this.managedBy();
    const v = m ? m.state().account : this.view;
    if (m && !v) return m.state().kind === "guest" ? "scmjs.dev: first use starts a free trial, or sign in from the Account menu." : "scmjs.dev: balance unknown until the next call.";
    if (!v) return this.store.get().session ? "Account: balance unknown until the next call." : "First use starts a free trial.";
    if (v.kind === "trial") return `Free trial: ${formatUsd(v.balanceUsd)} left. Sign in to keep it and get more.`;
    const resets = v.resetsAt ? ` · refills ${shortDay(v.resetsAt)}` : "";
    const credit = v.creditUsd > 0 && v.weeklyUsd > 0 ? ` (${formatUsd(v.creditUsd)} of it credit)` : "";
    return `${v.name ? `${v.name}: ` : ""}${formatUsd(v.balanceUsd)} left${credit}${resets}`;
  }
}

function shortDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
