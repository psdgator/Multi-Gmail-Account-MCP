import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountManager } from "../src/accounts.js";
import { AuditLog, redact } from "../src/audit.js";
import { GmailProvider, gmailApiFor } from "../src/providers/gmail.js";
import { looksAutomated } from "../src/providers/types.js";
import { SecretStore } from "../src/secrets.js";
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
    expect(looksAutomated("Γιάννα <gianna@kentia.example>", { "auto-submitted": "no" })).toBe(false);
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
    expect(r.messages.length).toBe(2);
    expect(fake.faults.get("GET /messages")).toBe(0);

    fake.faults.set("POST /messages/send", 1);
    const before = fake.requests.filter((x) => x.endsWith("/messages/send")).length;
    await expect(p.send("To: a@b.com\r\nSubject: x\r\n\r\nhi")).rejects.toBeTruthy();
    expect(fake.requests.filter((x) => x.endsWith("/messages/send")).length - before).toBe(1);
  });
});
