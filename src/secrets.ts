import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { ensureSecureDir, writeSecureFile } from "./config.js";

/**
 * Encryption at rest for OAuth tokens and IMAP passwords.
 *
 * Secrets are stored as AES-256-GCM envelopes. The 32-byte master key comes from,
 * in order:
 *   1. GMAIL_MCP_MASTER_KEY (base64 or hex): for servers / Docker
 *   2. the OS keychain: Windows Credential Manager, macOS Keychain, Linux Secret Service
 *   3. a key file next to the config (~/.gmail-mcp/master.key, owner-only), used only
 *      when no keychain is available (e.g. headless Linux). A warning is logged.
 *
 * Plain-text credential files from older versions are read transparently and
 * re-encrypted on the next write (see `migrate`).
 */

const SERVICE = "gmail-mcp-multi";

interface Envelope {
  v: 1;
  alg: "A256GCM";
  iv: string;
  tag: string;
  data: string;
}

function isEnvelope(x: unknown): x is Envelope {
  const e = x as Envelope;
  return Boolean(e && e.v === 1 && e.alg === "A256GCM" && e.iv && e.tag && typeof e.data === "string");
}

function parseKey(raw: string): Buffer {
  const t = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  if (buf.length !== 32) throw new Error("GMAIL_MCP_MASTER_KEY must be 32 bytes (64 hex chars or base64).");
  return buf;
}

type KeyringEntry = { getPassword(): string | null | undefined; setPassword(p: string): void };

function keyringEntry(account: string): KeyringEntry | undefined {
  if (process.env.GMAIL_MCP_KEYRING === "0") return undefined;
  try {
    const require = createRequire(import.meta.url);
    const { Entry } = require("@napi-rs/keyring") as { Entry: new (service: string, account: string) => KeyringEntry };
    return new Entry(SERVICE, account);
  } catch {
    return undefined;
  }
}

export type KeySource = "env" | "keychain" | "file";

export class SecretStore {
  private key?: Buffer;
  source?: KeySource;

  constructor(private readonly root: string) {}

  /** Keychain entry name is tied to the config folder so separate setups don't collide. */
  private keyName(): string {
    return `master-key:${crypto.createHash("sha256").update(path.resolve(this.root)).digest("hex").slice(0, 16)}`;
  }

  private masterKey(): Buffer {
    if (this.key) return this.key;
    const env = process.env.GMAIL_MCP_MASTER_KEY;
    if (env && env.trim()) {
      this.key = parseKey(env);
      this.source = "env";
      return this.key;
    }

    const entry = keyringEntry(this.keyName());
    if (entry) {
      try {
        const existing = entry.getPassword();
        if (existing) {
          this.key = parseKey(existing);
          this.source = "keychain";
          return this.key;
        }
        const fresh = crypto.randomBytes(32);
        entry.setPassword(fresh.toString("base64"));
        // Read back: some backends accept writes but can't persist (no daemon).
        if (entry.getPassword() === fresh.toString("base64")) {
          this.key = fresh;
          this.source = "keychain";
          return this.key;
        }
      } catch {
        /* fall through to file */
      }
    }

    ensureSecureDir(this.root);
    const keyFile = path.join(this.root, "master.key");
    if (fs.existsSync(keyFile)) {
      this.key = parseKey(fs.readFileSync(keyFile, "utf8"));
    } else {
      this.key = crypto.randomBytes(32);
      writeSecureFile(keyFile, this.key.toString("base64") + "\n");
      console.error(
        `[gmail-mcp-multi] No OS keychain available; stored the encryption key in ${keyFile} (owner-only). ` +
          "Set GMAIL_MCP_MASTER_KEY to keep it elsewhere."
      );
    }
    this.source = "file";
    return this.key;
  }

  encrypt(value: unknown): Envelope {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { v: 1, alg: "A256GCM", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  decrypt<T = unknown>(env: Envelope): T {
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.masterKey(), Buffer.from(env.iv, "base64"));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    try {
      const plain = Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as T;
    } catch {
      throw new Error(
        "Could not decrypt stored credentials (the encryption key changed or the file was copied from another machine). " +
          "Re-run authentication for this account."
      );
    }
  }

  /** Read a secret JSON file; plain-text (legacy) files are returned as-is. */
  read<T = Record<string, unknown>>(file: string): T {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return isEnvelope(raw) ? this.decrypt<T>(raw) : (raw as T);
  }

  isEncrypted(file: string): boolean {
    try {
      return isEnvelope(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return false;
    }
  }

  write(file: string, value: unknown): void {
    ensureSecureDir(path.dirname(file));
    writeSecureFile(file, JSON.stringify(this.encrypt(value), null, 2) + "\n");
  }

  /** Re-encrypt a legacy plain-text file in place. Returns true if it changed. */
  migrate(file: string): boolean {
    if (!fs.existsSync(file) || this.isEncrypted(file)) return false;
    this.write(file, this.read(file));
    return true;
  }

  describe(): string {
    this.masterKey();
    return { env: "GMAIL_MCP_MASTER_KEY", keychain: "OS keychain", file: "key file (no keychain found)" }[this.source!];
  }
}
