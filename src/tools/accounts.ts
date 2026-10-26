import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateAlias } from "../accounts.js";
import { MODES, modeAllows } from "../config.js";
import { openBrowser, startAuthFlow } from "../oauth.js";
import { accountMode, READ_ONLY, register, singleAccountArg, ToolContext, WRITES } from "./common.js";

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  register(server, ctx, {
    name: "list_accounts",
    title: "List mail accounts",
    description:
      "List the connected mail accounts (alias, email, Gmail or IMAP, signed-in status, default, permission mode, calendar access). Call this when unsure which accounts exist or what alias the user means.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {},
    run: async () => {
      const list = ctx.accounts.listAccounts().map((a) => {
        const pending = ctx.pendingAuth.get(a.alias);
        return {
          alias: a.alias,
          email: a.email,
          type: a.type ?? "gmail",
          signedIn: a.authenticated,
          default: a.isDefault,
          mode: accountMode(ctx, a),
          ...(a.calendar ? { calendar: true } : {}),
          ...(pending && !a.authenticated ? { signInPending: true } : {}),
        };
      });
      const pendingNew = [...ctx.pendingAuth.entries()]
        .filter(([alias]) => !list.some((a) => a.alias === alias))
        .map(([alias, p]) => ({ alias, status: p.result ?? "waiting for browser sign-in" }));
      return {
        serverMode: ctx.mode,
        accounts: list,
        ...(pendingNew.length ? { pendingSignIns: pendingNew } : {}),
        tip:
          'Use an alias or email in the "account" argument, or "all" for every mailbox.' +
          (ctx.transport === "http" ? " New accounts are added on the server with the gmail-mcp-multi CLI." : ""),
      };
    },
  });

  register(server, ctx, {
    name: "authenticate",
    title: "Connect a Gmail account",
    description:
      "Connect (or re-connect) a Gmail account. Opens Google sign-in in the user's browser on this computer and returns immediately with the sign-in link; " +
      "the account becomes available once the user approves in the browser. If a different Google account signs in than the email given, nothing is saved. " +
      "Set calendar=true to also allow Google Calendar. Afterwards call list_accounts to confirm. (IMAP mailboxes are added with the CLI: gmail-mcp-multi add-imap.)",
    minMode: "readonly",
    when: (c) => c.transport === "stdio",
    annotations: WRITES,
    input: {
      alias: z.string().describe('Short friendly name for the account, e.g. "work", "personal", "urbanstickers".'),
      email: z.string().optional().describe("The Gmail address. Strongly recommended: sign-ins from any other Google account are rejected."),
      mode: z.enum(MODES).optional().describe("Permissions to request from Google. Defaults to the server mode. Cannot exceed the server mode."),
      calendar: z.boolean().optional().describe("Also request Google Calendar access (read; plus create events in full mode)."),
    },
    run: async ({ alias, email, mode, calendar }) => {
      const a = validateAlias(alias);
      const want = mode ?? ctx.mode;
      if (!modeAllows(ctx.mode, want)) throw new Error(`The server runs in ${ctx.mode} mode; cannot request ${want}.`);
      const existing = ctx.accounts.getAccount(a);
      if (existing && existing.type === "imap") throw new Error(`"${a}" is an IMAP account; use the CLI (gmail-mcp-multi add-imap) to change it.`);
      ctx.pendingAuth.get(a)?.flow.cancel();
      const flow = await startAuthFlow(ctx.accounts, { alias: a, emailHint: email ?? existing?.email, mode: want, calendar: calendar ?? existing?.calendar });
      const entry: { flow: typeof flow; startedAt: number; result?: string } = { flow, startedAt: Date.now() };
      ctx.pendingAuth.set(a, entry);
      flow.done
        .then((r) => {
          ctx.mail.forget(a);
          entry.result = `connected ${r.email}`;
          ctx.pendingAuth.delete(a);
        })
        .catch((err) => {
          entry.result = `failed: ${(err as Error).message}`;
        });
      openBrowser(flow.url);
      return {
        status: "waiting_for_user",
        alias: a,
        requestedMode: want,
        calendar: Boolean(calendar ?? existing?.calendar),
        message:
          "A Google sign-in page should have opened in the browser. Ask the user to approve access there " +
          "(if the browser did not open, give them the link below). Then call list_accounts to confirm.",
        signInUrl: flow.url,
      };
    },
  });

  register(server, ctx, {
    name: "set_default_account",
    title: "Set default account",
    description: "Choose which account single-account tools use when no account is given.",
    minMode: "readonly",
    annotations: WRITES,
    input: { account: singleAccountArg(ctx).unwrap().describe("Alias or email of the new default account.") },
    run: async ({ account }) => {
      const acc = ctx.accounts.setDefault(account);
      return { default: acc.alias, email: acc.email };
    },
  });

  register(server, ctx, {
    name: "view_audit_log",
    title: "View the audit log",
    description:
      "Show what this mail server has done: every tool call with time, account, identifying details (ids, recipients, subject, query; never email bodies) and success/failure. " +
      'Use it to answer "what did you change / send / draft?". Newest first.',
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {
      limit: z.number().int().min(1).max(500).optional().describe("How many entries (default 30)."),
      onlyChanges: z.boolean().optional().describe("Hide read-only calls such as searches (default false)."),
      tool: z.string().optional().describe("Only this tool, e.g. create_draft."),
      account: z.string().optional().describe("Only calls that targeted this account alias/email."),
      since: z.string().optional().describe("Only entries at/after this ISO time, e.g. 2026-10-26T00:00:00Z."),
    },
    run: async ({ limit, onlyChanges, tool, account, since }) => {
      if (!ctx.audit.enabled) return { enabled: false, note: "Audit logging is turned off (GMAIL_MCP_AUDIT=off)." };
      const entries = ctx.audit.read({ limit: limit ?? 30, onlyChanges, tool, account, since });
      return { file: ctx.audit.file, count: entries.length, entries };
    },
  });
}
