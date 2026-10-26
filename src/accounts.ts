import * as fs from "node:fs";
import * as path from "node:path";
import { configDir, ensureSecureDir, isMode, Mode, writeSecureFile } from "./config.js";

export interface AccountConfig {
  alias: string;
  email: string;
  /** Optional per-account cap on what tools may do (never raises the server mode). */
  mode?: Mode;
}

export interface Account extends AccountConfig {
  authenticated: boolean;
  isDefault: boolean;
}

interface Config {
  accounts: AccountConfig[];
  defaultAccount?: string;
}

/** Aliases become directory names, so keep them to a safe character set. */
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function validateAlias(alias: string): string {
  const a = alias.trim();
  if (!ALIAS_RE.test(a) || a === "." || a === ".." || a.toLowerCase() === "all") {
    throw new Error(
      `Invalid alias "${alias}". Use letters, digits, dot, dash or underscore (max 64 chars); "all" is reserved.`
    );
  }
  return a;
}

/** Words that mean "every connected account". */
const ALL_WORDS = new Set(["all", "*", "every", "everything", "all accounts"]);

export class AccountManager {
  readonly root: string;
  private readonly configFile: string;
  private readonly accountsDir: string;
  private config: Config = { accounts: [] };
  private configMtime = 0;

  constructor(root: string = configDir()) {
    this.root = root;
    this.configFile = path.join(root, "config.json");
    this.accountsDir = path.join(root, "accounts");
    ensureSecureDir(this.root);
    ensureSecureDir(this.accountsDir);
    this.reload();
  }

  /** Re-read config.json if it changed on disk (e.g. after `gmail-mcp-multi auth` in a terminal). */
  reload(): void {
    if (!fs.existsSync(this.configFile)) {
      this.config = { accounts: [] };
      this.configMtime = 0;
      return;
    }
    const mtime = fs.statSync(this.configFile).mtimeMs;
    if (mtime === this.configMtime) return;
    const parsed = JSON.parse(fs.readFileSync(this.configFile, "utf-8")) as Partial<Config>;
    this.config = {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      defaultAccount: parsed.defaultAccount,
    };
    this.configMtime = mtime;
  }

  private save(): void {
    writeSecureFile(this.configFile, JSON.stringify(this.config, null, 2) + "\n");
    this.configMtime = fs.statSync(this.configFile).mtimeMs;
  }

  getAccountDir(alias: string): string {
    return path.join(this.accountsDir, validateAlias(alias));
  }

  getCredentialsPath(alias: string): string {
    return path.join(this.getAccountDir(alias), "credentials.json");
  }

  /**
   * OAuth client (Google Cloud "Desktop app") JSON. A per-account file wins
   * over the shared one, so different accounts can use different Cloud projects.
   */
  getOAuthKeysPath(alias?: string): string {
    if (alias) {
      const perAccount = path.join(this.getAccountDir(alias), "oauth-keys.json");
      if (fs.existsSync(perAccount)) return perAccount;
    }
    const env = process.env.GMAIL_MCP_OAUTH_KEYS;
    if (env && env.trim()) return path.resolve(env.trim());
    return path.join(this.root, "oauth-keys.json");
  }

  isAuthenticated(alias: string): boolean {
    return fs.existsSync(this.getCredentialsPath(alias));
  }

  listAccounts(): Account[] {
    this.reload();
    const def = this.getDefaultAlias();
    return this.config.accounts.map((acc) => ({
      ...acc,
      authenticated: this.isAuthenticated(acc.alias),
      isDefault: acc.alias === def,
    }));
  }

  /** Find an account by alias or email (case-insensitive). */
  getAccount(aliasOrEmail: string): AccountConfig | undefined {
    this.reload();
    const key = aliasOrEmail.trim().toLowerCase();
    return this.config.accounts.find(
      (acc) => acc.alias.toLowerCase() === key || acc.email.toLowerCase() === key
    );
  }

  /** Default alias: explicit setting, else the only account if there is exactly one. */
  getDefaultAlias(): string | undefined {
    const def = this.config.defaultAccount;
    if (def && this.config.accounts.some((a) => a.alias === def)) return def;
    if (this.config.accounts.length === 1) return this.config.accounts[0].alias;
    return undefined;
  }

  setDefault(aliasOrEmail: string): AccountConfig {
    const acc = this.requireAccount(aliasOrEmail);
    this.config.defaultAccount = acc.alias;
    this.save();
    return acc;
  }

  setAccountMode(aliasOrEmail: string, mode: Mode | undefined): AccountConfig {
    const acc = this.requireAccount(aliasOrEmail);
    if (mode === undefined) delete acc.mode;
    else acc.mode = mode;
    this.save();
    return acc;
  }

  requireAccount(aliasOrEmail: string): AccountConfig {
    const acc = this.getAccount(aliasOrEmail);
    if (!acc) {
      const known = this.config.accounts.map((a) => `${a.alias} (${a.email})`).join(", ");
      throw new Error(
        `Unknown account "${aliasOrEmail}". ${known ? `Connected accounts: ${known}.` : "No accounts are connected yet; use the authenticate tool."}`
      );
    }
    return acc;
  }

  addAccount(alias: string, email: string, mode?: Mode): AccountConfig {
    this.reload();
    const a = validateAlias(alias);
    const clash = this.config.accounts.find(
      (acc) => acc.alias !== a && acc.email.toLowerCase() === email.toLowerCase()
    );
    if (clash) {
      throw new Error(`${email} is already connected as "${clash.alias}".`);
    }
    const existing = this.config.accounts.find((acc) => acc.alias === a);
    if (existing) {
      existing.email = email;
      if (mode) existing.mode = mode;
    } else {
      this.config.accounts.push({ alias: a, email, ...(mode ? { mode } : {}) });
    }
    ensureSecureDir(this.getAccountDir(a));
    this.save();
    return this.requireAccount(a);
  }

  removeAccount(aliasOrEmail: string): boolean {
    this.reload();
    const acc = this.getAccount(aliasOrEmail);
    if (!acc) return false;
    this.config.accounts = this.config.accounts.filter((x) => x.alias !== acc.alias);
    if (this.config.defaultAccount === acc.alias) delete this.config.defaultAccount;
    this.save();
    fs.rmSync(this.getAccountDir(acc.alias), { recursive: true, force: true });
    return true;
  }

  saveCredentials(alias: string, tokens: object): void {
    ensureSecureDir(this.getAccountDir(alias));
    writeSecureFile(this.getCredentialsPath(alias), JSON.stringify(tokens, null, 2));
  }

  /**
   * Turn an `account` tool argument into concrete accounts.
   *
   * Accepts an alias, an email, "all", a comma-separated list, or an array.
   * When omitted: every account if `allowMany`, otherwise the default account.
   */
  resolve(arg: string | string[] | undefined, allowMany: boolean): AccountConfig[] {
    this.reload();
    const all = this.config.accounts;
    if (all.length === 0) {
      throw new Error("No Gmail accounts are connected yet. Use the authenticate tool to add one.");
    }

    let parts: string[] = [];
    if (Array.isArray(arg)) parts = arg;
    else if (typeof arg === "string") parts = arg.split(",");
    parts = parts.map((p) => p.trim()).filter(Boolean);

    if (parts.length === 0) {
      if (allowMany) return [...all];
      const def = this.getDefaultAlias();
      if (!def) {
        throw new Error(
          `Which account? Pass "account" as one of: ${all.map((a) => `${a.alias} (${a.email})`).join(", ")}.`
        );
      }
      return [this.requireAccount(def)];
    }

    if (parts.some((p) => ALL_WORDS.has(p.toLowerCase()))) {
      if (!allowMany) throw new Error('This tool works on one account at a time; "all" is not allowed here.');
      return [...all];
    }

    const seen = new Set<string>();
    const out: AccountConfig[] = [];
    for (const p of parts) {
      const acc = this.requireAccount(p);
      if (!seen.has(acc.alias)) {
        seen.add(acc.alias);
        out.push(acc);
      }
    }
    if (!allowMany && out.length > 1) {
      throw new Error("This tool works on one account at a time; pass a single alias or email.");
    }
    return out;
  }
}

export function sanitizeAccountMode(mode: unknown): Mode | undefined {
  return isMode(mode) ? mode : undefined;
}
