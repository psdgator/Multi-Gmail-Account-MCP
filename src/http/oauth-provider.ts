import * as crypto from "node:crypto";
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
 *   password (GMAIL_MCP_HTTP_PASSWORD). Wrong passwords are rate-limited and
 *   locked out per IP and globally.
 * - Codes are single-use and live 5 minutes; PKCE S256 is enforced by the SDK.
 * - Access tokens (1 h) and rotating refresh tokens (30 d) are random 256-bit
 *   strings stored only as hashes; reusing a rotated refresh token revokes the
 *   whole token family.
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
  maxClients?: number;
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

/** Per-IP and global brute-force protection for the password form. */
export class LoginLimiter {
  private perIp = new Map<string, { fails: number; first: number; lockedUntil: number }>();
  private global = { fails: 0, first: 0, lockedUntil: 0 };

  constructor(
    private readonly maxPerIp = 5,
    private readonly maxGlobal = 25,
    private readonly windowMs = 15 * 60_000,
    private readonly lockMs = 15 * 60_000
  ) {}

  lockedFor(ip: string): number {
    const now = Date.now();
    const g = this.global.lockedUntil > now ? this.global.lockedUntil - now : 0;
    const e = this.perIp.get(ip);
    const p = e && e.lockedUntil > now ? e.lockedUntil - now : 0;
    return Math.max(g, p);
  }

  fail(ip: string): void {
    const now = Date.now();
    const e = this.perIp.get(ip) ?? { fails: 0, first: now, lockedUntil: 0 };
    if (now - e.first > this.windowMs) Object.assign(e, { fails: 0, first: now });
    e.fails++;
    if (e.fails >= this.maxPerIp) e.lockedUntil = now + this.lockMs;
    this.perIp.set(ip, e);
    if (now - this.global.first > this.windowMs) Object.assign(this.global, { fails: 0, first: now });
    this.global.fails++;
    if (this.global.fails >= this.maxGlobal) this.global.lockedUntil = now + this.lockMs;
  }

  succeed(ip: string): void {
    this.perIp.delete(ip);
  }
}

export class PasswordOAuthProvider implements OAuthServerProvider {
  private pending = new Map<string, Pending>();
  private codes = new Map<string, CodeRecord>();
  readonly limiter = new LoginLimiter();
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;

  constructor(private readonly opts: ProviderOptions) {
    this.accessTtlMs = opts.accessTtlMs ?? 60 * 60_000;
    this.refreshTtlMs = opts.refreshTtlMs ?? 30 * 24 * 3600_000;
    setInterval(() => this.sweep(), 60_000).unref();
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
    return this.opts.allowedRedirects.some((rule) => (rule.endsWith("*") ? uri.startsWith(rule.slice(0, -1)) : uri === rule));
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
        if (this.opts.store.clientCount() >= (this.opts.maxClients ?? 100)) {
          throw new InvalidClientMetadataError("Too many registered clients. Run `gmail-mcp-multi http-logout --clients` on the server.");
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

  private plainPage(res: Response, status: number, title: string, msg: string): void {
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
        this.renderLogin(res, { id: body.request, csrf: p.csrf, client, redirectUri: p.params.redirectUri, status: 429, error: `Too many wrong passwords. Try again in ${Math.ceil(locked / 60_000)} minutes.` });
        return;
      }
      if (typeof body.password !== "string" || !passwordMatches(body.password, this.opts.password)) {
        this.limiter.fail(ip);
        await new Promise((r) => setTimeout(r, 400));
        this.renderLogin(res, { id: body.request, csrf: p.csrf, client, redirectUri: p.params.redirectUri, status: 401, error: "Wrong password." });
        return;
      }
      this.limiter.succeed(ip);
      this.pending.delete(body.request);
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
    rec.used = true;
    const t = this.opts.store.issue(
      { clientId: client.client_id, scopes: rec.scopes, resource: normalizeResource(this.opts.resource) },
      { accessMs: this.accessTtlMs, refreshMs: this.refreshTtlMs }
    );
    rec.family = t.family;
    return { access_token: t.access, token_type: "bearer", expires_in: t.expiresInSec, refresh_token: t.refresh, ...(rec.scopes.length ? { scope: rec.scopes.join(" ") } : {}) };
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    if (resource && normalizeResource(resource) !== normalizeResource(this.opts.resource)) throw new InvalidTargetError("Wrong resource");
    const rec = this.opts.store.takeRefresh(refreshToken);
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

export function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export { InvalidRequestError };
