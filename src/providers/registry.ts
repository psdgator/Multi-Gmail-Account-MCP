import * as fs from "node:fs";
import { AccountConfig, AccountManager, AccountType, accountType } from "../accounts.js";
import { GmailProvider, gmailApiFor } from "./gmail.js";
import { MailProvider, unsupported } from "./types.js";

export type ProviderFactory = (accounts: AccountManager, account: AccountConfig) => MailProvider;

/**
 * How each account type is reached. IMAP registers itself from providers/imap.ts
 * (imported by server.ts) so the Gmail-only build stays dependency-light.
 */
export const providerFactories: Partial<Record<AccountType, ProviderFactory>> = {
  gmail: (accounts, account) => new GmailProvider(account, gmailApiFor(accounts, account)),
};

export function registerProviderFactory(type: AccountType, factory: ProviderFactory): void {
  providerFactories[type] = factory;
}

export interface FanOutResult<T> {
  ok: { account: AccountConfig; value: T }[];
  errors: { account: string; email: string; error: string }[];
}

/** Hands tools a provider per account, cached until its credentials or config change. */
export class MailRegistry {
  private cache = new Map<string, { stamp: string; provider: MailProvider }>();

  constructor(readonly accounts: AccountManager) {}

  private stamp(acc: AccountConfig): string {
    const cred = this.accounts.getCredentialsPath(acc.alias);
    const mtime = fs.existsSync(cred) ? fs.statSync(cred).mtimeMs : 0;
    return `${mtime}|${this.accounts.getOAuthKeysPath(acc.alias)}|${JSON.stringify(acc)}`;
  }

  get(acc: AccountConfig): MailProvider {
    const stamp = this.stamp(acc);
    const hit = this.cache.get(acc.alias);
    if (hit && hit.stamp === stamp) return hit.provider;
    if (hit) void hit.provider.close?.().catch(() => undefined);
    const type = accountType(acc);
    const factory = providerFactories[type];
    if (!factory) throw new Error(`Account type "${type}" is not supported by this build.`);
    if (!fs.existsSync(this.accounts.getCredentialsPath(acc.alias))) {
      throw new Error(
        `"${acc.alias}" (${acc.email}) is not signed in yet. ${type === "gmail" ? "Run the authenticate tool for it." : "Run: gmail-mcp-multi add-imap " + acc.alias}`
      );
    }
    const provider = factory(this.accounts, acc);
    this.cache.set(acc.alias, { stamp, provider });
    return provider;
  }

  /** Gmail-only features (filters, Calendar): the Gmail provider or a clear error. */
  gmail(acc: AccountConfig): GmailProvider {
    const p = this.get(acc);
    if (!(p instanceof GmailProvider)) throw unsupported(acc, "This feature");
    return p;
  }

  /** Run `fn` against one account, translating provider errors. */
  async with<T>(acc: AccountConfig, fn: (p: MailProvider) => Promise<T>): Promise<T> {
    const p = this.get(acc);
    try {
      return await fn(p);
    } catch (err) {
      throw p.explain(err);
    }
  }

  /** Run `fn` on several accounts in parallel, collecting per-account failures. */
  async fanOut<T>(accs: AccountConfig[], fn: (p: MailProvider, acc: AccountConfig) => Promise<T>, concurrency = 4): Promise<FanOutResult<T>> {
    const ok: FanOutResult<T>["ok"] = [];
    const errors: FanOutResult<T>["errors"] = [];
    let i = 0;
    const worker = async () => {
      while (i < accs.length) {
        const acc = accs[i++];
        try {
          ok.push({ account: acc, value: await this.with(acc, (p) => fn(p, acc)) });
        } catch (err) {
          errors.push({ account: acc.alias, email: acc.email, error: (err as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, accs.length) }, worker));
    const order = new Map(accs.map((a, idx) => [a.alias, idx]));
    ok.sort((a, b) => order.get(a.account.alias)! - order.get(b.account.alias)!);
    return { ok, errors };
  }

  forget(alias: string): void {
    const hit = this.cache.get(alias);
    if (hit) void hit.provider.close?.().catch(() => undefined);
    this.cache.delete(alias);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.cache.values()].map((c) => c.provider.close?.().catch(() => undefined)));
    this.cache.clear();
  }
}
