import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny in-memory stand-in for the Gmail REST API, enough to exercise the
 * server end to end. Mailboxes are selected by the bearer token.
 */

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
/** Fixture timestamps are relative to "now" so time-window features stay testable. */
const ago = (hours: number) => String(Date.now() - hours * 3_600_000);

interface Msg {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds: string[];
  snippet: string;
  payload: Record<string, unknown>;
}

export interface Mailbox {
  email: string;
  messages: Msg[];
  labels: { id: string; name: string; type: string }[];
  drafts: { id: string; message: { id: string; threadId: string; raw?: string } }[];
  sendAs: { sendAsEmail: string; displayName?: string; isDefault?: boolean; signature?: string }[];
  attachments: Record<string, string>;
  sent: { raw: string; threadId?: string }[];
  calendar?: { calendars: Record<string, unknown>[]; events: Record<string, Record<string, unknown>[]> };
}

const hdrs = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));

export function fixtures(): Record<string, Mailbox> {
  return {
    "tok-urban": {
      email: "urbanstickersgr@gmail.com",
      labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "UNREAD", name: "UNREAD", type: "system" },
        { id: "Label_1", name: "Πελάτες", type: "user" },
      ],
      sendAs: [{ sendAsEmail: "urbanstickersgr@gmail.com", displayName: "UrbanStickers", isDefault: true, signature: "<b>UrbanStickers</b><br>urbanstickers.gr" }],
      drafts: [],
      sent: [],
      attachments: { "att-1": b64u("%PDF-1.4 fake invoice") },
      calendar: {
        calendars: [
          { id: "primary", summary: "urbanstickersgr@gmail.com", primary: true, selected: true, accessRole: "owner" },
          { id: "holidays", summary: "Αργίες", selected: false, accessRole: "reader" },
        ],
        events: { primary: [], holidays: [] },
      },
      messages: [
        {
          id: "u1",
          threadId: "tu1",
          internalDate: ago(1),
          labelIds: ["INBOX", "UNREAD", "Label_1"],
          snippet: "Καλημέρα, θα ήθελα προσφορά για βιτρίνα",
          payload: {
            mimeType: "multipart/mixed",
            headers: hdrs({
              From: "Μαρία <maria@acme.example>",
              To: "urbanstickersgr@gmail.com",
              Cc: "boss@acme.example",
              Subject: "Προσφορά βιτρίνας",
              "Message-ID": "<orig-u1@mail.example>",
            }),
            parts: [
              {
                partId: "0",
                mimeType: "text/html",
                headers: hdrs({ "Content-Type": "text/html; charset=iso-8859-7" }),
                body: { data: b64u(Buffer.from([0xca, 0xe1, 0xeb, 0xe7, 0xec, 0xdd, 0xf1, 0xe1])) }, // "Καλημέρα" in ISO-8859-7
              },
              {
                partId: "1",
                mimeType: "application/pdf",
                filename: "κάτοψη.pdf",
                headers: hdrs({ "Content-Disposition": "attachment" }),
                body: { attachmentId: "att-1", size: 21 },
              },
            ],
          },
        },
        {
          id: "u2",
          threadId: "tu2",
          internalDate: ago(24 * 6),
          labelIds: ["INBOX"],
          snippet: "Your order shipped",
          payload: { mimeType: "text/plain", headers: hdrs({ From: "shop@example.com", To: "urbanstickersgr@gmail.com", Subject: "Order shipped" }), body: { data: b64u("Shipped!") } },
        },
        {
          id: "n1",
          threadId: "tn1",
          internalDate: ago(3),
          labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
          snippet: "Νέες προσφορές! unsubscribe",
          payload: {
            mimeType: "text/plain",
            headers: hdrs({
              From: "Shop News <news@shop.example>",
              To: "urbanstickersgr@gmail.com",
              Subject: "Προσφορές εβδομάδας",
              "List-Unsubscribe": "<mailto:unsub@shop.example?subject=unsubscribe-me>, <https://shop.example/u/123>",
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              "Message-ID": "<n1@shop.example>",
            }),
            body: { data: b64u("Offers. unsubscribe") },
          },
        },
        {
          id: "n2",
          threadId: "tn2",
          internalDate: ago(50),
          labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
          snippet: "Last week offers unsubscribe",
          payload: {
            mimeType: "text/plain",
            headers: hdrs({ From: "Shop News <news@shop.example>", To: "urbanstickersgr@gmail.com", Subject: "Offers", "List-Unsubscribe": "<mailto:unsub@shop.example>" }),
            body: { data: b64u("Offers. unsubscribe") },
          },
        },
        {
          id: "r1a",
          threadId: "tr1",
          internalDate: ago(72),
          labelIds: ["INBOX"],
          snippet: "Where is order 55?",
          payload: { mimeType: "text/plain", headers: hdrs({ From: "Client Bob <bob@client.example>", To: "urbanstickersgr@gmail.com", Subject: "Order 55" }), body: { data: b64u("Where is order 55?") } },
        },
        {
          id: "r1b",
          threadId: "tr1",
          internalDate: ago(70),
          labelIds: ["SENT"],
          snippet: "Shipped today",
          payload: { mimeType: "text/plain", headers: hdrs({ From: "UrbanStickers <urbanstickersgr@gmail.com>", To: "bob@client.example", Subject: "Re: Order 55" }), body: { data: b64u("Shipped today") } },
        },
      ],
    },
    "tok-psd": {
      email: "antony@psdgator.com",
      labels: [{ id: "INBOX", name: "INBOX", type: "system" }],
      sendAs: [{ sendAsEmail: "antony@psdgator.com", isDefault: true }],
      drafts: [],
      sent: [],
      attachments: {},
      messages: [
        {
          id: "p1",
          threadId: "tp1",
          internalDate: ago(30),
          labelIds: ["INBOX", "UNREAD"],
          snippet: "Invoice &amp; contract",
          payload: { mimeType: "text/plain", headers: hdrs({ From: "client@example.com", To: "antony@psdgator.com", Subject: "Invoice" }), body: { data: b64u("Please find the invoice.") } },
        },
      ],
    },
  };
}

/** Gmail matches names regardless of case and accents. */
const fold = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function hdr(m: Msg, name: string): string {
  const hs = (m.payload.headers as { name: string; value: string }[] | undefined) ?? [];
  return hs.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Enough of Gmail's query language for the tests; unknown operators/groups are ignored. */
function matches(m: Msg, q: string): boolean {
  const query = q.replace(/\([^)]*\)/g, " ").trim();
  if (!query) return true;
  const tokens = query.match(/-?[a-z_]+:"[^"]*"|-?[a-z_]+:\S+|"[^"]*"|\S+/gi) ?? [];
  return tokens.every((raw) => {
    const neg = raw.startsWith("-");
    const t = (neg ? raw.slice(1) : raw).replace(/"/g, "");
    const lower = t.toLowerCase();
    let r: boolean;
    if (lower === "is:unread") r = m.labelIds.includes("UNREAD");
    else if (lower === "is:starred") r = m.labelIds.includes("STARRED");
    else if (lower === "in:inbox") r = m.labelIds.includes("INBOX");
    else if (lower === "in:sent") r = m.labelIds.includes("SENT");
    else if (lower === "in:drafts") r = m.labelIds.includes("DRAFT");
    else if (lower === "has:attachment") r = JSON.stringify(m.payload).includes("attachmentId");
    else if (lower.startsWith("from:")) r = fold(hdr(m, "From")).includes(fold(t.slice(5)));
    else if (lower.startsWith("to:")) r = fold(`${hdr(m, "To")} ${hdr(m, "Cc")}`).includes(fold(t.slice(3)));
    else if (lower.startsWith("category:")) r = m.labelIds.includes(`CATEGORY_${t.slice(9).toUpperCase()}`);
    else if (lower.startsWith("subject:")) r = hdr(m, "Subject").toLowerCase().includes(t.slice(8).toLowerCase());
    else if (lower.startsWith("newer_than:")) {
      const n = Number(lower.match(/(\d+)/)?.[1] ?? 0);
      r = Date.now() - Number(m.internalDate) <= n * 86_400_000;
    } else if (lower.startsWith("older_than:")) {
      const n = Number(lower.match(/(\d+)/)?.[1] ?? 0);
      r = Date.now() - Number(m.internalDate) > n * 86_400_000;
    } else if (/^[a-z_]+:/.test(lower)) return true; // operator the fake doesn't model: ignore (even when negated)
    else r = JSON.stringify(m).toLowerCase().includes(lower);
    return neg ? !r : r;
  });
}

function calendarRoute(box: Mailbox, method: string, url: URL, bodyText: string, send: (s: number, o: unknown) => void) {
  const cal = box.calendar;
  if (!cal) return send(403, { error: { code: 403, message: "Request had insufficient authentication scopes." } });
  const p = url.pathname.replace(/^\/calendar\/v3/, "");
  let mm: RegExpMatchArray | null;
  if (p === "/users/me/calendarList") return send(200, { items: cal.calendars });
  if ((mm = p.match(/^\/calendars\/([^/]+)\/events$/))) {
    const id = decodeURIComponent(mm[1]);
    cal.events[id] ??= [];
    if (method === "POST") {
      const ev = { id: `ev${cal.events[id].length + 1}`, status: "confirmed", htmlLink: `https://calendar.example/${id}`, ...JSON.parse(bodyText) };
      cal.events[id].push(ev);
      return send(200, ev);
    }
    const min = Date.parse(url.searchParams.get("timeMin") ?? "1970-01-01");
    const max = Date.parse(url.searchParams.get("timeMax") ?? "2999-01-01");
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const items = cal.events[id].filter((e) => {
      const st = Date.parse(((e.start as { dateTime?: string; date?: string }).dateTime ?? (e.start as { date: string }).date) as string);
      return st >= min && st < max && (!q || JSON.stringify(e).toLowerCase().includes(q));
    });
    return send(200, { items });
  }
  if (p === "/freeBusy" && method === "POST") {
    const b = JSON.parse(bodyText);
    const calendars: Record<string, { busy: { start: string; end: string }[] }> = {};
    for (const it of b.items as { id: string }[]) {
      calendars[it.id] = {
        busy: (cal.events[it.id] ?? [])
          .filter((e) => (e.start as { dateTime?: string }).dateTime)
          .map((e) => ({ start: (e.start as { dateTime: string }).dateTime, end: (e.end as { dateTime: string }).dateTime })),
      };
    }
    return send(200, { calendars });
  }
  return send(404, { error: { code: 404, message: `fake calendar: no route ${method} ${p}` } });
}

export interface FakeGmail {
  url: string;
  boxes: Record<string, Mailbox>;
  requests: string[];
  /** "METHOD /path" -> number of upcoming requests to fail with 503. */
  faults: Map<string, number>;
  close: () => Promise<void>;
}

export async function startFakeGmail(): Promise<FakeGmail> {
  const boxes = fixtures();
  const requests: string[] = [];
  const faults = new Map<string, number>();
  let seq = 1;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${req.method} ${url.pathname}`);
    const faultKey = `${req.method} ${url.pathname.replace(/^\/gmail\/v1\/users\/me/, "")}`;
    const pending = faults.get(faultKey) ?? 0;
    if (pending > 0) {
      faults.set(faultKey, pending - 1);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: 503, message: "Backend Error" } }));
      return;
    }
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const box = boxes[token];
    if (!box) return send(401, { error: { code: 401, message: "Invalid Credentials" } });

    if (url.pathname.startsWith("/calendar/v3/")) return calendarRoute(box, req.method ?? "GET", url, bodyText, send);
    const p = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    const find = (id: string) => box.messages.find((m) => m.id === id);
    let mm: RegExpMatchArray | null;

    if (p === "/profile") return send(200, { emailAddress: box.email, messagesTotal: box.messages.length });
    if (p === "/messages" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const max = Number(url.searchParams.get("maxResults") ?? 100);
      const found = box.messages
        .filter((m) => matches(m, q))
        .filter((m) => url.searchParams.get("includeSpamTrash") === "true" || !m.labelIds.includes("TRASH"))
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
        .slice(0, max);
      return send(200, { messages: found.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: found.length });
    }
    if (p === "/messages/send" && req.method === "POST") {
      const b = JSON.parse(bodyText);
      box.sent.push({ raw: b.raw, threadId: b.threadId });
      return send(200, { id: `s${seq++}`, threadId: b.threadId ?? `st${seq}`, labelIds: ["SENT"] });
    }
    if (p === "/messages/batchModify" && req.method === "POST") {
      const b = JSON.parse(bodyText);
      for (const id of b.ids) {
        const m = find(id);
        if (!m) continue;
        m.labelIds = m.labelIds.filter((l) => !(b.removeLabelIds ?? []).includes(l));
        for (const l of b.addLabelIds ?? []) if (!m.labelIds.includes(l)) m.labelIds.push(l);
      }
      res.writeHead(204).end();
      return;
    }
    if ((mm = p.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)$/))) {
      const data = box.attachments[mm[2]];
      return data ? send(200, { data, size: Buffer.from(data, "base64url").length }) : send(404, { error: { code: 404, message: "Not Found" } });
    }
    if ((mm = p.match(/^\/messages\/([^/]+)$/))) {
      const m = find(mm[1]);
      if (!m) return send(404, { error: { code: 404, message: "Requested entity was not found." } });
      return send(200, m);
    }
    if ((mm = p.match(/^\/threads\/([^/]+)$/))) {
      const msgs = box.messages.filter((m) => m.threadId === mm![1]).sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
      return msgs.length ? send(200, { id: mm[1], messages: msgs }) : send(404, { error: { code: 404, message: "Not Found" } });
    }
    if (p === "/labels" && req.method === "GET") return send(200, { labels: box.labels });
    if (p === "/labels/INBOX") {
      const inbox = box.messages.filter((m) => m.labelIds.includes("INBOX"));
      return send(200, { id: "INBOX", messagesTotal: inbox.length, messagesUnread: inbox.filter((m) => m.labelIds.includes("UNREAD")).length, threadsUnread: inbox.filter((m) => m.labelIds.includes("UNREAD")).length });
    }
    if (p === "/settings/sendAs") return send(200, { sendAs: box.sendAs });
    if (p === "/settings/filters") return send(200, { filter: [] });
    if (p === "/drafts" && req.method === "POST") {
      const b = JSON.parse(bodyText);
      const d = { id: `d${seq}`, message: { id: `dm${seq}`, threadId: b.message.threadId ?? `dt${seq}`, raw: b.message.raw } };
      seq++;
      box.drafts.push(d);
      return send(200, { id: d.id, message: { id: d.message.id, threadId: d.message.threadId, labelIds: ["DRAFT"] } });
    }
    if (p === "/drafts" && req.method === "GET") return send(200, { drafts: box.drafts.map((d) => ({ id: d.id, message: { id: d.message.id } })) });
    if ((mm = p.match(/^\/drafts\/([^/]+)$/)) && req.method === "GET") {
      const d = box.drafts.find((x) => x.id === mm![1]);
      return d ? send(200, { id: d.id, message: { id: d.message.id, threadId: d.message.threadId, payload: { headers: [] } } }) : send(404, {});
    }
    if ((mm = p.match(/^\/messages\/([^/]+)\/trash$/)) && req.method === "POST") {
      const m = find(mm[1]);
      if (!m) return send(404, { error: { code: 404, message: "Not Found" } });
      m.labelIds = [...m.labelIds.filter((l) => l !== "INBOX"), "TRASH"];
      return send(200, { id: m.id, labelIds: m.labelIds });
    }
    if (p === "/threads" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const max = Number(url.searchParams.get("maxResults") ?? 100);
      const ids = [...new Set(box.messages.filter((m) => matches(m, q)).sort((a, b) => Number(b.internalDate) - Number(a.internalDate)).map((m) => m.threadId))].slice(0, max);
      return send(200, { threads: ids.map((id) => ({ id })), resultSizeEstimate: ids.length });
    }
    return send(404, { error: { code: 404, message: `fake gmail: no route ${req.method} ${p}` } });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, boxes, requests, faults, close: () => new Promise((r) => server.close(() => r())) };
}
