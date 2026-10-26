import * as crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express, { NextFunction, Request, RequestHandler, Response } from "express";
import { rateLimit, type AugmentedRequest } from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AccountManager } from "../accounts.js";
import { AuditLog } from "../audit.js";
import type { Mode } from "../config.js";
import { MailRegistry } from "../providers/registry.js";
import { createServer } from "../server.js";
import type { ToolContext } from "../tools/common.js";
import { VERSION } from "../version.js";
import { AuthStore } from "./auth-store.js";
import { CLAUDE_CALLBACKS, ipKey, LoginLimiter, PasswordOAuthProvider } from "./oauth-provider.js";

/**
 * Hosted mode: the MCP server over Streamable HTTP, protected by the built-in
 * OAuth 2.1 server, so it can be added in claude.ai as a custom connector.
 *
 *   GET  /healthz                                   no auth, version only
 *   GET  /.well-known/oauth-protected-resource[/mcp] RFC 9728 metadata
 *   GET  /.well-known/oauth-authorization-server     RFC 8414 metadata
 *   POST /register                                  dynamic client registration
 *   GET  /authorize                                 password page (rate-limited per IP / IPv6 /64)
 *   POST /oauth/approve                             password form target (rate-limited per IP / IPv6 /64)
 *   POST /token, POST /revoke
 *   POST|GET|DELETE /mcp                            MCP (Bearer token required)
 */

export interface RateLimitSetting {
  windowMs: number;
  max: number;
}

/** Defaults for the per-network limits on the sign-in pages. */
export const AUTHORIZE_RATE_LIMIT: RateLimitSetting = { windowMs: 15 * 60_000, max: 30 };
export const APPROVE_RATE_LIMIT: RateLimitSetting = { windowMs: 15 * 60_000, max: 20 };

export interface HttpOptions {
  mode: Mode;
  /** Public origin, e.g. https://mail.example.com (no path). */
  publicUrl: string;
  port: number;
  host: string;
  password: string;
  /** Express "trust proxy" setting (e.g. "loopback", "uniquelocal", 1). */
  trustProxy?: string | number | boolean;
  allowedRedirects?: string[];
  allowLoopbackRedirects?: boolean;
  /** Extra Host header names accepted (DNS-rebinding protection). */
  allowedHosts?: string[];
  /** Extra Origin values accepted on /mcp. */
  allowedOrigins?: string[];
  accounts?: AccountManager;
  accessTtlMs?: number;
  refreshTtlMs?: number;
  refreshReuseGraceMs?: number;
  maxClients?: number;
  clientEvictMinAgeMs?: number;
  clientInactiveMs?: number;
  /** Minimum duration of each (server-wide serialized) password check. */
  attemptMinMs?: number;
  attemptQueueMax?: number;
  maxPending?: number;
  limiter?: LoginLimiter;
  sessionIdleMs?: number;
  maxSessions?: number;
  /** Per IP (IPv6: per /64) limit on GET|POST /authorize; false disables. */
  authorizeRateLimit?: RateLimitSetting | false;
  /** Per IP (IPv6: per /64) limit on POST /oauth/approve; false disables. */
  approveRateLimit?: RateLimitSetting | false;
  /** Disable the SDK's rate limits and the default sign-in page limits (tests); explicit settings above still apply. */
  disableRateLimits?: boolean;
}

export const MIN_PASSWORD_LENGTH = 12;

export function validatePassword(pw: string | undefined): string {
  if (!pw || pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Set GMAIL_MCP_HTTP_PASSWORD (or GMAIL_MCP_HTTP_PASSWORD_FILE) to a password of at least ${MIN_PASSWORD_LENGTH} characters. ` +
        "It protects access to your mail when connecting Claude to this server."
    );
  }
  return pw;
}

export function parsePublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`--public-url "${raw}" is not a valid URL (example: https://mail.example.com).`);
  }
  if (u.pathname !== "/" || u.search || u.hash) throw new Error("--public-url must be an origin without a path, e.g. https://mail.example.com");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error("--public-url must use https:// (put Caddy or another TLS proxy in front).");
  return u;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  ctx: ToolContext;
  close: () => Promise<void>;
  clientId: string;
  lastSeen: number;
}

export interface RunningHttpServer {
  url: string;
  mcpUrl: string;
  server: HttpServer;
  store: AuthStore;
  provider: PasswordOAuthProvider;
  sessions: Map<string, Session>;
  /** Provider registry shared by all sessions. */
  mail: MailRegistry;
  close: () => Promise<void>;
}

export function buildHttpApp(opts: HttpOptions) {
  const publicUrl = parsePublicUrl(opts.publicUrl);
  const password = validatePassword(opts.password);
  const accounts = opts.accounts ?? new AccountManager();
  const mcpUrl = new URL("/mcp", publicUrl);
  const store = new AuthStore(accounts.root, accounts.secrets);
  // Changing the access password signs every connected app out.
  const pw = store.syncPassword(password);
  if (pw.changed) console.error(`[gmail-mcp-multi] access password changed: revoked ${pw.revokedTokens} tokens; connected apps must sign in again.`);
  // One registry for all sessions, so IMAP connections and caches are shared.
  const mail = new MailRegistry(accounts);
  const audit = new AuditLog(accounts.root);
  const provider = new PasswordOAuthProvider({
    password,
    resource: mcpUrl,
    store,
    allowedRedirects: opts.allowedRedirects?.length ? opts.allowedRedirects : CLAUDE_CALLBACKS,
    allowLoopbackRedirects: opts.allowLoopbackRedirects ?? true,
    secureCookies: publicUrl.protocol === "https:",
    accessTtlMs: opts.accessTtlMs,
    refreshTtlMs: opts.refreshTtlMs,
    refreshReuseGraceMs: opts.refreshReuseGraceMs,
    maxClients: opts.maxClients,
    clientEvictMinAgeMs: opts.clientEvictMinAgeMs,
    clientInactiveMs: opts.clientInactiveMs,
    attemptMinMs: opts.attemptMinMs,
    attemptQueueMax: opts.attemptQueueMax,
    maxPending: opts.maxPending,
    limiter: opts.limiter,
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", opts.trustProxy ?? "loopback");

  // DNS-rebinding protection: only our public host name (plus loopback for local health checks).
  const hosts = [publicUrl.hostname, "localhost", "127.0.0.1", "[::1]", ...(opts.allowedHosts ?? [])];
  app.use(hostHeaderValidation(hosts));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "gmail-mcp-multi", version: VERSION });
  });

  // Claude re-registers when the token endpoint answers invalid_client with 401.
  app.use("/token", (_req: Request, res: Response, next: NextFunction) => {
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if ((body as { error?: string })?.error === "invalid_client" && res.statusCode === 400) res.status(401);
      return json(body);
    };
    next();
  });

  // Per-network limits on the sign-in pages (on top of the SDK's per-endpoint limits):
  // every password guess needs a fresh /authorize and a POST /oauth/approve.
  const perNetwork = (setting: RateLimitSetting | false | undefined, fallback: RateLimitSetting, what: string): RequestHandler => {
    const s = setting === false ? undefined : (setting ?? (opts.disableRateLimits ? undefined : fallback));
    if (!s) return (_req, _res, next) => next();
    return rateLimit({
      windowMs: s.windowMs,
      limit: s.max,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      keyGenerator: (request) => ipKey(request.ip ?? "unknown"),
      // ipKey already groups IPv6 per /64 (the library's check only looks for its own helper).
      validate: { keyGeneratorIpFallback: false },
      handler: (request, response) => {
        const reset = (request as AugmentedRequest).rateLimit?.resetTime;
        const secs = Math.max(1, Math.ceil(((reset?.getTime() ?? Date.now() + s.windowMs) - Date.now()) / 1000));
        response.setHeader("Retry-After", String(secs));
        provider.plainPage(response, 429, "Too many requests", `Too many ${what} from your network. Try again in ${Math.ceil(secs / 60)} minutes.`);
      },
    });
  };
  app.use("/authorize", perNetwork(opts.authorizeRateLimit, AUTHORIZE_RATE_LIMIT, "sign-in requests"));

  const rl = opts.disableRateLimits ? { rateLimit: false as const } : {};
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: "Gmail MCP Multi",
      serviceDocumentationUrl: new URL("https://github.com/psdgator/Multi-Gmail-Account-MCP/blob/main/docs/hosted.md"),
      clientRegistrationOptions: { clientSecretExpirySeconds: 365 * 24 * 3600, ...rl },
      authorizationOptions: { ...rl },
      tokenOptions: { ...rl },
      revocationOptions: { ...rl },
    })
  );
  // Some clients probe the root PRM path; serve the same document there.
  const prm = {
    resource: mcpUrl.href,
    authorization_servers: [publicUrl.href],
    resource_name: "Gmail MCP Multi",
    bearer_methods_supported: ["header"],
  };
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json(prm);
  });
  app.use("/oauth/approve", perNetwork(opts.approveRateLimit, APPROVE_RATE_LIMIT, "password attempts"));
  app.use("/oauth", provider.approvalRouter());

  // ---- MCP endpoint ----
  const allowedOrigins = new Set([publicUrl.origin, "https://claude.ai", "https://claude.com", ...(opts.allowedOrigins ?? [])]);
  const originCheck = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: `Origin ${origin} is not allowed` }, id: null });
      return;
    }
    next();
  };
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });

  const sessions = new Map<string, Session>();
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const maxSessions = opts.maxSessions ?? 50;

  const dropSession = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.close().catch(() => undefined);
  };
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > idleMs) void dropSession(id);
  }, 60_000);
  sweeper.unref();

  const rpcError = (res: Response, status: number, message: string) =>
    res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

  app.all("/mcp", originCheck, bearer, express.json({ limit: "4mb" }), async (req: Request, res: Response) => {
    const clientId = req.auth!.clientId;
    const sid = req.header("mcp-session-id");
    try {
      if (sid) {
        const s = sessions.get(sid);
        if (!s) return void rpcError(res, 404, "Session not found; re-initialize.");
        if (s.clientId !== clientId) return void rpcError(res, 403, "Session belongs to another client.");
        s.lastSeen = Date.now();
        await s.transport.handleRequest(req, res, req.body);
        if (req.method === "DELETE") await dropSession(sid);
        return;
      }
      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        return void rpcError(res, 400, "Bad request: missing mcp-session-id (send initialize first).");
      }
      if (sessions.size >= maxSessions) {
        const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
        if (oldest) await dropSession(oldest[0]);
      }
      const { server, ctx } = createServer(opts.mode, { transport: "http", accounts, mail, audit });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, {
            transport,
            ctx,
            clientId,
            lastSeen: Date.now(),
            close: async () => {
              // The mail registry is shared by all sessions; it is closed with the server.
              await transport.close().catch(() => undefined);
              await server.close().catch(() => undefined);
            },
          });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[gmail-mcp-multi] /mcp error:", (err as Error).message);
      if (!res.headersSent) rpcError(res, 500, "Internal server error");
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  // Errors outside the SDK handlers (e.g. the sign-in state file can't be read): log, answer briefly.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = Number((err as { status?: number }).status);
    const clientError = status >= 400 && status < 500;
    if (!clientError) console.error("[gmail-mcp-multi] request failed:", (err as Error)?.message ?? err);
    if (res.headersSent) return;
    res.status(clientError ? status : 500).json({ error: clientError ? "invalid_request" : "server_error" });
  });

  return { app, store, provider, sessions, mcpUrl, publicUrl, accounts, mail };
}

export async function startHttpServer(opts: HttpOptions): Promise<RunningHttpServer> {
  const built = buildHttpApp(opts);
  const server = await new Promise<HttpServer>((resolve, reject) => {
    const s = built.app.listen(opts.port, opts.host, () => resolve(s));
    s.once("error", reject);
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://${opts.host.includes(":") ? `[${opts.host}]` : opts.host}:${addr.port}`,
    mcpUrl: built.mcpUrl.href,
    server,
    store: built.store,
    provider: built.provider,
    sessions: built.sessions,
    mail: built.mail,
    close: async () => {
      await Promise.all([...built.sessions.values()].map((s) => s.close()));
      built.sessions.clear();
      await built.mail.closeAll().catch(() => undefined);
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await closed;
    },
  };
}
