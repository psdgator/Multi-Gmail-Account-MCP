import * as crypto from "node:crypto";
import * as dns from "node:dns/promises";
import * as https from "node:https";
import * as net from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildMime } from "../mime.js";
import type { MailProvider } from "../providers/types.js";
import { emailOf, nameOf } from "../util.js";
import { confirmWithUser, DESTRUCTIVE, multiAccountArg, READ_ONLY, register, requireMode, singleAccountArg, ToolContext, WRITES } from "./common.js";
import { findInAccounts } from "./read.js";

/** Parse an RFC 2369 List-Unsubscribe header: "<mailto:...>, <https://...>". */
export function parseListUnsubscribe(header: string | undefined, post?: string): { https?: string; mailto?: string; oneClick: boolean } {
  const out: { https?: string; mailto?: string; oneClick: boolean } = { oneClick: false };
  if (!header) return out;
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const u = m[1].trim();
    if (/^https:\/\//i.test(u) && !out.https) out.https = u;
    else if (/^mailto:/i.test(u) && !out.mailto) out.mailto = u;
  }
  out.oneClick = Boolean(out.https && post && /List-Unsubscribe=One-Click/i.test(post));
  return out;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return (
    v === "::1" ||
    v === "::" ||
    /^f[cd]/.test(v) || // unique local
    /^fe[89ab]/.test(v) || // link local
    v.startsWith("64:ff9b:") || // NAT64 (can reach IPv4 private ranges)
    v.startsWith("2002:") || // 6to4
    v.startsWith("2001:0:") || v.startsWith("2001::") || // Teredo
    v.startsWith("ff") // multicast
  );
}

/**
 * RFC 8058 one-click unsubscribe: a single POST to a public https URL, no redirects followed.
 * The address check runs inside the connection's own DNS lookup, so a hostname can't
 * resolve to a public IP for the check and a private one for the request (DNS rebinding).
 */
export async function oneClickUnsubscribe(url: string): Promise<{ status: number; ok: boolean; location?: string }> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("Only https unsubscribe links are used.");
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) {
    if (isPrivateIp(u.hostname.replace(/^\[|\]$/g, ""))) throw new Error(`Refusing to contact ${u.hostname}: private/local address.`);
  }
  const lookup: net.LookupFunction = (hostname, options, cb) => {
    dns
      .lookup(hostname, { all: true })
      .then((addrs) => {
        const bad = addrs.find((a) => isPrivateIp(a.address));
        if (!addrs.length || bad) {
          cb(Object.assign(new Error(`Refusing to contact ${hostname}: it resolves to a private/local address.`), { code: "EPRIVATE" }), "", 4);
          return;
        }
        if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs);
        else cb(null, addrs[0].address, addrs[0].family);
      })
      .catch((e) => cb(e, "", 4));
  };
  const body = "List-Unsubscribe=One-Click";
  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: "POST",
        lookup,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "gmail-mcp-multi (RFC 8058 one-click unsubscribe)",
        },
        timeout: 15_000,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, ...(status >= 300 && status < 400 && res.headers.location ? { location: String(res.headers.location) } : {}) });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Unsubscribe request timed out.")));
    req.on("error", reject);
    req.end(body);
  });
}

const EMAIL_RE = /^[^\s@"<>(){}\[\],;:\\]+@[^\s@"<>(){}\[\],;:\\]+\.[^\s@"<>(){}\[\],;:\\]+$/;

const NEWSLETTER_HEADERS = ["List-Unsubscribe", "List-Unsubscribe-Post", "List-Id"];

function newsletterQuery(p: MailProvider, days: number): string {
  return p.kind === "gmail"
    ? `newer_than:${days}d -in:sent -in:drafts (unsubscribe OR απεγγραφή OR διαγραφή OR category:promotions OR category:updates OR category:forums)`
    : `newer_than:${days}d`;
}

/** Normalise names for matching: lower-case, no accents/tonos, final sigma. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").replace(/ς/g, "σ").toLowerCase().trim();
}

export function registerCleanupTools(server: McpServer, ctx: ToolContext): void {
  register(server, ctx, {
    name: "find_newsletters",
    title: "Find newsletters & mailing lists",
    description:
      "List the newsletters, mailing lists and marketing senders that mailed you recently, across ALL accounts by default, grouped by sender with counts, " +
      "unread counts and whether one-click unsubscribe is supported. Use before cleaning up or unsubscribing.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {
      account: multiAccountArg(ctx),
      days: z.number().int().min(1).max(365).optional().describe("Look back this many days (default 30)."),
      scanPerAccount: z.number().int().min(10).max(500).optional().describe("How many recent emails to scan per account (default 150)."),
      top: z.number().int().min(1).max(100).optional().describe("Return the top N senders (default 30)."),
    },
    run: async ({ account, days, scanPerAccount, top }) => {
      const accs = ctx.accounts.resolve(account, true);
      const { ok, errors } = await ctx.mail.fanOut(accs, (p) => p.search({ query: newsletterQuery(p, days ?? 30), max: scanPerAccount ?? 150, headers: NEWSLETTER_HEADERS }));
      type Group = { account: string; sender: string; email: string; count: number; unread: number; lastDate: string; lastSubject: string; oneClick: boolean; hasUnsubscribeLink: boolean; sampleMessageId: string };
      const groups = new Map<string, Group>();
      let scanned = 0;
      for (const r of ok) {
        for (const m of r.value.messages) {
          scanned++;
          const h = m.headers ?? {};
          if (!h["list-unsubscribe"] && !h["list-id"]) continue;
          const email = emailOf(m.from);
          const key = `${r.account.alias}|${email}`;
          const unsub = parseListUnsubscribe(h["list-unsubscribe"], h["list-unsubscribe-post"]);
          const g = groups.get(key);
          if (g) {
            g.count++;
            if (m.unread) g.unread++;
            if (m.date > g.lastDate) Object.assign(g, { lastDate: m.date, lastSubject: m.subject, sampleMessageId: m.id });
            g.oneClick ||= unsub.oneClick;
            g.hasUnsubscribeLink ||= Boolean(unsub.https || unsub.mailto);
          } else {
            groups.set(key, {
              account: r.account.alias,
              sender: nameOf(m.from),
              email,
              count: 1,
              unread: m.unread ? 1 : 0,
              lastDate: m.date,
              lastSubject: m.subject,
              oneClick: unsub.oneClick,
              hasUnsubscribeLink: Boolean(unsub.https || unsub.mailto),
              sampleMessageId: m.id,
            });
          }
        }
      }
      const senders = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, top ?? 30);
      return {
        lookedBackDays: days ?? 30,
        emailsScanned: scanned,
        senders,
        tip: "Unsubscribe with unsubscribe(messageId=sampleMessageId, account) in full mode; tidy up existing mail with bulk_cleanup(query='from:<email>').",
        ...(errors.length ? { errors } : {}),
      };
    },
  });

  register(server, ctx, {
    name: "unsubscribe",
    title: "Unsubscribe from a mailing list",
    description:
      "Unsubscribe from the list that sent a given email (full mode only). Uses RFC 8058 one-click unsubscribe when the sender supports it, " +
      "otherwise sends the unsubscribe email the sender asks for (mailto). If only a web page is offered, returns the link for the user to open. " +
      "Only do this when the user asked to unsubscribe from that sender.",
    minMode: "full",
    annotations: DESTRUCTIVE,
    input: {
      messageId: z.string().describe("Any email from the sender (e.g. sampleMessageId from find_newsletters)."),
      account: singleAccountArg(ctx),
      archiveExisting: z.boolean().optional().describe("Also archive this sender's emails currently in the inbox (default false)."),
    },
    run: async ({ messageId, account, archiveExisting }) => {
      const { acc, value: h } = await findInAccounts(ctx, account, `Message ${messageId}`, (p) => p.getOriginalHeaders(messageId));
      requireMode(ctx, acc, "full", "unsubscribe");
      const unsub = parseListUnsubscribe(h.listUnsubscribe, h.listUnsubscribePost);
      const sender = emailOf(h.from);
      let result: Record<string, unknown>;
      if (unsub.oneClick && unsub.https) {
        const r = await oneClickUnsubscribe(unsub.https);
        result = {
          method: "one-click",
          httpStatus: r.status,
          ok: r.ok,
          ...(r.location ? { note: "The sender answered with a redirect; to be sure, open this link:", openThisLink: r.location } : {}),
        };
      } else if (unsub.mailto) {
        // The header is written by the sender: allow exactly one plain address and a fixed,
        // short message, so it can't be used to make you email arbitrary text to others.
        const mu = new URL(unsub.mailto);
        const to = decodeURIComponent(mu.pathname).trim();
        if (!EMAIL_RE.test(to)) throw new Error(`The unsubscribe address "${to.slice(0, 80)}" is not a single valid email address; not sending.`);
        const subject = (mu.searchParams.get("subject") ?? "unsubscribe").replace(/[\r\n]/g, " ").slice(0, 80) || "unsubscribe";
        result = await ctx.mail.with(acc, async (p) => {
          const ids = await p.identities();
          const me = ids.find((i) => i.isDefault) ?? ids[0];
          const raw = buildMime({ from: me?.email ?? acc.email, to: [to], subject, text: "unsubscribe" });
          const sent = await p.send(raw);
          return { method: "email", sentTo: to, subject, ok: true, messageId: sent.messageId };
        });
      } else if (unsub.https) {
        result = { method: "web-page", ok: false, openThisLink: unsub.https, note: "This sender only offers an unsubscribe web page; open the link to finish." };
      } else {
        result = { method: "none", ok: false, note: "This email has no unsubscribe information. Consider a filter or bulk_cleanup instead." };
      }
      let archived = 0;
      if (archiveExisting && sender && EMAIL_RE.test(sender)) {
        archived = await ctx.mail.with(acc, async (p) => {
          const r = await p.search({ query: `from:"${sender}" in:inbox`, max: 500, idsOnly: true });
          if (r.ignored?.length) return 0;
          const ids = r.messages.map((m) => m.id);
          if (ids.length) await p.modify(ids, { archive: true });
          return ids.length;
        });
      }
      return { account: acc.alias, sender, ...result, ...(archiveExisting ? { archivedFromInbox: archived } : {}) };
    },
  });

  register(server, ctx, {
    name: "bulk_cleanup",
    title: "Bulk clean-up with preview",
    description:
      "Archive, mark as read, label, or move to Trash every email matching a search in one account. ALWAYS two steps: first call with dryRun=true (default) " +
      "to get a preview and a confirmToken, show the preview to the user, and only after they agree call again with the same arguments, dryRun=false and that confirmToken. " +
      "Archive / mark read / label need drafts mode; trash needs full mode (recoverable for 30 days in Gmail).",
    minMode: "drafts",
    annotations: DESTRUCTIVE,
    input: {
      account: singleAccountArg(ctx),
      query: z.string().min(1).describe('Search selecting the emails, e.g. "from:newsletter@shop.gr older_than:30d".'),
      action: z.enum(["archive", "markRead", "label", "trash"]),
      label: z.string().optional().describe('For action "label": label name to add.'),
      max: z.number().int().min(1).max(1000).optional().describe("At most this many emails (default 200; trash max 500)."),
      dryRun: z.boolean().optional().describe("Preview only (default true)."),
      confirmToken: z.string().optional().describe("Token from the preview; required when dryRun=false."),
    },
    run: async ({ account, query, action, label, max, dryRun, confirmToken }) => {
      const [acc] = ctx.accounts.resolve(account, false);
      requireMode(ctx, acc, action === "trash" ? "full" : "drafts", `bulk_cleanup (${action})`);
      if (action === "label" && !label) throw new Error('action "label" needs a label name.');
      const limit = Math.min(max ?? 200, action === "trash" ? 500 : 1000);
      return ctx.mail.with(acc, async (p) => {
        const found = await p.search({ query, max: limit, idsOnly: true });
        if (found.ignored?.length) {
          throw new Error(
            `This search can't be applied exactly on "${acc.alias}" (${p.kind}): unsupported parts ${found.ignored.map((x) => `"${x}"`).join(", ")}. ` +
              "Refusing a bulk change that could match more mail than intended. Rephrase the query without those parts."
          );
        }
        const ids = found.messages.map((m) => m.id).sort();
        const token = crypto.createHash("sha256").update(`${acc.alias}|${action}|${label ?? ""}|${ids.join(",")}`).digest("hex").slice(0, 16);
        if (dryRun !== false) {
          const sample = (await p.search({ query, max: Math.min(10, limit) })).messages.map((m) => ({ date: m.date, from: m.from, subject: m.subject }));
          return {
            dryRun: true,
            account: acc.alias,
            action,
            ...(label ? { label } : {}),
            query,
            matches: ids.length,
            capped: ids.length >= limit,
            sample,
            confirmToken: token,
            next: "Show this preview to the user. If they agree, call bulk_cleanup again with dryRun=false and this confirmToken.",
          };
        }
        if (!confirmToken) throw new Error("dryRun=false needs the confirmToken from a preview. Run a preview first.");
        if (confirmToken !== token) throw new Error("The matching emails changed since the preview (or the token is wrong). Run a new preview.");
        if (!ids.length) return { account: acc.alias, action, changed: 0 };
        // When the client supports it, the human confirms directly (not just the model).
        const verb = { archive: "Archive", markRead: "Mark as read", label: `Add label "${label}" to`, trash: "Move to Trash" }[action];
        const answer = await confirmWithUser(ctx, `${verb} ${ids.length} email(s) in "${acc.alias}" matching: ${query}?`);
        if (answer === "declined") return { account: acc.alias, action, changed: 0, cancelled: "The user declined." };
        if (action === "trash") await p.trash(ids);
        else if (action === "archive") await p.modify(ids, { archive: true });
        else if (action === "markRead") await p.modify(ids, { markRead: true });
        else await p.modify(ids, { addLabels: [label!] });
        return { account: acc.alias, action, ...(label ? { label } : {}), changed: ids.length };
      });
    },
  });

  register(server, ctx, {
    name: "find_contact",
    title: "Find a contact's email address",
    description:
      "Look up the email address(es) of a person or company by name, across ALL accounts, from the emails you've exchanged with them " +
      "(accents/Greek tonos are ignored). Returns addresses with how often and how recently they appear.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {
      name: z.string().min(2).describe('Name or part of it, e.g. "Μαρία", "Acme", "dhl".'),
      account: multiAccountArg(ctx),
      max: z.number().int().min(1).max(30).optional().describe("Max addresses (default 10)."),
    },
    run: async ({ name, account, max }) => {
      const accs = ctx.accounts.resolve(account, true);
      const q = name.replace(/"/g, "").trim();
      const needle = fold(q);
      const { ok, errors } = await ctx.mail.fanOut(accs, async (p) => {
        const [a, b] = await Promise.all([
          p.search({ query: `from:"${q}"`, max: 50 }),
          p.search({ query: `to:"${q}"`, max: 50, ...(p.kind === "gmail" ? { includeSpamTrash: false } : {}) }),
        ]);
        return [...a.messages, ...b.messages];
      });
      const people = new Map<string, { name: string; email: string; count: number; lastSeen: string; accounts: Set<string> }>();
      for (const r of ok) {
        for (const m of r.value) {
          for (const field of [m.from, m.to, m.cc ?? ""]) {
            for (const addr of field.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
              const a = addr.trim();
              if (!a) continue;
              const email = emailOf(a);
              const display = nameOf(a);
              if (!fold(display).includes(needle) && !fold(email).includes(needle)) continue;
              const cur = people.get(email) ?? { name: display, email, count: 0, lastSeen: "", accounts: new Set<string>() };
              cur.count++;
              if (m.date > cur.lastSeen) cur.lastSeen = m.date;
              if (display !== email && (cur.name === cur.email || display.length > cur.name.length)) cur.name = display;
              cur.accounts.add(r.account.alias);
              people.set(email, cur);
            }
          }
        }
      }
      const contacts = [...people.values()]
        .sort((x, y) => y.count - x.count || (x.lastSeen < y.lastSeen ? 1 : -1))
        .slice(0, max ?? 10)
        .map((c) => ({ ...c, accounts: [...c.accounts] }));
      return { query: name, count: contacts.length, contacts, ...(errors.length ? { errors } : {}) };
    },
  });
}

export const _test = { isPrivateIp, WRITES };
