import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SecretStore } from "../secrets.js";

/**
 * Persistent state of the built-in OAuth server: registered clients and issued
 * tokens. Tokens are stored only as SHA-256 hashes; the whole file is
 * additionally encrypted with the same key as the mail logins.
 *
 * File: <config>/http-auth.json
 */

export interface TokenRecord {
  clientId: string;
  scopes: string[];
  /** ms since epoch */
  expiresAt: number;
  resource: string;
  /** Groups an access/refresh pair and its rotations (for reuse detection). */
  family: string;
}

interface StoreData {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, TokenRecord>;
  refresh: Record<string, TokenRecord>;
  /** Hashes of refresh tokens that were rotated away: reuse => family revoked. */
  rotated: Record<string, { family: string; at: number }>;
}

export const hashToken = (t: string) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
export const newToken = (prefix: string) => `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;

export class AuthStore {
  readonly file: string;
  private data: StoreData;

  constructor(
    root: string,
    private readonly secrets: SecretStore
  ) {
    this.file = path.join(root, "http-auth.json");
    this.data = this.load();
  }

  private empty(): StoreData {
    return { version: 1, clients: {}, access: {}, refresh: {}, rotated: {} };
  }

  private load(): StoreData {
    if (!fs.existsSync(this.file)) return this.empty();
    const d = this.secrets.read<Partial<StoreData>>(this.file);
    return { ...this.empty(), ...d, version: 1 };
  }

  private prune(): void {
    const now = Date.now();
    for (const map of [this.data.access, this.data.refresh]) {
      for (const [k, v] of Object.entries(map)) if (v.expiresAt <= now) delete map[k];
    }
    for (const [k, v] of Object.entries(this.data.rotated)) if (now - v.at > 60 * 24 * 3600_000) delete this.data.rotated[k];
  }

  save(): void {
    this.prune();
    this.secrets.write(this.file, this.data);
  }

  // ---- clients ----
  getClient(id: string): OAuthClientInformationFull | undefined {
    return this.data.clients[id];
  }

  clientCount(): number {
    return Object.keys(this.data.clients).length;
  }

  listClients(): OAuthClientInformationFull[] {
    return Object.values(this.data.clients);
  }

  putClient(c: OAuthClientInformationFull): void {
    this.data.clients[c.client_id] = c;
    this.save();
  }

  // ---- tokens ----
  issue(rec: Omit<TokenRecord, "expiresAt" | "family"> & { family?: string }, ttl: { accessMs: number; refreshMs: number }) {
    const family = rec.family ?? crypto.randomBytes(8).toString("hex");
    const access = newToken("gmm_at");
    const refresh = newToken("gmm_rt");
    const now = Date.now();
    this.data.access[hashToken(access)] = { clientId: rec.clientId, scopes: rec.scopes, resource: rec.resource, family, expiresAt: now + ttl.accessMs };
    this.data.refresh[hashToken(refresh)] = { clientId: rec.clientId, scopes: rec.scopes, resource: rec.resource, family, expiresAt: now + ttl.refreshMs };
    this.save();
    return { access, refresh, family, expiresInSec: Math.floor(ttl.accessMs / 1000) };
  }

  getAccess(token: string): TokenRecord | undefined {
    const r = this.data.access[hashToken(token)];
    if (!r || r.expiresAt <= Date.now()) return undefined;
    if (!this.data.clients[r.clientId]) return undefined;
    return r;
  }

  /** Take (consume) a refresh token. Returns "reused" if it was already rotated (family is then revoked). */
  takeRefresh(token: string): TokenRecord | "reused" | undefined {
    const h = hashToken(token);
    const r = this.data.refresh[h];
    if (!r) {
      const old = this.data.rotated[h];
      if (old) {
        this.revokeFamily(old.family);
        return "reused";
      }
      return undefined;
    }
    delete this.data.refresh[h];
    this.data.rotated[h] = { family: r.family, at: Date.now() };
    if (r.expiresAt <= Date.now() || !this.data.clients[r.clientId]) {
      this.save();
      return undefined;
    }
    return r;
  }

  revokeFamily(family: string): void {
    for (const map of [this.data.access, this.data.refresh]) {
      for (const [k, v] of Object.entries(map)) if (v.family === family) delete map[k];
    }
    this.save();
  }

  /** Revoke one token (access or refresh) owned by clientId; revokes its whole family. */
  revoke(clientId: string, token: string): boolean {
    const h = hashToken(token);
    const r = this.data.access[h] ?? this.data.refresh[h];
    if (!r || r.clientId !== clientId) return false;
    this.revokeFamily(r.family);
    return true;
  }

  /** Sign everything out: drop all tokens, and optionally all registered clients. */
  revokeAll(alsoClients: boolean): { tokens: number; clients: number } {
    const tokens = Object.keys(this.data.access).length + Object.keys(this.data.refresh).length;
    const clients = alsoClients ? this.clientCount() : 0;
    this.data.access = {};
    this.data.refresh = {};
    if (alsoClients) this.data.clients = {};
    this.save();
    return { tokens, clients };
  }

  stats() {
    this.prune();
    return { clients: this.clientCount(), accessTokens: Object.keys(this.data.access).length, refreshTokens: Object.keys(this.data.refresh).length };
  }
}
