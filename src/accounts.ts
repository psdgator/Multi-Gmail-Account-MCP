import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface Account {
  alias: string;
  email: string;
  authenticated: boolean;
}

export interface AccountConfig {
  alias: string;
  email: string;
}

interface Config {
  accounts: AccountConfig[];
}

const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const ACCOUNTS_DIR = path.join(CONFIG_DIR, "accounts");

/** Owner-only permissions for anything holding OAuth material. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Write a file that only the owner can read.
 *
 * The `mode` option is applied by the OS only when the file is created, so an
 * explicit chmod follows to also tighten files written by earlier versions.
 */
export function writeSecureFile(filePath: string, data: string): void {
  fs.writeFileSync(filePath, data, { mode: FILE_MODE });
  fs.chmodSync(filePath, FILE_MODE);
}

/**
 * Create a directory only the owner can enter.
 *
 * `mode` is honoured only on creation, so directories left behind by earlier
 * versions (created world-readable) are tightened on every startup.
 */
function ensureSecureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  }
  fs.chmodSync(dirPath, DIR_MODE);
}

export class AccountManager {
  private config: Config = { accounts: [] };

  constructor() {
    this.ensureDirectories();
    this.loadConfig();
  }

  private ensureDirectories(): void {
    ensureSecureDir(CONFIG_DIR);
    ensureSecureDir(ACCOUNTS_DIR);
  }

  private loadConfig(): void {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, "utf-8");
      this.config = JSON.parse(content);
    }
  }

  private saveConfig(): void {
    writeSecureFile(CONFIG_FILE, JSON.stringify(this.config, null, 2));
  }

  getAccountDir(alias: string): string {
    return path.join(ACCOUNTS_DIR, alias);
  }

  getCredentialsPath(alias: string): string {
    return path.join(this.getAccountDir(alias), "credentials.json");
  }

  isAuthenticated(alias: string): boolean {
    return fs.existsSync(this.getCredentialsPath(alias));
  }

  listAccounts(): Account[] {
    return this.config.accounts.map((acc) => ({
      ...acc,
      authenticated: this.isAuthenticated(acc.alias),
    }));
  }

  getAccount(aliasOrEmail: string): AccountConfig | undefined {
    return this.config.accounts.find(
      (acc) => acc.alias === aliasOrEmail || acc.email === aliasOrEmail
    );
  }

  addAccount(alias: string, email: string): void {
    const existing = this.config.accounts.findIndex(
      (acc) => acc.alias === alias
    );
    if (existing >= 0) {
      this.config.accounts[existing] = { alias, email };
    } else {
      this.config.accounts.push({ alias, email });
    }

    // Create account directory
    ensureSecureDir(this.getAccountDir(alias));

    this.saveConfig();
  }

  removeAccount(alias: string): boolean {
    const index = this.config.accounts.findIndex((acc) => acc.alias === alias);
    if (index >= 0) {
      this.config.accounts.splice(index, 1);
      this.saveConfig();

      // Remove credentials
      const accountDir = this.getAccountDir(alias);
      if (fs.existsSync(accountDir)) {
        fs.rmSync(accountDir, { recursive: true });
      }
      return true;
    }
    return false;
  }

  getOAuthKeysPath(): string {
    return path.join(CONFIG_DIR, "oauth-keys.json");
  }
}
