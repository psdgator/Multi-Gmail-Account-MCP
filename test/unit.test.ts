import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { AccountManager, validateAlias } from "../src/accounts.js";
import { minMode, modeAllows, parseMode } from "../src/config.js";
import { buildMime, encodeWords, formatAddress, replySubject, splitAddresses } from "../src/mime.js";
import { decodeBody, decodeEntities, extractBody, listAttachments, safeFilename, toClean } from "../src/message.js";
import { scopesForMode } from "../src/oauth.js";

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");

describe("mime", () => {
  it("encodes Greek subjects and names so they survive a round trip", async () => {
    const raw = buildMime({
      from: "Αντώνης Παπαμιχαήλ <antony@psdgator.com>",
      to: ["Γιάννα <gianna@example.gr>", "plain@example.com"],
      subject: "Προσφορά για αυτοκόλλητα βιτρίνας — μεγάλο θέμα με πολλούς χαρακτήρες για να σπάσει σε κομμάτια",
      text: "Γεια σας,\nσας στέλνω την προσφορά.\n",
    });
    expect(raw).not.toMatch(/[^\x00-\x7f]/); // headers and body are pure ASCII on the wire
    for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe("Προσφορά για αυτοκόλλητα βιτρίνας — μεγάλο θέμα με πολλούς χαρακτήρες για να σπάσει σε κομμάτια");
    expect(parsed.from?.value[0]).toMatchObject({ name: "Αντώνης Παπαμιχαήλ", address: "antony@psdgator.com" });
    const to = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    expect(to?.value.map((v) => v.address)).toEqual(["gianna@example.gr", "plain@example.com"]);
    expect(to?.value[0].name).toBe("Γιάννα");
    expect(parsed.text?.trim()).toBe("Γεια σας,\nσας στέλνω την προσφορά.");
  });

  it("builds multipart with html, attachments (non-ASCII filename) and reply headers", async () => {
    const raw = buildMime({
      to: ["a@b.com"],
      subject: "Re: hello",
      text: "plain",
      html: "<p>rich</p>",
      inReplyTo: "<orig@mail.gmail.com>",
      references: "<x@y> <orig@mail.gmail.com>",
      attachments: [{ filename: "τιμοκατάλογος 2026.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4 test") }],
    });
    const parsed = await simpleParser(raw);
    expect(parsed.html).toContain("<p>rich</p>");
    expect(parsed.text?.trim()).toBe("plain");
    expect(parsed.inReplyTo).toBe("<orig@mail.gmail.com>");
    expect(parsed.references).toEqual(["<x@y>", "<orig@mail.gmail.com>"]);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("τιμοκατάλογος 2026.pdf");
    expect(parsed.attachments[0].content.toString()).toBe("%PDF-1.4 test");
  });

  it("rejects header injection", () => {
    expect(() => buildMime({ to: ["a@b.com"], subject: "hi\r\nBcc: evil@x.com", text: "" })).toThrow(/line breaks/);
    expect(() => formatAddress("a@b.com\nBcc: x@y.z")).toThrow();
  });

  it("splits address lists with quoted commas", () => {
    expect(splitAddresses('"Doe, John" <j@d.com>, x@y.com; Z <z@z.com>')).toEqual(['"Doe, John" <j@d.com>', "x@y.com", "Z <z@z.com>"]);
    expect(formatAddress('"Doe, John" <j@d.com>')).toBe('"Doe, John" <j@d.com>');
  });

  it("keeps ASCII words untouched and never splits a UTF-8 character", () => {
    expect(encodeWords("hello")).toBe("hello");
    const enc = encodeWords("😀".repeat(30));
    for (const w of enc.split("\r\n ")) {
      const b = Buffer.from(w.slice(10, -2), "base64").toString("utf8");
      expect(b).toMatch(/^(😀)+$/u);
    }
  });

  it("builds reply subjects", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
    expect(replySubject("ΑΠ: Προσφορά")).toBe("ΑΠ: Προσφορά");
  });
});

describe("message parsing", () => {
  it("decodes non-UTF-8 charsets (ISO-8859-7 Greek)", () => {
    const greek = Buffer.from([0xc3, 0xe5, 0xe9, 0xe1]); // "Γεια" in ISO-8859-7
    expect(decodeBody(greek.toString("base64url"), "iso-8859-7")).toBe("Γεια");
  });

  it("prefers text/plain, falls back to converted HTML, lists attachments", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          partId: "0",
          mimeType: "multipart/alternative",
          parts: [{ partId: "0.1", mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { data: b64u("<h1>Γεια</h1><p>Line <a href='https://x.gr'>link</a></p><style>p{}</style>") } }],
        },
        { partId: "1", mimeType: "application/pdf", filename: "invoice.pdf", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: "ATT", size: 1234 } },
      ],
    };
    const body = extractBody(payload);
    expect(body.format).toBe("html-converted");
    expect(body.text).toContain("Γεια");
    expect(body.text).toContain("https://x.gr");
    expect(body.text).not.toContain("p{}");
    expect(listAttachments(payload)).toEqual([{ partId: "1", filename: "invoice.pdf", mimeType: "application/pdf", size: 1234, inline: false }]);
  });

  it("produces compact summaries with friendly labels", () => {
    const c = toClean("work", {
      id: "m1",
      threadId: "t1",
      internalDate: String(Date.UTC(2026, 9, 1)),
      labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS", "Label_7"],
      snippet: "Tom &amp; Jerry &#39;hi&#39;",
      payload: { headers: [{ name: "From", value: "a@b.com" }, { name: "Subject", value: "S" }] },
    }, { labelNames: new Map([["Label_7", "Clients/Kentia"]]) });
    expect(c).toMatchObject({ account: "work", unread: true, labels: ["INBOX", "Promotions", "Clients/Kentia"], snippet: "Tom & Jerry 'hi'" });
    expect(decodeEntities("&lt;b&gt;")).toBe("<b>");
  });

  it("makes filenames safe on Windows", () => {
    expect(safeFilename("..\\..\\evil.exe")).toBe("evil.exe");
    expect(safeFilename("a:b*c?.pdf")).toBe("a_b_c_.pdf");
    expect(safeFilename("CON.txt")).toBe("_CON.txt");
    expect(safeFilename("")).toBe("attachment");
  });
});

describe("accounts", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gmm-"));

  it("resolves aliases, emails, lists, 'all', and defaults", () => {
    const m = new AccountManager(tmp());
    m.addAccount("urbanstickers", "urbanstickersgr@gmail.com");
    m.addAccount("psdgator", "antony@psdgator.com");
    expect(m.resolve("URBANSTICKERS", false).map((a) => a.alias)).toEqual(["urbanstickers"]);
    expect(m.resolve("antony@psdgator.com", false).map((a) => a.alias)).toEqual(["psdgator"]);
    expect(m.resolve(undefined, true)).toHaveLength(2);
    expect(m.resolve("all", true)).toHaveLength(2);
    expect(m.resolve("psdgator, urbanstickers", true).map((a) => a.alias)).toEqual(["psdgator", "urbanstickers"]);
    expect(m.resolve(["psdgator", "antony@psdgator.com"], true)).toHaveLength(1);
    expect(() => m.resolve(undefined, false)).toThrow(/Which account/);
    expect(() => m.resolve("all", false)).toThrow(/one account/);
    expect(() => m.resolve("nope", true)).toThrow(/Unknown account "nope".*urbanstickers/);
    m.setDefault("psdgator");
    expect(m.resolve(undefined, false)[0].alias).toBe("psdgator");
  });

  it("rejects unsafe aliases and duplicate emails", () => {
    const m = new AccountManager(tmp());
    expect(() => validateAlias("../x")).toThrow();
    expect(() => validateAlias("all")).toThrow();
    m.addAccount("a", "x@y.com");
    expect(() => m.addAccount("b", "X@y.com")).toThrow(/already connected as "a"/);
  });

  it("stores tokens owner-only", () => {
    const root = tmp();
    const m = new AccountManager(root);
    m.addAccount("a", "x@y.com");
    m.saveCredentials("a", { refresh_token: "r" });
    if (process.platform !== "win32") {
      expect(fs.statSync(m.getCredentialsPath("a")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    }
    expect(m.isAuthenticated("a")).toBe(true);
    expect(m.removeAccount("a")).toBe(true);
    expect(fs.existsSync(m.getAccountDir("a"))).toBe(false);
  });
});

describe("modes", () => {
  it("orders and parses modes", () => {
    expect(modeAllows("full", "drafts")).toBe(true);
    expect(modeAllows("readonly", "drafts")).toBe(false);
    expect(minMode("full", "readonly")).toBe("readonly");
    expect(parseMode(undefined)).toBe("drafts");
    expect(parseMode("RO")).toBe("readonly");
    expect(() => parseMode("admin")).toThrow();
    expect(scopesForMode("readonly")).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(scopesForMode("full")).toContain("https://www.googleapis.com/auth/gmail.settings.basic");
  });
});
