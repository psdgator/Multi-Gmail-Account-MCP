import * as fs from "node:fs";
import { auth, gmail, gmail_v1 } from "@googleapis/gmail";
import type { AccountConfig, AccountManager } from "./accounts.js";
import { loadClientKeys } from "./oauth.js";

interface Cached {
  client: gmail_v1.Gmail;
  credMtime: number;
  keysPath: string;
}

/** Friendlier errors for the things that actually go wrong with Gmail OAuth. */
export function explainGoogleError(alias: string, err: unknown): Error {
  const e = err as {
    message?: string;
    code?: number | string;
    status?: number;
    response?: { status?: number; data?: { error?: string | { message?: string } } };
  };
  const status = e?.response?.status ?? e?.status ?? (typeof e?.code === "number" ? e.code : undefined);
  const data = e?.response?.data?.error;
  const detail = typeof data === "string" ? data : data?.message;
  const msg = `${e?.message ?? ""} ${detail ?? ""}`;

  if (/invalid_grant/i.test(msg)) {
    return new Error(
      `The Google sign-in for "${alias}" has expired or was revoked. Run the authenticate tool for "${alias}" again. ` +
        `(If this happens every 7 days, your Google Cloud OAuth app is still in "Testing"; set it to "In production".)`
    );
  }
  if (status === 403 && /insufficient|scope|permission/i.test(msg)) {
    return new Error(
      `"${alias}" was connected with fewer permissions than this action needs. Re-run authenticate for "${alias}" with a higher mode.`
    );
  }
  if (status === 404) {
    return new Error(`Not found in "${alias}" (wrong id, or it belongs to a different account).`);
  }
  if (status === 429) {
    return new Error(`Gmail rate limit hit for "${alias}". Try again in a minute.`);
  }
  return new Error(`[${alias}] ${e?.message ?? String(err)}`);
}

export class GmailClient {
  private cache = new Map<string, Cached>();

  constructor(private accounts: AccountManager) {}

  get(account: AccountConfig): gmail_v1.Gmail {
    const alias = account.alias;
    const credPath = this.accounts.getCredentialsPath(alias);
    if (!fs.existsSync(credPath)) {
      throw new Error(`"${alias}" (${account.email}) is not signed in yet. Run the authenticate tool for it.`);
    }
    const credMtime = fs.statSync(credPath).mtimeMs;
    const keysPath = this.accounts.getOAuthKeysPath(alias);
    const hit = this.cache.get(alias);
    if (hit && hit.credMtime === credMtime && hit.keysPath === keysPath) return hit.client;

    const keys = loadClientKeys(keysPath);
    const credentials = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    const oauth = new auth.OAuth2(keys.client_id, keys.client_secret);
    oauth.setCredentials(credentials);

    // Persist refreshed access tokens (and a rotated refresh token, if Google sends one).
    oauth.on("tokens", (tokens) => {
      const merged = { ...credentials, ...tokens };
      if (!tokens.refresh_token) merged.refresh_token = credentials.refresh_token;
      Object.assign(credentials, merged);
      try {
        this.accounts.saveCredentials(alias, merged);
        const entry = this.cache.get(alias);
        if (entry) entry.credMtime = fs.statSync(credPath).mtimeMs;
      } catch (err) {
        console.error(`[gmail-mcp-multi] could not save refreshed token for ${alias}:`, err);
      }
    });

    const rootUrl = process.env.GMAIL_MCP_API_ROOT || undefined;
    const client = gmail({ version: "v1", auth: oauth, ...(rootUrl ? { rootUrl } : {}) });
    this.cache.set(alias, { client, credMtime, keysPath });
    return client;
  }

  /** Run `fn` against one account, translating Google errors. */
  async with<T>(account: AccountConfig, fn: (g: gmail_v1.Gmail) => Promise<T>): Promise<T> {
    try {
      return await fn(this.get(account));
    } catch (err) {
      throw explainGoogleError(account.alias, err);
    }
  }

  /**
   * Run `fn` against several accounts in parallel (bounded), collecting
   * per-account failures instead of failing the whole call.
   */
  async fanOut<T>(
    accounts: AccountConfig[],
    fn: (g: gmail_v1.Gmail, account: AccountConfig) => Promise<T>,
    concurrency = 4
  ): Promise<{ ok: { account: AccountConfig; value: T }[]; errors: { account: string; email: string; error: string }[] }> {
    const ok: { account: AccountConfig; value: T }[] = [];
    const errors: { account: string; email: string; error: string }[] = [];
    let i = 0;
    const worker = async () => {
      while (i < accounts.length) {
        const account = accounts[i++];
        try {
          const value = await this.with(account, (g) => fn(g, account));
          ok.push({ account, value });
        } catch (err) {
          errors.push({ account: account.alias, email: account.email, error: (err as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, worker));
    // Keep config order for stable output.
    const order = new Map(accounts.map((a, idx) => [a.alias, idx]));
    ok.sort((a, b) => order.get(a.account.alias)! - order.get(b.account.alias)!);
    return { ok, errors };
  }

  forget(alias: string): void {
    this.cache.delete(alias);
  }
}

/** Run async work over items with a concurrency limit, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
