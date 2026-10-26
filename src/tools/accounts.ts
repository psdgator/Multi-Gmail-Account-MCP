import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateAlias } from "../accounts.js";
import { MODES, modeAllows } from "../config.js";
import { openBrowser, startAuthFlow } from "../oauth.js";
import { accountMode, READ_ONLY, register, singleAccountArg, ToolContext, WRITES } from "./common.js";

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  register(server, ctx, {
    name: "list_accounts",
    title: "List Gmail accounts",
    description:
      "List the connected Gmail accounts (alias, email, signed-in status, default, permission mode). Call this when unsure which accounts exist or what alias the user means.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {},
    run: async () => {
      const list = ctx.accounts.listAccounts().map((a) => {
        const pending = ctx.pendingAuth.get(a.alias);
        return {
          alias: a.alias,
          email: a.email,
          signedIn: a.authenticated,
          default: a.isDefault,
          mode: accountMode(ctx, a),
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
        tip: 'Use an alias or email in the "account" argument, or "all" for every mailbox.',
      };
    },
  });

  register(server, ctx, {
    name: "authenticate",
    title: "Connect a Gmail account",
    description:
      "Connect (or re-connect) a Gmail account. Opens Google sign-in in the user's browser on this computer and returns immediately with the sign-in link; " +
      "the account becomes available once the user approves in the browser. Afterwards call list_accounts to confirm.",
    minMode: "readonly",
    annotations: WRITES,
    input: {
      alias: z.string().describe('Short friendly name for the account, e.g. "work", "personal", "urbanstickers".'),
      email: z.string().optional().describe("The Gmail address, used to pre-select the right Google account."),
      mode: z
        .enum(MODES)
        .optional()
        .describe("Permissions to request from Google. Defaults to the server mode. Cannot exceed the server mode."),
    },
    run: async ({ alias, email, mode }) => {
      const a = validateAlias(alias);
      const want = mode ?? ctx.mode;
      if (!modeAllows(ctx.mode, want)) throw new Error(`The server runs in ${ctx.mode} mode; cannot request ${want}.`);
      ctx.pendingAuth.get(a)?.flow.cancel();
      const flow = await startAuthFlow(ctx.accounts, { alias: a, emailHint: email, mode: want });
      const entry: { flow: typeof flow; startedAt: number; result?: string } = { flow, startedAt: Date.now() };
      ctx.pendingAuth.set(a, entry);
      flow.done
        .then((r) => {
          ctx.gmail.forget(a);
          ctx.labels.invalidate(a);
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
        message:
          "A Google sign-in page should have opened in the browser. Ask the user to approve access there " +
          "(if the browser did not open, give them the link below). Then call list_accounts to confirm.",
        signInUrl: flow.url,
      };
    },
  });

  register(server, ctx, {
    name: "set_default_account",
    title: "Set default Gmail account",
    description: "Choose which account single-account tools use when no account is given.",
    minMode: "readonly",
    annotations: WRITES,
    input: { account: singleAccountArg(ctx).unwrap().describe("Alias or email of the new default account.") },
    run: async ({ account }) => {
      const acc = ctx.accounts.setDefault(account);
      return { default: acc.alias, email: acc.email };
    },
  });
}
