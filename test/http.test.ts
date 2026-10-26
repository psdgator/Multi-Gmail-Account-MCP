import * as crypto from "node:crypto";
import * as fs from "node:fs";
import fsCjs from "node:fs";
import * as http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../src/accounts.js";
import { AuthStore, AuthStoreError } from "../src/http/auth-store.js";
import {
  AttemptQueue,
  ipKey,
  ipPrefix48,
  LoginLimiter,
  networkKey,
  passwordMatches,
  redirectRuleMatches,
  REGISTRATION_LIMITS,
  sanitizeClientMetadata,
} from "../src/http/oauth-provider.js";
import { buildHttpApp, HttpOptions, parsePublicUrl, RunningHttpServer, startHttpServer } from "../src/http/server.js";
import { startFakeGmail } from "./fake-gmail.js";

const PASSWORD = "correct horse battery staple";
const DAY = 24 * 3600_000;
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

let fake: Awaited<ReturnType<typeof startFakeGmail>>;
let home: string;
let srv: RunningHttpServer;
let base: string;
let mcpUrl: string;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function writeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-http-"));
  fs.writeFileSync(path.join(dir, "oauth-keys.json"), JSON.stringify({ installed: { client_id: "cid", client_secret: "secret" } }));
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      accounts: [
        { alias: "urbanstickers", email: "urbanstickersgr@gmail.com" },
        { alias: "psdgator", email: "antony@psdgator.com" },
      ],
      defaultAccount: "urbanstickers",
    })
  );
  for (const [alias, tok] of [["urbanstickers", "tok-urban"], ["psdgator", "tok-psd"]]) {
    fs.mkdirSync(path.join(dir, "accounts", alias), { recursive: true });
    fs.writeFileSync(path.join(dir, "accounts", alias, "credentials.json"), JSON.stringify({ access_token: tok, refresh_token: "r", expiry_date: Date.now() + 3600_000 }));
  }
  return dir;
}

async function start(port?: number, extra: Partial<HttpOptions> = {}, homeDir = home): Promise<RunningHttpServer> {
  const p = port ?? (await freePort());
  return startHttpServer({
    mode: "drafts",
    publicUrl: `http://127.0.0.1:${p}`,
    port: p,
    host: "127.0.0.1",
    password: PASSWORD,
    accounts: new AccountManager(homeDir),
    disableRateLimits: true,
    attemptMinMs: 10,
    log: () => undefined,
    ...extra,
  });
}

/** Point the request helpers at another running server for the duration of fn. */
async function withServer<T>(s: RunningHttpServer, fn: () => Promise<T>): Promise<T> {
  const [b, m] = [base, mcpUrl];
  base = s.url;
  mcpUrl = s.mcpUrl;
  try {
    return await fn();
  } finally {
    base = b;
    mcpUrl = m;
  }
}

/** 400 (= authenticated, but no session) vs 401 (= token refused). */
async function probe(accessToken: string): Promise<number> {
  const r = await fetch(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: "{}" });
  return r.status;
}

const storeFor = (dir = home) => new AuthStore(dir, new AccountManager(dir).secrets);

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

async function register(redirect = CLAUDE_CB, method = "client_secret_post", ip?: string) {
  return registerRaw({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, ip);
}

async function registerRaw(body: unknown, ip?: string) {
  const r = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> & { client_id: string; client_secret?: string; error?: string; error_description?: string } };
}

async function openLogin(clientId: string, challenge: string, extra: Record<string, string> = {}, ip?: string) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256", state: "st-123", resource: mcpUrl, ...extra });
  const r = await fetch(`${base}/authorize?${q}`, { redirect: "manual", headers: ip ? { "x-forwarded-for": ip } : {} });
  const html = await r.text();
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return {
    status: r.status,
    html,
    cookie,
    location: r.headers.get("location"),
    retryAfter: r.headers.get("retry-after"),
    csp: r.headers.get("content-security-policy"),
    request: html.match(/name="request" value="([^"]+)"/)?.[1] ?? "",
    csrf: html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "",
  };
}

async function approve(page: { request: string; csrf: string; cookie: string }, password: string, action = "approve", cookie = page.cookie, ip?: string) {
  const r = await fetch(`${base}/oauth/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: new URLSearchParams({ request: page.request, csrf: page.csrf, password, action }).toString(),
  });
  return { status: r.status, location: r.headers.get("location"), retryAfter: r.headers.get("retry-after"), text: await r.text() };
}

async function token(params: Record<string, string>) {
  const r = await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

/** password -> code -> tokens for an already registered client. */
async function signIn(client: { client_id: string; client_secret?: string }, password = PASSWORD) {
  const { verifier, challenge } = pkce();
  const page = await openLogin(client.client_id, challenge);
  const ok = await approve(page, password);
  const code = new URL(ok.location!).searchParams.get("code")!;
  const t = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_CB, client_id: client.client_id, client_secret: client.client_secret!, resource: mcpUrl });
  return t.body;
}

/** Full happy path: register -> password -> code -> tokens. */
async function connect(password = PASSWORD) {
  const { body: client } = await register();
  return { client, tokens: await signIn(client, password) };
}

function mcpClient(accessToken: string) {
  const client = new Client({ name: "http-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
  return { client, transport };
}

beforeAll(async () => {
  fake = await startFakeGmail();
  process.env.GMAIL_MCP_API_ROOT = fake.url;
  process.env.GMAIL_MCP_MASTER_KEY = "b".repeat(64);
  home = writeHome();
  srv = await start();
  base = srv.url;
  mcpUrl = srv.mcpUrl;
});

afterAll(async () => {
  await srv?.close();
  await fake.close();
  delete process.env.GMAIL_MCP_API_ROOT;
  delete process.env.GMAIL_MCP_MASTER_KEY;
});

describe("configuration guards", () => {
  it("refuses weak passwords and non-https public URLs", () => {
    expect(() => buildHttpApp({ mode: "drafts", publicUrl: "https://mail.example.com", port: 1, host: "127.0.0.1", password: "short" })).toThrow(/at least 12/);
    expect(() => parsePublicUrl("http://mail.example.com")).toThrow(/https/);
    expect(() => parsePublicUrl("https://mail.example.com/sub")).toThrow(/without a path/);
    expect(parsePublicUrl("http://localhost:8787").hostname).toBe("localhost");
  });

  it("compares passwords in constant time and locks out brute force", () => {
    expect(passwordMatches(PASSWORD, PASSWORD)).toBe(true);
    expect(passwordMatches("x", PASSWORD)).toBe(false);
    const l = new LoginLimiter({ maxPerKey: 3 });
    for (let i = 0; i < 3; i++) l.fail("1.2.3.4");
    expect(l.lockedFor("1.2.3.4")).toBeGreaterThan(0);
    expect(l.lockedFor("5.6.7.8")).toBe(0);
  });
});

describe("discovery", () => {
  it("serves health without auth", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(await r.json()).toMatchObject({ ok: true, name: "gmail-mcp-multi" });
  });

  it("rejects /mcp without a token and points to the resource metadata", async () => {
    const r = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("publishes protected-resource and authorization-server metadata", async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({ resource: mcpUrl, authorization_servers: [`${base}/`] });
    const root = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    expect(root.resource).toBe(mcpUrl);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("blocks foreign Host headers (DNS rebinding)", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/healthz`);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("client registration", () => {
  it("only accepts allowed redirect URIs", async () => {
    const bad = await register("https://evil.example/callback");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_client_metadata");
    const http1 = await register("http://evil.example/cb");
    expect(http1.status).toBe(400);
    const good = await register();
    expect(good.status).toBe(201);
    expect(good.body.client_id).toBeTruthy();
    expect(good.body.client_secret).toBeTruthy();
    const loop = await register("http://127.0.0.1:33418/callback", "none");
    expect(loop.status).toBe(201);
  });
});

describe("authorization + tokens", () => {
  it("runs the password-protected PKCE flow, enforcing CSRF, password and verifier", async () => {
    const { body: client } = await register();
    const { verifier, challenge } = pkce();
    const page = await openLogin(client.client_id, challenge);
    expect(page.status).toBe(200);
    expect(page.html).toContain("Claude");
    expect(page.html).toContain("claude.ai");
    expect(page.csp).toContain("form-action 'self' https://claude.ai");
    expect(page.cookie).toMatch(/^gmm_csrf=/);

    expect((await approve(page, PASSWORD, "approve", "")).status).toBe(403); // no CSRF cookie
    const wrong = await approve(page, "not the password!!");
    expect(wrong.status).toBe(401);
    expect(wrong.location).toBeNull();
    expect(wrong.text).toContain("Wrong password");
    expect(wrong.text).toContain("Start the connection again");
    // A wrong password ends the request: the same form can't be used for another guess.
    const reuse = await approve(page, PASSWORD);
    expect(reuse.status).toBe(400);
    expect(reuse.text).toContain("Request expired");

    const page2 = await openLogin(client.client_id, challenge);
    const ok = await approve(page2, PASSWORD);
    expect(ok.status).toBe(302);
    const loc = new URL(ok.location!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE_CB);
    expect(loc.searchParams.get("state")).toBe("st-123");
    const code = loc.searchParams.get("code")!;
    expect(code.length).toBeGreaterThan(40);

    expect((await approve(page2, PASSWORD)).status).toBe(400); // pending request is single-use

    const creds = { client_id: client.client_id, client_secret: client.client_secret! };
    const badPkce = await token({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, redirect_uri: CLAUDE_CB, ...creds });
    expect(badPkce.status).toBe(400);
    expect(badPkce.body.error).toBe("invalid_grant");

    const t = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_CB, resource: mcpUrl, ...creds });
    expect(t.status).toBe(200);
    expect(t.body.access_token).toMatch(/^gmm_at_/);
    expect(t.body.refresh_token).toMatch(/^gmm_rt_/);
    expect(Number(t.body.expires_in)).toBe(3600);

    // Replaying the code fails and kills the tokens it produced.
    const replay = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_CB, ...creds });
    expect(replay.body.error).toBe("invalid_grant");
    const after = await fetch(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${t.body.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(after.status).toBe(401);
  });

  it("lets the user deny", async () => {
    const { body: client } = await register();
    const page = await openLogin(client.client_id, pkce().challenge);
    const r = await approve(page, "", "deny");
    expect(r.status).toBe(302);
    expect(new URL(r.location!).searchParams.get("error")).toBe("access_denied");
  });

  it("rejects tokens for a different resource", async () => {
    const { body: client } = await register();
    const page = await openLogin(client.client_id, pkce().challenge, { resource: "https://other.example/mcp" });
    expect(page.status).toBe(302);
    expect(new URL(page.location!).searchParams.get("error")).toBe("invalid_target");
  });

  it("rotates refresh tokens and tolerates a reuse within the 60 s grace window", async () => {
    const { client, tokens } = await connect();
    const creds = { client_id: client.client_id, client_secret: client.client_secret! };
    const r1 = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, ...creds });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token);
    // Lost response / concurrent refresh: the old token works once more, the session survives.
    const again = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, ...creds });
    expect(again.status).toBe(200);
    expect(again.body.access_token).toMatch(/^gmm_at_/);
    const r2 = await token({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, ...creds });
    expect(r2.status).toBe(200);
    expect(await probe(r2.body.access_token)).toBe(400);
  });

  it("revokes the whole family when a rotated refresh token is reused after the grace window", async () => {
    const strict = await start(undefined, { refreshReuseGraceMs: 0 });
    try {
      await withServer(strict, async () => {
        const { client, tokens } = await connect();
        const creds = { client_id: client.client_id, client_secret: client.client_secret! };
        const r1 = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, ...creds });
        expect(r1.status).toBe(200);
        const reuse = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, ...creds });
        expect(reuse.body.error).toBe("invalid_grant");
        const r2 = await token({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, ...creds });
        expect(r2.body.error).toBe("invalid_grant"); // whole family revoked
        expect(await probe(r1.body.access_token)).toBe(401);
      });
    } finally {
      await strict.close();
    }
  });

  it("answers an unknown client with 401 invalid_client (Claude then re-registers)", async () => {
    const r = await token({ grant_type: "refresh_token", refresh_token: "x", client_id: "does-not-exist", client_secret: "y" });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid_client");
  });

  it("stores only hashes of tokens, encrypted", async () => {
    const { tokens } = await connect();
    const raw = fs.readFileSync(path.join(home, "http-auth.json"), "utf8");
    expect(raw).not.toContain(tokens.access_token);
    expect(raw).not.toContain(tokens.refresh_token);
    expect(JSON.parse(raw).alg).toBe("A256GCM");
  });
});

describe("MCP over HTTP", () => {
  it("lists hosted tools and searches all accounts with a valid token", async () => {
    const { tokens } = await connect();
    const { client, transport } = mcpClient(tokens.access_token);
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("search_emails");
    expect(names).toContain("create_draft");
    expect(names).not.toContain("save_attachment");
    expect(names).not.toContain("authenticate");
    expect(names).not.toContain("send_email");
    const res = (await client.callTool({ name: "search_emails", arguments: { query: "is:unread" } })) as { content: { text: string }[] };
    const data = JSON.parse(res.content[0].text);
    expect(data.results.map((m: { account: string; id: string }) => `${m.account}:${m.id}`)).toEqual(["urbanstickers:u1", "urbanstickers:n1", "psdgator:p1"]);
    await client.close();
  });

  it("binds sessions to the client that created them", async () => {
    const a = await connect();
    const b = await connect();
    const { client, transport } = mcpClient(a.tokens.access_token);
    await client.connect(transport);
    const sid = transport.sessionId!;
    expect(sid).toBeTruthy();
    const r = await fetch(mcpUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${b.tokens.access_token}`, "mcp-session-id": sid, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(r.status).toBe(403);
    await client.close();
  });

  it("rejects foreign browser Origins", async () => {
    const { tokens } = await connect();
    const r = await fetch(mcpUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}`, origin: "https://evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    });
    expect(r.status).toBe(403);
  });

  it("stops accepting a revoked token", async () => {
    const { client, tokens } = await connect();
    const rv = await fetch(`${base}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.access_token, client_id: client.client_id, client_secret: client.client_secret! }).toString(),
    });
    expect(rv.status).toBe(200);
    const r = await fetch(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
  });

  it("keeps tokens across a restart", async () => {
    const { tokens } = await connect();
    const port = Number(new URL(base).port);
    await srv.close();
    await new Promise((r) => setTimeout(r, 200)); // let the client notice its pooled sockets closed
    srv = await start(port);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const { client, transport } = mcpClient(tokens.access_token);
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);
    await client.close();
  });
});

describe("store, limiter and redirect rules (units)", () => {
  it("groups IPv6 per /64 and maps v4-mapped addresses to IPv4", () => {
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe(ipKey("2001:db8:1:2:bbbb:cccc:dddd:2"));
    expect(ipKey("2001:db8:1:2::1")).not.toBe(ipKey("2001:db8:1:3::1"));
    expect(ipKey("2001:0db8:0001:0002:0000:0000:0000:0001")).toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("fe80::1%eth0")).toBe(ipKey("fe80::2"));
  });

  it("locks per IP / per /64 with backoff, never globally", () => {
    const l = new LoginLimiter({ maxPerKey: 2, baseLockMs: 1000 });
    for (let i = 0; i < 2; i++) l.fail("2001:db8:5:6::1");
    expect(l.lockedFor("2001:db8:5:6:ffff::9")).toBeGreaterThan(0); // same /64
    expect(l.lockedFor("2001:db8:5:7::1")).toBe(0);
    for (let i = 0; i < 40; i++) l.fail(`198.51.100.${i}`);
    expect(l.lockedFor("192.0.2.200")).toBe(0); // the owner's fresh address is never refused
    // Exponential backoff: the second lock of the same key lasts longer.
    const first = l.lockedFor("2001:db8:5:6::1");
    for (let i = 0; i < 2; i++) l.fail("2001:db8:5:6::1");
    expect(l.lockedFor("2001:db8:5:6::1")).toBeGreaterThan(first);
  });

  it("locks a whole IPv6 /48 after many failures across its /64s, but not other networks", () => {
    expect(ipPrefix48("2001:db8:aa:4::1")).toBe(ipPrefix48("2001:0db8:00aa:ffff:1:2:3:4"));
    expect(ipPrefix48("2001:db8:aa:4::1")).not.toBe(ipPrefix48("2001:db8:ab:4::1"));
    expect(ipPrefix48("203.0.113.5")).toBeUndefined();
    expect(ipPrefix48("::ffff:203.0.113.5")).toBeUndefined();
    const l = new LoginLimiter({ maxPerKey: 5, maxPerPrefix: 12 });
    for (const n of [1, 2]) for (let i = 0; i < 5; i++) l.fail(`2001:db8:aa:${n}::1`); // two /64s locked, 10 failures in the /48
    expect(l.lockedFor("2001:db8:aa:1::9")).toBeGreaterThan(0);
    expect(l.lockedFor("2001:db8:aa:3::1")).toBe(0); // the /48 is not locked yet
    for (let i = 0; i < 2; i++) l.fail("2001:db8:aa:3::1"); // 12 failures in the /48
    expect(l.lockedFor("2001:db8:aa:3::1")).toBeGreaterThan(0);
    expect(l.lockedFor("2001:db8:aa:ffff::1")).toBeGreaterThan(0); // a fresh /64 of the same /48
    expect(l.lockedFor("2001:db8:ab:1::1")).toBe(0); // the owner on another network is fine
    expect(l.lockedFor("203.0.113.5")).toBe(0);
  });

  it("keeps the limiter's memory bounded: expired entries are dropped and the oldest go beyond the cap", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const l = new LoginLimiter({ maxPerKey: 1, baseLockMs: 60_000, maxEntries: 100 });
      for (let i = 0; i < 1000; i++) l.fail(`10.0.${i >> 8}.${i & 255}`); // every one of them locked
      expect(l.size).toBe(100);
      expect(l.lockedFor("10.0.3.231")).toBeGreaterThan(0); // the most recent are kept
      expect(l.lockedFor("10.0.0.0")).toBe(0); // the oldest were forgotten
      vi.setSystemTime(Date.now() + 2 * DAY); // locks expired and a quiet day passed
      l.fail("192.0.2.1");
      expect(l.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes password checks with a minimum time each and a bounded line", async () => {
    const q = new AttemptQueue(50, 3);
    const started = Date.now();
    const runs = [q.run(() => 1), q.run(() => 2), q.run(() => 3)];
    expect(q.run(() => 4)).toBeUndefined(); // line full: refused at once, nothing run
    expect(q.length).toBe(3);
    expect(q.retryAfterSec()).toBe(1);
    expect(await Promise.all(runs)).toEqual([1, 2, 3]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140); // one at a time, >= 50 ms each
    expect(q.length).toBe(0);
    expect(await q.run(() => 5)).toBe(5);
  });

  it("matches redirect prefixes only at a path boundary", () => {
    const rule = "https://app.example.com*";
    expect(redirectRuleMatches(rule, "https://app.example.com")).toBe(true);
    expect(redirectRuleMatches(rule, "https://app.example.com/cb")).toBe(true);
    expect(redirectRuleMatches(rule, "https://app.example.com?x=1")).toBe(true);
    expect(redirectRuleMatches(rule, "https://app.example.com.evil.net/cb")).toBe(false);
    expect(redirectRuleMatches(rule, "https://app.example.community/cb")).toBe(false);
    expect(redirectRuleMatches(rule, "https://app.example.com:8443/cb")).toBe(false);
    expect(redirectRuleMatches("https://x.example/cb/*", "https://x.example/cb/anything")).toBe(true);
    expect(redirectRuleMatches("https://x.example/cb/*", "https://x.example/cbx")).toBe(false);
    expect(redirectRuleMatches("https://x.example/cb", "https://x.example/cb")).toBe(true);
    expect(redirectRuleMatches("https://x.example/cb", "https://x.example/cb/")).toBe(false);
    expect(redirectRuleMatches("*", "https://anything.example")).toBe(false);
  });

  it("re-reads the file changed by another process and never writes revoked tokens back", () => {
    const dir = writeHome();
    const a = storeFor(dir);
    a.putClient({ client_id: "c1", redirect_uris: [CLAUDE_CB] } as never);
    const t = a.issue({ clientId: "c1", scopes: [], resource: "https://x/mcp" }, { accessMs: 60_000, refreshMs: 60_000 });
    expect(a.getAccess(t.access)).toBeTruthy();
    const b = storeFor(dir); // "http-logout" in another process
    b.revokeAll(false);
    expect(a.getAccess(t.access)).toBeUndefined();
    a.issue({ clientId: "c1", scopes: [], resource: "https://x/mcp" }, { accessMs: 60_000, refreshMs: 60_000 }); // a writes again
    expect(storeFor(dir).getAccess(t.access)).toBeUndefined(); // the revoked token did not come back
    expect(storeFor(dir).stats().accessTokens).toBe(1);
  });

  it("revokes all tokens when the access password changes, but not otherwise", () => {
    const dir = writeHome();
    const s = storeFor(dir);
    expect(s.syncPassword("first password 123")).toEqual({ changed: false, revokedTokens: 0 }); // first run: just records it
    s.putClient({ client_id: "c1", redirect_uris: [CLAUDE_CB] } as never);
    const t = s.issue({ clientId: "c1", scopes: [], resource: "https://x/mcp" }, { accessMs: 60_000, refreshMs: 60_000 });
    expect(storeFor(dir).syncPassword("first password 123")).toEqual({ changed: false, revokedTokens: 0 });
    expect(storeFor(dir).getAccess(t.access)).toBeTruthy();
    expect(storeFor(dir).syncPassword("second password 456")).toEqual({ changed: true, revokedTokens: 2 });
    expect(storeFor(dir).getAccess(t.access)).toBeUndefined();
    expect(storeFor(dir).getClient("c1")).toBeTruthy(); // clients are kept
    expect(fs.readFileSync(path.join(dir, "http-auth.json"), "utf8")).not.toContain("second password");
  });

  it("refresh grace: reuse inside the window works only while the session is alive", () => {
    const s = storeFor(writeHome());
    s.putClient({ client_id: "c1", redirect_uris: [CLAUDE_CB] } as never);
    const t = s.issue({ clientId: "c1", scopes: [], resource: "https://x/mcp" }, { accessMs: 60_000, refreshMs: 60_000 });
    const first = s.takeRefresh(t.refresh, 60_000);
    expect(first).toMatchObject({ clientId: "c1" });
    const next = s.issue({ clientId: "c1", scopes: [], resource: "https://x/mcp", family: t.family }, { accessMs: 60_000, refreshMs: 60_000 });
    expect(s.takeRefresh(t.refresh, 60_000)).toMatchObject({ clientId: "c1", family: t.family }); // within grace
    expect(s.takeRefresh(t.refresh, 0)).toBe("reused"); // outside grace: family revoked
    expect(s.getAccess(next.access)).toBeUndefined();
    expect(s.takeRefresh(t.refresh, 60_000)).toBe("reused"); // session dead: no grace any more
  });

  it("evicts never-used clients after a short grace, then long-inactive ones, never one with live tokens", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = storeFor(writeHome());
      const now = Date.now();
      const put = (id: string, registeredAgoMs: number) =>
        s.putClient({ client_id: id, client_id_issued_at: Math.floor((now - registeredAgoMs) / 1000), redirect_uris: [CLAUDE_CB] } as never);
      put("unused-1h", 3600_000);
      put("unused-40s", 40_000);
      put("unused-5s", 5_000); // inside the grace period: a sign-in may be in progress
      put("mid-sign-in", 60_000); // holds an authorization code (passed in `keep`)
      for (const id of ["idle-100d", "idle-100d-live", "idle-10d"]) put(id, 200 * DAY);
      const tok = (clientId: string, refreshMs: number) => s.issue({ clientId, scopes: [], resource: "https://x/mcp" }, { accessMs: 3600_000, refreshMs });
      vi.setSystemTime(now - 100 * DAY);
      tok("idle-100d", 30 * DAY); // all its tokens have expired since
      tok("idle-100d-live", 200 * DAY); // still holds a live refresh token
      vi.setSystemTime(now - 10 * DAY);
      tok("idle-10d", 1000); // no live token, but active recently
      vi.setSystemTime(now);
      const o = { unusedGraceMs: 30_000, inactiveMs: 90 * DAY, keep: new Set(["mid-sign-in"]) };
      expect(s.evictClients(1, o)).toBe(1);
      expect(s.getClient("unused-1h")).toBeUndefined(); // the oldest never-used client goes first
      expect(s.evictClients(10, o)).toBe(2);
      expect(s.getClient("unused-40s")).toBeUndefined(); // never used, regardless of age
      expect(s.getClient("idle-100d")).toBeUndefined(); // inactive for 100 days, no live tokens
      for (const id of ["unused-5s", "mid-sign-in", "idle-100d-live", "idle-10d"]) expect(s.getClient(id)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to use or overwrite a sign-in file it can't read, and recovers when it can", () => {
    const dir = writeHome();
    const file = path.join(dir, "http-auth.json");
    const a = storeFor(dir);
    a.putClient({ client_id: "c1", redirect_uris: [CLAUDE_CB] } as never);
    const t = a.issue({ clientId: "c1", scopes: [], resource: "https://x/mcp" }, { accessMs: 60_000, refreshMs: 60_000 });
    const good = fs.readFileSync(file);
    const torn = good.subarray(0, 40); // e.g. another process's write cut short
    fs.writeFileSync(file, torn);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => a.issue({ clientId: "c1", scopes: [], resource: "https://x/mcp" }, { accessMs: 60_000, refreshMs: 60_000 })).toThrow(AuthStoreError);
      expect(() => a.getAccess(t.access)).toThrow(/could not be read/); // no answers from the stale copy either
      expect(() => a.revoke("c1", t.access)).toThrow(AuthStoreError);
      expect(fs.readFileSync(file).equals(torn)).toBe(true); // never overwritten with stale state
      fs.writeFileSync(file, good); // the file becomes readable again
      expect(a.getAccess(t.access)).toBeTruthy();
      // http-logout is the way out of a damaged file: it replaces it instead of failing.
      fs.writeFileSync(file, "garbage");
      expect(storeFor(dir).revokeAll(false)).toMatchObject({ replacedUnreadable: true });
      expect(a.getAccess(t.access)).toBeUndefined();
      expect(a.stats().clients).toBe(0);
    } finally {
      quiet.mockRestore();
    }
  });

  it("writes the sign-in file atomically (temp file + rename), owner-only", () => {
    const dir = writeHome();
    const file = path.join(dir, "http-auth.json");
    const s = storeFor(dir);
    s.putClient({ client_id: "c1", redirect_uris: [CLAUDE_CB] } as never);
    const ino = fs.statSync(file).ino;
    s.putClient({ client_id: "c2", redirect_uris: [CLAUDE_CB] } as never);
    expect(fs.statSync(file).ino).not.toBe(ino); // replaced, not rewritten in place
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(storeFor(dir).clientCount()).toBe(2);
  });
});

describe("sign-out and abuse resistance (HTTP)", () => {
  it("honours http-logout run from another process immediately", async () => {
    const { tokens } = await connect();
    expect(await probe(tokens.access_token)).toBe(400);
    const r = storeFor().revokeAll(false); // what `gmail-mcp-multi http-logout` does
    expect(r.tokens).toBeGreaterThan(0);
    expect(await probe(tokens.access_token)).toBe(401);
    const fresh = await connect(); // the running server writes the file again...
    expect(await probe(fresh.tokens.access_token)).toBe(400);
    expect(await probe(tokens.access_token)).toBe(401); // ...without resurrecting revoked tokens
    expect(storeFor().getAccess(tokens.access_token)).toBeUndefined();
  });

  it("changing the access password signs everything out", async () => {
    const { tokens } = await connect();
    expect(await probe(tokens.access_token)).toBe(400);
    const other = await start(undefined, { password: "a completely new password" });
    try {
      // The new server revoked every token at startup; the old server sees it too.
      expect(await probe(tokens.access_token)).toBe(401);
      await withServer(other, async () => {
        expect(await probe(tokens.access_token)).toBe(401);
        const again = await connect("a completely new password");
        expect(await probe(again.tokens.access_token)).toBe(400);
      });
    } finally {
      await other.close();
      storeFor().syncPassword(PASSWORD); // restore the fingerprint for the remaining tests
    }
  });

  it("locks the attacking IP or IPv6 /64 but never refuses the right password from elsewhere", async () => {
    const limited = await start(undefined, { attemptMinMs: 0 });
    try {
      await withServer(limited, async () => {
        const { body: client } = await register();
        // Every guess needs a fresh sign-in request: a wrong password ends the old one.
        const guess = async (password: string, ip: string) => {
          const page = await openLogin(client.client_id, pkce().challenge);
          return approve(page, password, "approve", page.cookie, ip);
        };
        // 6 IPv4 attackers x 5 attempts = 30 failures (the old global lock was 25).
        for (let a = 1; a <= 6; a++) for (let i = 0; i < 5; i++) expect((await guess("wrong password!!", `203.0.113.${a}`)).status).toBe(401);
        for (let i = 0; i < 5; i++) expect((await guess("wrong password!!", `2001:db8:1:2::${i + 1}`)).status).toBe(401);
        expect((await guess(PASSWORD, "203.0.113.1")).status).toBe(429);
        const sameNet = await guess(PASSWORD, "2001:db8:1:2:dead:beef::1"); // same /64
        expect(sameNet.status).toBe(429);
        expect(Number(sameNet.retryAfter)).toBeGreaterThan(0);
        expect((await guess(PASSWORD, "198.51.100.7")).status).toBe(302);
        expect((await guess(PASSWORD, "2001:db8:1:3::1")).status).toBe(302); // next /64 is fine
      });
    } finally {
      await limited.close();
    }
  });

  it("checks passwords one at a time server-wide, still accepting the owner's", async () => {
    const s = await start(undefined, { attemptMinMs: 150, attemptQueueMax: 20 });
    try {
      await withServer(s, async () => {
        const { body: client } = await register();
        const pages = await Promise.all(Array.from({ length: 5 }, () => openLogin(client.client_id, pkce().challenge)));
        const started = Date.now();
        // Four guesses from different addresses and the owner's correct password, all at once.
        const results = await Promise.all(pages.map((pg, i) => approve(pg, i === 4 ? PASSWORD : "wrong password!!", "approve", pg.cookie, `198.51.100.${i + 10}`)));
        expect(Date.now() - started).toBeGreaterThanOrEqual(700); // 5 checks x >= 150 ms, never in parallel
        expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 302]);

        // Parallel guesses from one address: it gets 2 places in the line, the rest are answered "busy" at once
        // (nothing checked, the forms stay valid).
        const burst = await Promise.all(Array.from({ length: 8 }, () => openLogin(client.client_id, pkce().challenge)));
        const burstResults = await Promise.all(burst.map((pg) => approve(pg, "wrong password!!", "approve", pg.cookie, "192.0.2.77")));
        expect(burstResults.filter((r) => r.status === 401)).toHaveLength(2);
        expect(burstResults.filter((r) => r.status === 429 && r.text.includes("busy"))).toHaveLength(6);
      });
    } finally {
      await s.close();
    }
  });

  it("answers 429 at once when too many password checks are waiting, keeping the form valid", async () => {
    const s = await start(undefined, { attemptMinMs: 300, attemptQueueMax: 2 });
    try {
      await withServer(s, async () => {
        const { body: client } = await register();
        const pages = await Promise.all(Array.from({ length: 5 }, () => openLogin(client.client_id, pkce().challenge)));
        const results = await Promise.all(pages.map((pg, i) => approve(pg, "wrong password!!", "approve", pg.cookie, `198.51.100.${i + 30}`)));
        const busy = results.map((r, i) => ({ r, page: pages[i] })).filter((x) => x.r.status === 429);
        expect(busy.length).toBe(3);
        expect(results.filter((r) => r.status === 401)).toHaveLength(2);
        for (const { r } of busy) {
          expect(Number(r.retryAfter)).toBeGreaterThan(0);
          expect(r.text).toContain("busy");
        }
        // Nothing was checked for those, so the same form still works once the line has cleared.
        const later = await approve(busy[0].page, PASSWORD, "approve", busy[0].page.cookie, "198.51.100.99");
        expect(later.status).toBe(302);
      });
    } finally {
      await s.close();
    }
  });

  it("rate-limits /authorize and /oauth/approve per IP (IPv6: per /64)", async () => {
    const s = await start(undefined, { authorizeRateLimit: { windowMs: 60_000, max: 3 }, approveRateLimit: { windowMs: 60_000, max: 2 } });
    try {
      await withServer(s, async () => {
        const { body: client } = await register();
        const open = (ip: string) => openLogin(client.client_id, pkce().challenge, {}, ip);
        for (let i = 0; i < 3; i++) expect((await open(`2001:db8:9:9::${i + 1}`)).status).toBe(200);
        const limited = await open("2001:db8:9:9:ffff::2"); // same /64
        expect(limited.status).toBe(429);
        expect(Number(limited.retryAfter)).toBeGreaterThan(0);
        expect((await open("2001:db8:9:a::1")).status).toBe(200); // the next /64 is separate

        const pages = [await open("192.0.2.1"), await open("192.0.2.2"), await open("192.0.2.3"), await open("192.0.2.4")];
        expect((await approve(pages[0], "wrong password!!", "approve", pages[0].cookie, "203.0.113.77")).status).toBe(401);
        expect((await approve(pages[1], "wrong password!!", "approve", pages[1].cookie, "203.0.113.77")).status).toBe(401);
        const third = await approve(pages[2], PASSWORD, "approve", pages[2].cookie, "203.0.113.77");
        expect(third.status).toBe(429); // refused before the password is even looked at
        expect(Number(third.retryAfter)).toBeGreaterThan(0);
        expect((await approve(pages[3], PASSWORD, "approve", pages[3].cookie, "203.0.113.78")).status).toBe(302);
      });
    } finally {
      await s.close();
    }
  });

  it("keeps a bounded number of open sign-in requests", async () => {
    const s = await start(undefined, { maxPending: 2 });
    try {
      await withServer(s, async () => {
        const { body: client } = await register();
        const [p1, p2, p3] = [await openLogin(client.client_id, pkce().challenge), await openLogin(client.client_id, pkce().challenge), await openLogin(client.client_id, pkce().challenge)];
        expect((await approve(p1, PASSWORD)).status).toBe(400); // the oldest was dropped
        expect((await approve(p2, PASSWORD)).status).toBe(302);
        expect((await approve(p3, PASSWORD)).status).toBe(302);
      });
    } finally {
      await s.close();
    }
  });

  it("answers 500 (not 401) while the sign-in file can't be read, and never overwrites it", async () => {
    const dir = writeHome();
    const s = await start(undefined, {}, dir);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withServer(s, async () => {
        const { tokens } = await connect();
        expect(await probe(tokens.access_token)).toBe(400);
        const file = path.join(dir, "http-auth.json");
        const good = fs.readFileSync(file);
        fs.writeFileSync(file, '{"v":1,"alg":');
        expect(await probe(tokens.access_token)).toBe(500); // fails closed, but is not a sign-out
        expect((await register()).status).toBe(500);
        expect(fs.readFileSync(file, "utf8")).toBe('{"v":1,"alg":');
        fs.writeFileSync(file, good);
        expect(await probe(tokens.access_token)).toBe(400);
      });
    } finally {
      quiet.mockRestore();
      await s.close();
    }
  });

  it("evicts never-used clients when the registration cap is reached", async () => {
    const dir = writeHome();
    const capped = await start(undefined, { maxClients: 3, clientEvictMinAgeMs: 0 }, dir);
    try {
      await withServer(capped, async () => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) ids.push((await register()).body.client_id);
        const fourth = await register();
        expect(fourth.status).toBe(201);
        expect(storeFor(dir).clientCount()).toBe(3);
        expect(storeFor(dir).getClient(ids[0])).toBeUndefined(); // the oldest unused one made room
        // Once every client has signed in, nothing is evictable and the cap holds.
        for (const id of [ids[1], ids[2], fourth.body.client_id]) {
          const c = storeFor(dir).getClient(id)!;
          await signIn(c as { client_id: string; client_secret?: string });
        }
        const fifth = await register();
        expect(fifth.status).toBe(400);
        expect(fifth.body.error).toBe("invalid_client_metadata");
      });
    } finally {
      await capped.close();
    }
  });

  it("shares one mail registry across sessions", async () => {
    const a = await connect();
    const c1 = mcpClient(a.tokens.access_token);
    const c2 = mcpClient(a.tokens.access_token);
    await c1.client.connect(c1.transport);
    await c2.client.connect(c2.transport);
    const ctxs = [...srv.sessions.values()].map((s) => s.ctx);
    expect(ctxs.length).toBeGreaterThanOrEqual(2);
    for (const ctx of ctxs) expect(ctx.mail).toBe(srv.mail);
    await c1.client.close();
    await c2.client.close();
  });
});

const secretsFor = (dir: string) => new AccountManager(dir).secrets;
const testClient = (id: string) => ({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: [CLAUDE_CB] }) as never;

/** Replace fs.renameSync (as seen by src/, too) for the duration of fn. */
function withRenameHook<T>(hook: (from: fs.PathLike, to: fs.PathLike) => void, fn: () => T): T {
  const real = fsCjs.renameSync;
  fsCjs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    hook(from, to);
    return real(from, to);
  }) as typeof fsCjs.renameSync;
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fsCjs.renameSync = real;
    syncBuiltinESMExports();
  }
}

describe("client registration limits", () => {
  it("refuses registration bodies over 8 kB and keeps only the metadata the server uses", async () => {
    const dir = writeHome();
    const s = await start(undefined, {}, dir);
    try {
      await withServer(s, async () => {
        const huge = await registerRaw({ client_name: "A".repeat(95_000), redirect_uris: [CLAUDE_CB] });
        expect(huge.status).toBe(413);
        expect(huge.body.error).toBe("invalid_client_metadata");
        expect(storeFor(dir).clientCount()).toBe(0);
        expect((await registerRaw("{not json")).status).toBe(400);

        const r = await registerRaw({
          client_name: "  Evil‮App\n" + "x".repeat(300),
          redirect_uris: [CLAUDE_CB],
          token_endpoint_auth_method: "client_secret_post",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          logo_uri: `https://evil.example/${"l".repeat(1500)}`,
          contacts: Array.from({ length: 20 }, (_, i) => `a${i}@evil.example`),
          jwks: { keys: [{ kty: "RSA", n: "n".repeat(1500) }] },
          software_statement: "s".repeat(800),
          extra_field: "e".repeat(300),
        });
        expect(r.status).toBe(201);
        expect(String(r.body.client_name)).toHaveLength(REGISTRATION_LIMITS.nameChars);
        expect(r.body.client_name).toMatch(/^Evil App x+$/); // control and bidi characters replaced
        for (const k of ["logo_uri", "contacts", "jwks", "software_statement", "extra_field"]) expect(r.body).not.toHaveProperty(k);
        const stored = storeFor(dir).getClient(r.body.client_id)!;
        expect(Object.keys(stored).sort()).toEqual([
          "client_id",
          "client_id_issued_at",
          "client_name",
          "client_secret",
          "client_secret_expires_at",
          "grant_types",
          "redirect_uris",
          "response_types",
          "token_endpoint_auth_method",
        ]);
        expect((await signIn(r.body)).access_token).toMatch(/^gmm_at_/); // the trimmed client works
      });
    } finally {
      await s.close();
    }
  });

  it("accepts at most 5 redirect URIs of at most 500 characters, all allowed, and caps the stored size", async () => {
    const dir = writeHome();
    const s = await start(undefined, { allowedRedirects: ["https://app.example.com/cb/*"], allowLoopbackRedirects: false }, dir);
    try {
      await withServer(s, async () => {
        const uri = (len: number, tag = "p") => {
          const prefix = "https://app.example.com/cb/";
          return prefix + tag.repeat(len - prefix.length);
        };
        const reg = (uris: string[], name = "App") => registerRaw({ client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none" });
        expect((await reg([uri(40, "a"), uri(40, "b"), uri(40, "c"), uri(40, "d"), uri(40, "e")])).status).toBe(201);
        const six = await reg(Array.from({ length: 6 }, (_, i) => uri(40, String(i))));
        expect(six.status).toBe(400);
        expect(six.body.error_description).toMatch(/1 to 5 URIs/);
        expect((await reg([uri(501)])).status).toBe(400);
        const foreign = await reg([uri(40), "https://evil.example/cb"]);
        expect(foreign.status).toBe(400);
        expect(foreign.body.error_description).toMatch(/not allowed/);
        // The largest registration accepted stays small, so 500 clients stay around 2 MB.
        const max = await reg(["a", "b", "c", "d", "e"].map((t) => uri(REGISTRATION_LIMITS.redirectUriChars, t)), "N".repeat(500));
        expect(max.status).toBe(201);
        const size = Buffer.byteLength(JSON.stringify(storeFor(dir).getClient(max.body.client_id)));
        expect(size).toBeLessThanOrEqual(REGISTRATION_LIMITS.storedBytes);
      });
    } finally {
      await s.close();
    }
  });

  it("sanitizes registration metadata (unit) and groups networks per IPv4 address / IPv6 /48", () => {
    expect(sanitizeClientMetadata(null)).toHaveProperty("error");
    expect(sanitizeClientMetadata([CLAUDE_CB])).toHaveProperty("error");
    expect(sanitizeClientMetadata({ redirect_uris: [] })).toHaveProperty("error");
    expect(sanitizeClientMetadata({ redirect_uris: [CLAUDE_CB], client_name: 5 })).toHaveProperty("error");
    expect(sanitizeClientMetadata({ redirect_uris: [CLAUDE_CB], grant_types: Array(6).fill("x") })).toHaveProperty("error");
    expect(sanitizeClientMetadata({ redirect_uris: [CLAUDE_CB], scope: "s".repeat(300) })).toHaveProperty("error");
    expect(sanitizeClientMetadata({ redirect_uris: [CLAUDE_CB], client_name: "\u0000⁦ ", logo_uri: "https://x.example" })).toEqual({ metadata: { redirect_uris: [CLAUDE_CB] } });
    expect(networkKey("2001:db8:1:2::1")).toBe(networkKey("2001:db8:1:ff00:1::9"));
    expect(networkKey("2001:db8:1:2::1")).not.toBe(networkKey("2001:db8:2:2::1"));
    expect(networkKey("203.0.113.1")).toBe("203.0.113.1");
    expect(networkKey("::ffff:203.0.113.1")).toBe("203.0.113.1");
  });

  it("rate-limits registration per IPv4 address / IPv6 /48, not per /56 or /64", async () => {
    const s = await start(undefined, { registerRateLimit: { windowMs: 60_000, max: 2 } });
    try {
      await withServer(s, async () => {
        const reg = (ip: string) => register(undefined, undefined, ip);
        expect((await reg("2001:db8:7:100::1")).status).toBe(201);
        expect((await reg("2001:db8:7:ff00::1")).status).toBe(201); // another /56 (and /64) of the same /48
        const third = await reg("2001:db8:7:abcd::9");
        expect(third.status).toBe(429);
        expect(third.body.error).toBe("too_many_requests");
        expect((await reg("2001:db8:8::1")).status).toBe(201); // another /48
        expect((await reg("203.0.113.50")).status).toBe(201);
        expect((await reg("203.0.113.50")).status).toBe(201);
        expect((await reg("203.0.113.50")).status).toBe(429);
        expect((await reg("203.0.113.51")).status).toBe(201);
      });
    } finally {
      await s.close();
    }
  });

  it("admits clients per network: each network keeps only a few never-used ones, the network with the most goes first, they expire", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = storeFor(writeHome());
      const o = { maxClients: 6, maxUnusedPerNetwork: 3, unusedGraceMs: 15 * 60_000, unusedTtlMs: 3600_000, inactiveMs: 90 * DAY };
      const add = (id: string, network: string, keep?: Set<string>) => {
        vi.setSystemTime(Date.now() + 1000);
        return s.addClient(testClient(id), { ...o, network, keep });
      };
      const ids = () => s.listClients().map((c) => c.client_id).sort();
      const A = networkKey("2001:db8:a:1::1");
      expect(add("owner", "198.51.100.1")).toBe(true);
      // One network (any /64 of a /48): a 4th never-used registration drops that network's oldest, nobody else's.
      for (const [i, id] of ["a1", "a2", "a3", "a4"].entries()) expect(add(id, networkKey(`2001:db8:a:${i}::1`))).toBe(true);
      expect(ids()).toEqual(["a2", "a3", "a4", "owner"]);
      expect(add("b1", "203.0.113.2")).toBe(true);
      expect(add("b2", "203.0.113.2")).toBe(true);
      // Full: the network with the most never-used clients loses its oldest, even inside the grace period.
      expect(add("c1", "203.0.113.3")).toBe(true);
      expect(ids()).toEqual(["a3", "a4", "b1", "b2", "c1", "owner"]);
      expect(add("c2", "203.0.113.4")).toBe(true); // A and B both have 2: A's a3 is older
      expect(add("c3", "203.0.113.5")).toBe(true); // then B
      expect(ids()).toEqual(["a4", "b2", "c1", "c2", "c3", "owner"]);
      expect(s.unusedByNetwork().get(A)).toBe(1);
      // Every network is down to its newest never-used client, all within the grace period: refused, nothing dropped.
      expect(add("c4", "203.0.113.6")).toBe(false);
      expect(ids()).toEqual(["a4", "b2", "c1", "c2", "c3", "owner"]);
      // The owner completes the sign-in: a client that obtained a token is no longer "never used".
      s.issue({ clientId: "owner", scopes: [], resource: "https://x/mcp" }, { accessMs: 60_000, refreshMs: 60_000 });
      // After the grace period the oldest never-used client goes.
      vi.setSystemTime(Date.now() + 16 * 60_000);
      expect(add("c4", "203.0.113.6")).toBe(true);
      expect(ids()).toEqual(["b2", "c1", "c2", "c3", "c4", "owner"]);
      // Never-used clients expire after an hour (unless mid sign-in); used ones don't.
      vi.setSystemTime(Date.now() + 61 * 60_000);
      expect(add("d1", "203.0.113.7", new Set(["c3"]))).toBe(true);
      expect(ids()).toEqual(["c3", "d1", "owner"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't let one network fill the client slots, or churn push out the owner's fresh client", async () => {
    const dir = writeHome();
    const s = await start(undefined, { maxClients: 20 }, dir); // default: 10 never-used per network, 15 min grace
    try {
      await withServer(s, async () => {
        // One /48 registers 40 clients from different /56s and /64s: it keeps only its newest 10.
        for (let i = 0; i < 40; i++) expect((await register(undefined, undefined, `2001:db8:9:${(i * 256).toString(16)}::1`)).status).toBe(201);
        expect(storeFor(dir).clientCount()).toBe(10);
        expect(storeFor(dir).unusedByNetwork().get(networkKey("2001:db8:9::1"))).toBe(10); // the registering network was recorded
        const { body: owner } = await register(undefined, undefined, "198.51.100.5");
        const ownerPage = await openLogin(owner.client_id, pkce().challenge, {}, "198.51.100.5");
        // Churn from many addresses: at the cap the /48's older registrations make room; the owner's fresh
        // client (its network's newest, in its grace period) is never the one to go.
        const statuses: number[] = [];
        for (let i = 0; i < 20; i++) statuses.push((await register(undefined, undefined, `203.0.113.${i + 1}`)).status);
        expect(statuses.filter((x) => x === 201)).toHaveLength(18);
        expect(statuses.filter((x) => x === 400)).toHaveLength(2); // every network is down to one fresh client
        expect(storeFor(dir).clientCount()).toBe(20);
        expect(storeFor(dir).getClient(owner.client_id)).toBeTruthy();
        expect((await approve(ownerPage, PASSWORD, "approve", ownerPage.cookie, "198.51.100.5")).status).toBe(302);
      });
    } finally {
      await s.close();
    }
  });
});

describe("sign-in file lock", () => {
  it("holds off http-logout while a save is between its check and its rename, then applies it in full", () => {
    const dir = writeHome();
    const server = new AuthStore(dir, secretsFor(dir), { lockWaitMs: 150 });
    server.putClient(testClient("attacker"));
    const stolen = server.issue({ clientId: "attacker", scopes: [], resource: "r" }, { accessMs: 3600_000, refreshMs: DAY });
    let during: unknown = "not run";
    // The server rotates a refresh token; http-logout from another process runs while the file is being written.
    const rotated = withRenameHook(
      (from) => {
        if (during !== "not run" || !String(from).endsWith(".tmp")) return;
        try {
          during = new AuthStore(dir, secretsFor(dir), { lockWaitMs: 150 }).revokeAll(false);
        } catch (err) {
          during = err;
        }
      },
      () => server.takeRefresh(stolen.refresh, 0)
    );
    // It could not write in between: it waited for the lock and gave up, changing nothing (the CLI then says to retry;
    // a real second process simply waits until the server's save is done).
    expect(during).toBeInstanceOf(AuthStoreError);
    expect((during as Error).message).toMatch(/being changed by another process/);
    expect(rotated).toMatchObject({ clientId: "attacker" });
    const fresh = server.issue({ clientId: "attacker", scopes: [], resource: "r", family: stolen.family }, { accessMs: 3600_000, refreshMs: DAY });
    expect(new AuthStore(dir, secretsFor(dir)).revokeAll(false).tokens).toBe(3);
    for (const st of [server, storeFor(dir)]) {
      expect(st.getAccess(stolen.access)).toBeUndefined();
      expect(st.getAccess(fresh.access)).toBeUndefined();
      expect(st.stats()).toMatchObject({ accessTokens: 0, refreshTokens: 0 });
    }
    expect(fs.existsSync(server.lockFile)).toBe(false);
  });

  it("waits for a lock held by another thread/process, then saves", async () => {
    const dir = writeHome();
    const store = new AuthStore(dir, secretsFor(dir));
    store.putClient(testClient("c1"));
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const fs = require("node:fs");
       fs.writeFileSync(workerData.lock, "another process\\n", { flag: "wx" });
       setTimeout(() => fs.unlinkSync(workerData.lock), workerData.holdMs);
       parentPort.postMessage("locked");`,
      { eval: true, workerData: { lock: store.lockFile, holdMs: 400 } }
    );
    try {
      await new Promise((resolve) => worker.once("message", resolve));
      const started = Date.now();
      store.putClient(testClient("c2")); // blocks until the other side lets go
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(250);
      expect(waited).toBeLessThan(2000);
    } finally {
      await worker.terminate();
    }
    expect(storeFor(dir).clientCount()).toBe(2);
    expect(fs.existsSync(store.lockFile)).toBe(false);
  });

  it("gives up without changes while the lock stays held, and takes over a stale lock", () => {
    const dir = writeHome();
    const store = new AuthStore(dir, secretsFor(dir), { lockWaitMs: 100 });
    store.putClient(testClient("c1"));
    const t = store.issue({ clientId: "c1", scopes: [], resource: "r" }, { accessMs: 60_000, refreshMs: 60_000 });
    const before = fs.readFileSync(store.file);
    fs.writeFileSync(store.lockFile, "4242 live\n");
    const started = Date.now();
    expect(() => store.putClient(testClient("c2"))).toThrow(AuthStoreError);
    expect(() => new AuthStore(dir, secretsFor(dir), { lockWaitMs: 100 }).revokeAll(false)).toThrow(/being changed by another process/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
    expect(fs.readFileSync(store.file).equals(before)).toBe(true);
    expect(fs.readFileSync(store.lockFile, "utf8")).toBe("4242 live\n"); // not ours: left alone
    expect(store.getClient("c2")).toBeUndefined();
    expect(store.getAccess(t.access)).toBeTruthy(); // reading needs no lock
    // A lock left behind by a crashed process (older than 10 s) is taken over.
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(store.lockFile, old, old);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      store.putClient(testClient("c2"));
      expect(quiet.mock.calls.flat().join(" ")).toMatch(/stale lock file/);
    } finally {
      quiet.mockRestore();
    }
    expect(storeFor(dir).clientCount()).toBe(2);
    expect(fs.existsSync(store.lockFile)).toBe(false);
  });

  it("never removes a lock that another process took over meanwhile", () => {
    const dir = writeHome();
    const store = new AuthStore(dir, secretsFor(dir));
    withRenameHook(
      () => fs.writeFileSync(store.lockFile, "5151 took it over\n"), // we were slow; someone decided our lock was stale
      () => store.putClient(testClient("c1"))
    );
    expect(fs.readFileSync(store.lockFile, "utf8")).toBe("5151 took it over\n");
    fs.unlinkSync(store.lockFile);
    expect(storeFor(dir).getClient("c1")).toBeTruthy();
  });
});

describe("owner sign-in under attack", () => {
  it("answers requests from a locked network at once, without a place in the line or its minimum time", async () => {
    const s = await start(undefined, { attemptMinMs: 300, limiter: new LoginLimiter({ maxPerKey: 1 }) });
    try {
      await withServer(s, async () => {
        const { body: client } = await register();
        const open = () => openLogin(client.client_id, pkce().challenge);
        // Two parallel guesses from one address: the first locks it; the second, already in line, takes no 300 ms.
        const [a, b] = [await open(), await open()];
        const t0 = Date.now();
        const rs = await Promise.all([a, b].map((pg) => approve(pg, "wrong password!!", "approve", pg.cookie, "203.0.113.20")));
        expect(rs.map((r) => r.status).sort()).toEqual([401, 429]);
        expect(Date.now() - t0).toBeLessThan(550); // one check (it was 2 x 300 ms)
        // Locked: a burst is answered at once and never enters the line.
        const pages = await Promise.all(Array.from({ length: 15 }, open));
        const t1 = Date.now();
        const locked = await Promise.all(pages.map((pg) => approve(pg, PASSWORD, "approve", pg.cookie, "203.0.113.20")));
        expect(locked.every((r) => r.status === 429 && r.text.includes("Too many wrong passwords"))).toBe(true);
        expect(Date.now() - t1).toBeLessThan(1500); // 15 x 300 ms if they had queued
        expect(s.provider.attempts.length).toBe(0);
        const own = await open();
        expect((await approve(own, PASSWORD, "approve", own.cookie, "198.51.100.200")).status).toBe(302);
      });
    } finally {
      await s.close();
    }
  });

  it("gives one address 2 places in the line (and an IPv6 /48 4), so one attacker can't keep the owner out", async () => {
    const s = await start(undefined, { attemptMinMs: 400, attemptQueueMax: 20 }); // production timings
    try {
      await withServer(s, async () => {
        const { body: atk } = await register();
        const { body: owner } = await register();
        const pages = await Promise.all(Array.from({ length: 20 }, () => openLogin(atk.client_id, pkce().challenge)));
        const ownerPage = await openLogin(owner.client_id, pkce().challenge, {}, "198.51.100.66");
        const t0 = Date.now();
        const flood = Promise.all(pages.map((pg, i) => approve(pg, `guess ${i}!!`, "approve", pg.cookie, "203.0.113.66")));
        await new Promise((r) => setTimeout(r, 50));
        const r = await approve(ownerPage, PASSWORD, "approve", ownerPage.cookie, "198.51.100.66");
        expect(r.status).toBe(302); // not "server busy"
        expect(Date.now() - t0).toBeLessThan(2500);
        const fr = await flood;
        expect(fr.filter((x) => x.status === 401)).toHaveLength(2);
        expect(fr.filter((x) => x.status === 429 && x.text.includes("busy"))).toHaveLength(18);

        // IPv6: 2 places per /64 and 4 per /48.
        const v6 = await Promise.all(Array.from({ length: 9 }, () => openLogin(atk.client_id, pkce().challenge)));
        const ips = ["2001:db8:44:1::1", "2001:db8:44:1::2", "2001:db8:44:1::3", "2001:db8:44:2::1", "2001:db8:44:3::1", "2001:db8:44:4::1", "2001:db8:44:5::1", "2001:db8:44:6::1"];
        const res = await Promise.all(ips.map((ip, i) => approve(v6[i], "wrong password!!", "approve", v6[i].cookie, ip)));
        expect(res.map((x) => x.status)).toEqual([401, 401, 429, 401, 401, 429, 429, 429]);
        expect((await approve(v6[8], PASSWORD, "approve", v6[8].cookie, "2001:db8:45::1")).status).toBe(302);
      });
    } finally {
      await s.close();
    }
  });

  it("doesn't count 'server busy' answers against the per-network limit on the password form", async () => {
    const s = await start(undefined, { attemptMinMs: 600, attemptQueueMax: 1, approveRateLimit: { windowMs: 60_000, max: 2 } });
    try {
      await withServer(s, async () => {
        const { body: client } = await register();
        const atk = await openLogin(client.client_id, pkce().challenge);
        const own = await openLogin(client.client_id, pkce().challenge);
        const holding = approve(atk, "wrong password!!", "approve", atk.cookie, "203.0.113.90"); // takes the only place
        await new Promise((r) => setTimeout(r, 100));
        for (let i = 0; i < 3; i++) {
          const busy = await approve(own, PASSWORD, "approve", own.cookie, "198.51.100.90");
          expect(busy.status).toBe(429);
          expect(busy.text).toContain("busy");
        }
        await holding;
        // The 4th request from this address with a limit of 2: the busy answers were not counted.
        expect((await approve(own, PASSWORD, "approve", own.cookie, "198.51.100.90")).status).toBe(302);
        // Real attempts still count.
        const more = [await openLogin(client.client_id, pkce().challenge), await openLogin(client.client_id, pkce().challenge)];
        expect((await approve(more[0], "wrong password!!", "approve", more[0].cookie, "198.51.100.90")).status).toBe(401);
        expect((await approve(more[1], PASSWORD, "approve", more[1].cookie, "198.51.100.90")).status).toBe(429);
      });
    } finally {
      await s.close();
    }
  });

  it("caps open sign-in requests per network, so no network can push out the owner's", async () => {
    const s = await start(undefined, { maxPending: 8, maxPendingPerNetwork: 3 });
    try {
      await withServer(s, async () => {
        const { body: client } = await register();
        const own = await openLogin(client.client_id, pkce().challenge, {}, "198.51.100.7");
        // One IPv6 /48 opens many requests from different /64s: it keeps only its newest 3.
        const atk = [];
        for (let i = 0; i < 12; i++) atk.push(await openLogin(client.client_id, pkce().challenge, {}, `2001:db8:5:${i.toString(16)}::1`));
        expect(s.provider.pendingCount(networkKey("2001:db8:5::1"))).toBe(3);
        expect((await approve(atk[0], PASSWORD)).status).toBe(400); // its oldest were dropped
        expect((await approve(atk[11], PASSWORD)).status).toBe(302);
        // Many networks: at the server-wide cap, the networks with the most open requests lose their oldest.
        for (let n = 1; n <= 4; n++) for (let i = 0; i < 3; i++) await openLogin(client.client_id, pkce().challenge, {}, `203.0.113.${n}`);
        expect(s.provider.pendingCount()).toBe(8);
        expect(s.provider.pendingCount("198.51.100.7")).toBe(1);
        expect((await approve(own, PASSWORD, "approve", own.cookie, "198.51.100.7")).status).toBe(302);
      });
    } finally {
      await s.close();
    }
  });

  it("rate-limits /authorize per IPv6 /48 as well as per /64", async () => {
    const s = await start(undefined, { authorizeRateLimit: { windowMs: 60_000, max: 3, maxPerPrefix: 5 } });
    try {
      await withServer(s, async () => {
        const { body: client } = await register();
        const open = (ip: string) => openLogin(client.client_id, pkce().challenge, {}, ip);
        for (let i = 0; i < 5; i++) expect((await open(`2001:db8:66:${i}::1`)).status).toBe(200);
        const limited = await open("2001:db8:66:99::1"); // a fresh /64 of the same /48
        expect(limited.status).toBe(429);
        expect(Number(limited.retryAfter)).toBeGreaterThan(0);
        expect((await open("2001:db8:67::1")).status).toBe(200);
        for (let i = 0; i < 3; i++) expect((await open("192.0.2.9")).status).toBe(200);
        expect((await open("192.0.2.9")).status).toBe(429);
        expect((await open("192.0.2.10")).status).toBe(200);
      });
    } finally {
      await s.close();
    }
  });

  it("logs sign-ins with the client address the server sees", async () => {
    const lines: string[] = [];
    const s = await start(undefined, { log: (l) => lines.push(l), limiter: new LoginLimiter({ maxPerKey: 2 }) });
    try {
      await withServer(s, async () => {
        const { body: client } = await register();
        for (let i = 0; i < 2; i++) {
          const pg = await openLogin(client.client_id, pkce().challenge);
          expect((await approve(pg, "wrong password!!", "approve", pg.cookie, "203.0.113.30")).status).toBe(401);
        }
        const pg = await openLogin(client.client_id, pkce().challenge);
        expect((await approve(pg, PASSWORD, "approve", pg.cookie, "2001:db8:31:1::5")).status).toBe(302);
        expect(lines).toEqual([
          "sign-in: wrong password from 203.0.113.30",
          "sign-in: wrong password from 203.0.113.30; 203.0.113.30 is locked for 5 min",
          'sign-in: approved from 2001:db8:31:1::5 for client "Claude"',
        ]);
      });
    } finally {
      await s.close();
    }
  });
});
