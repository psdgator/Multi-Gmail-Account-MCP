import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { gmail_v1 } from "@googleapis/gmail";
import { z } from "zod";
import type { AccountConfig } from "../accounts.js";
import { buildMime, loadAttachments, replySubject, splitAddresses } from "../mime.js";
import { header, htmlToText } from "../message.js";
import { DESTRUCTIVE, gmailUrl, register, requireMode, singleAccountArg, ToolContext, WRITES } from "./common.js";

const emailOf = (addr: string) => (addr.match(/<([^>]+)>/)?.[1] ?? addr).trim().toLowerCase();

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const textToHtml = (t: string) => `<div dir="auto">${escapeHtml(t).replace(/\r?\n/g, "<br>")}</div>`;

function composeShape(ctx: ToolContext) {
  return {
    account: singleAccountArg(ctx),
    to: z.union([z.string(), z.array(z.string())]).optional().describe('Recipients ("a@b.com" or "Name <a@b.com>"). Optional when replying.'),
    cc: z.union([z.string(), z.array(z.string())]).optional(),
    bcc: z.union([z.string(), z.array(z.string())]).optional(),
    subject: z.string().optional().describe('Subject. When replying, defaults to "Re: <original subject>".'),
    body: z.string().describe("Plain-text body (Greek and other languages are fine)."),
    html: z.string().optional().describe("Optional HTML version of the body."),
    from: z.string().optional().describe('Send-as address to use (must be configured in Gmail "Send mail as"). Defaults to the account address.'),
    replyToMessageId: z.string().optional().describe("Message id to reply to. Threads the email and fills in recipients and subject."),
    replyAll: z.boolean().optional().describe("When replying, also include the original To/Cc recipients (default false)."),
    attachments: z.array(z.string()).optional().describe("Absolute paths of local files to attach (max 25 MB total)."),
    includeSignature: z.boolean().optional().describe("Append the Gmail signature of the sending address (default true)."),
  };
}

type ComposeArgs = {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  body: string;
  html?: string;
  from?: string;
  replyToMessageId?: string;
  replyAll?: boolean;
  attachments?: string[];
  includeSignature?: boolean;
};

async function buildOutgoing(g: gmail_v1.Gmail, acc: AccountConfig, a: ComposeArgs) {
  const sendAs = (await g.users.settings.sendAs.list({ userId: "me" }).catch(() => undefined))?.data.sendAs ?? [];
  const own = new Set([acc.email.toLowerCase(), ...sendAs.map((s) => (s.sendAsEmail ?? "").toLowerCase()).filter(Boolean)]);

  let fromIdentity = sendAs.find((s) => s.isDefault) ?? sendAs.find((s) => (s.sendAsEmail ?? "").toLowerCase() === acc.email.toLowerCase());
  if (a.from) {
    const wanted = emailOf(a.from);
    const match = sendAs.find((s) => (s.sendAsEmail ?? "").toLowerCase() === wanted);
    if (!match && wanted !== acc.email.toLowerCase()) {
      const opts = sendAs.map((s) => s.sendAsEmail).filter(Boolean).join(", ") || acc.email;
      throw new Error(`"${a.from}" is not a send-as address of ${acc.alias}. Available: ${opts}`);
    }
    fromIdentity = match ?? fromIdentity;
  }

  let to = splitAddresses(a.to);
  let cc = splitAddresses(a.cc);
  let subject = a.subject;
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;

  if (a.replyToMessageId) {
    const orig = await g.users.messages.get({
      userId: "me",
      id: a.replyToMessageId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Reply-To", "Subject", "Message-ID", "Message-Id", "References"],
    });
    const h = orig.data.payload?.headers ?? undefined;
    threadId = orig.data.threadId ?? undefined;
    const origFrom = header(h, "Reply-To") ?? header(h, "From") ?? "";
    const origTo = splitAddresses(header(h, "To"));
    const origCc = splitAddresses(header(h, "Cc"));
    if (!to.length) {
      // Replying to something we sent ourselves: answer the original recipients instead.
      to = own.has(emailOf(origFrom)) ? origTo : splitAddresses(origFrom);
    }
    if (a.replyAll) {
      const taken = new Set(to.map(emailOf));
      for (const addr of [...origTo, ...origCc]) {
        const e = emailOf(addr);
        if (!own.has(e) && !taken.has(e)) {
          cc.push(addr);
          taken.add(e);
        }
      }
    }
    subject = subject ?? replySubject(header(h, "Subject"));
    const mid = header(h, "Message-ID") ?? header(h, "Message-Id");
    if (mid) {
      inReplyTo = mid;
      references = [header(h, "References"), mid].filter(Boolean).join(" ");
    }
  }

  if (!to.length && !cc.length && !splitAddresses(a.bcc).length) {
    throw new Error('No recipients. Pass "to" (or replyToMessageId).');
  }

  let text = a.body;
  let html = a.html;
  const signature = a.includeSignature === false ? "" : (fromIdentity?.signature ?? "").trim();
  if (signature) {
    html = `${html ?? textToHtml(text)}<br><br><div class="gmail_signature">${signature}</div>`;
    text = `${text}\n\n-- \n${htmlToText(signature)}`;
  }

  const fromHeader = a.from
    ? a.from
    : fromIdentity?.sendAsEmail && fromIdentity.sendAsEmail.toLowerCase() !== acc.email.toLowerCase()
      ? fromIdentity.displayName
        ? `${fromIdentity.displayName} <${fromIdentity.sendAsEmail}>`
        : fromIdentity.sendAsEmail
      : fromIdentity?.displayName
        ? `${fromIdentity.displayName} <${acc.email}>`
        : undefined;

  const raw = buildMime({
    from: fromHeader,
    to,
    cc,
    bcc: splitAddresses(a.bcc),
    subject: subject ?? "",
    text,
    html,
    inReplyTo,
    references,
    attachments: loadAttachments(a.attachments),
  });
  return { raw, threadId, to, cc, subject: subject ?? "", from: fromHeader ?? acc.email };
}

/** Small messages go inline as base64url JSON; large ones via media upload. */
const INLINE_LIMIT = 4 * 1024 * 1024;

export function registerComposeTools(server: McpServer, ctx: ToolContext): void {
  register(server, ctx, {
    name: "create_draft",
    title: "Create a draft",
    description:
      "Create a draft email in one account's Drafts folder (it is NOT sent). Supports replies (threaded, with recipients filled in), " +
      "reply-all, send-as addresses, the Gmail signature and local file attachments. Returns a link to open the draft in Gmail.",
    minMode: "drafts",
    annotations: WRITES,
    input: composeShape(ctx),
    run: async (args) => {
      const [acc] = ctx.accounts.resolve(args.account, false);
      requireMode(ctx, acc, "drafts", "create_draft");
      return ctx.gmail.with(acc, async (g) => {
        const out = await buildOutgoing(g, acc, args);
        const res =
          out.raw.length < INLINE_LIMIT
            ? await g.users.drafts.create({
                userId: "me",
                requestBody: { message: { raw: Buffer.from(out.raw).toString("base64url"), ...(out.threadId ? { threadId: out.threadId } : {}) } },
              })
            : await g.users.drafts.create({
                userId: "me",
                requestBody: { message: out.threadId ? { threadId: out.threadId } : {} },
                media: { mimeType: "message/rfc822", body: out.raw },
              });
        const messageId = res.data.message?.id ?? "";
        return {
          status: "draft_saved_not_sent",
          account: acc.alias,
          draftId: res.data.id,
          messageId,
          threadId: res.data.message?.threadId,
          from: out.from,
          to: out.to,
          ...(out.cc.length ? { cc: out.cc } : {}),
          subject: out.subject,
          openInGmail: gmailUrl(acc.email, `drafts?compose=${messageId}`),
        };
      });
    },
  });

  register(server, ctx, {
    name: "delete_draft",
    title: "Delete a draft",
    description: "Permanently delete a draft (by draftId from create_draft or list_drafts).",
    minMode: "drafts",
    annotations: DESTRUCTIVE,
    input: { draftId: z.string(), account: singleAccountArg(ctx) },
    run: async ({ draftId, account }) => {
      const [acc] = ctx.accounts.resolve(account, false);
      requireMode(ctx, acc, "drafts", "delete_draft");
      await ctx.gmail.with(acc, (g) => g.users.drafts.delete({ userId: "me", id: draftId }));
      return { account: acc.alias, deletedDraftId: draftId };
    },
  });

  register(server, ctx, {
    name: "send_email",
    title: "Send an email",
    description:
      "SEND an email immediately from one account (only available in full mode). Prefer create_draft unless the user explicitly asked to send. " +
      "Same options as create_draft.",
    minMode: "full",
    annotations: DESTRUCTIVE,
    input: composeShape(ctx),
    run: async (args) => {
      const [acc] = ctx.accounts.resolve(args.account, false);
      requireMode(ctx, acc, "full", "send_email");
      return ctx.gmail.with(acc, async (g) => {
        const out = await buildOutgoing(g, acc, args);
        const res =
          out.raw.length < INLINE_LIMIT
            ? await g.users.messages.send({
                userId: "me",
                requestBody: { raw: Buffer.from(out.raw).toString("base64url"), ...(out.threadId ? { threadId: out.threadId } : {}) },
              })
            : await g.users.messages.send({
                userId: "me",
                requestBody: out.threadId ? { threadId: out.threadId } : {},
                media: { mimeType: "message/rfc822", body: out.raw },
              });
        return { status: "sent", account: acc.alias, messageId: res.data.id, threadId: res.data.threadId, to: out.to, subject: out.subject };
      });
    },
  });

  register(server, ctx, {
    name: "send_draft",
    title: "Send a draft",
    description: "SEND an existing draft (only available in full mode).",
    minMode: "full",
    annotations: DESTRUCTIVE,
    input: { draftId: z.string(), account: singleAccountArg(ctx) },
    run: async ({ draftId, account }) => {
      const [acc] = ctx.accounts.resolve(account, false);
      requireMode(ctx, acc, "full", "send_draft");
      const res = await ctx.gmail.with(acc, (g) => g.users.drafts.send({ userId: "me", requestBody: { id: draftId } }));
      return { status: "sent", account: acc.alias, messageId: res.data.id, threadId: res.data.threadId };
    },
  });
}
