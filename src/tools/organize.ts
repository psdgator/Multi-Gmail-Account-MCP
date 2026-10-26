import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { gmail_v1 } from "@googleapis/gmail";
import { z } from "zod";
import type { AccountConfig } from "../accounts.js";
import { mapLimit } from "../gmail.js";
import { DESTRUCTIVE, register, requireMode, singleAccountArg, ToolContext, WRITES } from "./common.js";

async function resolveLabels(ctx: ToolContext, g: gmail_v1.Gmail, acc: AccountConfig, names: string[] | undefined): Promise<string[]> {
  if (!names?.length) return [];
  const { byName } = await ctx.labels.get(acc.alias, g);
  return names.map((n) => {
    const id = byName.get(n.trim().toLowerCase());
    if (!id) throw new Error(`Label "${n}" does not exist in ${acc.alias}. Use list_labels, or create_label first.`);
    return id;
  });
}

export function registerOrganizeTools(server: McpServer, ctx: ToolContext): void {
  register(server, ctx, {
    name: "modify_emails",
    title: "Label / mark / archive emails",
    description:
      "Change messages in one account: mark read/unread, star/unstar, archive (remove from Inbox), move back to Inbox, or add/remove labels " +
      "(by label name or id). Accepts up to 1000 message ids at once. Never deletes anything.",
    minMode: "drafts",
    annotations: WRITES,
    input: {
      messageIds: z.array(z.string()).min(1).max(1000),
      account: singleAccountArg(ctx),
      markRead: z.boolean().optional(),
      markUnread: z.boolean().optional(),
      star: z.boolean().optional(),
      unstar: z.boolean().optional(),
      archive: z.boolean().optional().describe("Remove from Inbox (the mail stays in All Mail)."),
      moveToInbox: z.boolean().optional(),
      addLabels: z.array(z.string()).optional().describe("Label names or ids to add."),
      removeLabels: z.array(z.string()).optional().describe("Label names or ids to remove."),
    },
    run: async (a) => {
      const [acc] = ctx.accounts.resolve(a.account, false);
      requireMode(ctx, acc, "drafts", "modify_emails");
      return ctx.gmail.with(acc, async (g) => {
        const add = new Set(await resolveLabels(ctx, g, acc, a.addLabels));
        const remove = new Set(await resolveLabels(ctx, g, acc, a.removeLabels));
        if (a.markRead) remove.add("UNREAD");
        if (a.markUnread) add.add("UNREAD");
        if (a.star) add.add("STARRED");
        if (a.unstar) remove.add("STARRED");
        if (a.archive) remove.add("INBOX");
        if (a.moveToInbox) add.add("INBOX");
        for (const id of add) if (remove.has(id)) throw new Error(`Conflicting changes for label ${id}.`);
        if (!add.size && !remove.size) throw new Error("Nothing to change.");
        await g.users.messages.batchModify({
          userId: "me",
          requestBody: { ids: a.messageIds, addLabelIds: [...add], removeLabelIds: [...remove] },
        });
        return { account: acc.alias, modified: a.messageIds.length, added: [...add], removed: [...remove] };
      });
    },
  });

  register(server, ctx, {
    name: "create_label",
    title: "Create a label",
    description: 'Create a Gmail label (folder). Use "Parent/Child" for nested labels.',
    minMode: "drafts",
    annotations: WRITES,
    input: { name: z.string().min(1), account: singleAccountArg(ctx) },
    run: async ({ name, account }) => {
      const [acc] = ctx.accounts.resolve(account, false);
      requireMode(ctx, acc, "drafts", "create_label");
      const res = await ctx.gmail.with(acc, (g) =>
        g.users.labels.create({ userId: "me", requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } })
      );
      ctx.labels.invalidate(acc.alias);
      return { account: acc.alias, id: res.data.id, name: res.data.name };
    },
  });

  register(server, ctx, {
    name: "trash_emails",
    title: "Move emails to Trash",
    description: "Move messages to Trash in one account (recoverable for 30 days). Only available in full mode.",
    minMode: "full",
    annotations: DESTRUCTIVE,
    input: { messageIds: z.array(z.string()).min(1).max(500), account: singleAccountArg(ctx) },
    run: async ({ messageIds, account }) => {
      const [acc] = ctx.accounts.resolve(account, false);
      requireMode(ctx, acc, "full", "trash_emails");
      await ctx.gmail.with(acc, (g) => mapLimit(messageIds, 8, (id) => g.users.messages.trash({ userId: "me", id })));
      return { account: acc.alias, trashed: messageIds.length };
    },
  });

  register(server, ctx, {
    name: "create_filter",
    title: "Create a filter",
    description:
      "Create a Gmail filter (rule for incoming mail) in one account. Only available in full mode. " +
      "Actions: add labels (names or ids), markRead, archive, star, neverSpam, forward is not supported.",
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
      return ctx.gmail.with(acc, async (g) => {
        const add = await resolveLabels(ctx, g, acc, a.addLabels);
        if (a.star) add.push("STARRED");
        const remove: string[] = [];
        if (a.markRead) remove.push("UNREAD");
        if (a.archive) remove.push("INBOX");
        if (a.neverSpam) remove.push("SPAM");
        const criteria = { from: a.from, to: a.to, subject: a.subject, query: a.query, hasAttachment: a.hasAttachment };
        if (!Object.values(criteria).some((v) => v !== undefined)) throw new Error("A filter needs at least one criterion.");
        if (!add.length && !remove.length) throw new Error("A filter needs at least one action.");
        const res = await g.users.settings.filters.create({
          userId: "me",
          requestBody: { criteria, action: { addLabelIds: add, removeLabelIds: remove } },
        });
        return { account: acc.alias, filter: res.data };
      });
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
      await ctx.gmail.with(acc, (g) => g.users.settings.filters.delete({ userId: "me", id: filterId }));
      return { account: acc.alias, deletedFilterId: filterId };
    },
  });
}
