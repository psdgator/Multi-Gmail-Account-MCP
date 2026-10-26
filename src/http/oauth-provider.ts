import * as crypto from "node:crypto";
import * as net from "node:net";
import express, { Request, Response, Router } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthStore } from "./auth-store.js";

/**
 * A small, single-user OAuth 2.1 authorization server for the hosted mode.
 *
 * - Clients register dynamically (claude.ai does this), but only with redirect
 *   URIs on the allow-list (Claude's callback and loopback by default).
 * - The authorization step shows a page asking for the server's access
 *   password (GMAIL_MCP_HTTP_PASSWORD). Every password check ends the sign-in
 *   request, right or wrong (another guess needs a new /authorize). Checks are
 *   serialized server-wide with a minimum duration each, which caps the global
 *   guess rate. Wrong passwords lock out the offending IP (IPv6: its /64, and its
 *   /48 after many /64s failed) with exponential backoff; there is no global lock,
 *   so the owner is never locked out by other people's attempts.
 * - Codes are single-use and live 5 minutes; PKCE S256 is enforced by the SDK.
 * - Access tokens (1 h) and rotating refresh tokens (30 d) are random 256-bit
 *   strings stored only as hashes; reusing a rotated refresh token revokes the
 *   whole token family (after a 60 s grace window for lost responses).
 */

export const CLAUDE_CALLBACKS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface ProviderOptions {
  password: string;
  /** Canonical MCP resource URL, e.g. https://mail.example.com/mcp */
  resource: URL;
  store: AuthStore;
  /** Exact redirect URIs or prefixes ending in "*". */
  allowedRedirects: string[];
  allowLoopbackRedirects: boolean;
  /** Mark the CSRF cookie Secure (when served over https). */
  secureCookies: boolean;
  accessTtlMs?: number;
  refreshTtlMs?: number;
  /** Rotated refresh tokens are still accepted this long (default 60 s). */
  refreshReuseGraceMs?: number;
  /** Registered clients kept at most (default 500). */
  maxClients?: number;
  /** Never-used clients younger than this are not evicted to make room (default 30 s). */
  clientEvictMinAgeMs?: number;
  /** Clients without live tokens and no token issued for this long can be evicted (default 90 days). */
  clientInactiveMs?: number;
  /** Minimum duration of every password check; checks run one at a time server-wide (default 400 ms). */
  attemptMinMs?: number;
  /** Password checks allowed to wait in line; more are answered 429 at once (default 20). */
  attemptQueueMax?: number;
  /** Open sign-in requests kept at most; the oldest are dropped (default 5000). */
  maxPending?: number;
  limiter?: LoginLimiter;
  /** Shown on the login page. */
  serverName?: string;
}

interface Pending {
  clientId: string;
  params: AuthorizationParams;
  csrf: string;
  expiresAt: number;
}

interface CodeRecord {
  clientId: string;
  challenge: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
  used: boolean;
  family?: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();

/** Constant-time password check (hashing first makes lengths equal). */
export function passwordMatches(given: string, expected: string): boolean {
  return crypto.timingSafeEqual(sha(given), sha(expected));
}

function normalizeResource(u: string | URL): string {
  const s = typeof u === "string" ? u : u.href;
  return s.replace(/#.*$/, "").replace(/\/$/, "");
}

/** Expand an IPv6 address to 8 hextets (embedded IPv4 and zone ids handled). */
function ipv6Groups(addr: string): string[] {
  let s = addr.split("%")[0];
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[2].split(".").map(Number);
    s = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail !== undefined ? Array(Math.max(0, 8 - h.length - t.length)).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => parseInt(g || "0", 16).toString(16));
}

/**
 * The unit a lockout applies to: an IPv4 address, or an IPv6 /64 (one
 * customer's whole allocation, so rotating addresses inside it doesn't help).
 */
export function ipKey(ip: string): string {
  const a = ip.trim();
  if (/^::ffff:/i.test(a) && net.isIPv4(a.slice(7))) return a.slice(7);
  if (net.isIPv6(a.split("%")[0])) return `${ipv6Groups(a).slice(0, 4).join(":")}::/64`;
  return a;
}

/** The IPv6 /48 an address belongs to (one site; several /64s), or undefined for IPv4. */
export function ipPrefix48(ip: string): string | undefined {
  const a = ip.trim();
  if (/^::ffff:/i.test(a) && net.isIPv4(a.slice(7))) return undefined;
  if (!net.isIPv6(a.split("%")[0])) return undefined;
  return `${ipv6Groups(a).slice(0, 3).join(":")}::/48`;
}

export interface LoginLimiterOptions {
  /** Wrong passwords per IP (IPv6: per /64) within the window before that address is locked. */
  maxPerKey: number;
  /** Wrong passwords per IPv6 /48 within the window before the whole /48 is locked. */
  maxPerPrefix: number;
  windowMs: number;
  /** First lock duration; doubles with every further lock, up to maxLockMs. */
  baseLockMs: number;
  maxLockMs: number;
  /** Addresses/networks remembered at most; the least recently seen are forgotten first. */
  maxEntries: number;
}

const LIMITER_DEFAULTS: LoginLimiterOptions = {
  maxPerKey: 5,
  maxPerPrefix: 50,
  windowMs: 15 * 60_000,
  baseLockMs: 5 * 60_000,
  maxLockMs: 60 * 60_000,
  maxEntries: 10_000,
};

const DAY_MS = 24 * 3600_000;

interface LimiterEntry {
  fails: number;
  first: number;
  lockedUntil: number;
  locks: number;
  last: number;
}

/**
 * Per-network lockout for the password form.
 *
 * Locks are per IPv4 address or IPv6 /64, with exponential backoff; many
 * failures from different /64s of one IPv6 /48 lock that /48 as well. There is
 * no global lock, so the owner's correct password from another network is never
 * refused because of someone else's failures (the global guess rate is bounded
 * separately by AttemptQueue). Memory is bounded: expired entries are dropped
 * and at most `maxEntries` are kept.
 */
export class LoginLimiter {
  /** Map order = least recently failed first (entries are re-inserted on every failure). */
  private entries = new Map<string, LimiterEntry>();
  private lastPrune = 0;
  readonly o: LoginLimiterOptions;

  constructor(opts: Partial<LoginLimiterOptions> = {}) {
    this.o = { ...LIMITER_DEFAULTS, ...opts };
  }

  private keys(ip: string): { key: string; max: number }[] {
    const out = [{ key: ipKey(ip), max: this.o.maxPerKey }];
    const prefix = ipPrefix48(ip);
    if (prefix) out.push({ key: prefix, max: this.o.maxPerPrefix });
    return out;
  }

  /** How long (ms) this address is still locked out; 0 = not locked. */
  lockedFor(ip: string): number {
    const now = Date.now();
    let ms = 0;
    for (const { key } of this.keys(ip)) {
      const e = this.entries.get(key);
      if (e && e.lockedUntil > now) ms = Math.max(ms, e.lockedUntil - now);
    }
    return ms;
  }

  fail(ip: string): void {
    const now = Date.now();
    for (const { key, max } of this.keys(ip)) {
      const e = this.entries.get(key) ?? { fails: 0, first: now, lockedUntil: 0, locks: 0, last: now };
      if (now - e.last > DAY_MS) e.locks = 0; // a quiet day forgets earlier locks
      if (now - e.first > this.o.windowMs) Object.assign(e, { fails: 0, first: now });
      e.fails++;
      e.last = now;
      if (e.fails >= max) {
        e.lockedUntil = now + Math.min(this.o.maxLockMs, this.o.baseLockMs * 2 ** e.locks);
        e.locks++;
        e.fails = 0;
        e.first = now;
      }
      this.entries.delete(key);
      this.entries.set(key, e);
    }
    this.prune(now);
  }

  succeed(ip: string): void {
    this.entries.delete(ipKey(ip));
  }

  /** Number of remembered addresses/networks. */
  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    if (now - this.lastPrune >= 60_000) {
      this.lastPrune = now;
      for (const [k, e] of this.entries) {
        // Lock history is kept for a day (for the backoff), plain failures for the window.
        if (e.lockedUntil <= now && now - e.last > (e.locks > 0 ? DAY_MS : this.o.windowMs)) this.entries.delete(k);
      }
    }
    while (this.entries.size > this.o.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}

/**
 * Serializes password checks server-wide: one at a time, each taking at least
 * `minMs`, so at most 1000/minMs guesses per second are possible no matter how
 * many addresses or parallel connections are used. At most `maxQueue` attempts
 * may wait (including the one being checked); beyond that, `run` returns
 * undefined at once and nothing is checked.
 */
export class AttemptQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;

  constructor(
    readonly minMs = 400,
    readonly maxQueue = 20
  ) {}

  get length(): number {
    return this.queued;
  }

  /** Seconds until an attempt submitted now would be checked. */
  retryAfterSec(): number {
    return Math.max(1, Math.ceil((this.queued * this.minMs) / 1000));
  }

  run<T>(fn: () => T): Promise<T> | undefined {
    if (this.queued >= this.maxQueue) return undefined;
    this.queued++;
    const turn = this.tail.then(async () => {
      const started = Date.now();
      try {
        return fn();
      } finally {
        const left = this.minMs - (Date.now() - started);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
        this.queued--;
      }
    });
    this.tail = turn.catch(() => undefined);
    return turn;
  }
}

export class PasswordOAuthProvider implements OAuthServerProvider {
  private pending = new Map<string, Pending>();
  private codes = new Map<string, CodeRecord>();
  readonly limiter: LoginLimiter;
  readonly attempts: AttemptQueue;
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;

  constructor(private readonly opts: ProviderOptions) {
    this.accessTtlMs = opts.accessTtlMs ?? 60 * 60_000;
    this.refreshTtlMs = opts.refreshTtlMs ?? 30 * 24 * 3600_000;
    this.limiter = opts.limiter ?? new LoginLimiter();
    this.attempts = new AttemptQueue(opts.attemptMinMs ?? 400, opts.attemptQueueMax ?? 20);
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /** Clients between a correct password and their token request (never evicted). */
  private clientsMidSignIn(): Set<string> {
    const now = Date.now();
    return new Set([...this.codes.values()].filter((c) => !c.used && c.expiresAt > now).map((c) => c.clientId));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt + 10 * 60_000 <= now) this.codes.delete(k);
  }

  redirectAllowed(uri: string): boolean {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    if (u.hash) return false;
    if (this.opts.allowLoopbackRedirects && u.protocol === "http:" && LOOPBACK.has(u.hostname)) return true;
    if (u.protocol !== "https:") return false;
    return this.opts.allowedRedirects.some((rule) => redirectRuleMatches(rule, uri));
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id: string) => this.opts.store.getClient(id),
      registerClient: (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
        const full = client as OAuthClientInformationFull;
        if (!full.client_id) full.client_id = crypto.randomUUID();
        if (!full.client_id_issued_at) full.client_id_issued_at = Math.floor(Date.now() / 1000);
        const bad = (full.redirect_uris ?? []).filter((r) => !this.redirectAllowed(String(r)));
        if (!full.redirect_uris?.length || bad.length) {
          throw new InvalidClientMetadataError(
            `redirect_uri not allowed by this server: ${bad.join(", ") || "(none given)"}. Allowed: ${this.opts.allowedRedirects.join(", ")}${this.opts.allowLoopbackRedirects ? ", http://localhost/127.0.0.1 (any port)" : ""}`
          );
        }
        const max = this.opts.maxClients ?? 500;
        const count = this.opts.store.clientCount();
        if (count >= max) {
          // Make room: clients that never completed a sign-in first, then long-inactive ones without live tokens.
          this.opts.store.evictClients(count - max + 1, {
            unusedGraceMs: this.opts.clientEvictMinAgeMs ?? 30_000,
            inactiveMs: this.opts.clientInactiveMs ?? 90 * DAY_MS,
            keep: this.clientsMidSignIn(),
          });
          if (this.opts.store.clientCount() >= max) {
            throw new InvalidClientMetadataError("Too many registered clients. Run `gmail-mcp-multi http-logout --clients` on the server.");
          }
        }
        this.opts.store.putClient(full);
        return full;
      },
    };
  }

  // ---- authorization: show the password page ----
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && normalizeResource(params.resource) !== normalizeResource(this.opts.resource)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.opts.resource.href}`);
    }
    const id = crypto.randomBytes(24).toString("base64url");
    const csrf = crypto.randomBytes(24).toString("base64url");
    this.pending.set(id, { clientId: client.client_id, params, csrf, expiresAt: Date.now() + 10 * 60_000 });
    const maxPending = this.opts.maxPending ?? 5000;
    while (this.pending.size > maxPending) this.pending.delete(this.pending.keys().next().value!);
    this.renderLogin(res, { id, csrf, client, redirectUri: params.redirectUri });
  }

  private securityHeaders(res: Response, redirectUri?: string): void {
    let target = "";
    try {
      if (redirectUri) target = ` ${new URL(redirectUri).origin}`;
    } catch {
      /* ignore */
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // form-action must allow the redirect target: Chrome applies it to the redirect after POST.
    res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${target}; frame-ancestors 'none'; base-uri 'none'`);
  }

  private renderLogin(
    res: Response,
    v: { id: string; csrf: string; client: OAuthClientInformationFull; redirectUri: string; error?: string; status?: number }
  ): void {
    this.securityHeaders(res, v.redirectUri);
    res.cookie("gmm_csrf", v.csrf, { httpOnly: true, sameSite: "strict", secure: this.opts.secureCookies, path: "/oauth", maxAge: 10 * 60_000 });
    let host = v.redirectUri;
    try {
      host = new URL(v.redirectUri).host;
    } catch {
      /* ignore */
    }
    const name = escapeHtml(v.client.client_name || "An application");
    res.status(v.status ?? 200).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allow mail access?</title></head>
<body style="font-family:system-ui,sans-serif;background:#f5f5f4;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px">
<form method="post" action="/oauth/approve" style="background:#fff;border-radius:12px;padding:28px;max-width:420px;width:100%;box-shadow:0 1px 3px rgba(0,0,0,.12)">
<h1 style="font-size:20px;margin:0 0 8px">${escapeHtml(this.opts.serverName ?? "Gmail MCP Multi")}</h1>
<p style="color:#444;line-height:1.5;margin:0 0 16px"><b>${name}</b> wants access to your connected mailboxes.<br>
<span style="color:#666;font-size:14px">It will be sent back to <code>${escapeHtml(host)}</code>.</span></p>
${v.error ? `<p role="alert" style="color:#b91c1c;margin:0 0 12px">${escapeHtml(v.error)}</p>` : ""}
<label for="pw" style="display:block;font-size:14px;margin-bottom:6px">Server access password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus
 style="width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:8px;margin-bottom:16px">
<input type="hidden" name="request" value="${escapeHtml(v.id)}"><input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">
<div style="display:flex;gap:8px"><button name="action" value="approve" style="flex:1;padding:10px;font-size:16px;border:0;border-radius:8px;background:#1d4ed8;color:#fff;cursor:pointer">Allow</button>
<button name="action" value="deny" style="flex:1;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer">Deny</button></div>
</form></body></html>`);
  }

  plainPage(res: Response, status: number, title: string, msg: string): void {
    this.securityHeaders(res);
    res.status(status).type("html").send(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui,sans-serif;padding:32px"><h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(msg)}</p></body>`);
  }

  private redirectWith(res: Response, redirectUri: string, params: Record<string, string | undefined>): void {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, u.href);
  }

  /** POST /oauth/approve: check CSRF + password, then redirect back with a code. */
  approvalRouter(): Router {
    const router = express.Router();
    router.post("/approve", express.urlencoded({ extended: false, limit: "8kb" }), async (req: Request, res: Response) => {
      const ip = req.ip ?? "unknown";
      const body = (req.body ?? {}) as Record<string, string>;
      const p = typeof body.request === "string" ? this.pending.get(body.request) : undefined;
      if (!p || p.expiresAt <= Date.now()) {
        this.plainPage(res, 400, "Request expired", "This sign-in request is no longer valid. Start the connection again from your app.");
        return;
      }
      const cookieCsrf = parseCookie(req.headers.cookie ?? "", "gmm_csrf");
      if (!body.csrf || body.csrf !== p.csrf || cookieCsrf !== p.csrf) {
        this.plainPage(res, 403, "Invalid form", "The form could not be verified (missing or wrong security token). Start the connection again.");
        return;
      }
      const client = this.opts.store.getClient(p.clientId);
      if (!client) {
        this.plainPage(res, 400, "Unknown application", "The application is no longer registered. Start the connection again.");
        return;
      }
      if (body.action === "deny") {
        this.pending.delete(body.request);
        this.redirectWith(res, p.params.redirectUri, { error: "access_denied", error_description: "The user denied access", state: p.params.state });
        return;
      }
      const locked = this.limiter.lockedFor(ip);
      if (locked > 0) {
        this.pending.delete(body.request);
        this.lockedPage(res, locked);
        return;
      }
      // Claim the request before checking: right or wrong, it can't be used for another guess.
      const id = body.request;
      this.pending.delete(id);
      const turn = this.attempts.run((): { kind: "ok" | "wrong" } | { kind: "locked"; ms: number } => {
        // Re-checked in line: parallel attempts from one network stop at its limit.
        const lockedNow = this.limiter.lockedFor(ip);
        if (lockedNow > 0) return { kind: "locked", ms: lockedNow };
        if (typeof body.password !== "string" || !passwordMatches(body.password, this.opts.password)) {
          this.limiter.fail(ip);
          return { kind: "wrong" };
        }
        this.limiter.succeed(ip);
        return { kind: "ok" };
      });
      if (!turn) {
        // Too many attempts waiting: nothing was checked, so the form stays valid.
        this.pending.set(id, p);
        const wait = this.attempts.retryAfterSec();
        res.setHeader("Retry-After", String(wait));
        this.renderLogin(res, { id, csrf: p.csrf, client, redirectUri: p.params.redirectUri, status: 429, error: `The server is busy with other sign-in attempts. Wait ${wait} seconds, then enter the password again.` });
        return;
      }
      const result = await turn;
      if (result.kind === "locked") {
        this.lockedPage(res, result.ms);
        return;
      }
      if (result.kind === "wrong") {
        this.plainPage(res, 401, "Wrong password", "The password was wrong, so this sign-in request was cancelled. Start the connection again from your app.");
        return;
      }
      const code = crypto.randomBytes(32).toString("base64url");
      this.codes.set(code, {
        clientId: client.client_id,
        challenge: p.params.codeChallenge,
        redirectUri: p.params.redirectUri,
        scopes: p.params.scopes ?? [],
        expiresAt: Date.now() + 5 * 60_000,
        used: false,
      });
      this.redirectWith(res, p.params.redirectUri, { code, state: p.params.state });
    });
    return router;
  }

  private lockedPage(res: Response, ms: number): void {
    res.setHeader("Retry-After", String(Math.ceil(ms / 1000)));
    this.plainPage(res, 429, "Too many wrong passwords", `Too many wrong passwords from your network. Try again in ${Math.ceil(ms / 60_000)} minutes, then start the connection again from your app.`);
  }

  // ---- token endpoint ----
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const rec = this.codes.get(code);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return rec.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(code);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    if (rec.used) {
      // Code replay: kill whatever was issued from it.
      if (rec.family) this.opts.store.revokeFamily(rec.family);
      this.codes.delete(code);
      throw new InvalidGrantError("Authorization code already used");
    }
    if (redirectUri !== undefined && redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
    if (resource && normalizeResource(resource) !== normalizeResource(this.opts.resource)) throw new InvalidTargetError("Wrong resource");
    const t = this.opts.store.issue(
      { clientId: client.client_id, scopes: rec.scopes, resource: normalizeResource(this.opts.resource) },
      { accessMs: this.accessTtlMs, refreshMs: this.refreshTtlMs }
    );
    // Marked only once tokens exist: if saving failed, the code can be retried.
    rec.used = true;
    rec.family = t.family;
    return { access_token: t.access, token_type: "bearer", expires_in: t.expiresInSec, refresh_token: t.refresh, ...(rec.scopes.length ? { scope: rec.scopes.join(" ") } : {}) };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    if (resource && normalizeResource(resource) !== normalizeResource(this.opts.resource)) throw new InvalidTargetError("Wrong resource");
    const rec = this.opts.store.takeRefresh(refreshToken, this.opts.refreshReuseGraceMs ?? 60_000);
    if (rec === "reused") throw new InvalidGrantError("Refresh token reuse detected; all tokens of this session were revoked. Reconnect.");
    if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    const granted = scopes?.length ? scopes.filter((s) => rec.scopes.includes(s)) : rec.scopes;
    const t = this.opts.store.issue(
      { clientId: rec.clientId, scopes: granted, resource: rec.resource, family: rec.family },
      { accessMs: this.accessTtlMs, refreshMs: this.refreshTtlMs }
    );
    return { access_token: t.access, token_type: "bearer", expires_in: t.expiresInSec, refresh_token: t.refresh, ...(granted.length ? { scope: granted.join(" ") } : {}) };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.opts.store.getAccess(token);
    if (!rec) throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: rec.clientId, scopes: rec.scopes, expiresAt: Math.floor(rec.expiresAt / 1000), resource: new URL(rec.resource) };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.opts.store.revoke(client.client_id, request.token);
  }
}

/**
 * Redirect allow-list rule: an exact URI, or a prefix ending in "*". A prefix
 * only matches at a boundary: either the prefix itself ends with "/", or the
 * next character is "/", "?" or "#" (or the URI ends), so
 * "https://app.example.com*" does not match "https://app.example.com.evil.net".
 */
export function redirectRuleMatches(rule: string, uri: string): boolean {
  if (!rule.endsWith("*")) return uri === rule;
  const prefix = rule.slice(0, -1);
  if (!prefix || !uri.startsWith(prefix)) return false;
  if (prefix.endsWith("/")) return true;
  const next = uri.charAt(prefix.length);
  return next === "" || next === "/" || next === "?" || next === "#";
}

export function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export { InvalidRequestError };
