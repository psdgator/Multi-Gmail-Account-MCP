import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";

/**
 * A real (in-memory) IMAP server (hoodiecrow) with a Hetzner-like folder layout
 * and an SMTP server that captures what is sent. Dates are relative to now so
 * newer_than:/needs-reply windows behave like they would on a live mailbox.
 */

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hoodiecrow = require("hoodiecrow-imap") as (opts: unknown) => {
  listen(port: number, host: string, cb: () => void): void;
  close(cb?: () => void): void;
  address?: () => AddressInfo;
  server?: { address(): AddressInfo };
};

const H = 3_600_000;
const CRLF = "\r\n";

function iso88597(s: string): string {
  // Greek letters in ISO-8859-7: U+0386..U+03CE map to 0xB6..0xFE (offset 0x2D0)
  return [...s].map((ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0386 && cp <= 0x03ce) return String.fromCharCode(cp - 0x2d0);
    return ch;
  }).join("");
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const ew = (s: string, charset = "UTF-8") =>
  charset === "UTF-8" ? `=?UTF-8?B?${b64(s)}?=` : `=?ISO-8859-7?B?${Buffer.from(iso88597(s), "latin1").toString("base64")}?=`;

export const FAKE_IMAP = {
  user: "testuser",
  pass: "testpass",
};

export function imapStorage(now = Date.now()) {
  const d = (hoursAgo: number) => new Date(now - hoursAgo * H);
  const pdf = b64("%PDF-1.4 fake floor plan");
  const acme = [
    `From: ${ew("Μαρία")} <maria@acme.example>`,
    "To: antony@psdgator.com",
    "Cc: boss@acme.example",
    `Subject: ${ew("Προσφορά βιτρίνας", "ISO-8859-7")}`,
    "Message-ID: <k1@acme.example>",
    `Date: ${d(30).toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/html; charset=iso-8859-7",
    "Content-Transfer-Encoding: 8bit",
    "",
    `<p>${iso88597("Καλημέρα")}</p>`,
    "--b1",
    'Content-Type: application/pdf; name="=?UTF-8?B?' + b64("κάτοψη.pdf") + '?="',
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment; filename*=UTF-8''%CE%BA%CE%AC%CF%84%CE%BF%CF%88%CE%B7.pdf",
    "",
    pdf,
    "--b1--",
    "",
  ].join(CRLF);
  const newsletter = [
    "From: Shop Deals <news@shop.example>",
    "To: antony@psdgator.com",
    "Subject: Weekly deals",
    "List-Unsubscribe: <https://shop.example/unsub?u=1>, <mailto:unsub@shop.example>",
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    "Message-ID: <n1@shop.example>",
    `Date: ${d(5).toUTCString()}`,
    "",
    "Big savings this week",
  ].join(CRLF);
  const bob = [
    "From: Bob <bob@client.example>",
    "To: antony@psdgator.com",
    `Subject: ${ew("Ερώτηση για τιμολόγιο")}`,
    "Message-ID: <b1@client.example>",
    `Date: ${d(50).toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    "Γεια σου Αντώνη, μια ερώτηση για το τιμολόγιο.",
  ].join(CRLF);
  const carol = [
    "From: Carol <carol@x.example>",
    "To: antony@psdgator.com",
    "Subject: Old thing",
    "Message-ID: <c1@x.example>",
    `Date: ${d(24 * 20).toUTCString()}`,
    "",
    "From three weeks ago",
  ].join(CRLF);
  const self = [
    "From: Antony <antony@psdgator.com>",
    "To: antony@psdgator.com",
    "Subject: note to self",
    "Message-ID: <s1@psdgator.com>",
    `Date: ${d(1).toUTCString()}`,
    "",
    "remember the milk",
  ].join(CRLF);
  const replyToBob = [
    "From: Antony <antony@psdgator.com>",
    "To: Bob <bob@client.example>",
    `Subject: ${ew("Re: Ερώτηση για τιμολόγιο")}`,
    "Message-ID: <r1@psdgator.com>",
    "In-Reply-To: <b1@client.example>",
    "References: <b1@client.example>",
    `Date: ${d(48).toUTCString()}`,
    "",
    "Answered.",
  ].join(CRLF);

  // Hoodiecrow stores raw as a binary (latin1) string.
  const bin = (s: string) => Buffer.from(s, "latin1").toString("binary");
  return {
    INBOX: {
      messages: [
        { raw: bin(carol), flags: ["\\Seen"], internaldate: d(24 * 20) },
        { raw: Buffer.from(bob, "utf8").toString("binary"), flags: ["\\Seen"], internaldate: d(50) },
        { raw: bin(acme), flags: [], internaldate: d(30) },
        { raw: bin(newsletter), flags: [], internaldate: d(5) },
        { raw: bin(self), flags: ["\\Seen"], internaldate: d(1) },
      ],
    },
    "": {
      separator: "/",
      folders: {
        Sent: { "special-use": "\\Sent", messages: [{ raw: Buffer.from(replyToBob, "utf8").toString("binary"), flags: ["\\Seen"], internaldate: d(48) }] },
        Drafts: { "special-use": "\\Drafts" },
        Trash: { "special-use": "\\Trash" },
        Junk: { "special-use": "\\Junk" },
        Archive: { "special-use": "\\Archive" },
        Clients: {},
      },
    },
  };
}

export interface FakeMailServers {
  imapPort: number;
  smtpPort: number;
  sent: { from: string; to: string[]; data: string }[];
  close(): Promise<void>;
}

export async function startFakeMailServers(): Promise<FakeMailServers> {
  const imap = hoodiecrow({
    plugins: ["ID", "ENABLE", "IDLE", "SPECIAL-USE", "UIDPLUS", "MOVE", "UNSELECT", "LITERALPLUS", "ESEARCH", "NAMESPACE", "CREATE-SPECIAL-USE"],
    storage: imapStorage(),
  });
  await new Promise<void>((r) => imap.listen(0, "127.0.0.1", r));
  const imapPort = (imap.server ? imap.server.address() : imap.address!()).port;

  const sent: FakeMailServers["sent"] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    allowInsecureAuth: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.password !== FAKE_IMAP.pass) return cb(new Error("Invalid login"));
      cb(null, { user: auth.username });
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        sent.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          data: Buffer.concat(chunks).toString("utf8"),
        });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  const smtpPort = (smtp.server.address() as AddressInfo).port;

  return {
    imapPort,
    smtpPort,
    sent,
    close: async () => {
      await new Promise<void>((r) => imap.close(() => r()));
      await new Promise<void>((r) => smtp.close(() => r()));
    },
  };
}
