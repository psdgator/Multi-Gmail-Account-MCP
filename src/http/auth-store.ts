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
 *
 * The file is the source of truth. Every operation first re-reads it when it
 * changed on disk (e.g. `gmail-mcp-multi http-logout` run from another
 * process), so a running server never keeps honouring revoked tokens and never
 * writes them back from a stale in-memory copy.
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

interface RotatedRecord {
  family: string;
  /** When the token was rotated away (ms since epoch). */
  at: number;
  /** Kept so a reuse inside the grace window can be answered with a new pair. */
  clientId?: string;
  scopes?: string[];
  resource?: string;
  expiresAt?: number;
}

interface PasswordFingerprint {
  alg: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

interface StoreData {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, TokenRecord>;
  refresh: Record<string, TokenRecord>;
  /** Hashes of refresh tokens that were rotated away: reuse => family revoked (after the grace window). */
  rotated: Record<string, RotatedRecord>;
  /** clientId -> first time a token was issued to it (clients never used can be evicted). */
  tokenIssued: Record<string, number>;
  /** scrypt fingerprint of the access password the tokens were issued under (never the password itself). */
  password?: PasswordFingerprint;
}

export const hashToken = (t: string) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
export const newToken = (prefix: string) => `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;

const SCRYPT = { N: 16384, r: 8, p: 1 };

function fingerprint(password: string, salt: Buffer, params = SCRYPT): string {
  return crypto.scryptSync(password, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }).toString("base64");
}

export class AuthStore {
  readonly file: string;
  private data: StoreData;
  /** stat signature of the file as we last read/wrote it. */
  private stamp = "";

  constructor(
    root: string,
    private readonly secrets: SecretStore
  ) {
    this.file = path.join(root, "http-auth.json");
    this.data = this.load();
  }

  private empty(): StoreData {
    return { version: 1, clients: {}, access: {}, refresh: {}, rotated: {}, tokenIssued: {} };
  }

  private statStamp(): string {
    try {
      const s = fs.statSync(this.file);
      return `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`;
    } catch {
      return "missing";
    }
  }

  private load(): StoreData {
    const stamp = this.statStamp();
    if (stamp === "missing") {
      this.stamp = stamp;
      return this.empty();
    }
    const d = this.secrets.read<Partial<StoreData>>(this.file);
    this.stamp = stamp;
    return { ...this.empty(), ...d, version: 1 };
  }

  /** Re-read the file if another process changed it since we last saw it. */
  sync(): void {
    if (this.statStamp() === this.stamp) return;
    try {
      this.data = this.load();
    } catch (err) {
      // A half-written file (Windows in-place write) or a key problem: keep the
      // current state and retry on the next call rather than crash the server.
      console.error("[gmail-mcp-multi] could not re-read http-auth.json:", (err as Error).message);
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const map of [this.data.access, this.data.refresh]) {
      for (const [k, v] of Object.entries(map)) if (v.expiresAt <= now) delete map[k];
    }
    for (const [k, v] of Object.entries(this.data.rotated)) if (now - v.at > 60 * 24 * 3600_000) delete this.data.rotated[k];
    for (const id of Object.keys(this.data.tokenIssued)) if (!this.data.clients[id]) delete this.data.tokenIssued[id];
  }

  /** Persist. Callers must have called sync() before mutating (all public methods do). */
  private save(): void {
    this.prune();
    this.secrets.write(this.file, this.data);
    this.stamp = this.statStamp();
  }

  // ---- password fingerprint ----

  /**
   * Compare the configured access password with the one the stored tokens were
   * issued under. If it changed, every token is revoked (clients are kept) so
   * changing the password signs everything out. Returns what happened.
   */
  syncPassword(password: string): { changed: boolean; revokedTokens: number } {
    this.sync();
    const fp = this.data.password;
    if (fp) {
      const expected = Buffer.from(fp.hash, "base64");
      const given = Buffer.from(fingerprint(password, Buffer.from(fp.salt, "base64"), fp), "base64");
      if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return { changed: false, revokedTokens: 0 };
    }
    let revokedTokens = 0;
    if (fp) {
      revokedTokens = Object.keys(this.data.access).length + Object.keys(this.data.refresh).length;
      this.data.access = {};
      this.data.refresh = {};
      this.data.rotated = {};
    }
    const salt = crypto.randomBytes(16);
    this.data.password = { alg: "scrypt", ...SCRYPT, salt: salt.toString("base64"), hash: fingerprint(password, salt) };
    this.save();
    return { changed: Boolean(fp), revokedTokens };
  }

  // ---- clients ----
  getClient(id: string): OAuthClientInformationFull | undefined {
    this.sync();
    return this.data.clients[id];
  }

  clientCount(): number {
    this.sync();
    return Object.keys(this.data.clients).length;
  }

  listClients(): OAuthClientInformationFull[] {
    this.sync();
    return Object.values(this.data.clients);
  }

  putClient(c: OAuthClientInformationFull): void {
    this.sync();
    this.data.clients[c.client_id] = c;
    this.save();
  }

  /**
   * Make room for new registrations: drop up to `count` of the oldest clients
   * that never obtained a token and were registered at least `minAgeMs` ago.
   */
  evictUnusedClients(count: number, minAgeMs: number): number {
    this.sync();
    if (count <= 0) return 0;
    const cutoff = Date.now() - minAgeMs;
    const candidates = Object.values(this.data.clients)
      .filter((c) => !this.data.tokenIssued[c.client_id] && (c.client_id_issued_at ?? 0) * 1000 <= cutoff)
      .sort((a, b) => (a.client_id_issued_at ?? 0) - (b.client_id_issued_at ?? 0))
      .slice(0, count);
    for (const c of candidates) delete this.data.clients[c.client_id];
    if (candidates.length) this.save();
    return candidates.length;
  }

  // ---- tokens ----
  issue(rec: Omit<TokenRecord, "expiresAt" | "family"> & { family?: string }, ttl: { accessMs: number; refreshMs: number }) {
    this.sync();
    const family = rec.family ?? crypto.randomBytes(8).toString("hex");
    const access = newToken("gmm_at");
    const refresh = newToken("gmm_rt");
    const now = Date.now();
    this.data.access[hashToken(access)] = { clientId: rec.clientId, scopes: rec.scopes, resource: rec.resource, family, expiresAt: now + ttl.accessMs };
    this.data.refresh[hashToken(refresh)] = { clientId: rec.clientId, scopes: rec.scopes, resource: rec.resource, family, expiresAt: now + ttl.refreshMs };
    this.data.tokenIssued[rec.clientId] ??= now;
    this.save();
    return { access, refresh, family, expiresInSec: Math.floor(ttl.accessMs / 1000) };
  }

  getAccess(token: string): TokenRecord | undefined {
    this.sync();
    const r = this.data.access[hashToken(token)];
    if (!r || r.expiresAt <= Date.now()) return undefined;
    if (!this.data.clients[r.clientId]) return undefined;
    return r;
  }

  /**
   * Take (consume) a refresh token.
   *
   * A token that was already rotated away is answered as still valid when it is
   * reused within `graceMs` of its rotation and its session is still alive (a lost
   * response or two concurrent refreshes); later reuse returns "reused" and
   * revokes the whole family.
   */
  takeRefresh(token: string, graceMs = 0): TokenRecord | "reused" | undefined {
    this.sync();
    const h = hashToken(token);
    const now = Date.now();
    const r = this.data.refresh[h];
    if (!r) {
      const old = this.data.rotated[h];
      if (!old) return undefined;
      const alive = Object.values(this.data.refresh).some((x) => x.family === old.family && x.expiresAt > now);
      if (graceMs > 0 && now - old.at <= graceMs && alive && old.clientId && this.data.clients[old.clientId] && old.resource && (old.expiresAt ?? 0) > now) {
        return { clientId: old.clientId, scopes: old.scopes ?? [], resource: old.resource, family: old.family, expiresAt: old.expiresAt! };
      }
      this.revokeFamilyNow(old.family);
      return "reused";
    }
    delete this.data.refresh[h];
    this.data.rotated[h] = { family: r.family, at: now, clientId: r.clientId, scopes: r.scopes, resource: r.resource, expiresAt: r.expiresAt };
    if (r.expiresAt <= now || !this.data.clients[r.clientId]) {
      this.save();
      return undefined;
    }
    this.save();
    return r;
  }

  private revokeFamilyNow(family: string): void {
    for (const map of [this.data.access, this.data.refresh]) {
      for (const [k, v] of Object.entries(map)) if (v.family === family) delete map[k];
    }
    this.save();
  }

  revokeFamily(family: string): void {
    this.sync();
    this.revokeFamilyNow(family);
  }

  /** Revoke one token (access or refresh) owned by clientId; revokes its whole family. */
  revoke(clientId: string, token: string): boolean {
    this.sync();
    const h = hashToken(token);
    const r = this.data.access[h] ?? this.data.refresh[h];
    if (!r || r.clientId !== clientId) return false;
    this.revokeFamilyNow(r.family);
    return true;
  }

  /** Sign everything out: drop all tokens, and optionally all registered clients. */
  revokeAll(alsoClients: boolean): { tokens: number; clients: number } {
    this.sync();
    const tokens = Object.keys(this.data.access).length + Object.keys(this.data.refresh).length;
    const clients = alsoClients ? Object.keys(this.data.clients).length : 0;
    this.data.access = {};
    this.data.refresh = {};
    this.data.rotated = {};
    if (alsoClients) {
      this.data.clients = {};
      this.data.tokenIssued = {};
    }
    this.save();
    return { tokens, clients };
  }

  stats() {
    this.sync();
    const now = Date.now();
    const live = (m: Record<string, TokenRecord>) => Object.values(m).filter((t) => t.expiresAt > now).length;
    return { clients: Object.keys(this.data.clients).length, accessTokens: live(this.data.access), refreshTokens: live(this.data.refresh) };
  }
}
