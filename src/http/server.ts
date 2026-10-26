import * as crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express, { NextFunction, Request, Response } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AccountManager } from "../accounts.js";
import type { Mode } from "../config.js";
import { createServer } from "../server.js";
import type { ToolContext } from "../tools/common.js";
import { VERSION } from "../version.js";
import { AuthStore } from "./auth-store.js";
import { CLAUDE_CALLBACKS, PasswordOAuthProvider } from "./oauth-provider.js";

/**
 * Hosted mode: the MCP server over Streamable HTTP, protected by the built-in
 * OAuth 2.1 server, so it can be added in claude.ai as a custom connector.
 *
 *   GET  /healthz                                   no auth, version only
 *   GET  /.well-known/oauth-protected-resource[/mcp] RFC 9728 metadata
 *   GET  /.well-known/oauth-authorization-server     RFC 8414 metadata
 *   POST /register                                  dynamic client registration
 *   GET  /authorize                                 password page
 *   POST /oauth/approve                             password form target
 *   POST /token, POST /revoke
 *   POST|GET|DELETE /mcp                            MCP (Bearer token required)
 */

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
  sessionIdleMs?: number;
  maxSessions?: number;
  /** Disable the SDK's rate limits (tests). */
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
  close: () => Promise<void>;
}

export function buildHttpApp(opts: HttpOptions) {
  const publicUrl = parsePublicUrl(opts.publicUrl);
  const password = validatePassword(opts.password);
  const accounts = opts.accounts ?? new AccountManager();
  const mcpUrl = new URL("/mcp", publicUrl);
  const store = new AuthStore(accounts.root, accounts.secrets);
  const provider = new PasswordOAuthProvider({
    password,
    resource: mcpUrl,
    store,
    allowedRedirects: opts.allowedRedirects?.length ? opts.allowedRedirects : CLAUDE_CALLBACKS,
    allowLoopbackRedirects: opts.allowLoopbackRedirects ?? true,
    secureCookies: publicUrl.protocol === "https:",
    accessTtlMs: opts.accessTtlMs,
    refreshTtlMs: opts.refreshTtlMs,
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
      const { server, ctx } = createServer(opts.mode, { transport: "http", accounts });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, {
            transport,
            ctx,
            clientId,
            lastSeen: Date.now(),
            close: async () => {
              await transport.close().catch(() => undefined);
              await server.close().catch(() => undefined);
              await ctx.mail.closeAll().catch(() => undefined);
            },
          });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.has(id)) {
          const s = sessions.get(id)!;
          sessions.delete(id);
          void s.ctx.mail.closeAll().catch(() => undefined);
        }
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

  return { app, store, provider, sessions, mcpUrl, publicUrl, accounts };
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
    close: async () => {
      await Promise.all([...built.sessions.values()].map((s) => s.close()));
      built.sessions.clear();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await closed;
    },
  };
}
