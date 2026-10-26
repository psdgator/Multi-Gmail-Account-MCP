import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DESTRUCTIVE, register, requireMode, singleAccountArg, ToolContext, WRITES } from "./common.js";

export function registerOrganizeTools(server: McpServer, ctx: ToolContext): void {
  register(server, ctx, {
    name: "modify_emails",
    title: "Label / mark / archive emails",
    description:
      "Change messages in one account: mark read/unread, star/unstar, archive (remove from Inbox), move back to Inbox, or add/remove labels " +
      "(by label name or id; for IMAP accounts labels are folders). Accepts up to 1000 message ids at once. Never deletes anything.",
    minMode: "drafts",
    annotations: WRITES,
    input: {
      messageIds: z.array(z.string()).min(1).max(1000),
      account: singleAccountArg(ctx),
      markRead: z.boolean().optional(),
      markUnread: z.boolean().optional(),
      star: z.boolean().optional(),
      unstar: z.boolean().optional(),
      archive: z.boolean().optional().describe("Remove from Inbox (the mail stays in All Mail / Archive)."),
      moveToInbox: z.boolean().optional(),
      addLabels: z.array(z.string()).optional().describe("Label names or ids to add."),
      removeLabels: z.array(z.string()).optional().describe("Label names or ids to remove."),
    },
    run: async ({ account, messageIds, ...changes }) => {
      const [acc] = ctx.accounts.resolve(account, false);
      requireMode(ctx, acc, "drafts", "modify_emails");
      const r = await ctx.mail.with(acc, (p) => p.modify(messageIds, changes));
      return { account: acc.alias, modified: messageIds.length, ...r };
    },
  });

  register(server, ctx, {
    name: "create_label",
    title: "Create a label / folder",
    description: 'Create a Gmail label (or IMAP folder). Use "Parent/Child" for nested labels.',
    minMode: "drafts",
    annotations: WRITES,
    input: { name: z.string().min(1), account: singleAccountArg(ctx) },
    run: async ({ name, account }) => {
      const [acc] = ctx.accounts.resolve(account, false);
      requireMode(ctx, acc, "drafts", "create_label");
      const label = await ctx.mail.with(acc, (p) => p.createLabel(name));
      return { account: acc.alias, ...label };
    },
  });

  register(server, ctx, {
    name: "trash_emails",
    title: "Move emails to Trash",
    description: "Move messages to Trash in one account (recoverable for 30 days in Gmail). Only available in full mode.",
    minMode: "full",
    annotations: DESTRUCTIVE,
    input: { messageIds: z.array(z.string()).min(1).max(500), account: singleAccountArg(ctx) },
    run: async ({ messageIds, account }) => {
      const [acc] = ctx.accounts.resolve(account, false);
      requireMode(ctx, acc, "full", "trash_emails");
      const n = await ctx.mail.with(acc, (p) => p.trash(messageIds));
      return { account: acc.alias, trashed: n };
    },
  });

  register(server, ctx, {
    name: "create_filter",
    title: "Create a filter",
    description:
      "Create a Gmail filter (rule for incoming mail) in one Gmail account. Only available in full mode. " +
      "Actions: add labels (names or ids), markRead, archive, star, neverSpam. Forwarding is not supported.",
    minMode: "full",
    annotations: WRITES,
    input: {
      account: singleAccountArg(ctx),
      from: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
      query: z.string().optional().describe("Gmail search query the message must match."),
      hasAttachment: z.boolean().optional(),
      addLabels: z.array(z.string()).optional(),
      markRead: z.boolean().optional(),
      archive: z.boolean().optional(),
      star: z.boolean().optional(),
      neverSpam: z.boolean().optional(),
    },
    run: async (a) => {
      const [acc] = ctx.accounts.resolve(a.account, false);
      requireMode(ctx, acc, "full", "create_filter");
      const g = ctx.mail.gmail(acc);
      try {
        const add = await g.resolveLabelIds(a.addLabels);
        if (a.star) add.push("STARRED");
        const remove: string[] = [];
        if (a.markRead) remove.push("UNREAD");
        if (a.archive) remove.push("INBOX");
        if (a.neverSpam) remove.push("SPAM");
        const criteria = { from: a.from, to: a.to, subject: a.subject, query: a.query, hasAttachment: a.hasAttachment };
        if (!Object.values(criteria).some((v) => v !== undefined)) throw new Error("A filter needs at least one criterion.");
        if (!add.length && !remove.length) throw new Error("A filter needs at least one action.");
        const res = await g.api.users.settings.filters.create({ userId: "me", requestBody: { criteria, action: { addLabelIds: add, removeLabelIds: remove } } });
        return { account: acc.alias, filter: res.data };
      } catch (err) {
        throw g.explain(err);
      }
    },
  });

  register(server, ctx, {
    name: "delete_filter",
    title: "Delete a filter",
    description: "Delete a Gmail filter by id (from list_filters). Only available in full mode.",
    minMode: "full",
    annotations: DESTRUCTIVE,
    input: { filterId: z.string(), account: singleAccountArg(ctx) },
    run: async ({ filterId, account }) => {
      const [acc] = ctx.accounts.resolve(account, false);
      requireMode(ctx, acc, "full", "delete_filter");
      const g = ctx.mail.gmail(acc);
      await g.api.users.settings.filters.delete({ userId: "me", id: filterId }).catch((e) => {
        throw g.explain(e);
      });
      return { account: acc.alias, deletedFilterId: filterId };
    },
  });
}
