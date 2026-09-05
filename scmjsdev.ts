/**
 * The `scmjs-dev.account` service the scmjs.dev plugin provides through `api.services`
 * — one sign-in for every plugin that talks to scmjs.dev. These are the types from
 * `contract.d.ts` in https://github.com/scm-js/plugin-scmjs-dev, copied so this plugin
 * needs no dependency on that repository; the object is matched by shape. Keep them in
 * step when the contract moves (`CONTRACT_VERSION` there).
 */
import type { AccountsInfo, AccountView, StorageView } from "./protocol";

export const SCMJS_ACCOUNT_SERVICE = "scmjs-dev.account";

export type AccountKind = "guest" | "trial" | "account";

export interface AccountState {
  kind: AccountKind;
  account: AccountView | null;
  storage: StorageView | null;
  offers: AccountsInfo | null;
}

export interface ScmjsAccountService {
  state(): AccountState;
  onChange(listener: (state: AccountState) => void): () => void;
  serverUrl(): string;
  session(): string;
  headers(): Record<string, string>;
  ensureSession(): Promise<void>;
  signIn(provider?: string): Promise<AccountView>;
  signOut(): Promise<void>;
  refresh(): Promise<AccountView | null>;
  openAccount(): void;
  noteBalance(balanceUsd: number): void;
}
