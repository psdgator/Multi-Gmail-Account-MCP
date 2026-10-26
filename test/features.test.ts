import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { simpleParser } from "mailparser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fold, parseListUnsubscribe, _test } from "../src/tools/cleanup.js";
import { parseWhen, zonedTime } from "../src/tools/calendar.js";
import { startFakeGmail } from "./fake-gmail.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "index.js");
const KEY = "b".repeat(64);

let fake: Awaited<ReturnType<typeof startFakeGmail>>;
let home: string;

function writeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-feat-"));
  fs.writeFileSync(path.join(dir, "oauth-keys.json"), JSON.stringify({ installed: { client_id: "cid", client_secret: "secret" } }));
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      accounts: [
        { alias: "urbanstickers", email: "urbanstickersgr@gmail.com", calendar: true },
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

async function connect(mode: string): Promise<Client> {
  const client = new Client({ name: "features", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, "--mode", mode],
      env: { ...process.env, GMAIL_MCP_HOME: home, GMAIL_MCP_API_ROOT: fake.url, GMAIL_MCP_MASTER_KEY: KEY, GMAIL_MCP_TIMEZONE: "Europe/Athens" } as Record<string, string>,
      stderr: "pipe",
    })
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = res.content[0]?.text ?? "";
  return res.isError ? { error: text } : JSON.parse(text);
}

beforeAll(async () => {
  fake = await startFakeGmail();
  home = writeHome();
  const now = Date.now();
  fake.boxes["tok-urban"].calendar!.events.primary.push(
    { id: "e1", summary: "Μάστορας για βιτρίνα Acme", start: { dateTime: new Date(now + 3600_000).toISOString() }, end: { dateTime: new Date(now + 2 * 3600_000).toISOString() }, location: "Θεσσαλονίκη" },
    { id: "e2", summary: "Next week thing", start: { dateTime: new Date(now + 9 * 86_400_000).toISOString() }, end: { dateTime: new Date(now + 9 * 86_400_000 + 3600_000).toISOString() } }
  );
});
afterAll(async () => {
  await fake.close();
});

describe("pure helpers", () => {
  it("parses List-Unsubscribe and one-click", () => {
    expect(parseListUnsubscribe("<mailto:u@x.gr?subject=unsub>, <https://x.gr/u?id=1>", "List-Unsubscribe=One-Click")).toEqual({
      mailto: "mailto:u@x.gr?subject=unsub",
      https: "https://x.gr/u?id=1",
      oneClick: true,
    });
    expect(parseListUnsubscribe("<http://insecure.example/u>").https).toBeUndefined();
    expect(parseListUnsubscribe(undefined).oneClick).toBe(false);
  });
  it("blocks private addresses for unsubscribe POSTs", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "172.20.0.1", "169.254.1.1", "::1", "fd00::1", "::ffff:192.168.0.1"]) expect(_test.isPrivateIp(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "2a01:4f8::1"]) expect(_test.isPrivateIp(ip)).toBe(false);
  });
  it("folds Greek accents for name matching", () => {
    expect(fold("Μαρία")).toBe(fold("ΜΑΡΙΑ"));
    expect(fold("Παπαδόπουλος")).toBe("παπαδοπουλοσ");
    expect(fold("Νίκος")).toBe("νικοσ");
  });
  it("handles time zones for calendar dates", () => {
    expect(zonedTime(2026, 10, 27, 9, 0, "Europe/Athens").toISOString()).toBe("2026-10-27T07:00:00.000Z"); // winter time UTC+2
    expect(zonedTime(2026, 7, 1, 9, 0, "Europe/Athens").toISOString()).toBe("2026-07-01T06:00:00.000Z"); // summer time UTC+3
    expect(parseWhen("2026-12-24", "Europe/Athens", new Date()).toISOString()).toBe("2026-12-23T22:00:00.000Z");
    expect(() => parseWhen("someday", "UTC", new Date())).toThrow(/Could not understand/);
  });
});

describe("drafts mode features", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect("drafts");
  });
  afterAll(async () => {
    await client.close();
  });

  it("offers prompts and the new tools (calendar because an account has it)", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["needs_reply", "daily_digest", "find_newsletters", "bulk_cleanup", "find_contact", "forward_email", "view_audit_log", "list_events", "find_free_time"]) expect(names).toContain(n);
    for (const n of ["unsubscribe", "create_event", "send_email"]) expect(names).not.toContain(n);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(["morning-digest", "reply-queue"]));
    const p = await client.getPrompt({ name: "morning-digest", arguments: { language: "Greek" } });
    expect((p.messages[0].content as { text: string }).text).toContain("daily_digest");
    expect((p.messages[0].content as { text: string }).text).toContain("Greek");
  });

  it("needs_reply finds unanswered personal mail across accounts, skipping newsletters and answered threads", async () => {
    const r = await call(client, "needs_reply");
    const keys = r.items.map((i: { account: string; threadId: string }) => `${i.account}:${i.threadId}`);
    expect(keys).toEqual(expect.arrayContaining(["urbanstickers:tu1", "urbanstickers:tu2", "psdgator:tp1"]));
    expect(keys).not.toContain("urbanstickers:tr1"); // we replied last
    expect(keys).not.toContain("urbanstickers:tn1"); // newsletter
    // Promotions are excluded by the search itself; a newsletter outside Promotions is caught by the heuristic:
    const nl = fake.boxes["tok-urban"].messages.find((m) => m.id === "n1")!;
    nl.labelIds = nl.labelIds.filter((l) => l !== "CATEGORY_PROMOTIONS");
    const again = await call(client, "needs_reply", { account: "urbanstickers" });
    nl.labelIds.push("CATEGORY_PROMOTIONS");
    expect(again.items.map((i: { threadId: string }) => i.threadId)).not.toContain("tn1");
    expect(again.perAccount[0].skippedAutomated).toBe(1);
    for (let i = 1; i < r.items.length; i++) expect(r.items[i - 1].waitingHours).toBeGreaterThanOrEqual(r.items[i].waitingHours);
    const older = await call(client, "needs_reply", { olderThanHours: 24 });
    expect(older.items.map((i: { threadId: string }) => i.threadId)).not.toContain("tu1");
  });

  it("daily_digest separates personal mail, newsletters, waiting replies and today's events", async () => {
    const r = await call(client, "daily_digest");
    const urban = r.accounts.find((a: { account: string }) => a.account === "urbanstickers");
    expect(urban.newPersonal.map((m: { id: string }) => m.id)).toEqual(["u1"]);
    expect(urban.newSince.automated).toBe(1);
    expect(urban.automatedSenders[0]).toEqual({ from: "Shop News", count: 1 });
    expect(urban.todaysEvents.map((e: { summary: string }) => e.summary)).toEqual(["Μάστορας για βιτρίνα Acme"]);
    const psd = r.accounts.find((a: { account: string }) => a.account === "psdgator");
    expect(psd.todaysEvents).toBeUndefined(); // no calendar access there
    expect(r.totals.needsReply).toBeGreaterThanOrEqual(2);
  });

  it("find_newsletters groups by sender with one-click info", async () => {
    const r = await call(client, "find_newsletters");
    expect(r.senders[0]).toMatchObject({ account: "urbanstickers", email: "news@shop.example", count: 2, unread: 1, oneClick: true, hasUnsubscribeLink: true, sampleMessageId: "n1" });
  });

  it("bulk_cleanup requires a preview token and then archives", async () => {
    const prev = await call(client, "bulk_cleanup", { account: "urbanstickers", query: "from:news@shop.example", action: "archive" });
    expect(prev).toMatchObject({ dryRun: true, matches: 2 });
    expect(prev.sample).toHaveLength(2);
    const noToken = await call(client, "bulk_cleanup", { account: "urbanstickers", query: "from:news@shop.example", action: "archive", dryRun: false });
    expect(noToken.error).toMatch(/confirmToken/);
    const wrong = await call(client, "bulk_cleanup", { account: "urbanstickers", query: "from:news@shop.example", action: "archive", dryRun: false, confirmToken: "nope" });
    expect(wrong.error).toMatch(/changed since the preview/);
    const done = await call(client, "bulk_cleanup", { account: "urbanstickers", query: "from:news@shop.example", action: "archive", dryRun: false, confirmToken: prev.confirmToken });
    expect(done.changed).toBe(2);
    const n1 = fake.boxes["tok-urban"].messages.find((m) => m.id === "n1")!;
    expect(n1.labelIds).not.toContain("INBOX");
    n1.labelIds.push("INBOX"); // restore for later tests
    fake.boxes["tok-urban"].messages.find((m) => m.id === "n2")!.labelIds.push("INBOX");
    const trash = await call(client, "bulk_cleanup", { account: "urbanstickers", query: "from:news@shop.example", action: "trash" });
    expect(trash.error).toMatch(/needs full mode/);
  });

  it("find_contact matches names without accents across accounts", async () => {
    const r = await call(client, "find_contact", { name: "μαρια" });
    expect(r.contacts[0]).toMatchObject({ email: "maria@acme.example", name: "Μαρία", accounts: ["urbanstickers"] });
    const bob = await call(client, "find_contact", { name: "bob" });
    expect(bob.contacts[0].email).toBe("bob@client.example");
    expect(bob.contacts[0].count).toBeGreaterThanOrEqual(2);
  });

  it("forward_email drafts a forward with the original attachment", async () => {
    const r = await call(client, "forward_email", { messageId: "u1", account: "urbanstickers", to: "partner@print.example", note: "Δες το παρακάτω" });
    expect(r).toMatchObject({ status: "draft_saved_not_sent", subject: "Fwd: Προσφορά βιτρίνας", attachments: ["κάτοψη.pdf"] });
    const raw = Buffer.from(fake.boxes["tok-urban"].drafts.at(-1)!.message.raw!, "base64url").toString("utf8");
    const parsed = await simpleParser(raw);
    expect(parsed.text).toContain("Δες το παρακάτω");
    expect(parsed.text).toContain("---------- Forwarded message ---------");
    expect(parsed.text).toContain("Καλημέρα");
    expect(parsed.attachments[0].filename).toBe("κάτοψη.pdf");
    expect(parsed.attachments[0].content.toString()).toBe("%PDF-1.4 fake invoice");
  });

  it("calendar: list events across accounts and find free time", async () => {
    const ev = await call(client, "list_events", { days: 14 });
    expect(ev.events.map((e: { summary: string }) => e.summary)).toEqual(["Μάστορας για βιτρίνα Acme", "Next week thing"]);
    expect(ev.skipped).toEqual([{ account: "psdgator", reason: "calendar access not enabled" }]);
    const q = await call(client, "list_events", { days: 14, query: "acme" });
    expect(q.count).toBe(1);
    const free = await call(client, "find_free_time", { days: 3, durationMinutes: 60, includeWeekends: true });
    expect(free.freeSlots.length).toBeGreaterThan(0);
    const e1 = fake.boxes["tok-urban"].calendar!.events.primary.find((e) => e.id === "e1")!;
    const busy = [Date.parse((e1.start as { dateTime: string }).dateTime), Date.parse((e1.end as { dateTime: string }).dateTime)];
    for (const s of free.freeSlots) expect(Date.parse(s.end) <= busy[0] || Date.parse(s.start) >= busy[1]).toBe(true);
  });

  it("audit log records the session's actions without bodies", async () => {
    const r = await call(client, "view_audit_log", { onlyChanges: true, limit: 10 });
    const tools = r.entries.map((e: { tool: string }) => e.tool);
    expect(tools).toContain("forward_email");
    expect(tools).toContain("bulk_cleanup");
    expect(tools).not.toContain("search_emails");
    const raw = fs.readFileSync(path.join(home, "audit.log"), "utf8");
    expect(raw).not.toContain("Δες το παρακάτω"); // the note is a body: never logged
  });
});

describe("full mode features", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect("full");
  });
  afterAll(async () => {
    await client.close();
  });

  it("unsubscribe falls back to the mailto method when one-click can't be used", async () => {
    // n2 only has a mailto link.
    const r = await call(client, "unsubscribe", { messageId: "n2", account: "urbanstickers" });
    expect(r).toMatchObject({ method: "email", sentTo: "unsub@shop.example", ok: true });
    const parsed = await simpleParser(Buffer.from(fake.boxes["tok-urban"].sent.at(-1)!.raw, "base64url").toString("utf8"));
    expect(parsed.subject).toBe("unsubscribe");
  });

  it("bulk trash works after a preview", async () => {
    const prev = await call(client, "bulk_cleanup", { account: "urbanstickers", query: "subject:Offers", action: "trash" });
    const done = await call(client, "bulk_cleanup", { account: "urbanstickers", query: "subject:Offers", action: "trash", dryRun: false, confirmToken: prev.confirmToken });
    expect(done.changed).toBe(prev.matches);
    expect(fake.boxes["tok-urban"].messages.find((m) => m.id === "n2")!.labelIds).toContain("TRASH");
  });

  it("create_event creates without notifying attendees by default", async () => {
    const r = await call(client, "create_event", { summary: "Παράδοση αυτοκόλλητων", start: "2026-11-02T10:00", attendees: ["maria@acme.example"] });
    expect(r).toMatchObject({ status: "created", account: "urbanstickers", invitationsSent: false });
    const ev = fake.boxes["tok-urban"].calendar!.events.primary.at(-1)!;
    expect(ev.start).toEqual({ dateTime: "2026-11-02T10:00:00", timeZone: "Europe/Athens" });
    expect((ev.end as { dateTime: string }).dateTime).toBe("2026-11-02T09:00:00.000Z");
    expect(fake.requests.some((x) => x.includes("sendUpdates=all"))).toBe(false);
  });
});

describe("security fixes (review)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect("drafts");
  });
  afterAll(async () => {
    await client.close();
  });

  it("drafts mode can't trash or spam mail through system labels", async () => {
    for (const label of ["Trash", "TRASH", "spam", "SENT", "DRAFT"]) {
      const r = await call(client, "modify_emails", { account: "urbanstickers", messageIds: ["u2"], addLabels: [label] });
      expect(r.error).toMatch(/can't be added or removed/);
    }
    const rm = await call(client, "modify_emails", { account: "urbanstickers", messageIds: ["u2"], removeLabels: ["INBOX", "TRASH"] });
    expect(rm.error).toMatch(/can't be added or removed/);
    const prev = await call(client, "bulk_cleanup", { account: "urbanstickers", query: "from:shop@example.com", action: "label", label: "TRASH" });
    expect(prev.matches).toBe(1);
    const run = await call(client, "bulk_cleanup", { account: "urbanstickers", query: "from:shop@example.com", action: "label", label: "TRASH", dryRun: false, confirmToken: prev.confirmToken });
    expect(run.error).toMatch(/can't be added or removed/);
    expect(fake.boxes["tok-urban"].messages.find((m) => m.id === "u2")!.labelIds).not.toContain("TRASH");
  });

  it("asks the human through elicitation when the client supports it", async () => {
    const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    let answer: "decline" | "accept" = "decline";
    const asked: string[] = [];
    const c = new Client({ name: "elicit", version: "1" }, { capabilities: { elicitation: {} } });
    c.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push((req.params as { message: string }).message);
      return answer === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" };
    });
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [ENTRY, "--mode", "drafts"],
        env: { ...process.env, GMAIL_MCP_HOME: home, GMAIL_MCP_API_ROOT: fake.url, GMAIL_MCP_MASTER_KEY: KEY } as Record<string, string>,
        stderr: "pipe",
      })
    );
    const args = { account: "urbanstickers", query: "from:shop@example.com", action: "markRead" };
    const prev = await call(c, "bulk_cleanup", args);
    const declined = await call(c, "bulk_cleanup", { ...args, dryRun: false, confirmToken: prev.confirmToken });
    expect(declined).toMatchObject({ changed: 0, cancelled: "The user declined." });
    expect(asked[0]).toMatch(/Mark as read 1 email\(s\) in "urbanstickers"/);
    answer = "accept";
    const done = await call(c, "bulk_cleanup", { ...args, dryRun: false, confirmToken: prev.confirmToken });
    expect(done.changed).toBe(1);
    await c.close();
  });

  it("find_free_time starts on the requested local day even in the afternoon", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(tomorrow);
    const r = await call(client, "find_free_time", { from: `${ymd}T15:00`, days: 1, includeWeekends: true });
    expect(r.freeSlots[0].day).toBe(ymd);
    expect(Date.parse(r.freeSlots[0].start)).toBeGreaterThanOrEqual(Date.parse(`${ymd}T15:00:00+02:00`) - 3_600_000);
  });
});

describe("full mode safety (review)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect("full");
  });
  afterAll(async () => {
    await client.close();
  });

  it("unsubscribe mailto: one address only, fixed short body, From set", async () => {
    const box = fake.boxes["tok-urban"];
    box.messages.push({
      id: "evil1",
      threadId: "tevil1",
      internalDate: String(Date.now() - 3600_000),
      labelIds: [],
      snippet: "x",
      payload: { mimeType: "text/plain", headers: [{ name: "From", value: "x@evil.example" }, { name: "Subject", value: "hi" }, { name: "List-Unsubscribe", value: "<mailto:a@victim.example,b@victim.example?body=Please wire money>" }] },
    });
    const multi = await call(client, "unsubscribe", { messageId: "evil1", account: "urbanstickers" });
    expect(multi.error).toMatch(/not a single valid email address/);
    box.messages.at(-1)!.payload.headers = [{ name: "From", value: "x@evil.example" }, { name: "Subject", value: "hi" }, { name: "List-Unsubscribe", value: "<mailto:unsub@evil.example?subject=Invoice%20attached&body=Please%20wire%20money>" }];
    const before = box.sent.length;
    const ok = await call(client, "unsubscribe", { messageId: "evil1", account: "urbanstickers" });
    expect(ok).toMatchObject({ method: "email", sentTo: "unsub@evil.example" });
    const parsed = await simpleParser(Buffer.from(box.sent[before].raw, "base64url").toString("utf8"));
    expect(parsed.text?.trim()).toBe("unsubscribe");
    expect(parsed.from?.value[0].address).toBe("urbanstickersgr@gmail.com");
  });
});
