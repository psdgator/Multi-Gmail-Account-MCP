import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { gmail_v1 } from "@googleapis/gmail";
import type { AccountConfig, AccountManager } from "../accounts.js";
import { minMode, Mode, modeAllows } from "../config.js";
import type { GmailClient } from "../gmail.js";
import type { LabelNames } from "../message.js";
import type { AuthFlow } from "../oauth.js";

export interface ToolContext {
  accounts: AccountManager;
  gmail: GmailClient;
  /** The server-wide ceiling chosen at startup (--mode). */
  mode: Mode;
  labels: LabelCache;
  pendingAuth: Map<string, { flow: AuthFlow; startedAt: number; result?: string }>;
}

export function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/** Effective mode for an account: the server mode, lowered by a per-account cap. */
export function accountMode(ctx: ToolContext, acc: AccountConfig): Mode {
  return acc.mode ? minMode(ctx.mode, acc.mode) : ctx.mode;
}

export function requireMode(ctx: ToolContext, acc: AccountConfig, need: Mode, tool: string): void {
  const have = accountMode(ctx, acc);
  if (!modeAllows(have, need)) {
    throw new Error(`"${tool}" needs ${need} mode, but "${acc.alias}" is limited to ${have}.`);
  }
}

function accountList(ctx: ToolContext): string {
  const list = ctx.accounts.listAccounts();
  if (!list.length) return "No accounts connected yet.";
  return `Connected: ${list.map((a) => `${a.alias} = ${a.email}${a.isDefault ? " (default)" : ""}`).join("; ")}.`;
}

/** `account` argument for tools that can read several mailboxes at once. */
export function multiAccountArg(ctx: ToolContext) {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      `Which mailbox(es): an alias, an email address, a list of them, or "all". Omit to use ALL connected accounts. ${accountList(ctx)}`
    );
}

/** `account` argument for tools that act on exactly one mailbox. */
export function singleAccountArg(ctx: ToolContext) {
  return z
    .string()
    .optional()
    .describe(`Account alias or email address. Omit to use the default account. ${accountList(ctx)}`);
}

export interface ToolDef<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Minimum server mode needed for this tool to be offered at all. */
  minMode: Mode;
  annotations?: ToolAnnotations;
  input: Shape;
  run: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<unknown>;
}

export function register<Shape extends z.ZodRawShape>(server: McpServer, ctx: ToolContext, def: ToolDef<Shape>): boolean {
  if (!modeAllows(ctx.mode, def.minMode)) return false;
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      annotations: { title: def.title, ...def.annotations },
    },
    (async (args: z.objectOutputType<Shape, z.ZodTypeAny>) => {
      try {
        return ok(await def.run(args));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }) as never
  );
  return true;
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
export const WRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** Per-account label id <-> name cache (labels rarely change). */
export class LabelCache {
  private cache = new Map<string, { at: number; byId: LabelNames; byName: Map<string, string> }>();
  constructor(private ttlMs = 5 * 60 * 1000) {}

  async get(alias: string, g: gmail_v1.Gmail): Promise<{ byId: LabelNames; byName: Map<string, string> }> {
    const hit = this.cache.get(alias);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit;
    const res = await g.users.labels.list({ userId: "me" });
    const byId: LabelNames = new Map();
    const byName = new Map<string, string>();
    for (const l of res.data.labels ?? []) {
      if (!l.id || !l.name) continue;
      if (l.type !== "system") byId.set(l.id, l.name);
      byName.set(l.name.toLowerCase(), l.id);
      byName.set(l.id.toLowerCase(), l.id);
    }
    const entry = { at: Date.now(), byId, byName };
    this.cache.set(alias, entry);
    return entry;
  }

  invalidate(alias: string): void {
    this.cache.delete(alias);
  }
}

/** Gmail's web URL for a mailbox (selects the right account by email). */
export function gmailUrl(email: string, fragment: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#${fragment}`;
}
