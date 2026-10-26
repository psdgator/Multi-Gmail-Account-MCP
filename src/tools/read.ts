import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { gmail_v1 } from "@googleapis/gmail";
import { z } from "zod";
import type { AccountConfig } from "../accounts.js";
import { expandHome } from "../config.js";
import { mapLimit } from "../gmail.js";
import { CleanMessage, findPart, listAttachments, safeFilename, toClean } from "../message.js";
import { gmailUrl, multiAccountArg, READ_ONLY, register, singleAccountArg, ToolContext } from "./common.js";

const META_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Reply-To"];

async function fetchMeta(
  ctx: ToolContext,
  g: gmail_v1.Gmail,
  acc: AccountConfig,
  ids: string[]
): Promise<CleanMessage[]> {
  const { byId } = await ctx.labels.get(acc.alias, g);
  return mapLimit(ids, 8, async (id) => {
    const res = await g.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: META_HEADERS });
    return toClean(acc.alias, res.data, { labelNames: byId });
  });
}

/**
 * Candidate accounts for an id-based lookup. An explicit account is strict;
 * otherwise try the default first, then the rest (Gmail ids are per-mailbox).
 */
function candidates(ctx: ToolContext, account: string | undefined): AccountConfig[] {
  if (account) return ctx.accounts.resolve(account, false);
  const all = ctx.accounts.resolve(undefined, true);
  const def = ctx.accounts.getDefaultAlias();
  return def ? [...all.filter((a) => a.alias === def), ...all.filter((a) => a.alias !== def)] : all;
}

async function findInAccounts<T>(
  ctx: ToolContext,
  account: string | undefined,
  what: string,
  fn: (g: gmail_v1.Gmail, acc: AccountConfig) => Promise<T>
): Promise<{ acc: AccountConfig; value: T }> {
  const list = candidates(ctx, account);
  let lastErr: Error | undefined;
  for (const acc of list) {
    try {
      return { acc, value: await ctx.gmail.with(acc, (g) => fn(g, acc)) };
    } catch (err) {
      lastErr = err as Error;
      if (list.length === 1 || !/^Not found/.test(lastErr.message)) throw lastErr;
    }
  }
  throw new Error(`${what} not found in any connected account (${list.map((a) => a.alias).join(", ")}).`);
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  register(server, ctx, {
    name: "search_emails",
    title: "Search emails (one or many accounts)",
    description:
      "Search Gmail with Gmail query syntax (from:, to:, subject:, is:unread, has:attachment, after:2026/10/01, label:, in:inbox ...). " +
      'Searches ALL connected accounts by default and merges the results newest-first, each tagged with its account; pass "account" to narrow it. ' +
      "Returns headers + snippet; use read_email for the full body.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {
      query: z.string().describe('Gmail search query, e.g. "is:unread newer_than:2d" or "from:dhl.com has:attachment". Use "" for latest mail.'),
      account: multiAccountArg(ctx),
      maxResults: z.number().int().min(1).max(100).optional().describe("Max results PER ACCOUNT (default 10)."),
      includeSpamTrash: z.boolean().optional().describe("Also search Spam and Trash (default false)."),
      pageToken: z.string().optional().describe("Continue a previous single-account search (from nextPageTokens)."),
    },
    run: async ({ query, account, maxResults, includeSpamTrash, pageToken }) => {
      const accs = ctx.accounts.resolve(account, true);
      if (pageToken && accs.length > 1) throw new Error("pageToken only works when searching a single account.");
      const max = maxResults ?? 10;
      const { ok, errors } = await ctx.gmail.fanOut(accs, async (g, acc) => {
        const res = await g.users.messages.list({
          userId: "me",
          q: query,
          maxResults: max,
          includeSpamTrash: includeSpamTrash ?? false,
          ...(pageToken ? { pageToken } : {}),
        });
        const ids = (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
        return {
          messages: await fetchMeta(ctx, g, acc, ids),
          next: res.data.nextPageToken ?? undefined,
          estimate: res.data.resultSizeEstimate ?? 0,
        };
      });
      const results = ok.flatMap((r) => r.value.messages).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const nextPageTokens = Object.fromEntries(ok.filter((r) => r.value.next).map((r) => [r.account.alias, r.value.next]));
      return {
        query,
        searched: ok.map((r) => ({ account: r.account.alias, email: r.account.email, returned: r.value.messages.length, estimatedMatches: r.value.estimate })),
        count: results.length,
        results,
        ...(Object.keys(nextPageTokens).length ? { nextPageTokens } : {}),
        ...(errors.length ? { errors } : {}),
      };
    },
  });

  register(server, ctx, {
    name: "inbox_summary",
    title: "Inbox summary across accounts",
    description:
      "Quick overview of one or more inboxes: unread/total counts per account plus the newest unread messages. " +
      'Use this for "check my email", "anything new?", or "what\'s unread across my accounts". Covers ALL accounts by default.',
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {
      account: multiAccountArg(ctx),
      latest: z.number().int().min(0).max(25).optional().describe("How many newest unread messages to list per account (default 5)."),
      query: z.string().optional().describe('Which messages to list (default "in:inbox is:unread").'),
    },
    run: async ({ account, latest, query }) => {
      const accs = ctx.accounts.resolve(account, true);
      const n = latest ?? 5;
      const q = query ?? "in:inbox is:unread";
      const { ok, errors } = await ctx.gmail.fanOut(accs, async (g, acc) => {
        const [inbox, list] = await Promise.all([
          g.users.labels.get({ userId: "me", id: "INBOX" }),
          n > 0 ? g.users.messages.list({ userId: "me", q, maxResults: n }) : Promise.resolve(undefined),
        ]);
        const ids = (list?.data.messages ?? []).map((m) => m.id!).filter(Boolean);
        return {
          account: acc.alias,
          email: acc.email,
          inboxUnread: inbox.data.messagesUnread ?? 0,
          inboxUnreadThreads: inbox.data.threadsUnread ?? 0,
          inboxTotal: inbox.data.messagesTotal ?? 0,
          latest: await fetchMeta(ctx, g, acc, ids),
          openInGmail: gmailUrl(acc.email, "inbox"),
        };
      });
      const perAccount = ok.map((r) => r.value);
      return {
        totalUnread: perAccount.reduce((s, a) => s + a.inboxUnread, 0),
        accounts: perAccount,
        ...(errors.length ? { errors } : {}),
      };
    },
  });

  register(server, ctx, {
    name: "read_email",
    title: "Read an email",
    description:
      "Read one email: headers, labels, clean text body (HTML is converted to text) and attachment list. " +
      "Pass the account shown in search results. If account is omitted, every connected account is tried.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {
      messageId: z.string().describe("Message id from search_emails / inbox_summary."),
      account: singleAccountArg(ctx),
      maxBodyChars: z.number().int().min(500).max(200000).optional().describe("Truncate the body after this many characters (default 20000)."),
    },
    run: async ({ messageId, account, maxBodyChars }) => {
      const { acc, value } = await findInAccounts(ctx, account, `Message ${messageId}`, async (g, a) => {
        const { byId } = await ctx.labels.get(a.alias, g);
        const res = await g.users.messages.get({ userId: "me", id: messageId, format: "full" });
        return toClean(a.alias, res.data, { body: true, maxBodyChars, labelNames: byId });
      });
      return { ...value, email: acc.email, openInGmail: gmailUrl(acc.email, `all/${value.threadId}`) };
    },
  });

  register(server, ctx, {
    name: "read_thread",
    title: "Read an email thread",
    description: "Read a whole conversation (all messages in a thread) with clean text bodies.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {
      threadId: z.string().describe("Thread id (threadId field in search results)."),
      account: singleAccountArg(ctx),
      maxBodyChars: z.number().int().min(200).max(100000).optional().describe("Truncate EACH message body after this many characters (default 8000)."),
    },
    run: async ({ threadId, account, maxBodyChars }) => {
      const { acc, value } = await findInAccounts(ctx, account, `Thread ${threadId}`, async (g, a) => {
        const { byId } = await ctx.labels.get(a.alias, g);
        const res = await g.users.threads.get({ userId: "me", id: threadId, format: "full" });
        return (res.data.messages ?? []).map((m) => toClean(a.alias, m, { body: true, maxBodyChars: maxBodyChars ?? 8000, labelNames: byId }));
      });
      return {
        account: acc.alias,
        email: acc.email,
        threadId,
        subject: value[0]?.subject,
        messageCount: value.length,
        messages: value,
        openInGmail: gmailUrl(acc.email, `all/${threadId}`),
      };
    },
  });

  register(server, ctx, {
    name: "list_labels",
    title: "List labels",
    description: "List Gmail labels (folders) with their ids for one or more accounts.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: { account: multiAccountArg(ctx) },
    run: async ({ account }) => {
      const accs = ctx.accounts.resolve(account, true);
      const { ok, errors } = await ctx.gmail.fanOut(accs, async (g) => {
        const res = await g.users.labels.list({ userId: "me" });
        return (res.data.labels ?? [])
          .map((l) => ({ id: l.id, name: l.name, type: l.type }))
          .sort((a, b) => (a.type === b.type ? String(a.name).localeCompare(String(b.name)) : a.type === "system" ? -1 : 1));
      });
      return { accounts: ok.map((r) => ({ account: r.account.alias, labels: r.value })), ...(errors.length ? { errors } : {}) };
    },
  });

  register(server, ctx, {
    name: "list_drafts",
    title: "List drafts",
    description: "List draft emails (newest first) for one or more accounts.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {
      account: multiAccountArg(ctx),
      maxResults: z.number().int().min(1).max(50).optional().describe("Max drafts per account (default 10)."),
    },
    run: async ({ account, maxResults }) => {
      const accs = ctx.accounts.resolve(account, true);
      const { ok, errors } = await ctx.gmail.fanOut(accs, async (g, acc) => {
        const res = await g.users.drafts.list({ userId: "me", maxResults: maxResults ?? 10 });
        return mapLimit(res.data.drafts ?? [], 8, async (d) => {
          const full = await g.users.drafts.get({ userId: "me", id: d.id!, format: "metadata" });
          const m = toClean(acc.alias, full.data.message ?? {}, {});
          return { draftId: d.id, messageId: m.id, threadId: m.threadId, to: m.to, subject: m.subject, date: m.date, snippet: m.snippet };
        });
      });
      return { accounts: ok.map((r) => ({ account: r.account.alias, drafts: r.value })), ...(errors.length ? { errors } : {}) };
    },
  });

  register(server, ctx, {
    name: "list_filters",
    title: "List filters",
    description: "List Gmail filters (automatic rules) for one or more accounts.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: { account: multiAccountArg(ctx) },
    run: async ({ account }) => {
      const accs = ctx.accounts.resolve(account, true);
      const { ok, errors } = await ctx.gmail.fanOut(accs, async (g) => (await g.users.settings.filters.list({ userId: "me" })).data.filter ?? []);
      return { accounts: ok.map((r) => ({ account: r.account.alias, filters: r.value })), ...(errors.length ? { errors } : {}) };
    },
  });

  register(server, ctx, {
    name: "save_attachment",
    title: "Save an attachment to disk",
    description:
      "Download an email attachment to a folder on this computer and return its path. Identify it by partId or filename from read_email " +
      "(if the email has exactly one attachment, neither is needed).",
    minMode: "readonly",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    input: {
      messageId: z.string(),
      account: singleAccountArg(ctx),
      partId: z.string().optional().describe("partId from read_email's attachments list."),
      filename: z.string().optional().describe("Attachment filename (case-insensitive) if partId is not known."),
      directory: z.string().optional().describe("Folder to save into (default: ~/Downloads/gmail-mcp). Created if missing."),
    },
    run: async ({ messageId, account, partId, filename, directory }) => {
      const { acc, value } = await findInAccounts(ctx, account, `Message ${messageId}`, async (g) => {
        const msg = await g.users.messages.get({ userId: "me", id: messageId, format: "full" });
        const payload = msg.data.payload ?? undefined;
        const atts = listAttachments(payload);
        let target = partId
          ? findPart(payload, (p) => p.partId === partId)
          : filename
            ? findPart(payload, (p) => (p.filename ?? "").toLowerCase() === filename.toLowerCase())
            : undefined;
        if (!target && !partId && !filename && atts.length === 1) target = findPart(payload, (p) => p.partId === atts[0].partId);
        if (!target || !target.filename) {
          throw new Error(
            atts.length
              ? `Attachment not found. Available: ${atts.map((a) => `${a.filename} (partId ${a.partId})`).join(", ")}`
              : "This email has no attachments."
          );
        }
        let data = target.body?.data ?? undefined;
        if (!data && target.body?.attachmentId) {
          const res = await g.users.messages.attachments.get({ userId: "me", messageId, id: target.body.attachmentId });
          data = res.data.data ?? undefined;
        }
        if (!data) throw new Error("Attachment has no data.");
        return { name: target.filename, buf: Buffer.from(data, "base64url"), mimeType: target.mimeType };
      });

      const dir = path.resolve(expandHome(directory ?? path.join(os.homedir(), "Downloads", "gmail-mcp")));
      fs.mkdirSync(dir, { recursive: true });
      const clean = safeFilename(value.name);
      const ext = path.extname(clean);
      const stem = clean.slice(0, clean.length - ext.length);
      let file = path.join(dir, clean);
      for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${stem} (${i})${ext}`);
      fs.writeFileSync(file, value.buf, { flag: "wx" });
      return { account: acc.alias, savedTo: file, filename: path.basename(file), mimeType: value.mimeType, bytes: value.buf.length };
    },
  });
}
