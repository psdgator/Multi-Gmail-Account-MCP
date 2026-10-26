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
 *   - every change (read, modify, write) runs under a lock file
 *     (http-auth.json.lock, created exclusively), so a change made by another
 *     process can't land between our read and our write and be overwritten; a
 *     lock left behind by a crashed process is taken over after 10 s;
 *   - a save is still refused if the file changed since it was read (a writer
 *     that doesn't take the lock, e.g. a restored backup);
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
  /** clientId -> network it registered from (IPv4 address or IPv6 /48), for per-network limits. */
  registeredFrom: Record<string, string>;
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

export interface AddClientOptions extends EvictOptions {
  /** Network the registration came from (IPv4 address or IPv6 /48). */
  network?: string;
  /** Registered clients kept at most. */
  maxClients: number;
  /** Never-used clients kept per network; registering one more drops that network's oldest never-used one. */
  maxUnusedPerNetwork: number;
  /** Never-used clients older than this are dropped. */
  unusedTtlMs: number;
}

export interface AuthStoreOptions {
  /** How long to wait for another process holding the lock before giving up (default 2 s). */
  lockWaitMs?: number;
  /** A lock file older than this was left behind by a crashed process and is taken over (default 10 s). */
  lockStaleMs?: number;
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
/** When a client registered (ms since epoch). */
const registeredAt = (c: OAuthClientInformationFull) => (c.client_id_issued_at ?? 0) * 1000;

const SCRYPT = { N: 16384, r: 8, p: 1 };

function fingerprint(password: string, salt: Buffer, params = SCRYPT): string {
  return crypto.scryptSync(password, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }).toString("base64");
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Errors that mean "another process has (or is just releasing) the lock file". */
function lockBusy(code: string | undefined): boolean {
  if (code === "EEXIST") return true;
  // Windows: a lock file that is being deleted can't be created again until the deletion completes.
  return process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(code ?? "");
}

/** unlink(), retried briefly: Windows refuses it while another process (antivirus) has the file open. */
function unlinkWithRetry(file: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.unlinkSync(file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw err;
      sleepSync(20 * (attempt + 1));
    }
  }
}

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
  readonly lockFile: string;
  private data: StoreData;
  /** stat signature of the file as we last read it ("" = re-read on next access). */
  private stamp = "";
  /** Why the file on disk could not be read (set while it can't). */
  private unreadable?: string;
  /** Nesting depth of withLock() (the lock is taken once, by the outermost call). */
  private lockDepth = 0;
  /** What we wrote into the lock file, so we never remove a lock that isn't ours. */
  private lockToken?: string;
  private readonly lockWaitMs: number;
  private readonly lockStaleMs: number;

  constructor(
    root: string,
    private readonly secrets: SecretStore,
    opts: AuthStoreOptions = {}
  ) {
    this.file = path.join(root, "http-auth.json");
    this.lockFile = `${this.file}.lock`;
    this.lockWaitMs = opts.lockWaitMs ?? 2000;
    this.lockStaleMs = opts.lockStaleMs ?? 10_000;
    this.data = this.empty();
    try {
      this.reload(this.statStamp());
    } catch {
      // Reported (and retried) by the first operation; http-logout can still reset the file.
    }
  }

  private empty(): StoreData {
    return { version: 1, clients: {}, access: {}, refresh: {}, rotated: {}, tokenIssued: {}, lastActive: {}, registeredFrom: {} };
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
    for (const m of [this.data.tokenIssued, this.data.lastActive, this.data.registeredFrom]) for (const id of Object.keys(m)) if (!this.data.clients[id]) delete m[id];
  }

  // ---- cross-process lock ----

  /**
   * Run fn while holding the lock file. Re-entrant within this store. Other
   * processes (http-logout, a second server) wait for it, up to lockWaitMs.
   */
  private withLock<T>(fn: () => T): T {
    if (this.lockDepth > 0) {
      this.lockDepth++;
      try {
        return fn();
      } finally {
        this.lockDepth--;
      }
    }
    this.acquireLock();
    this.lockDepth = 1;
    try {
      return fn();
    } finally {
      this.lockDepth = 0;
      this.releaseLock();
    }
  }

  /** Read (if changed), modify and save as one step under the lock. */
  private mutate<T>(fn: () => T): T {
    return this.withLock(() => {
      this.sync();
      return fn();
    });
  }

  private acquireLock(): void {
    ensureSecureDir(path.dirname(this.file));
    const token = `${process.pid} ${crypto.randomBytes(8).toString("hex")}`;
    const deadline = Date.now() + this.lockWaitMs;
    for (let attempt = 0; ; attempt++) {
      let fd: number | undefined;
      let code: string | undefined;
      try {
        fd = fs.openSync(this.lockFile, "wx", 0o600);
      } catch (err) {
        code = (err as NodeJS.ErrnoException).code;
        if (!lockBusy(code)) throw new AuthStoreError(`Could not lock ${this.file}: ${(err as Error).message}`);
      }
      if (fd !== undefined) {
        try {
          fs.writeFileSync(fd, `${token}\n`);
        } catch (err) {
          fs.closeSync(fd);
          unlinkWithRetry(this.lockFile);
          throw new AuthStoreError(`Could not lock ${this.file}: ${(err as Error).message}`);
        }
        fs.closeSync(fd);
        this.lockToken = token;
        return;
      }
      const gone = this.removeStaleLock();
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new AuthStoreError(
          `${this.file} is being changed by another process (lock file ${this.lockFile}${code === "EEXIST" ? "" : `, ${code}`}); nothing was changed. Try again.`
        );
      }
      sleepSync(gone ? 1 : Math.min(5 * 2 ** Math.min(attempt, 6), 100, left));
    }
  }

  /**
   * A lock older than lockStaleMs was left behind by a process that died while
   * holding it: remove it (unless it was replaced meanwhile). Returns true when
   * the lock file is gone, so acquiring can be retried at once.
   */
  private removeStaleLock(): boolean {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.lockFile);
    } catch {
      return true;
    }
    const age = Date.now() - st.mtimeMs;
    if (age < this.lockStaleMs && age > -this.lockStaleMs) return false;
    try {
      const again = fs.statSync(this.lockFile);
      if (again.ino !== st.ino || again.mtimeMs !== st.mtimeMs) return false; // someone else took it over first
      unlinkWithRetry(this.lockFile);
      console.error(`[gmail-mcp-multi] removed a stale lock file ${this.lockFile} (${Math.round(age / 1000)} s old).`);
    } catch {
      /* removed by someone else */
    }
    return true;
  }

  private releaseLock(): void {
    const token = this.lockToken;
    this.lockToken = undefined;
    try {
      // Taken over meanwhile (we held it longer than lockStaleMs)? Then it isn't ours to remove.
      if (fs.readFileSync(this.lockFile, "utf8").trim() !== token) return;
      unlinkWithRetry(this.lockFile);
    } catch {
      /* already gone; a lock that can't be removed is taken over once stale */
    }
  }

  /** Persist, under the lock. Callers must have called sync() before mutating (all public methods do, via mutate()). */
  private save(): void {
    this.withLock(() => {
      try {
        if (this.unreadable) throw new AuthStoreError(`${this.file} could not be read; not overwriting it.`);
        if (this.statStamp() !== this.stamp) {
          // Another process wrote the file after we read it: don't replace its changes with ours.
          throw new AuthStoreError(`${this.file} was changed by another process during this request; nothing was saved. Try again.`);
        }
        this.prune();
        this.writeAtomic();
        // Still under the lock, so this is our own file: no need to read it back on the next access.
        this.stamp = this.statStamp();
      } catch (err) {
        // Re-read on the next access: discards the unsaved change.
        this.stamp = "";
        throw err;
      }
    });
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
    return this.mutate(() => {
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
    });
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

  /** Never-used clients per registering network ("" = unknown). */
  unusedByNetwork(): Map<string, number> {
    this.sync();
    const out = new Map<string, number>();
    for (const id of Object.keys(this.data.clients)) {
      if (this.data.tokenIssued[id]) continue;
      const net = this.data.registeredFrom[id] ?? "";
      out.set(net, (out.get(net) ?? 0) + 1);
    }
    return out;
  }

  putClient(c: OAuthClientInformationFull, network?: string): void {
    this.mutate(() => {
      this.data.clients[c.client_id] = c;
      if (network) this.data.registeredFrom[c.client_id] = network;
      this.save();
    });
  }

  /**
   * Register a client, making room first, as one locked read-modify-write:
   *   1. never-used clients older than `unusedTtlMs` are dropped;
   *   2. if the registering network already has `maxUnusedPerNetwork` never-used
   *      clients, its oldest never-used ones are dropped (a network can only
   *      push out its own registrations this way);
   *   3. if `maxClients` is reached, room is made as in evictClients().
   * Clients holding a live token or listed in `keep` are never dropped.
   * Returns false (and adds nothing) when no room could be made.
   */
  addClient(c: OAuthClientInformationFull, o: AddClientOptions): boolean {
    return this.mutate(() => {
      const now = Date.now();
      const keep = this.keeper(o.keep, now);
      let changed = false;
      for (const x of Object.values(this.data.clients)) {
        if (!this.data.tokenIssued[x.client_id] && !keep(x.client_id) && registeredAt(x) <= now - o.unusedTtlMs) {
          this.dropClient(x.client_id);
          changed = true;
        }
      }
      const net = o.network ?? "";
      const own = Object.values(this.data.clients)
        .filter((x) => !this.data.tokenIssued[x.client_id] && (this.data.registeredFrom[x.client_id] ?? "") === net && !keep(x.client_id))
        .sort((a, b) => registeredAt(a) - registeredAt(b));
      for (const x of own.slice(0, Math.max(0, own.length - Math.max(0, o.maxUnusedPerNetwork - 1)))) {
        this.dropClient(x.client_id);
        changed = true;
      }
      const count = Object.keys(this.data.clients).length;
      if (count >= o.maxClients) {
        const victims = this.pickVictims(count - o.maxClients + 1, o, keep, now);
        for (const id of victims) this.dropClient(id);
        changed ||= victims.length > 0;
      }
      if (Object.keys(this.data.clients).length >= o.maxClients) {
        if (changed) this.save();
        return false;
      }
      this.data.clients[c.client_id] = c;
      if (o.network) this.data.registeredFrom[c.client_id] = o.network;
      this.save();
      return true;
    });
  }

  /**
   * Make room for new registrations: drop up to `count` clients, in this order:
   *   1. clients that never obtained a token: from the network with the most
   *      never-used clients first, oldest registration first within it. Each
   *      network's newest never-used client is kept while it is younger than
   *      `unusedGraceMs` (that may be the owner, typing the password);
   *   2. clients without any live token whose last token was issued more than
   *      `inactiveMs` ago (longest inactive first).
   * A client holding a live (unexpired) access or refresh token is never dropped.
   */
  evictClients(count: number, o: EvictOptions): number {
    return this.mutate(() => {
      if (count <= 0) return 0;
      const now = Date.now();
      const victims = this.pickVictims(count, o, this.keeper(o.keep, now), now);
      for (const id of victims) this.dropClient(id);
      if (victims.length) this.save();
      return victims.length;
    });
  }

  /** Clients that must stay: holding a live token, or listed in `keep`. */
  private keeper(keepIds: ReadonlySet<string> | undefined, now: number): (id: string) => boolean {
    const live = new Set<string>();
    for (const map of [this.data.access, this.data.refresh]) for (const t of Object.values(map)) if (t.expiresAt > now) live.add(t.clientId);
    return (id: string) => live.has(id) || Boolean(keepIds?.has(id));
  }

  private pickVictims(count: number, o: EvictOptions, keep: (id: string) => boolean, now: number): string[] {
    const all = Object.values(this.data.clients);
    // Never-used clients, grouped by network; a network is ranked by all its never-used clients.
    const byNetwork = new Map<string, OAuthClientInformationFull[]>();
    for (const c of all) {
      if (this.data.tokenIssued[c.client_id]) continue;
      const net = this.data.registeredFrom[c.client_id] ?? "";
      const list = byNetwork.get(net) ?? [];
      list.push(c);
      byNetwork.set(net, list);
    }
    const unusedCount = new Map<string, number>();
    const evictable = new Map<string, OAuthClientInformationFull[]>();
    for (const [net, list] of byNetwork) {
      unusedCount.set(net, list.length);
      list.sort((a, b) => registeredAt(a) - registeredAt(b));
      const newest = list[list.length - 1];
      const ev = list.filter((c) => !keep(c.client_id) && (c !== newest || registeredAt(c) <= now - o.unusedGraceMs));
      if (ev.length) evictable.set(net, ev);
    }
    const victims: string[] = [];
    while (victims.length < count) {
      let best: string | undefined;
      for (const [net, list] of evictable) {
        if (!list.length) continue;
        if (
          best === undefined ||
          unusedCount.get(net)! > unusedCount.get(best)! ||
          (unusedCount.get(net) === unusedCount.get(best) && registeredAt(list[0]) < registeredAt(evictable.get(best)![0]))
        ) {
          best = net;
        }
      }
      if (best === undefined) break;
      victims.push(evictable.get(best)!.shift()!.client_id);
      unusedCount.set(best, unusedCount.get(best)! - 1);
    }
    if (victims.length < count) {
      const active = (id: string) => this.data.lastActive[id] ?? this.data.tokenIssued[id] ?? 0;
      const inactive = all
        .filter((c) => this.data.tokenIssued[c.client_id] && !keep(c.client_id) && active(c.client_id) <= now - o.inactiveMs)
        .sort((a, b) => active(a.client_id) - active(b.client_id));
      for (const c of inactive.slice(0, count - victims.length)) victims.push(c.client_id);
    }
    return victims;
  }

  private dropClient(id: string): void {
    delete this.data.clients[id];
    delete this.data.tokenIssued[id];
    delete this.data.lastActive[id];
    delete this.data.registeredFrom[id];
  }

  // ---- tokens ----
  issue(rec: Omit<TokenRecord, "expiresAt" | "family"> & { family?: string }, ttl: { accessMs: number; refreshMs: number }) {
    return this.mutate(() => {
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
    });
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
    return this.mutate(() => {
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
      this.save();
      if (r.expiresAt <= now || !this.data.clients[r.clientId]) return undefined;
      return r;
    });
  }

  private revokeFamilyNow(family: string): void {
    for (const map of [this.data.access, this.data.refresh]) {
      for (const [k, v] of Object.entries(map)) if (v.family === family) delete map[k];
    }
    this.save();
  }

  revokeFamily(family: string): void {
    this.mutate(() => this.revokeFamilyNow(family));
  }

  /** Revoke one token (access or refresh) owned by clientId; revokes its whole family. */
  revoke(clientId: string, token: string): boolean {
    return this.mutate(() => {
      const h = hashToken(token);
      const r = this.data.access[h] ?? this.data.refresh[h];
      if (!r || r.clientId !== clientId) return false;
      this.revokeFamilyNow(r.family);
      return true;
    });
  }

  /**
   * Sign everything out: drop all tokens, and optionally all registered clients.
   * An unreadable file is replaced by an empty one (that signs everything out too),
   * so this always works as the way out of a damaged file. Runs under the lock,
   * so a running server's save can't overwrite it.
   */
  revokeAll(alsoClients: boolean): { tokens: number; clients: number; clientsBefore: number; replacedUnreadable?: boolean } {
    return this.withLock(() => {
      try {
        this.sync();
      } catch (err) {
        if (!(err instanceof AuthStoreError)) throw err;
        console.error(`[gmail-mcp-multi] replacing the unreadable ${this.file} with an empty one; every app must connect again.`);
        this.data = this.empty();
        this.unreadable = undefined;
        this.stamp = this.statStamp();
        this.save();
        return { tokens: 0, clients: 0, clientsBefore: 0, replacedUnreadable: true };
      }
      const tokens = Object.keys(this.data.access).length + Object.keys(this.data.refresh).length;
      const clientsBefore = Object.keys(this.data.clients).length;
      this.data.access = {};
      this.data.refresh = {};
      this.data.rotated = {};
      if (alsoClients) {
        this.data.clients = {};
        this.data.tokenIssued = {};
        this.data.lastActive = {};
        this.data.registeredFrom = {};
      }
      this.save();
      return { tokens, clients: alsoClients ? clientsBefore : 0, clientsBefore };
    });
  }

  stats() {
    this.sync();
    const now = Date.now();
    const live = (m: Record<string, TokenRecord>) => Object.values(m).filter((t) => t.expiresAt > now).length;
    return { clients: Object.keys(this.data.clients).length, accessTokens: live(this.data.access), refreshTokens: live(this.data.refresh) };
  }
}
