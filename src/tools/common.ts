import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AccountConfig, AccountManager } from "../accounts.js";
import { AuditLog, READ_ONLY_TOOLS, redact } from "../audit.js";
import { minMode, Mode, modeAllows } from "../config.js";
import type { AuthFlow } from "../oauth.js";
import type { MailRegistry } from "../providers/registry.js";

export interface ToolContext {
  accounts: AccountManager;
  mail: MailRegistry;
  /** The server-wide ceiling chosen at startup (--mode). */
  mode: Mode;
  audit: AuditLog;
  /** "stdio" (local) or "http" (hosted); some tools behave differently when hosted. */
  transport: "stdio" | "http";
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
  return `Connected: ${list.map((a) => `${a.alias} = ${a.email}${a.type === "imap" ? " (IMAP)" : ""}${a.isDefault ? " (default)" : ""}`).join("; ")}.`;
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

/** A tool result that is not JSON (e.g. an image for Claude to look at). */
export class RawResult {
  constructor(readonly result: CallToolResult) {}
}

export interface ToolDef<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Minimum server mode needed for this tool to be offered at all. */
  minMode: Mode;
  /** Only offer the tool when this returns true (e.g. not in hosted mode). */
  when?: (ctx: ToolContext) => boolean;
  annotations?: ToolAnnotations;
  input: Shape;
  run: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<unknown>;
}

function accountsIn(args: Record<string, unknown> | undefined): string[] | undefined {
  const a = args?.account;
  if (a === undefined) return undefined;
  return Array.isArray(a) ? a.map(String) : String(a).split(",").map((s) => s.trim());
}

export function register<Shape extends z.ZodRawShape>(server: McpServer, ctx: ToolContext, def: ToolDef<Shape>): boolean {
  if (!modeAllows(ctx.mode, def.minMode)) return false;
  if (def.when && !def.when(ctx)) return false;
  if (def.annotations?.readOnlyHint) READ_ONLY_TOOLS.add(def.name);
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      annotations: { title: def.title, ...def.annotations },
    },
    (async (args: z.objectOutputType<Shape, z.ZodTypeAny>) => {
      const started = Date.now();
      const base = { tool: def.name, mode: ctx.mode, via: ctx.transport, accounts: accountsIn(args as Record<string, unknown>), args: redact(args as Record<string, unknown>) };
      try {
        const value = await def.run(args);
        ctx.audit.record({ ...base, ok: true, ms: Date.now() - started });
        return value instanceof RawResult ? value.result : ok(value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.audit.record({ ...base, ok: false, error: message.slice(0, 300), ms: Date.now() - started });
        return fail(message);
      }
    }) as never
  );
  return true;
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
export const WRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** Sort newest first and merge copies of the same email found in several accounts. */
export function mergeAndDedupe<T extends { date: string; account: string; rfcMessageId?: string; alsoIn?: string[] }>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const seen = new Map<string, T>();
  const out: T[] = [];
  for (const m of sorted) {
    const key = m.rfcMessageId?.trim().toLowerCase();
    if (key) {
      const first = seen.get(key);
      if (first) {
        if (first.account !== m.account) {
          first.alsoIn = [...new Set([...(first.alsoIn ?? []), m.account])];
        }
        continue;
      }
      seen.set(key, m);
    }
    out.push(m);
  }
  return out;
}
