import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ensureSecureDir } from "../config.js";
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
 * writes them back from a stale in-memory copy:
 *   - if the changed file can't be read (damaged, wrong key), every operation
 *     fails with an AuthStoreError until it can be read again; nothing is
 *     answered from, or written back from, the old in-memory copy;
 *   - a save is refused if the file changed since it was read;
 *   - writes go to a temporary file that is then renamed over the old one, so
 *     readers never see a half-written file.
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
  /** clientId -> last time a token was issued to it (sign-in or refresh). */
  lastActive: Record<string, number>;
  /** scrypt fingerprint of the access password the tokens were issued under (never the password itself). */
  password?: PasswordFingerprint;
}

export interface EvictOptions {
  /** Never-used clients younger than this are kept (a sign-in may be in progress). */
  unusedGraceMs: number;
  /** Clients without live tokens whose last token was issued longer ago than this can go too. */
  inactiveMs: number;
  /** Clients that must not be evicted (e.g. holding an authorization code). */
  keep?: ReadonlySet<string>;
}

/** The sign-in state file could not be read or written; the operation was not carried out. */
export class AuthStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthStoreError";
  }
}

export const hashToken = (t: string) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
export const newToken = (prefix: string) => `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;

const SCRYPT = { N: 16384, r: 8, p: 1 };

function fingerprint(password: string, salt: Buffer, params = SCRYPT): string {
  return crypto.scryptSync(password, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }).toString("base64");
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** rename(), retried briefly: Windows refuses it while another process (antivirus, a reader) has the target open. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw err;
      sleepSync(20 * (attempt + 1));
    }
  }
}

export class AuthStore {
  readonly file: string;
  private data: StoreData;
  /** stat signature of the file as we last read it ("" = re-read on next access). */
  private stamp = "";
  /** Why the file on disk could not be read (set while it can't). */
  private unreadable?: string;

  constructor(
    root: string,
    private readonly secrets: SecretStore
  ) {
    this.file = path.join(root, "http-auth.json");
    this.data = this.empty();
    try {
      this.reload(this.statStamp());
    } catch {
      // Reported (and retried) by the first operation; http-logout can still reset the file.
    }
  }

  private empty(): StoreData {
    return { version: 1, clients: {}, access: {}, refresh: {}, rotated: {}, tokenIssued: {}, lastActive: {} };
  }

  private statStamp(): string {
    try {
      const s = fs.statSync(this.file);
      return `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`;
    } catch {
      return "missing";
    }
  }

  private reload(stamp: string): void {
    if (stamp === "missing") {
      this.data = this.empty();
      this.stamp = stamp;
      this.unreadable = undefined;
      return;
    }
    try {
      const d = this.secrets.read<Partial<StoreData>>(this.file);
      if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("unexpected content.");
      this.data = { ...this.empty(), ...d, version: 1 };
      this.stamp = stamp;
      if (this.unreadable) console.error(`[gmail-mcp-multi] ${this.file} can be read again.`);
      this.unreadable = undefined;
    } catch (err) {
      const why = (err as Error).message.replace(/\.$/, "");
      if (this.unreadable !== why) console.error(`[gmail-mcp-multi] could not read ${this.file}: ${why}. Refusing to use or overwrite it until it can be read.`);
      this.unreadable = why;
      throw new AuthStoreError(
        `The hosted-mode sign-in file ${this.file} could not be read (${why}). Nothing was changed. ` +
          'Restore the file or the encryption key, or run "gmail-mcp-multi http-logout" to reset it (everyone must sign in again).'
      );
    }
  }

  /**
   * Re-read the file if another process changed it since we last saw it. Throws
   * AuthStoreError while the file can't be read, so no operation is answered from
   * (or saved over the file from) an out-of-date copy.
   */
  sync(): void {
    const stamp = this.statStamp();
    if (stamp === this.stamp && !this.unreadable) return;
    this.reload(stamp);
  }

  private prune(): void {
    const now = Date.now();
    for (const map of [this.data.access, this.data.refresh]) {
      for (const [k, v] of Object.entries(map)) if (v.expiresAt <= now) delete map[k];
    }
    for (const [k, v] of Object.entries(this.data.rotated)) if (now - v.at > 60 * 24 * 3600_000) delete this.data.rotated[k];
    for (const m of [this.data.tokenIssued, this.data.lastActive]) for (const id of Object.keys(m)) if (!this.data.clients[id]) delete m[id];
  }

  /** Persist. Callers must have called sync() before mutating (all public methods do). */
  private save(): void {
    try {
      if (this.unreadable) throw new AuthStoreError(`${this.file} could not be read; not overwriting it.`);
      if (this.statStamp() !== this.stamp) {
        // Another process wrote the file after we read it: don't replace its changes with ours.
        throw new AuthStoreError(`${this.file} was changed by another process during this request; nothing was saved. Try again.`);
      }
      this.prune();
      this.writeAtomic();
    } finally {
      // Re-read on the next access: picks up our own write, or discards an unsaved change.
      this.stamp = "";
    }
  }

  private writeAtomic(): void {
    ensureSecureDir(path.dirname(this.file));
    const body = JSON.stringify(this.secrets.encrypt(this.data), null, 2) + "\n";
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      renameWithRetry(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw new AuthStoreError(`Could not save ${this.file}: ${(err as Error).message}`);
    }
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
   * Make room for new registrations: drop up to `count` clients, in this order:
   *   1. clients that never obtained a token (oldest registration first), once
   *      they are older than `unusedGraceMs`;
   *   2. clients without any live token whose last token was issued more than
   *      `inactiveMs` ago (longest inactive first).
   * A client holding a live (unexpired) access or refresh token is never dropped.
   */
  evictClients(count: number, o: EvictOptions): number {
    this.sync();
    if (count <= 0) return 0;
    const now = Date.now();
    const live = new Set<string>();
    for (const map of [this.data.access, this.data.refresh]) for (const t of Object.values(map)) if (t.expiresAt > now) live.add(t.clientId);
    const keep = (id: string) => live.has(id) || Boolean(o.keep?.has(id));
    const registered = (c: OAuthClientInformationFull) => (c.client_id_issued_at ?? 0) * 1000;
    const active = (id: string) => this.data.lastActive[id] ?? this.data.tokenIssued[id] ?? 0;
    const all = Object.values(this.data.clients);
    const unused = all
      .filter((c) => !this.data.tokenIssued[c.client_id] && !keep(c.client_id) && registered(c) <= now - o.unusedGraceMs)
      .sort((a, b) => registered(a) - registered(b));
    const inactive = all
      .filter((c) => this.data.tokenIssued[c.client_id] && !keep(c.client_id) && active(c.client_id) <= now - o.inactiveMs)
      .sort((a, b) => active(a.client_id) - active(b.client_id));
    const victims = [...unused, ...inactive].slice(0, count);
    for (const c of victims) {
      delete this.data.clients[c.client_id];
      delete this.data.tokenIssued[c.client_id];
      delete this.data.lastActive[c.client_id];
    }
    if (victims.length) this.save();
    return victims.length;
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
    this.data.lastActive[rec.clientId] = now;
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

  /**
   * Sign everything out: drop all tokens, and optionally all registered clients.
   * An unreadable file is replaced by an empty one (that signs everything out too),
   * so this always works as the way out of a damaged file.
   */
  revokeAll(alsoClients: boolean): { tokens: number; clients: number; replacedUnreadable?: boolean } {
    try {
      this.sync();
    } catch (err) {
      if (!(err instanceof AuthStoreError)) throw err;
      console.error(`[gmail-mcp-multi] replacing the unreadable ${this.file} with an empty one; every app must connect again.`);
      this.data = this.empty();
      this.unreadable = undefined;
      this.stamp = this.statStamp();
      this.save();
      return { tokens: 0, clients: 0, replacedUnreadable: true };
    }
    const tokens = Object.keys(this.data.access).length + Object.keys(this.data.refresh).length;
    const clients = alsoClients ? Object.keys(this.data.clients).length : 0;
    this.data.access = {};
    this.data.refresh = {};
    this.data.rotated = {};
    if (alsoClients) {
      this.data.clients = {};
      this.data.tokenIssued = {};
      this.data.lastActive = {};
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
