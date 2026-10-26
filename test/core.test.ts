import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountManager } from "../src/accounts.js";
import { AuditLog, redact } from "../src/audit.js";
import { GmailProvider, gmailApiFor } from "../src/providers/gmail.js";
import { looksAutomated } from "../src/providers/types.js";
import { SecretStore } from "../src/secrets.js";
import { READ_ONLY_TOOLS } from "../src/audit.js";
import { createServer } from "../src/server.js";
import { parseWhen } from "../src/tools/calendar.js";
import { mergeAndDedupe } from "../src/tools/common.js";
import { startFakeGmail } from "./fake-gmail.js";

const tmp = (p = "gmm-core-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe("secret store", () => {
  it("encrypts with AES-256-GCM, decrypts, and migrates plain-text files", () => {
    const root = tmp();
    const s = new SecretStore(root);
    const file = path.join(root, "accounts", "a", "credentials.json");
    s.write(file, { refresh_token: "secret-refresh", n: 1 });
    const onDisk = fs.readFileSync(file, "utf8");
    expect(onDisk).not.toContain("secret-refresh");
    expect(JSON.parse(onDisk)).toMatchObject({ v: 1, alg: "A256GCM" });
    expect(s.read(file)).toEqual({ refresh_token: "secret-refresh", n: 1 });
    expect(s.source).toBe("file"); // keychain disabled in tests
    if (process.platform !== "win32") expect(fs.statSync(path.join(root, "master.key")).mode & 0o777).toBe(0o600);

    const legacy = path.join(root, "legacy.json");
    fs.writeFileSync(legacy, JSON.stringify({ access_token: "plain" }));
    expect(s.read(legacy)).toEqual({ access_token: "plain" });
    expect(s.migrate(legacy)).toBe(true);
    expect(fs.readFileSync(legacy, "utf8")).not.toContain("plain");
    expect(s.migrate(legacy)).toBe(false);
  });

  it("uses GMAIL_MCP_MASTER_KEY when set and fails clearly with the wrong key", () => {
    const root = tmp();
    const file = path.join(root, "c.json");
    process.env.GMAIL_MCP_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const s = new SecretStore(root);
      s.write(file, { x: 1 });
      expect(s.source).toBe("env");
      expect(fs.existsSync(path.join(root, "master.key"))).toBe(false);
      process.env.GMAIL_MCP_MASTER_KEY = Buffer.alloc(32, 8).toString("base64");
      expect(() => new SecretStore(root).read(file)).toThrow(/Could not decrypt/);
    } finally {
      delete process.env.GMAIL_MCP_MASTER_KEY;
    }
  });

  it("account manager stores credentials encrypted and migrates old ones", () => {
    const root = tmp();
    const m = new AccountManager(root);
    m.addAccount("a", "a@x.com");
    fs.writeFileSync(m.getCredentialsPath("a"), JSON.stringify({ refresh_token: "old" }));
    expect(m.migrateCredentials()).toEqual(["a"]);
    expect(fs.readFileSync(m.getCredentialsPath("a"), "utf8")).not.toContain("old");
    expect(m.loadCredentials("a")).toEqual({ refresh_token: "old" });
  });
});

describe("audit log", () => {
  it("records calls without bodies or secrets and reads newest first with filters", () => {
    const root = tmp();
    const log = new AuditLog(root);
    log.record({ tool: "search_emails", mode: "drafts", accounts: ["work"], args: redact({ query: "is:unread" }), ok: true, ms: 5 });
    log.record({
      tool: "create_draft",
      mode: "drafts",
      accounts: ["home"],
      args: redact({ to: ["a@b.com"], subject: "Hi", body: "very private text", password: "pw", attachments: ["C:/x.pdf"] }),
      ok: true,
      ms: 9,
    });
    log.record({ tool: "create_draft", mode: "drafts", accounts: ["work"], args: redact({ to: "x@y" }), ok: false, error: "boom", ms: 1 });
    const raw = fs.readFileSync(log.file, "utf8");
    expect(raw).not.toContain("very private text");
    expect(raw).not.toContain('"pw"');
    expect(raw).toContain('"body":"[17 chars]"');
    const all = log.read();
    expect(all.map((e) => e.tool)).toEqual(["create_draft", "create_draft", "search_emails"]);
    expect(log.read({ account: "home" })).toHaveLength(1);
    expect(log.read({ tool: "search_emails" })).toHaveLength(1);
    expect(log.read({ limit: 1 })[0].error).toBe("boom");
  });

  it("can be turned off", () => {
    process.env.GMAIL_MCP_AUDIT = "off";
    try {
      const log = new AuditLog(tmp());
      log.record({ tool: "x", mode: "drafts", ok: true, ms: 1 });
      expect(fs.existsSync(log.file)).toBe(false);
    } finally {
      delete process.env.GMAIL_MCP_AUDIT;
    }
  });
});

describe("cross-account merge", () => {
  it("sorts newest first and folds copies of the same Message-ID", () => {
    const out = mergeAndDedupe([
      { account: "a", date: "2026-10-01T10:00:00Z", rfcMessageId: "<1@x>" },
      { account: "b", date: "2026-10-02T10:00:00Z", rfcMessageId: "<2@x>" },
      { account: "b", date: "2026-10-01T10:00:00Z", rfcMessageId: "<1@X>" },
      { account: "a", date: "2026-09-01T10:00:00Z" },
    ]);
    expect(out.map((m) => `${m.account}:${m.rfcMessageId ?? "-"}`)).toEqual(["b:<2@x>", "a:<1@x>", "a:-"]);
    expect(out[1].alsoIn).toEqual(["b"]);
  });
});

describe("automated-mail heuristic", () => {
  it("flags newsletters and robots but not people", () => {
    expect(looksAutomated("no-reply@accounts.google.com", {})).toBe(true);
    expect(looksAutomated("Shop <news@shop.gr>", { "list-unsubscribe": "<mailto:u@shop.gr>" })).toBe(true);
    expect(looksAutomated("x@y.com", { "auto-submitted": "auto-replied" })).toBe(true);
    expect(looksAutomated("Μαρία <maria@acme.example>", { "auto-submitted": "no" })).toBe(false);
    expect(looksAutomated('"Acs eΤιμολόγια" <e-bill@courier.example>', {})).toBe(true);
    expect(looksAutomated("Shop <billing@shop.example>", {})).toBe(true);
    expect(looksAutomated("Bob <bob.billington@client.example>", {})).toBe(false);
    expect(looksAutomated("Newsroom Editor <editor@paper.example>", {})).toBe(false);
  });
});

describe("retries", () => {
  let fake: Awaited<ReturnType<typeof startFakeGmail>>;
  beforeAll(async () => {
    fake = await startFakeGmail();
    process.env.GMAIL_MCP_API_ROOT = fake.url;
  });
  afterAll(async () => {
    delete process.env.GMAIL_MCP_API_ROOT;
    await fake.close();
  });

  it("retries transient Gmail errors on reads, never on sends", async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "oauth-keys.json"), JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }));
    const m = new AccountManager(root);
    const acc = m.addAccount("urbanstickers", "urbanstickersgr@gmail.com");
    m.saveCredentials("urbanstickers", { access_token: "tok-urban", refresh_token: "r", expiry_date: Date.now() + 3600_000 });
    const p = new GmailProvider(acc, gmailApiFor(m, acc));

    fake.faults.set("GET /messages", 2);
    const r = await p.search({ query: "", max: 5 });
    expect(r.messages.length).toBe(5);
    expect(fake.faults.get("GET /messages")).toBe(0);

    fake.faults.set("POST /messages/send", 1);
    const before = fake.requests.filter((x) => x.endsWith("/messages/send")).length;
    await expect(p.send("To: a@b.com\r\nSubject: x\r\n\r\nhi")).rejects.toBeTruthy();
    expect(fake.requests.filter((x) => x.endsWith("/messages/send")).length - before).toBe(1);
  });
});

describe("review fixes", () => {
  it("never creates a new key over existing encrypted logins", () => {
    const root = tmp();
    const file = path.join(root, "accounts", "a", "credentials.json");
    process.env.GMAIL_MCP_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
    try {
      new SecretStore(root).write(file, { refresh_token: "r" });
    } finally {
      delete process.env.GMAIL_MCP_MASTER_KEY;
    }
    expect(() => new SecretStore(root).read(file)).toThrow(/Not creating a new key/);
    expect(fs.existsSync(path.join(root, "master.key"))).toBe(false);
  });

  it("an existing key file wins and envelopes carry a key fingerprint", () => {
    const root = tmp();
    const s1 = new SecretStore(root);
    const f = path.join(root, "x.json");
    s1.write(f, { a: 1 });
    expect(JSON.parse(fs.readFileSync(f, "utf8")).kid).toMatch(/^[0-9a-f]{8}$/);
    expect(new SecretStore(root).read(f)).toEqual({ a: 1 });
  });

  it("parses local times in the configured time zone, not the process one", () => {
    expect(parseWhen("2026-10-27T09:00", "Europe/Athens", new Date()).toISOString()).toBe("2026-10-27T07:00:00.000Z");
    expect(parseWhen("2026-07-01 09:30", "Europe/Athens", new Date()).toISOString()).toBe("2026-07-01T06:30:00.000Z");
  });

  it("the static read-only list matches the tools' annotations", () => {
    const root = tmp();
    const { server } = createServer("full", { accounts: new AccountManager(root) });
    const tools = (server as unknown as { _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }> })._registeredTools;
    for (const [name, t] of Object.entries(tools)) expect(READ_ONLY_TOOLS.has(name)).toBe(Boolean(t.annotations?.readOnlyHint));
  });

  it("calendar tools appear when an account gains calendar access", () => {
    const root = tmp();
    const m = new AccountManager(root);
    m.addAccount("a", "a@x.com");
    const { server, ctx } = createServer("drafts", { accounts: m });
    const tools = (server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })._registeredTools;
    expect(tools.list_events.enabled).toBe(false);
    m.updateAccount("a", { calendar: true });
    for (const cb of ctx.onAccountsChanged) cb();
    expect(tools.list_events.enabled).toBe(true);
    expect(tools.find_free_time.enabled).toBe(true);
  });
});

describe("gmail pagination", () => {
  let fake2: Awaited<ReturnType<typeof startFakeGmail>>;
  beforeAll(async () => {
    fake2 = await startFakeGmail();
    process.env.GMAIL_MCP_API_ROOT = fake2.url;
    const box = fake2.boxes["tok-psd"];
    for (let i = 0; i < 620; i++) box.messages.push({ id: `bulk${i}`, threadId: `tb${i}`, internalDate: String(Date.now() - i * 1000), labelIds: ["INBOX"], snippet: "", payload: { headers: [{ name: "From", value: "bulk@x.example" }] } });
  });
  afterAll(async () => {
    delete process.env.GMAIL_MCP_API_ROOT;
    await fake2.close();
  });

  it("pages through more than 500 ids", async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "oauth-keys.json"), JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }));
    const m = new AccountManager(root);
    const acc = m.addAccount("psd", "antony@psdgator.com");
    m.saveCredentials("psd", { access_token: "tok-psd", refresh_token: "r", expiry_date: Date.now() + 3600_000 });
    const p = new GmailProvider(acc, gmailApiFor(m, acc));
    const r = await p.search({ query: "from:bulk@x.example", max: 600, idsOnly: true });
    expect(r.messages).toHaveLength(600);
    expect(new Set(r.messages.map((x) => x.id)).size).toBe(600);
  });
});
