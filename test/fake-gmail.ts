import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny in-memory stand-in for the Gmail REST API, enough to exercise the
 * server end to end. Mailboxes are selected by the bearer token.
 */

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");

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
      attachments: { "att-1": b64u("%PDF-1.4 fake invoice") },
      messages: [
        {
          id: "u1",
          threadId: "tu1",
          internalDate: String(Date.UTC(2026, 9, 25, 9, 0)),
          labelIds: ["INBOX", "UNREAD", "Label_1"],
          snippet: "Καλημέρα, θα ήθελα προσφορά για βιτρίνα",
          payload: {
            mimeType: "multipart/mixed",
            headers: hdrs({
              From: "Γιάννα <gianna@kentia.example>",
              To: "urbanstickersgr@gmail.com",
              Cc: "boss@kentia.example",
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
          internalDate: String(Date.UTC(2026, 9, 20, 9, 0)),
          labelIds: ["INBOX"],
          snippet: "Your order shipped",
          payload: { mimeType: "text/plain", headers: hdrs({ From: "shop@example.com", To: "urbanstickersgr@gmail.com", Subject: "Order shipped" }), body: { data: b64u("Shipped!") } },
        },
      ],
    },
    "tok-psd": {
      email: "antony@psdgator.com",
      labels: [{ id: "INBOX", name: "INBOX", type: "system" }],
      sendAs: [{ sendAsEmail: "antony@psdgator.com", isDefault: true }],
      drafts: [],
      attachments: {},
      messages: [
        {
          id: "p1",
          threadId: "tp1",
          internalDate: String(Date.UTC(2026, 9, 24, 12, 0)),
          labelIds: ["INBOX", "UNREAD"],
          snippet: "Invoice &amp; contract",
          payload: { mimeType: "text/plain", headers: hdrs({ From: "client@example.com", To: "antony@psdgator.com", Subject: "Invoice" }), body: { data: b64u("Please find the invoice.") } },
        },
      ],
    },
  };
}

function matches(m: Msg, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (!query) return true;
  return query.split(/\s+/).every((t) => {
    if (t === "is:unread") return m.labelIds.includes("UNREAD");
    if (t === "in:inbox") return m.labelIds.includes("INBOX");
    if (t === "has:attachment") return JSON.stringify(m.payload).includes("attachmentId");
    const text = JSON.stringify(m).toLowerCase();
    return text.includes(t.replace(/^(from|subject):/, ""));
  });
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

    const p = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    const find = (id: string) => box.messages.find((m) => m.id === id);
    let mm: RegExpMatchArray | null;

    if (p === "/profile") return send(200, { emailAddress: box.email, messagesTotal: box.messages.length });
    if (p === "/messages" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const max = Number(url.searchParams.get("maxResults") ?? 100);
      const found = box.messages.filter((m) => matches(m, q)).slice(0, max);
      return send(200, { messages: found.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: found.length });
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
      const msgs = box.messages.filter((m) => m.threadId === mm![1]);
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
    if (p.startsWith("/messages/send")) return send(500, { error: { code: 500, message: "SEND MUST NEVER BE CALLED IN THIS TEST" } });
    return send(404, { error: { code: 404, message: `fake gmail: no route ${req.method} ${p}` } });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, boxes, requests, faults, close: () => new Promise((r) => server.close(() => r())) };
}
