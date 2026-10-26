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
import { buildOutgoing } from "../src/tools/compose.js";
import { exactStorage, FAKE_IMAP, FakeMailServers, imapStorage, minimalStorage, startFakeMailServers } from "./fake-imap.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (p = "gmm-imap-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe("Gmail query -> IMAP search", () => {
  const now = new Date("2026-10-26T12:00:00Z");

  it("tokenizes operators, quotes, negation and OR", () => {
    expect(tokenize('from:"Μαρία Π" -subject:x OR "big deal" in:sent')).toEqual([
      { neg: false, op: "from", value: "Μαρία Π" },
      { neg: true, op: "subject", value: "x" },
      { neg: false, value: "OR", or: true },
      { neg: false, op: undefined, value: "big deal" },
      { neg: false, op: "in", value: "sent" },
    ]);
  });

  it("maps common operators", () => {
    const q = parseGmailQuery("from:a@b.com is:unread has:attachment after:2026/10/01 in:sent label:Clients/Acme larger:2m category:promotions", now);
    expect(q.criteria).toEqual({ from: "a@b.com", seen: false, since: new Date(Date.UTC(2026, 9, 1)), larger: 2 * 1024 * 1024 });
    expect(q.hasAttachment).toBe(true);
    expect(q.roles).toEqual(["sent"]);
    expect(q.folders).toEqual(["Clients/Acme"]);
    expect(q.ignored).toEqual(["category:promotions"]);
  });

  it("keeps hour precision for newer_than and nests repeated keys", () => {
    const q = parseGmailQuery("newer_than:2d invoice τιμολόγιο -from:x@y -from:z@w", now);
    expect(q.notBefore?.toISOString()).toBe("2026-10-24T12:00:00.000Z");
    expect(q.criteria).toEqual({
      since: new Date(Date.UTC(2026, 9, 23)), // a day wider for server time zones, exact afterwards
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

  it("reports what it can't apply instead of silently widening the search", () => {
    const cases: Record<string, string[]> = {
      "category:promotions older_than:30d": ["category:promotions"],
      "filename:pdf": ["filename:pdf"],
      "list:x": ["list:x"],
      "is:important foo": ["is:important"],
      "has:drive deliveredto:me@x.com": ["has:drive", "deliveredto:me@x.com"],
      "after:yesterday larger:huge": ["after:yesterday (invalid date)", "larger:huge (invalid size)"],
    };
    for (const [query, ignored] of Object.entries(cases)) expect(parseGmailQuery(query, now).ignored, query).toEqual(ignored);
    expect(parseGmailQuery("filename:pdf", now).criteria).toEqual({ all: true });
    expect(parseGmailQuery("is:important foo", now).criteria).toEqual({ text: "foo" });

    const negIn = parseGmailQuery("-in:sent from:a", now);
    expect(negIn.ignored).toHaveLength(1);
    expect(negIn.ignored[0]).toMatch(/^-in:sent/);
    expect(negIn.criteria).toEqual({ from: "a" });
    expect(negIn.roles).toEqual([]);
    expect(parseGmailQuery("-label:Clients x", now).ignored[0]).toMatch(/^-label:Clients/);

    // Simple supported queries report nothing.
    for (const ok of ["from:a@b.com is:unread", "in:sent", 'label:"Clients/Acme" newer_than:2d', "has:attachment -from:x", ""]) {
      expect(parseGmailQuery(ok, now).ignored, ok).toEqual([]);
    }
  });

  it("translates parenthesised and braced groups instead of searching for their text", () => {
    const g = parseGmailQuery("(from:a OR from:b)", now);
    expect(g.ignored).toEqual([]);
    expect(g.criteria).toEqual({ or: [{ from: "a" }, { from: "b" }] });
    expect(JSON.stringify(g.criteria)).not.toContain("text");
    expect(parseGmailQuery("-(from:a OR from:b) is:unread", now).criteria).toEqual({ not: { or: [{ from: "a" }, { from: "b" }] }, seen: false });
    expect(parseGmailQuery("{from:a from:b}", now).criteria).toEqual({ or: [{ from: "a" }, { from: "b" }] });
    expect(parseGmailQuery("from:a OR (subject:x is:unread)", now).criteria).toEqual({ or: [{ from: "a" }, { subject: "x", seen: false }] });
    expect(parseGmailQuery('subject:"(draft)" x', now).criteria).toEqual({ subject: "(draft)", text: "x" });

    // Things that only work at the top level are reported when grouped.
    const loc = parseGmailQuery("(in:sent OR from:a)", now);
    expect(loc.ignored[0]).toMatch(/^in:sent \(inside a group/);
    expect(loc.roles).toEqual([]);
    expect(parseGmailQuery("(has:attachment OR from:a)", now).ignored[0]).toMatch(/^has:attachment \(inside a group/);

    const open = parseGmailQuery("(from:a", now);
    expect(open.ignored).toEqual(["unbalanced parentheses"]);
    expect(open.criteria).toEqual({ from: "a" });
    expect(parseGmailQuery("from:a)", now).ignored).toEqual(['unbalanced ")"']);
  });

  it("makes newer_than / older_than exact at the top level", () => {
    const o = parseGmailQuery("older_than:30d", now);
    expect(o.ignored).toEqual([]);
    expect(o.notAfter?.toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect(o.criteria).toEqual({ before: new Date(Date.UTC(2026, 8, 28)) }); // whole days (+1 for time zones) on the server, exact afterwards
    expect(parseGmailQuery("-newer_than:2d", now).notAfter?.toISOString()).toBe("2026-10-24T12:00:00.000Z");
    expect(parseGmailQuery("-older_than:3h", now).notBefore?.toISOString()).toBe("2026-10-26T09:00:00.000Z");
    // "-(older_than:30d)" is "-older_than:30d": newer than 30 days, exact.
    const neg = parseGmailQuery("-(older_than:30d)", now);
    expect(neg.notBefore?.toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect([neg.notAfter, neg.ignored, neg.exact]).toEqual([undefined, [], []]);
    // Inside groups and under NOT they are exact checks for the provider, not day-rounded criteria.
    for (const g of ["(older_than:1d OR from:a)", "(newer_than:2d OR from:a)", "-(older_than:30d from:a)", "{newer_than:1h is:starred}"]) {
      const r = parseGmailQuery(g, now);
      expect(r.ignored, g).toEqual([]);
      expect(r.exact, g).toHaveLength(1);
      expect(r.criteria, g).toEqual({ all: true });
    }
    expect(parseGmailQuery("(older_than:1d OR from:a)", now).exact[0]).toEqual({
      t: "or",
      items: [{ t: "exact", leaf: { kind: "time", since: false, at: new Date("2026-10-25T12:00:00Z") } }, { t: "crit", crit: ["from", "a"] }],
    });
    expect(parseGmailQuery("-(older_than:30d from:a)", now).exact[0]).toMatchObject({ t: "not", item: { t: "and" } });
  });

  it("matches full addresses exactly and partial ones as substrings", () => {
    const q = parseGmailQuery("from:Bob@Client.Example -to:x@y.example cc:team@client.example", now);
    expect(q.addrs).toEqual([
      { field: "from", addr: "bob@client.example", neg: false },
      { field: "to", addr: "x@y.example", neg: true },
      { field: "cc", addr: "team@client.example", neg: false },
    ]);
    // Positive ones narrow the server search (substring, never narrower); a negated one is not sent,
    // because NOT TO "x@y.example" would also drop mail to "max@y.example".
    expect(q.criteria).toEqual({ from: "Bob@Client.Example", cc: "team@client.example" });
    expect(q.ignored).toEqual([]);
    for (const partial of ["from:bob", "from:@client.example", "from:bob@client", 'from:"Bob Smith"', "to:x@y"]) {
      expect(parseGmailQuery(partial, now).addrs, partial).toEqual([]);
    }
    // Inside groups they become exact checks too.
    const g = parseGmailQuery("(from:bob@client.example OR from:carol@x.example) is:unread", now);
    expect(g.exact).toEqual([
      {
        t: "or",
        items: [
          { t: "exact", leaf: { kind: "addr", field: "from", addr: "bob@client.example" } },
          { t: "exact", leaf: { kind: "addr", field: "from", addr: "carol@x.example" } },
        ],
      },
    ]);
    expect(g.criteria).toEqual({ seen: false });
    expect(parseGmailQuery("-(from:a@b.example OR from:c)", now).exact[0]).toMatchObject({ t: "not", item: { t: "or" } });
    expect(parseGmailQuery("-(from:a@b.example)", now).addrs).toEqual([{ field: "from", addr: "a@b.example", neg: true }]);
  });

  it("makes Unix-timestamp after:/before: exact, and keeps plain dates as whole days", () => {
    const ts = Date.UTC(2026, 9, 25, 6, 30) / 1000;
    const a = parseGmailQuery(`after:${ts}`, now);
    expect(a.notBefore?.toISOString()).toBe("2026-10-25T06:30:00.000Z");
    expect(a.criteria).toEqual({ since: new Date(Date.UTC(2026, 9, 24)) });
    const b = parseGmailQuery(`before:${ts} from:a`, now);
    expect(b.notAfter?.toISOString()).toBe("2026-10-25T06:30:00.000Z");
    expect(b.criteria).toEqual({ before: new Date(Date.UTC(2026, 9, 27)), from: "a" });
    expect(parseGmailQuery(`-after:${ts}`, now).notAfter?.toISOString()).toBe("2026-10-25T06:30:00.000Z");
    expect(parseGmailQuery(`-before:${ts}`, now).notBefore?.toISOString()).toBe("2026-10-25T06:30:00.000Z");
    const g = parseGmailQuery(`(after:${ts} OR from:a)`, now);
    expect(g.ignored).toEqual([]);
    expect(g.exact[0]).toMatchObject({ t: "or", items: [{ t: "exact", leaf: { kind: "time", since: true } }, { t: "crit" }] });
    // Plain dates are the server's whole days, everywhere.
    expect(parseGmailQuery("(after:2026/10/01 OR from:a)", now).criteria).toEqual({ or: [{ since: new Date(Date.UTC(2026, 9, 1)) }, { from: "a" }] });
    expect(parseGmailQuery("after:2026/10/01", now).notBefore).toBeUndefined();
  });

  it("supports rfc822msgid: (operator names may contain digits)", () => {
    expect(tokenize("rfc822msgid:<k1@acme.example>")).toEqual([{ neg: false, op: "rfc822msgid", value: "<k1@acme.example>" }]);
    const q = parseGmailQuery("rfc822msgid:k1@acme.example", now);
    expect(q.criteria).toEqual({ header: { "message-id": "<k1@acme.example>" } });
    expect(q.ignored).toEqual([]);
  });

  it("reports queries without any usable term; only the empty query means all mail", () => {
    for (const bad of ["OR", "-", '""', "   ", "AND", "OR OR", "()", "-()", "( OR )", '-""']) {
      const r = parseGmailQuery(bad, now);
      expect(r.ignored.length, JSON.stringify(bad)).toBeGreaterThan(0);
      expect(r.ignored.join(" "), JSON.stringify(bad)).toMatch(/no usable search terms|empty group/);
      expect(r.criteria).toEqual({ all: true });
    }
    expect(parseGmailQuery("", now).ignored).toEqual([]);
    // An empty group next to real terms is reported, not silently dropped.
    for (const q of ["in:inbox -()", 'in:inbox -("")', "-(x OR ())", "a ()"]) expect(parseGmailQuery(q, now).ignored, q).toContain("empty group");
    // Invisible characters are spaces, not a search term.
    for (const q of ["\u200b", "\u2060 \ufeff", "\u180e"]) expect(parseGmailQuery(q, now).ignored, JSON.stringify(q)).toEqual(["no usable search terms"]);
    for (const ok of ["in:inbox", "in:anywhere", "has:attachment", "-from:a@b.example", "newer_than:1d", "x OR"]) {
      expect(parseGmailQuery(ok, now).ignored, ok).toEqual([]);
    }
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
    expect(subjects(await p.search({ query: "from:maria@acme.example", max: 10 }))).toEqual(["Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "has:attachment", max: 10 }))).toEqual(["Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "newer_than:2d", max: 10 }))).toEqual(["note to self", "Weekly deals", "Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "-from:shop.example newer_than:2d", max: 10 }))).toEqual(["note to self", "Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "from:bob@client.example OR from:carol@x.example", max: 10 }))).toEqual(["Ερώτηση για τιμολόγιο", "Old thing"]);
    expect(subjects(await p.search({ query: '"Big savings"', max: 10 }))).toEqual(["Weekly deals"]);
    expect(subjects(await p.search({ query: "big savings week", max: 10 }))).toEqual(["Weekly deals"]); // repeated TEXT keys nest correctly
    expect(subjects(await p.search({ query: "big -savings", max: 10 }))).toEqual([]);
    expect(subjects(await p.search({ query: "-from:shop.example -from:maria -from:carol in:inbox", max: 10 }))).toEqual(["note to self", "Ερώτηση για τιμολόγιο"]);
    expect(subjects(await p.search({ query: "in:sent", max: 10 }))).toEqual(["Re: Ερώτηση για τιμολόγιο"]);

    const page1 = await p.search({ query: "", max: 2 });
    expect(page1.next).toBe("2");
    expect(page1.estimate).toBe(5);
    expect(subjects(await p.search({ query: "", max: 2, pageToken: page1.next }))).toEqual(["Προσφορά βιτρίνας", "Ερώτηση για τιμολόγιο"]);

    const k = (await p.search({ query: "from:maria", max: 1, headers: ["List-Unsubscribe"] })).messages[0];
    expect(k).toMatchObject({ account: "hetzner", from: "Μαρία <maria@acme.example>", cc: "boss@acme.example", unread: true, rfcMessageId: "<k1@acme.example>", labels: ["INBOX"] });
    const n = (await p.search({ query: "from:shop.example", max: 1, headers: ["List-Unsubscribe"] })).messages[0];
    expect(n.headers?.["list-unsubscribe"]).toContain("https://shop.example/unsub");
  });

  it("reads status, messages, attachments and threads", async () => {
    expect(await p.inboxStatus()).toEqual({ unread: 2, total: 5 });
    const k = (await p.search({ query: "from:maria", max: 1 })).messages[0];
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
    const acme = all.find((m) => m.subject === "Προσφορά βιτρίνας")!;

    await p.modify([news.id], { markRead: true, star: true });
    const news2 = (await p.search({ query: "from:shop.example", max: 1 })).messages[0];
    expect(news2).toMatchObject({ unread: false, starred: true });

    const r = await p.modify([old.id], { archive: true });
    expect(r.removed).toEqual(["INBOX"]);
    expect(subjects(await p.search({ query: "in:archive", max: 5 }))).toEqual(["Old thing"]);
    expect(subjects(await p.search({ query: "", max: 10 }))).not.toContain("Old thing");

    const label = await p.createLabel("Clients/Acme");
    expect(label.name).toBe("Clients/Acme");
    await p.modify([acme.id], { addLabels: ["clients/acme"] });
    expect(subjects(await p.search({ query: 'label:"Clients/Acme"', max: 5 }))).toEqual(["Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "from:maria", max: 5 }))).toEqual(["Προσφορά βιτρίνας"]); // copy, still in INBOX

    expect((await p.listLabels()).map((l) => `${l.name}:${l.type}`)).toEqual(
      expect.arrayContaining(["INBOX:system", "Sent:system", "Archive:system", "Clients:user", "Clients/Acme:user"])
    );
    await expect(p.modify([news.id], { addLabels: ["Nope"] })).rejects.toThrow(/does not exist/);

    expect(await p.trash([news.id])).toBe(1);
    expect(subjects(await p.search({ query: "in:trash", max: 5 }))).toEqual(["Weekly deals"]);
  });

  it("finds conversations waiting for a reply", async () => {
    const r = await p.needsReply({ days: 14, max: 10, olderThanHours: 0, skipAutomated: true });
    expect(r.items.map((i) => i.subject)).toEqual(["Προσφορά βιτρίνας"]);
    expect(r.items[0]).toMatchObject({ account: "hetzner", from: "Μαρία <maria@acme.example>", unread: true, youRepliedEarlier: false, hasDraft: false });
    expect(r.items[0].waitingHours).toBeGreaterThanOrEqual(29);
    expect(r.skippedAutomated).toBe(1);
    const strict = await p.needsReply({ days: 14, max: 10, olderThanHours: 48, skipAutomated: true });
    expect(strict.items).toEqual([]);
    const all = await p.needsReply({ days: 14, max: 10, olderThanHours: 0, skipAutomated: false });
    expect(all.items.map((i) => i.subject)).toEqual(["Προσφορά βιτρίνας", "Weekly deals"]);

    // A draft reply is reported.
    const h = await p.getOriginalHeaders(r.items[0].lastMessageId);
    await p.saveDraft(buildMime({ to: ["maria@acme.example"], subject: "Re: x", text: "...", inReplyTo: h.rfcMessageId, references: h.rfcMessageId }));
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

  it("returns ignored query parts with the results, and applies groups and exact ages live", async () => {
    const wide = await p.search({ query: "category:promotions older_than:1d", max: 10 });
    expect(wide.ignored).toEqual(["category:promotions"]);
    expect((await p.search({ query: "from:maria", max: 5 })).ignored).toBeUndefined();
    expect(subjects(await p.search({ query: "(from:bob@client.example OR from:carol@x.example)", max: 10 }))).toEqual(["Ερώτηση για τιμολόγιο", "Old thing"]);
    expect(subjects(await p.search({ query: "-(from:bob@client.example OR from:carol@x.example) is:read", max: 10 }))).toEqual(["note to self"]);
    // Bob's mail is 50h old, Maria's 30h, Carol's 20 days.
    expect(subjects(await p.search({ query: "older_than:2d", max: 10 }))).toEqual(["Ερώτηση για τιμολόγιο", "Old thing"]);
    expect(subjects(await p.search({ query: "older_than:19d", max: 10 }))).toEqual(["Old thing"]);
    expect(subjects(await p.search({ query: "older_than:21d", max: 10 }))).toEqual([]);
    const negLoc = await p.search({ query: "-in:sent from:bob", max: 10 });
    expect(negLoc.ignored?.[0]).toMatch(/^-in:sent/);
  });

  it("refuses to delete or send anything that is not a draft", async () => {
    const inbox = (await p.search({ query: "from:maria", max: 1 })).messages[0];
    await expect(p.deleteDraft(inbox.id)).rejects.toThrow(/not in the Drafts folder/);
    await expect(p.sendDraft(inbox.id)).rejects.toThrow(/not in the Drafts folder/);
    expect(servers.sent).toHaveLength(0);
    expect(subjects(await p.search({ query: "from:maria", max: 5 }))).toEqual(["Προσφορά βιτρίνας"]); // still there

    // A message sitting in Drafts without the \Draft flag is not a draft either.
    // @ts-expect-error private: append straight into Drafts like another client might
    const c = await p.conn();
    const r = await c.append("Drafts", "From: x@y\r\nTo: z@w\r\nSubject: not really a draft\r\nMessage-ID: <nd@x>\r\n\r\nx", ["\\Seen"]);
    const id = encodeId("Drafts", r.uid);
    await expect(p.deleteDraft(id)).rejects.toThrow(/no \\Draft flag/);
    await expect(p.sendDraft(id)).rejects.toThrow(/no \\Draft flag/);
    expect(servers.sent).toHaveLength(0);

    // Real drafts still work.
    const d = await p.saveDraft(buildMime({ from: "antony@psdgator.com", to: ["bob@client.example"], subject: "ok draft", text: "x" }));
    await p.deleteDraft(d.draftId);
  });

  it("reports a successful send even if removing the draft afterwards fails", async () => {
    const d = await p.saveDraft(buildMime({ from: "antony@psdgator.com", to: ["carol@x.example"], subject: "once", text: "x" }));
    const priv = p as unknown as { removeSentDraft: (path: string, uid: number) => Promise<void> };
    const orig = priv.removeSentDraft;
    priv.removeSentDraft = async () => {
      throw new Error("server hiccup");
    };
    const r = await p.sendDraft(d.draftId);
    priv.removeSentDraft = orig;
    expect(servers.sent).toHaveLength(1);
    expect(r.warning).toMatch(/WAS sent.*server hiccup.*do not send it again/);
    // The draft is still there, but this server won't send it a second time.
    await expect(p.sendDraft(d.draftId)).rejects.toThrow(/was already sent; not sending it again/);
    expect(servers.sent).toHaveLength(1);
  });

  it("sends a draft only once when send_draft is called twice at the same time", async () => {
    const d = await p.saveDraft(buildMime({ from: "antony@psdgator.com", to: ["carol@x.example"], subject: "twice?", text: "x" }));
    const [a, b] = await Promise.allSettled([p.sendDraft(d.draftId), p.sendDraft(d.draftId)]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason.message).toMatch(/already being sent/);
    expect(servers.sent).toHaveLength(1);
    expect(await p.listDrafts(5)).toEqual([]);
    await expect(p.sendDraft(d.draftId)).rejects.toThrow(/already sent/);
    expect(servers.sent).toHaveLength(1);
  });

  it("deletes a draft with UID EXPUNGE, leaving other messages marked deleted alone", async () => {
    // @ts-expect-error private: another mail app marked a message deleted but has not expunged it
    const c = await p.conn();
    const other = await c.append("Drafts", "From: x@y\r\nSubject: pending deletion\r\nMessage-ID: <pd@x>\r\n\r\nx", ["\\Draft", "\\Deleted"]);
    const d = await p.saveDraft(buildMime({ from: "antony@psdgator.com", to: ["bob@client.example"], subject: "mine", text: "x" }));
    await p.deleteDraft(d.draftId);
    expect((await p.listDrafts(5)).map((x) => x.subject)).toEqual(["pending deletion"]);
    expect(other.uid).toBeGreaterThan(0);
  });

  it("refuses to archive or move drafts out of the Drafts folder", async () => {
    const d = await p.saveDraft(buildMime({ from: "antony@psdgator.com", to: ["bob@client.example"], subject: "stay", text: "x" }));
    await expect(p.modify([d.draftId], { archive: true })).rejects.toThrow(/Drafts folder.*not archived or moved/);
    await expect(p.modify([d.draftId], { moveToInbox: true })).rejects.toThrow(/Drafts folder/);
    // Mixed with inbox mail: nothing changes at all.
    const inbox = (await p.search({ query: "from:maria", max: 1 })).messages[0];
    await expect(p.modify([inbox.id, d.draftId], { archive: true })).rejects.toThrow(/Drafts folder/);
    expect(subjects(await p.search({ query: "from:maria", max: 5 }))).toEqual(["Προσφορά βιτρίνας"]);
    expect((await p.listDrafts(5)).map((x) => x.subject)).toEqual(["stay"]);
    await p.modify([d.draftId], { star: true }); // flags are fine
  });

  it("finds by rfc822msgid: and reports a query with no usable terms", async () => {
    expect(subjects(await p.search({ query: "rfc822msgid:k1@acme.example", max: 5 }))).toEqual(["Προσφορά βιτρίνας"]);
    expect(subjects(await p.search({ query: "rfc822msgid:<b1@client.example>", max: 5 }))).toEqual(["Ερώτηση για τιμολόγιο"]);
    for (const query of ["OR", "-", '""', "  "]) expect((await p.search({ query, max: 5 })).ignored, query).toEqual(["no usable search terms"]);
    expect((await p.search({ query: "", max: 5 })).ignored).toBeUndefined();
  });

  it("refuses labels that would move mail into or out of Trash, Spam, Drafts or Sent", async () => {
    const m = (await p.search({ query: "from:maria", max: 1 })).messages[0];
    await expect(p.modify([m.id], { addLabels: ["Trash"] })).rejects.toThrow(/trash folder.*use trash_emails \(full mode\)/);
    await expect(p.modify([m.id], { addLabels: ["junk"] })).rejects.toThrow(/junk folder/);
    await expect(p.modify([m.id], { addLabels: ["Drafts"] })).rejects.toThrow(/drafts folder/);
    await expect(p.modify([m.id], { addLabels: ["Sent"] })).rejects.toThrow(/sent folder/);
    await expect(p.modify([m.id], { removeLabels: ["Sent"] })).rejects.toThrow(/sent folder/);
    await expect(p.modify([m.id], { removeLabels: ["Trash"] })).rejects.toThrow(/trash folder/);
    expect(subjects(await p.search({ query: "in:trash", max: 5 }))).toEqual([]);
    expect(subjects(await p.search({ query: "in:spam", max: 5 }))).toEqual([]);
    expect(subjects(await p.search({ query: "from:maria", max: 5 }))).toEqual(["Προσφορά βιτρίνας"]);
  });

  it("reconnects after the connection drops", async () => {
    await p.inboxStatus();
    // @ts-expect-error reach into the private client to simulate a dropped socket
    p.client?.close();
    expect(await p.inboxStatus()).toEqual({ unread: 2, total: 5 });
  });
});

describe("ImapProvider on a bare mailbox (no Drafts folder, group addresses)", () => {
  let servers: FakeMailServers;
  let acc: AccountConfig;
  let p: ImapProvider;

  beforeEach(async () => {
    servers = await startFakeMailServers({ storage: minimalStorage() });
    const accounts = new AccountManager(tmp());
    acc = accounts.addAccount("bare", "antony@psdgator.com", undefined, {
      type: "imap",
      imap: { host: "127.0.0.1", port: servers.imapPort, secure: false, user: FAKE_IMAP.user, allowInsecureTls: true },
      smtp: { host: "127.0.0.1", port: servers.smtpPort, secure: false, user: FAKE_IMAP.user, allowInsecureTls: true },
    });
    accounts.saveCredentials("bare", { password: FAKE_IMAP.pass });
    p = new MailRegistry(accounts).get(acc) as ImapProvider;
    return async () => {
      await p.close();
      await servers.close();
    };
  });

  it("never deletes or sends inbox mail when there is no Drafts folder", async () => {
    const all = (await p.search({ query: "", max: 10 })).messages;
    expect(all).toHaveLength(2);
    for (const m of all) {
      await expect(p.deleteDraft(m.id)).rejects.toThrow(/has no Drafts folder/);
      await expect(p.sendDraft(m.id)).rejects.toThrow(/has no Drafts folder/);
    }
    expect(servers.sent).toHaveLength(0);
    expect((await p.search({ query: "", max: 10 })).messages).toHaveLength(2);
    expect(await p.listDrafts(5)).toEqual([]);
  });

  it("recognises protected folders by name when they have no special-use flag", async () => {
    const m = (await p.search({ query: "", max: 1 })).messages[0];
    await expect(p.modify([m.id], { addLabels: ["Spam"] })).rejects.toThrow(/junk folder/);
    await expect(p.modify([m.id], { addLabels: ["Κάδος"] })).rejects.toThrow(/trash folder/);
    for (const name of ["Papelera", "Корзина", "Çöp Kutusu", "ÇÖP KUTUSU"]) await expect(p.modify([m.id], { addLabels: [name] }), name).rejects.toThrow(/trash folder/);
    for (const name of ["Correo no deseado", "Posta indesiderata", "Pourriel"]) await expect(p.modify([m.id], { addLabels: [name] }), name).rejects.toThrow(/junk folder/);
    const r = await p.modify([m.id], { addLabels: ["Clients"] });
    expect(r.added).toEqual(["Clients"]);
  });

  it("skips group-syntax addresses so reply-all works", async () => {
    const g = (await p.search({ query: "subject:Group", max: 1 })).messages[0];
    expect(g.to).toBe("");
    expect(g.to).not.toContain("<>");
    expect(g.cc).toBe("a@team.example, Bee <b@team.example>");
    const h = await p.getOriginalHeaders(g.id);
    expect(h.to).toBe("");
    expect(h.cc).toBe("a@team.example, Bee <b@team.example>");
    const out = await buildOutgoing(p, acc, { body: "Thanks!", replyToMessageId: g.id, replyAll: true });
    expect(out.to).toEqual(["Dimitris <dim@x.example>"]);
    expect(out.cc).toEqual(["a@team.example", "Bee <b@team.example>"]);
    expect(out.raw).not.toContain("<>");
    const parsed = await simpleParser(out.raw);
    expect(parsed.subject).toBe("Re: Group mail");
  });
});

describe("ImapProvider: exact addresses and times, All Mail", () => {
  let servers: FakeMailServers;
  let p: ImapProvider;

  beforeEach(async () => {
    servers = await startFakeMailServers({ storage: exactStorage() });
    const accounts = new AccountManager(tmp());
    const acc = accounts.addAccount("exact", "antony@psdgator.com", undefined, {
      type: "imap",
      imap: { host: "127.0.0.1", port: servers.imapPort, secure: false, user: FAKE_IMAP.user, allowInsecureTls: true },
    });
    accounts.saveCredentials("exact", { password: FAKE_IMAP.pass });
    p = new MailRegistry(accounts).get(acc) as ImapProvider;
    return async () => {
      await p.close();
      await servers.close();
    };
  });

  const subjects = (r: { messages: { subject: string }[]; ignored?: string[] }) => {
    expect(r.ignored).toBeUndefined();
    return r.messages.map((m) => m.subject);
  };
  const find = async (query: string, extra: { idsOnly?: boolean } = {}) => subjects(await p.search({ query, max: 20, ...extra }));

  it("matches a full address exactly, not as a substring", async () => {
    expect(await find("from:bob@client.example")).toEqual(["Real Bob"]);
    expect(await find("from:BOB@Client.Example")).toEqual(["Real Bob"]);
    expect(await find('from:"bob@client.example" in:inbox', { idsOnly: true })).toEqual(["Real Bob"]); // what unsubscribe's archive uses
    expect(await find("to:bob@client.example")).toEqual(["To Bob"]);
    expect(await find("cc:bob@client.example")).toEqual([]);
    expect(await find("cc:notbob@client.example")).toEqual(["Cc lookalike"]);
    // Partial values stay substrings.
    expect(await find("from:bob")).toEqual(["Real Bob", "Lookalike prefix", "Lookalike suffix"]);
    expect(await find("from:client.example")).toEqual(["Real Bob", "Lookalike prefix", "Lookalike suffix"]);
    // Negated: only the exact address is excluded.
    expect(await find("-from:bob@client.example")).toEqual(["Cc lookalike", "Lookalike prefix", "Lookalike suffix", "To Bob"]);
  });

  it("matches full addresses exactly inside OR / NOT groups", async () => {
    expect(await find("(from:bob@client.example OR cc:bob@client.example)")).toEqual(["Real Bob"]);
    expect(await find("{from:bob@client.example from:notbob@client.example}")).toEqual(["Real Bob", "Lookalike prefix"]);
    expect(await find("-(from:bob@client.example OR to:bob@client.example)")).toEqual(["Cc lookalike", "Lookalike prefix", "Lookalike suffix"]);
    expect(await find("(from:bob@client.example OR subject:suffix)", { idsOnly: true })).toEqual(["Real Bob", "Lookalike suffix"]);
  });

  it("applies timestamps, newer_than and older_than to the second, also in groups and under NOT", async () => {
    // Real Bob 3h, Cc 1h, prefix 30h, suffix 50h, To Bob 10 days old.
    const ts = Math.floor((Date.now() - 40 * 3_600_000) / 1000);
    expect(await find(`after:${ts}`)).toEqual(["Cc lookalike", "Real Bob", "Lookalike prefix"]);
    expect(await find(`before:${ts}`)).toEqual(["Lookalike suffix", "To Bob"]);
    expect(await find(`-after:${ts}`)).toEqual(["Lookalike suffix", "To Bob"]);
    expect(await find(`(after:${ts} OR from:carol@x.example)`)).toEqual(["Cc lookalike", "Real Bob", "Lookalike prefix", "To Bob"]);
    expect(await find(`-(before:${ts} OR from:dan@x.example)`)).toEqual(["Real Bob", "Lookalike prefix"]);
    expect(await find("-(older_than:2d)")).toEqual(["Cc lookalike", "Real Bob", "Lookalike prefix"]);
    expect(await find("-(older_than:2d from:bob)")).toEqual(["Cc lookalike", "Real Bob", "Lookalike prefix", "To Bob"]);
    expect(await find("(newer_than:2d OR from:carol@x.example)")).toEqual(["Cc lookalike", "Real Bob", "Lookalike prefix", "To Bob"]);
    expect(await find("(older_than:29h OR subject:Real)")).toEqual(["Real Bob", "Lookalike prefix", "Lookalike suffix", "To Bob"]);
    expect(await find("(older_than:31h OR subject:Real)")).toEqual(["Real Bob", "Lookalike suffix", "To Bob"]);
  });

  it("refuses to archive or move mail out of All Mail (that would delete it)", async () => {
    const m = (await p.search({ query: 'label:"All Mail"', max: 5 })).messages[0];
    expect(m.subject).toBe("In All Mail");
    await expect(p.modify([m.id], { archive: true })).rejects.toThrow(/All Mail folder.*would delete it/);
    await expect(p.modify([m.id], { moveToInbox: true })).rejects.toThrow(/All Mail folder/);
    await p.modify([m.id], { markRead: true }); // flags are fine
    expect(subjects(await p.search({ query: 'label:"All Mail"', max: 5 }))).toEqual(["In All Mail"]);
  });
});

describe("ImapProvider on a server without UIDPLUS (and MOVE)", () => {
  let servers: FakeMailServers | undefined;
  let p: ImapProvider | undefined;
  const subjects = (r: { messages: { subject: string }[] }) => r.messages.map((m) => m.subject);
  let lastAccounts: AccountManager | undefined;

  async function start(without: string[]) {
    servers = await startFakeMailServers({ storage: imapStorage(), without });
    const accounts = new AccountManager(tmp());
    const acc = accounts.addAccount("old", "antony@psdgator.com", undefined, {
      type: "imap",
      imap: { host: "127.0.0.1", port: servers.imapPort, secure: false, user: FAKE_IMAP.user, allowInsecureTls: true },
      smtp: { host: "127.0.0.1", port: servers.smtpPort, secure: false, user: FAKE_IMAP.user, allowInsecureTls: true },
    });
    accounts.saveCredentials("old", { password: FAKE_IMAP.pass });
    lastAccounts = accounts;
    p = new MailRegistry(accounts).get(acc) as ImapProvider;
    // @ts-expect-error private connection, to act like another mail app
    const c = (await p.conn()) as import("imapflow").ImapFlow;
    expect(c.capabilities.has("UIDPLUS")).toBe(false);
    return { p, c };
  }
  beforeEach(() => async () => {
    await p?.close();
    await servers?.close();
    p = servers = undefined;
  });

  it("refuses to send a draft it could not remove afterwards (nothing is sent)", async () => {
    const { p, c } = await start(["UIDPLUS"]);
    const d = await p.saveDraft(buildMime({ from: "antony@psdgator.com", to: ["bob@client.example"], subject: "mine", text: "x" }));
    await c.append("Drafts", "From: x@y\r\nSubject: pending deletion\r\nMessage-ID: <pd2@x>\r\n\r\nx", ["\\Draft", "\\Deleted"]);
    await expect(p.sendDraft(d.draftId)).rejects.toThrow(/no UIDPLUS.*1 other message/);
    expect(servers!.sent).toHaveLength(0);
  });

  it("a sent draft that couldn't be removed is no longer a draft, so a restarted server won't send it again", async () => {
    const { p } = await start(["UIDPLUS"]);
    const d = await p.saveDraft(buildMime({ from: "antony@psdgator.com", to: ["bob@client.example"], subject: "once only", text: "x" }));
    // Let the check before sending pass, then fail the removal after the \Draft flag is gone.
    const priv = p as unknown as { refuseUnsafeExpunge: (...a: unknown[]) => Promise<void> };
    const refuse = priv.refuseUnsafeExpunge.bind(p);
    let calls = 0;
    priv.refuseUnsafeExpunge = async (...args: unknown[]) => {
      if (++calls > 1) throw new Error("server hiccup");
      return refuse(...args);
    };
    const r = await p.sendDraft(d.draftId);
    expect(r.warning).toMatch(/WAS sent/);
    expect(servers!.sent).toHaveLength(1);
    const fresh = new MailRegistry(lastAccounts!).get(lastAccounts!.requireAccount("old")) as ImapProvider;
    try {
      await expect(fresh.sendDraft(d.draftId)).rejects.toThrow(/no \\Draft flag/);
    } finally {
      await fresh.close();
    }
    expect(servers!.sent).toHaveLength(1);
  });

  it("does not expunge other messages marked deleted when deleting a draft", async () => {
    const { p, c } = await start(["UIDPLUS"]);
    const d = await p.saveDraft(buildMime({ from: "antony@psdgator.com", to: ["bob@client.example"], subject: "mine", text: "x" }));
    const other = await c.append("Drafts", "From: x@y\r\nSubject: pending deletion\r\nMessage-ID: <pd@x>\r\n\r\nx", ["\\Draft", "\\Deleted"]);
    await expect(p.deleteDraft(d.draftId)).rejects.toThrow(/no UIDPLUS.*1 other message/);
    expect((await p.listDrafts(5)).map((x) => x.subject).sort()).toEqual(["mine", "pending deletion"]);
    // Once nothing else is waiting to be expunged, deleting works.
    const lock = await c.getMailboxLock("Drafts");
    try {
      await c.messageFlagsRemove(String(other.uid || (await c.search({ header: { "message-id": "<pd@x>" } }, { uid: true }))[0]), ["\\Deleted"], { uid: true });
    } finally {
      lock.release();
    }
    await p.deleteDraft(d.draftId);
    expect((await p.listDrafts(5)).map((x) => x.subject)).toEqual(["pending deletion"]);
  });

  it("refuses moves that would expunge other deleted messages when there is no MOVE either", async () => {
    const { p, c } = await start(["UIDPLUS", "MOVE"]);
    const all = (await p.search({ query: "", max: 10 })).messages;
    const news = all.find((m) => m.subject === "Weekly deals")!;
    const old = all.find((m) => m.subject === "Old thing")!;
    const lock = await c.getMailboxLock("INBOX");
    try {
      await c.messageFlagsAdd(news.id.split(":")[1], ["\\Deleted"], { uid: true });
    } finally {
      lock.release();
    }
    await expect(p.modify([old.id], { archive: true })).rejects.toThrow(/no UIDPLUS or MOVE.*1 other message/);
    await expect(p.trash([old.id])).rejects.toThrow(/no UIDPLUS or MOVE/);
    // Several folders: refused before the safe one (Sent, nothing marked deleted) is touched.
    const sent = (await p.search({ query: "in:sent", max: 1 })).messages[0];
    await expect(p.modify([sent.id, old.id], { archive: true, markRead: true })).rejects.toThrow(/Not changing "INBOX"/);
    expect(subjects(await p.search({ query: "in:sent", max: 5 }))).toEqual(["Re: Ερώτηση για τιμολόγιο"]);
    expect(subjects(await p.search({ query: "in:archive", max: 5 }))).toEqual([]);
    expect(subjects(await p.search({ query: "", max: 10 }))).toEqual(["note to self", "Weekly deals", "Προσφορά βιτρίνας", "Ερώτηση για τιμολόγιο", "Old thing"]);
  });

  it("moves with MOVE (no expunge of other messages) even without UIDPLUS", async () => {
    const { p, c } = await start(["UIDPLUS"]);
    const all = (await p.search({ query: "", max: 10 })).messages;
    const news = all.find((m) => m.subject === "Weekly deals")!;
    const old = all.find((m) => m.subject === "Old thing")!;
    const lock = await c.getMailboxLock("INBOX");
    try {
      await c.messageFlagsAdd(news.id.split(":")[1], ["\\Deleted"], { uid: true });
    } finally {
      lock.release();
    }
    await p.modify([old.id], { archive: true });
    expect(subjects(await p.search({ query: "in:archive", max: 5 }))).toEqual(["Old thing"]);
    expect(subjects(await p.search({ query: "", max: 10 }))).toContain("Weekly deals");
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
    const s = await call("search_emails", { query: "from:maria", account: "hetzner" });
    const id = s.results[0].id;
    const msg = await call("read_email", { messageId: id });
    expect(msg).toMatchObject({ account: "hetzner", body: "Καλημέρα" });
    const d = await call("create_draft", { account: "hetzner", replyToMessageId: id, replyAll: true, body: "Καλημέρα Μαρία!" });
    expect(d).toMatchObject({ status: "draft_saved_not_sent", account: "hetzner", subject: "Re: Προσφορά βιτρίνας", to: ["Μαρία <maria@acme.example>"], cc: ["boss@acme.example"] });
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
