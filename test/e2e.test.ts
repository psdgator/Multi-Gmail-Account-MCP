import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { simpleParser } from "mailparser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeGmail } from "./fake-gmail.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "index.js");

const TEST_KEY = "a".repeat(64);
let fake: Awaited<ReturnType<typeof startFakeGmail>>;
let home: string;

function writeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-e2e-"));
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
  const far = Date.now() + 3600_000;
  for (const [alias, tok] of [["urbanstickers", "tok-urban"], ["psdgator", "tok-psd"]]) {
    fs.mkdirSync(path.join(dir, "accounts", alias), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "accounts", alias, "credentials.json"),
      JSON.stringify({ access_token: tok, refresh_token: "r", expiry_date: far, token_type: "Bearer" })
    );
  }
  return dir;
}

async function connect(mode: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "--mode", mode],
    env: { ...process.env, GMAIL_MCP_HOME: home, GMAIL_MCP_API_ROOT: fake.url, GMAIL_MCP_NO_BROWSER: "1", GMAIL_MCP_MASTER_KEY: TEST_KEY, GMAIL_MCP_ALLOWED_DIRS: os.tmpdir() } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = res.content[0]?.text ?? "";
  if (res.isError) return { error: text };
  return JSON.parse(text);
}

beforeAll(async () => {
  fake = await startFakeGmail();
  home = writeHome();
});
afterAll(async () => {
  await fake.close();
});

describe("tool exposure per mode", () => {
  it.each([
    ["readonly", ["search_emails", "read_email", "inbox_summary"], ["create_draft", "modify_emails", "send_email"]],
    ["drafts", ["create_draft", "modify_emails", "create_label"], ["send_email", "send_draft", "trash_emails", "create_filter"]],
    ["full", ["send_email", "send_draft", "trash_emails", "create_filter"], []],
  ])("%s mode", async (mode, present, absent) => {
    const client = await connect(mode);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of present) expect(names).toContain(n);
    for (const n of absent) expect(names).not.toContain(n);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("urbanstickers: urbanstickersgr@gmail.com (default)");
    await client.close();
  });
});

describe("multi-account behaviour (drafts mode)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect("drafts");
  });
  afterAll(async () => {
    await client.close();
  });

  it("lists accounts", async () => {
    const r = await call(client, "list_accounts");
    expect(r.serverMode).toBe("drafts");
    expect(r.accounts.map((a: { alias: string }) => a.alias)).toEqual(["urbanstickers", "psdgator"]);
    expect(r.accounts.every((a: { signedIn: boolean }) => a.signedIn)).toBe(true);
  });

  it("searches every account at once, newest first, tagged by account", async () => {
    const r = await call(client, "search_emails", { query: "is:unread" });
    expect(r.searched.map((s: { account: string }) => s.account)).toEqual(["urbanstickers", "psdgator"]);
    expect(r.results.map((m: { account: string; id: string }) => `${m.account}:${m.id}`)).toEqual(["urbanstickers:u1", "urbanstickers:n1", "psdgator:p1"]);
    expect(r.results[0].labels).toContain("Πελάτες");
    expect(r.results[2].snippet).toBe("Invoice & contract");
  });

  it("searches a single account by alias or email", async () => {
    const a = await call(client, "search_emails", { query: "", account: "psdgator" });
    expect(a.results.map((m: { id: string }) => m.id)).toEqual(["p1"]);
    const b = await call(client, "search_emails", { query: "in:inbox", account: ["urbanstickersgr@gmail.com"] });
    expect(b.results.every((m: { account: string }) => m.account === "urbanstickers")).toBe(true);
    expect(b.results.map((m: { id: string }) => m.id)).toEqual(["u1", "n1", "n2", "r1a", "u2"]);
  });

  it("reports a broken account without failing the others", async () => {
    const credPath = path.join(home, "accounts", "psdgator", "credentials.json");
    const good = fs.readFileSync(credPath, "utf8");
    expect(JSON.parse(good).alg).toBe("A256GCM"); // stored encrypted after startup migration
    fs.writeFileSync(credPath, JSON.stringify({ access_token: "revoked", refresh_token: "r", expiry_date: Date.now() + 3600_000 }));
    try {
      const r = await call(client, "search_emails", { query: "" });
      expect(r.results.every((m: { account: string }) => m.account === "urbanstickers")).toBe(true);
      expect(r.errors[0].account).toBe("psdgator");
    } finally {
      fs.writeFileSync(credPath, good);
    }
  });

  it("summarizes all inboxes", async () => {
    const r = await call(client, "inbox_summary");
    expect(r.totalUnread).toBe(3);
    expect(r.accounts.map((a: { account: string; inboxUnread: number }) => [a.account, a.inboxUnread])).toEqual([
      ["urbanstickers", 2],
      ["psdgator", 1],
    ]);
  });

  it("reads an email with a Greek ISO-8859-7 HTML body, even without the account", async () => {
    const r = await call(client, "read_email", { messageId: "p1" }); // default is urbanstickers; must fall through to psdgator
    expect(r.account).toBe("psdgator");
    expect(r.body).toBe("Please find the invoice.");
    const g = await call(client, "read_email", { messageId: "u1", account: "urbanstickers" });
    expect(g.body).toBe("Καλημέρα");
    expect(g.bodyFormat).toBe("html-converted");
    expect(g.attachments[0]).toMatchObject({ filename: "κάτοψη.pdf", partId: "1" });
    const strict = await call(client, "read_email", { messageId: "p1", account: "urbanstickers" });
    expect(strict.error).toMatch(/Not found in "urbanstickers"/);
  });

  it("saves an attachment to disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-dl-"));
    const r = await call(client, "save_attachment", { messageId: "u1", account: "urbanstickers", directory: dir });
    expect(r.filename).toBe("κάτοψη.pdf");
    expect(fs.readFileSync(r.savedTo, "utf8")).toBe("%PDF-1.4 fake invoice");
    const again = await call(client, "save_attachment", { messageId: "u1", account: "urbanstickers", directory: dir });
    expect(again.filename).toBe("κάτοψη (1).pdf");
  });

  it("creates a threaded reply-all draft with signature, and never sends", async () => {
    const r = await call(client, "create_draft", {
      account: "urbanstickers",
      replyToMessageId: "u1",
      replyAll: true,
      body: "Καλημέρα Μαρία,\nσας στέλνω την προσφορά.",
    });
    expect(r.status).toBe("draft_saved_not_sent");
    expect(r.threadId).toBe("tu1");
    expect(r.to).toEqual(["Μαρία <maria@acme.example>"]);
    expect(r.cc).toEqual(["boss@acme.example"]);
    expect(r.subject).toBe("Re: Προσφορά βιτρίνας");
    const raw = Buffer.from(fake.boxes["tok-urban"].drafts[0].message.raw!, "base64url").toString("utf8");
    const parsed = await simpleParser(raw);
    expect(parsed.inReplyTo).toBe("<orig-u1@mail.example>");
    expect(parsed.subject).toBe("Re: Προσφορά βιτρίνας");
    expect(parsed.from?.text).toContain("UrbanStickers");
    expect(parsed.text).toContain("Καλημέρα Μαρία");
    expect(parsed.text).toContain("urbanstickers.gr");
    expect(parsed.html).toContain("gmail_signature");
    expect(fake.requests.some((x) => x.includes("/messages/send"))).toBe(false);
  });

  it("refuses unknown send-as addresses", async () => {
    const r = await call(client, "create_draft", { account: "psdgator", to: "x@y.com", body: "hi", from: "ceo@other.com" });
    expect(r.error).toMatch(/not a send-as address/);
  });

  it("marks read and labels by name", async () => {
    const r = await call(client, "modify_emails", { account: "urbanstickers", messageIds: ["u2"], markUnread: true, addLabels: ["πελάτες"] });
    expect(r.added.sort()).toEqual(["Label_1", "UNREAD"]);
    expect(fake.boxes["tok-urban"].messages[1].labelIds).toContain("Label_1");
    const bad = await call(client, "modify_emails", { account: "urbanstickers", messageIds: ["u2"], addLabels: ["Nope"] });
    expect(bad.error).toMatch(/does not exist/);
  });

  it("rejects 'all' for single-account actions and unknown accounts", async () => {
    expect((await call(client, "create_draft", { account: "all", to: "a@b.com", body: "x" })).error).toMatch(/one account/);
    expect((await call(client, "search_emails", { query: "", account: "gmail" })).error).toMatch(/Unknown account "gmail"/);
  });
});

describe("per-account limits", () => {
  it("a readonly-limited account cannot get drafts even in drafts mode", async () => {
    const cfgPath = path.join(home, "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.accounts[1].mode = "readonly";
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const client = await connect("drafts");
    const r = await call(client, "create_draft", { account: "psdgator", to: "a@b.com", body: "x" });
    expect(r.error).toMatch(/limited to readonly/);
    const ok = await call(client, "search_emails", { query: "", account: "psdgator" });
    expect(ok.results).toHaveLength(1);
    await client.close();
    delete cfg.accounts[1].mode;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  });
});
