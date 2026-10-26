import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { simpleParser } from "mailparser";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountConfig, AccountManager } from "../src/accounts.js";
import { buildMime } from "../src/mime.js";
import { buildCriteria, parseGmailQuery, tokenize } from "../src/providers/imap-query.js";
import { decodeId, encodeId, ensureHeaders, ImapProvider, stripBcc } from "../src/providers/imap.js";
import { MailRegistry } from "../src/providers/registry.js";
import { startFakeGmail } from "./fake-gmail.js";
import { FAKE_IMAP, FakeMailServers, startFakeMailServers } from "./fake-imap.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (p = "gmm-imap-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe("Gmail query -> IMAP search", () => {
  const now = new Date("2026-10-26T12:00:00Z");

  it("tokenizes operators, quotes, negation and OR", () => {
    expect(tokenize('from:"Γιάννα Π" -subject:x OR "big deal" in:sent')).toEqual([
      { neg: false, op: "from", value: "Γιάννα Π" },
      { neg: true, op: "subject", value: "x" },
      { neg: false, value: "OR", or: true },
      { neg: false, op: undefined, value: "big deal" },
      { neg: false, op: "in", value: "sent" },
    ]);
  });

  it("maps common operators", () => {
    const q = parseGmailQuery("from:a@b.com is:unread has:attachment after:2026/10/01 in:sent label:Clients/Kentia larger:2m category:promotions", now);
    expect(q.criteria).toEqual({ from: "a@b.com", seen: false, since: new Date(Date.UTC(2026, 9, 1)), larger: 2 * 1024 * 1024 });
    expect(q.hasAttachment).toBe(true);
    expect(q.roles).toEqual(["sent"]);
    expect(q.folders).toEqual(["Clients/Kentia"]);
    expect(q.ignored).toEqual(["category:promotions"]);
  });

  it("keeps hour precision for newer_than and nests repeated keys", () => {
    const q = parseGmailQuery("newer_than:2d invoice τιμολόγιο -from:x@y -from:z@w", now);
    expect(q.notBefore?.toISOString()).toBe("2026-10-24T12:00:00.000Z");
    expect(q.criteria).toEqual({
      since: new Date(Date.UTC(2026, 9, 24)),
      text: "invoice",
      not: { from: "x@y" },
      or: [{ text: "τιμολόγιο", not: { from: "z@w" } }],
    });
  });

  it("builds OR groups and handles empty queries", () => {
    expect(parseGmailQuery("from:a OR from:b OR subject:c", now).criteria).toEqual({ or: [{ from: "a" }, { from: "b" }, { subject: "c" }] });
    expect(parseGmailQuery("", now).criteria).toEqual({ all: true });
    expect(parseGmailQuery("in:anywhere", now).anywhere).toBe(true);
    expect(buildCriteria([["from", "a"], ["from", "b"], ["from", "c"]])).toEqual({ from: "a", or: [{ from: "b", or: [{ from: "c" }] }] });
    // both "or" and "not" already used at this level: wrap, and AND the rest through a double NOT
    expect(buildCriteria([["or", [1]], ["not", 2], ["or", [3]]])).toEqual({ or: [{ or: [1], not: 2 }], not: { not: { or: [3] } } });
  });

  it("encodes ids and headers", () => {
    expect(decodeId(encodeId("Clients/Κεντία:x", 42))).toEqual({ path: "Clients/Κεντία:x", uid: 42 });
    expect(decodeId("18c3f0a9b2d4e5f6")).toBeUndefined();
    const { raw, messageId } = ensureHeaders("From: a@psdgator.com\r\nSubject: x\r\n\r\nbody", "a@psdgator.com");
    expect(messageId).toMatch(/^<.+@psdgator\.com>$/);
    expect(raw).toMatch(/^Date: .+\r\nMessage-ID: <.+>\r\nFrom:/);
    expect(stripBcc("To: a@b\r\nBcc: secret@x,\r\n other@y\r\nSubject: s\r\n\r\nBcc: stays in body")).toBe("To: a@b\r\nSubject: s\r\n\r\nBcc: stays in body");
  });
});

describe("ImapProvider against a real IMAP + SMTP server", () => {
  let servers: FakeMailServers;
  let accounts: AccountManager;
  let acc: AccountConfig;
  let p: ImapProvider;

  beforeEach(async () => {
    servers = await startFakeMailServers();
    accounts = new AccountManager(tmp());
    acc = accounts.addAccount("hetzner", "antony@psdgator.com", undefined, {
      type: "imap",
      imap: { host: "127.0.0.1", port: servers.imapPort, secure: false, user: FAKE_IMAP.user, allowInsecureTls: true },
      smtp: { host: "127.0.0.1", port: servers.smtpPort, secure: false, user: FAKE_IMAP.user, allowInsecureTls: true },
      displayName: "Antony",
      signature: "Antony\npsdgator.com",
    });
    accounts.saveCredentials("hetzner", { password: FAKE_IMAP.pass });
    p = new MailRegistry(accounts).get(acc) as ImapProvider;
    return async () => {
      await p.close();
      await servers.close();
    };
  });

  const subjects = (r: { messages: { subject: string }[] }) => r.messages.map((m) => m.subject);

  it("searches newest-first with Gmail syntax and decodes Greek", async () => {
    expect(subjects(await p.search({ query: "", max: 10 }))).toEqual(["note to self", "Weekly deals", "Προσφορά βιτρίνας", "Ερώτηση για τιμολόγιο", "Old thing"]);
    expect(subjects(await p.search({ query: "is:unread", max: 10 }))).toEqual(["Weekly deals", "Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "from:gianna@kentia.example", max: 10 }))).toEqual(["Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "has:attachment", max: 10 }))).toEqual(["Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "newer_than:2d", max: 10 }))).toEqual(["note to self", "Weekly deals", "Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "-from:shop.example newer_than:2d", max: 10 }))).toEqual(["note to self", "Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "from:bob@client.example OR from:carol@x.example", max: 10 }))).toEqual(["Ερώτηση για τιμολόγιο", "Old thing"]);
    expect(subjects(await p.search({ query: '"Big savings"', max: 10 }))).toEqual(["Weekly deals"]);
    expect(subjects(await p.search({ query: "big savings week", max: 10 }))).toEqual(["Weekly deals"]); // repeated TEXT keys nest correctly
    expect(subjects(await p.search({ query: "big -savings", max: 10 }))).toEqual([]);
    expect(subjects(await p.search({ query: "-from:shop.example -from:gianna -from:carol in:inbox", max: 10 }))).toEqual(["note to self", "Ερώτηση για τιμολόγιο"]);
    expect(subjects(await p.search({ query: "in:sent", max: 10 }))).toEqual(["Re: Ερώτηση για τιμολόγιο"]);

    const page1 = await p.search({ query: "", max: 2 });
    expect(page1.next).toBe("2");
    expect(page1.estimate).toBe(5);
    expect(subjects(await p.search({ query: "", max: 2, pageToken: page1.next }))).toEqual(["Προσφορά βιτρίνας", "Ερώτηση για τιμολόγιο"]);

    const k = (await p.search({ query: "from:gianna", max: 1, headers: ["List-Unsubscribe"] })).messages[0];
    expect(k).toMatchObject({ account: "hetzner", from: "Γιάννα <gianna@kentia.example>", cc: "boss@kentia.example", unread: true, rfcMessageId: "<k1@kentia.example>", labels: ["INBOX"] });
    const n = (await p.search({ query: "from:shop.example", max: 1, headers: ["List-Unsubscribe"] })).messages[0];
    expect(n.headers?.["list-unsubscribe"]).toContain("https://shop.example/unsub");
  });

  it("reads status, messages, attachments and threads", async () => {
    expect(await p.inboxStatus()).toEqual({ unread: 2, total: 5 });
    const k = (await p.search({ query: "from:gianna", max: 1 })).messages[0];
    const full = await p.getMessage(k.id, {});
    expect(full.body).toBe("Καλημέρα");
    expect(full.bodyFormat).toBe("html-converted");
    expect(full.attachments).toEqual([{ partId: "1", filename: "κάτοψη.pdf", mimeType: "application/pdf", size: 24, inline: false }]);
    const att = await p.getAttachment(k.id, {});
    expect(att.data.toString()).toBe("%PDF-1.4 fake floor plan");
    await expect(p.getAttachment(k.id, { filename: "nope.pdf" })).rejects.toThrow(/Available: κάτοψη.pdf \(partId 1\)/);

    const bob = (await p.search({ query: "from:bob@client.example", max: 1 })).messages[0];
    const thread = await p.getThread(bob.threadId, {});
    expect(thread.map((m) => m.labels[0])).toEqual(["INBOX", "Sent"]);
    const h = await p.getOriginalHeaders(bob.id);
    expect(h).toMatchObject({ from: "Bob <bob@client.example>", subject: "Ερώτηση για τιμολόγιο", rfcMessageId: "<b1@client.example>", threadId: bob.threadId });

    await expect(p.getMessage("18c3f0a9b2d4e5f6", {})).rejects.toThrow(/^Not found in "hetzner"/);
    await expect(p.getMessage(encodeId("INBOX", 999), {})).rejects.toThrow(/^Not found in "hetzner"/);
  });

  it("saves, lists and deletes drafts in the Drafts folder", async () => {
    const raw = buildMime({ from: "Antony <antony@psdgator.com>", to: ["bob@client.example"], subject: "Πρόχειρο", text: "γεια" });
    const d = await p.saveDraft(raw);
    expect(d.draftId).toMatch(/^Drafts:\d+$/);
    const list = await p.listDrafts(10);
    expect(list.map((x) => x.subject)).toEqual(["Πρόχειρο"]);
    const msg = await p.getMessage(d.draftId, {});
    expect(msg.rfcMessageId).toMatch(/@psdgator\.com>$/);
    await p.deleteDraft(d.draftId);
    expect(await p.listDrafts(10)).toEqual([]);
  });

  it("marks, stars, archives, copies to folders and trashes", async () => {
    const all = (await p.search({ query: "", max: 10 })).messages;
    const news = all.find((m) => m.subject === "Weekly deals")!;
    const old = all.find((m) => m.subject === "Old thing")!;
    const kentia = all.find((m) => m.subject === "Προσφορά βιτρίνας")!;

    await p.modify([news.id], { markRead: true, star: true });
    const news2 = (await p.search({ query: "from:shop.example", max: 1 })).messages[0];
    expect(news2).toMatchObject({ unread: false, starred: true });

    const r = await p.modify([old.id], { archive: true });
    expect(r.removed).toEqual(["INBOX"]);
    expect(subjects(await p.search({ query: "in:archive", max: 5 }))).toEqual(["Old thing"]);
    expect(subjects(await p.search({ query: "", max: 10 }))).not.toContain("Old thing");

    const label = await p.createLabel("Clients/Kentia");
    expect(label.name).toBe("Clients/Kentia");
    await p.modify([kentia.id], { addLabels: ["clients/kentia"] });
    expect(subjects(await p.search({ query: 'label:"Clients/Kentia"', max: 5 }))).toEqual(["Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "from:gianna", max: 5 }))).toEqual(["Προσφορά βιτρίνας"]); // copy, still in INBOX

    expect((await p.listLabels()).map((l) => `${l.name}:${l.type}`)).toEqual(
      expect.arrayContaining(["INBOX:system", "Sent:system", "Archive:system", "Clients:user", "Clients/Kentia:user"])
    );
    await expect(p.modify([news.id], { addLabels: ["Nope"] })).rejects.toThrow(/does not exist/);

    expect(await p.trash([news.id])).toBe(1);
    expect(subjects(await p.search({ query: "in:trash", max: 5 }))).toEqual(["Weekly deals"]);
  });

  it("finds conversations waiting for a reply", async () => {
    const r = await p.needsReply({ days: 14, max: 10, olderThanHours: 0, skipAutomated: true });
    expect(r.items.map((i) => i.subject)).toEqual(["Προσφορά βιτρίνας"]);
    expect(r.items[0]).toMatchObject({ account: "hetzner", from: "Γιάννα <gianna@kentia.example>", unread: true, youRepliedEarlier: false, hasDraft: false });
    expect(r.items[0].waitingHours).toBeGreaterThanOrEqual(29);
    expect(r.skippedAutomated).toBe(1);
    const strict = await p.needsReply({ days: 14, max: 10, olderThanHours: 48, skipAutomated: true });
    expect(strict.items).toEqual([]);
    const all = await p.needsReply({ days: 14, max: 10, olderThanHours: 0, skipAutomated: false });
    expect(all.items.map((i) => i.subject)).toEqual(["Προσφορά βιτρίνας", "Weekly deals"]);

    // A draft reply is reported.
    const h = await p.getOriginalHeaders(r.items[0].lastMessageId);
    await p.saveDraft(buildMime({ to: ["gianna@kentia.example"], subject: "Re: x", text: "...", inReplyTo: h.rfcMessageId, references: h.rfcMessageId }));
    const withDraft = await p.needsReply({ days: 14, max: 10, olderThanHours: 0, skipAutomated: true });
    expect(withDraft.items[0].hasDraft).toBe(true);
  });

  it("sends through SMTP without leaking Bcc, and keeps a copy in Sent", async () => {
    const raw = buildMime({
      from: "Antony <antony@psdgator.com>",
      to: ["Bob <bob@client.example>"],
      bcc: ["secret@psdgator.com"],
      subject: "Τιμολόγιο",
      text: "Επισυνάπτεται.",
    });
    const r = await p.send(raw);
    expect(servers.sent).toHaveLength(1);
    expect(servers.sent[0].from).toBe("antony@psdgator.com");
    expect(servers.sent[0].to.sort()).toEqual(["bob@client.example", "secret@psdgator.com"]);
    expect(servers.sent[0].data).not.toMatch(/^bcc:/im);
    const parsed = await simpleParser(servers.sent[0].data);
    expect(parsed.subject).toBe("Τιμολόγιο");
    expect(parsed.messageId).toMatch(/@psdgator\.com>$/);
    expect(r.messageId).toMatch(/^Sent:\d+$/);
    expect(subjects(await p.search({ query: "in:sent", max: 5 }))).toContain("Τιμολόγιο");

    // sendDraft: sends and removes the draft
    const d = await p.saveDraft(buildMime({ from: "antony@psdgator.com", to: ["carol@x.example"], subject: "From draft", text: "x" }));
    await p.sendDraft(d.draftId);
    expect(servers.sent.map((s) => s.to[0])).toContain("carol@x.example");
    expect(await p.listDrafts(5)).toEqual([]);
  });

  it("explains login failures and missing SMTP clearly", async () => {
    const bad = new ImapProvider(acc, "wrong");
    const err = await bad.inboxStatus().then(
      () => undefined,
      (e) => bad.explain(e)
    );
    expect(err?.message).toMatch(/IMAP login failed for "hetzner".*add-imap hetzner/);
    await bad.close();
    const noSmtp = new ImapProvider({ ...acc, smtp: undefined }, FAKE_IMAP.pass);
    expect(noSmtp.capabilities.send).toBe(false);
    await expect(noSmtp.send("To: a@b\r\n\r\nx")).rejects.toThrow(/Sending needs SMTP settings/);
    await noSmtp.close();
  });

  it("reconnects after the connection drops", async () => {
    await p.inboxStatus();
    // @ts-expect-error reach into the private client to simulate a dropped socket
    p.client?.close();
    expect(await p.inboxStatus()).toEqual({ unread: 2, total: 5 });
  });
});

describe("MCP server with a Gmail and an IMAP account", () => {
  let servers: FakeMailServers;
  let fake: Awaited<ReturnType<typeof startFakeGmail>>;
  let home: string;
  let client: Client;

  beforeAll(async () => {
    servers = await startFakeMailServers();
    fake = await startFakeGmail();
    home = tmp("gmm-imap-e2e-");
    fs.writeFileSync(path.join(home, "oauth-keys.json"), JSON.stringify({ installed: { client_id: "cid", client_secret: "secret" } }));
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        accounts: [
          { alias: "urbanstickers", email: "urbanstickersgr@gmail.com" },
          {
            alias: "hetzner",
            email: "antony@psdgator.com",
            type: "imap",
            imap: { host: "127.0.0.1", port: servers.imapPort, secure: false, user: FAKE_IMAP.user, allowInsecureTls: true },
            displayName: "Antony",
          },
        ],
        defaultAccount: "urbanstickers",
      })
    );
    for (const [alias, cred] of [
      ["urbanstickers", { access_token: "tok-urban", refresh_token: "r", expiry_date: Date.now() + 3600_000 }],
      ["hetzner", { password: FAKE_IMAP.pass }],
    ] as const) {
      fs.mkdirSync(path.join(home, "accounts", alias), { recursive: true });
      fs.writeFileSync(path.join(home, "accounts", alias, "credentials.json"), JSON.stringify(cred));
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "dist", "index.js"), "--mode", "drafts"],
      env: { ...process.env, GMAIL_MCP_HOME: home, GMAIL_MCP_API_ROOT: fake.url, GMAIL_MCP_MASTER_KEY: "b".repeat(64), GMAIL_MCP_KEYRING: "0" } as Record<string, string>,
      stderr: "pipe",
    });
    client = new Client({ name: "imap-e2e", version: "1.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    await fake.close();
    await servers.close();
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    if (res.isError) return { error: res.content[0].text };
    return JSON.parse(res.content[0].text);
  }

  it("lists both accounts and stores the IMAP password encrypted", async () => {
    const r = await call("list_accounts");
    expect(r.accounts.map((a: { alias: string; type: string; signedIn: boolean }) => `${a.alias}:${a.type}:${a.signedIn}`)).toEqual(["urbanstickers:gmail:true", "hetzner:imap:true"]);
    const onDisk = fs.readFileSync(path.join(home, "accounts", "hetzner", "credentials.json"), "utf8");
    expect(onDisk).not.toContain(FAKE_IMAP.pass);
    expect(JSON.parse(onDisk).alg).toBe("A256GCM");
  });

  it("searches Gmail and IMAP together", async () => {
    const r = await call("search_emails", { query: "" });
    expect(r.searched.map((s: { account: string }) => s.account)).toEqual(["urbanstickers", "hetzner"]);
    const accountsSeen = new Set(r.results.map((m: { account: string }) => m.account));
    expect([...accountsSeen].sort()).toEqual(["hetzner", "urbanstickers"]);
    const dates = r.results.map((m: { date: string }) => m.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(r.errors).toBeUndefined();
  });

  it("summarizes both inboxes", async () => {
    const r = await call("inbox_summary", { latest: 2 });
    const h = r.accounts.find((a: { account: string }) => a.account === "hetzner");
    expect(h).toMatchObject({ type: "imap", inboxUnread: 2, inboxTotal: 5 });
    expect(h.latest.map((m: { subject: string }) => m.subject)).toEqual(["Weekly deals", "Προσφορά βιτρίνας"]);
  });

  it("reads an IMAP message without being told the account, and drafts a reply", async () => {
    const s = await call("search_emails", { query: "from:gianna", account: "hetzner" });
    const id = s.results[0].id;
    const msg = await call("read_email", { messageId: id });
    expect(msg).toMatchObject({ account: "hetzner", body: "Καλημέρα" });
    const d = await call("create_draft", { account: "hetzner", replyToMessageId: id, replyAll: true, body: "Καλημέρα Γιάννα!" });
    expect(d).toMatchObject({ status: "draft_saved_not_sent", account: "hetzner", subject: "Re: Προσφορά βιτρίνας", to: ["Γιάννα <gianna@kentia.example>"], cc: ["boss@kentia.example"] });
    expect(d.draftId).toMatch(/^Drafts:\d+$/);
    const drafts = await call("list_drafts", { account: "hetzner" });
    expect(drafts.accounts[0].drafts[0].subject).toBe("Re: Προσφορά βιτρίνας");
  });

  it("skips IMAP accounts for Gmail-only tools with a clear message", async () => {
    const f = await call("list_filters");
    expect(f.accounts.map((a: { account: string }) => a.account)).toEqual(["urbanstickers"]);
  });
});

describe("add-imap CLI", () => {
  let servers: FakeMailServers;
  beforeAll(async () => {
    servers = await startFakeMailServers();
  });
  afterAll(async () => {
    await servers.close();
  });

  async function cli(args: string[], env: Record<string, string>) {
    const { spawn } = await import("node:child_process");
    return new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js"), ...args], {
        env: { ...process.env, GMAIL_MCP_KEYRING: "0", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
    });
  }

  it("verifies the login before saving, stores the password encrypted, and rejects bad passwords", async () => {
    const home = tmp("gmm-cli-");
    const base = ["add-imap", "hetzner", "antony@psdgator.com", "--host", "127.0.0.1", "--port", String(servers.imapPort), "--starttls", "--user", "testuser", "--smtp-host", "127.0.0.1", "--smtp-port", String(servers.smtpPort), "--name", "Antony", "--allow-insecure-tls"];

    const bad = await cli(base, { GMAIL_MCP_HOME: home, GMAIL_MCP_IMAP_PASSWORD: "wrong" });
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/Login rejected/);
    expect(fs.existsSync(path.join(home, "accounts", "hetzner", "credentials.json"))).toBe(false);

    const ok = await cli(base, { GMAIL_MCP_HOME: home, GMAIL_MCP_IMAP_PASSWORD: FAKE_IMAP.pass });
    expect(ok.out).toMatch(/Checking IMAP login .* ok \(INBOX: 2 unread \/ 5\)/);
    expect(ok.out).toMatch(/Checking SMTP login .* ok/);
    expect(ok.out).toMatch(/Connected antony@psdgator.com as "hetzner" \(IMAP/);
    expect(ok.code).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    expect(cfg.accounts[0]).toMatchObject({
      alias: "hetzner",
      type: "imap",
      displayName: "Antony",
      imap: { host: "127.0.0.1", port: servers.imapPort, secure: false, user: "testuser", allowInsecureTls: true },
      smtp: { host: "127.0.0.1", port: servers.smtpPort, secure: false },
    });
    const cred = fs.readFileSync(path.join(home, "accounts", "hetzner", "credentials.json"), "utf8");
    expect(cred).not.toContain(FAKE_IMAP.pass);

    const list = await cli(["accounts"], { GMAIL_MCP_HOME: home });
    expect(list.out).toMatch(/hetzner\s+antony@psdgator\.com\s+imap\s+signed in/);
    const doctor = await cli(["doctor"], { GMAIL_MCP_HOME: home });
    expect(doctor.out).toMatch(/OK\s+hetzner\s+imap\s+antony@psdgator\.com \(inbox: 2 unread \/ 5\)/);
  });

  it("asks for the host with a Hetzner hint", async () => {
    const r = await cli(["add-imap", "x", "a@psdgator.com"], { GMAIL_MCP_HOME: tmp("gmm-cli-"), GMAIL_MCP_IMAP_PASSWORD: "p" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Hetzner: --host mail\.your-server\.de/);
  });
});
