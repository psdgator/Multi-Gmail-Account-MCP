import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountManager } from "../src/accounts.js";
import { LoginLimiter, passwordMatches } from "../src/http/oauth-provider.js";
import { buildHttpApp, parsePublicUrl, RunningHttpServer, startHttpServer } from "../src/http/server.js";
import { startFakeGmail } from "./fake-gmail.js";

const PASSWORD = "correct horse battery staple";
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

async function start(port?: number): Promise<RunningHttpServer> {
  const p = port ?? (await freePort());
  return startHttpServer({
    mode: "drafts",
    publicUrl: `http://127.0.0.1:${p}`,
    port: p,
    host: "127.0.0.1",
    password: PASSWORD,
    accounts: new AccountManager(home),
    disableRateLimits: true,
  });
}

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

async function register(redirect = CLAUDE_CB, method = "client_secret_post") {
  const r = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  return { status: r.status, body: (await r.json()) as { client_id: string; client_secret?: string; error?: string } };
}

async function openLogin(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256", state: "st-123", resource: mcpUrl, ...extra });
  const r = await fetch(`${base}/authorize?${q}`, { redirect: "manual" });
  const html = await r.text();
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return {
    status: r.status,
    html,
    cookie,
    location: r.headers.get("location"),
    csp: r.headers.get("content-security-policy"),
    request: html.match(/name="request" value="([^"]+)"/)?.[1] ?? "",
    csrf: html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "",
  };
}

async function approve(page: { request: string; csrf: string; cookie: string }, password: string, action = "approve", cookie = page.cookie) {
  const r = await fetch(`${base}/oauth/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ request: page.request, csrf: page.csrf, password, action }).toString(),
  });
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
}

async function token(params: Record<string, string>) {
  const r = await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

/** Full happy path: register -> password -> code -> tokens. */
async function connect() {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();
  const page = await openLogin(client.client_id, challenge);
  const ok = await approve(page, PASSWORD);
  const code = new URL(ok.location!).searchParams.get("code")!;
  const t = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_CB, client_id: client.client_id, client_secret: client.client_secret!, resource: mcpUrl });
  return { client, tokens: t.body };
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
    const l = new LoginLimiter(3, 10);
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

    const ok = await approve(page, PASSWORD);
    expect(ok.status).toBe(302);
    const loc = new URL(ok.location!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE_CB);
    expect(loc.searchParams.get("state")).toBe("st-123");
    const code = loc.searchParams.get("code")!;
    expect(code.length).toBeGreaterThan(40);

    expect((await approve(page, PASSWORD)).status).toBe(400); // pending request is single-use

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

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    const { client, tokens } = await connect();
    const creds = { client_id: client.client_id, client_secret: client.client_secret! };
    const r1 = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, ...creds });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(tokens.refresh_token);
    const reuse = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, ...creds });
    expect(reuse.body.error).toBe("invalid_grant");
    const r2 = await token({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, ...creds });
    expect(r2.body.error).toBe("invalid_grant"); // whole family revoked
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
