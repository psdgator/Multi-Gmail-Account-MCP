#!/usr/bin/env node
import * as readline from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AccountManager } from "./accounts.js";
import { AuditLog } from "./audit.js";
import { DEFAULT_MODE, Mode, MODES, parseMode } from "./config.js";
import { loadClientKeys, openBrowser, startAuthFlow } from "./oauth.js";
import { MailRegistry } from "./providers/registry.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

/** Extra CLI commands contributed by optional modules (IMAP, HTTP...). */
export type Command = (args: string[], mode: Mode) => Promise<void>;
export const extraCommands: Record<string, { help: string; run: Command }> = {};

const HELP = () => `gmail-mcp-multi ${VERSION} - mail MCP server for many accounts at once (Gmail + IMAP)

Usage:
  gmail-mcp-multi [--mode readonly|drafts|full]   Run the MCP server on stdio (default mode: ${DEFAULT_MODE})
  gmail-mcp-multi auth <alias> <email> [--mode M] [--calendar] [--manual]
                                                  Connect a Gmail account (opens a browser; --manual: paste the
                                                  redirect URL instead, for servers without a browser)
  gmail-mcp-multi accounts                        List connected accounts
  gmail-mcp-multi doctor                          Check setup and test every account
  gmail-mcp-multi default <alias>                 Set the default account
  gmail-mcp-multi limit <alias> <mode|none>       Cap one account to a lower mode
  gmail-mcp-multi remove <alias>                  Disconnect an account and delete its stored login
  gmail-mcp-multi audit [N] [--changes]           Show the last N logged actions (default 20)
  gmail-mcp-multi encrypt                         Encrypt any plain-text stored logins; show where the key lives
${Object.entries(extraCommands)
  .map(([, c]) => c.help)
  .join("\n")}
Modes:
  readonly  search and read only
  drafts    read + labels/archive/mark read + create drafts; never sends (default)
  full      everything, including send, trash, unsubscribe and filters

Files live in ~/.gmail-mcp (override with GMAIL_MCP_HOME). Put your Google OAuth
"Desktop app" client JSON at ~/.gmail-mcp/oauth-keys.json. Docs: https://github.com/psdgator/Multi-Gmail-Account-MCP
`;

export function takeFlag(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (i === -1) continue;
    const a = args[i];
    if (a.includes("=")) {
      args.splice(i, 1);
      return a.slice(a.indexOf("=") + 1);
    }
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  }
  return undefined;
}

export function takeBool(args: string[], ...names: string[]): boolean {
  let found = false;
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1) {
      args.splice(i, 1);
      found = true;
    }
  }
  return found;
}

function resolveMode(args: string[]): Mode {
  const flag = takeFlag(args, "--mode", "-m");
  const ro = takeBool(args, "--readonly", "-r") || process.env.GMAIL_MCP_READONLY === "1";
  if (ro) return "readonly";
  return parseMode(flag ?? process.env.GMAIL_MCP_MODE, DEFAULT_MODE);
}

export async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  // Optional modules register their commands/tools when present.
  await import("./extensions.js").catch((e) => {
    if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e;
  });

  const args = process.argv.slice(2);
  if (takeBool(args, "--help", "-h", "help")) {
    process.stdout.write(HELP());
    return;
  }
  if (takeBool(args, "--version", "-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const mode = resolveMode(args);
  const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "serve";

  if (extraCommands[cmd]) return extraCommands[cmd].run(args.slice(1), mode);

  switch (cmd) {
    case "serve": {
      const { server, ctx } = createServer(mode);
      await server.connect(new StdioServerTransport());
      console.error(`gmail-mcp-multi ${VERSION} running on stdio (${mode} mode)`);
      const shutdown = async () => {
        await ctx.mail.closeAll();
        process.exit(0);
      };
      process.stdin.on("close", shutdown);
      return;
    }

    case "auth": {
      const calendar = takeBool(args, "--calendar");
      const manual = takeBool(args, "--manual", "--no-browser");
      const allowDifferentEmail = takeBool(args, "--allow-different-email");
      const [, alias, email] = args;
      if (!alias) throw new Error("Usage: gmail-mcp-multi auth <alias> <email> [--mode readonly|drafts|full] [--calendar] [--manual]");
      const accounts = new AccountManager();
      const flow = await startAuthFlow(accounts, { alias, emailHint: email, mode, calendar, allowDifferentEmail });
      console.error(`\nSign in to Google for "${alias}"${email ? ` (${email})` : ""} with ${mode} permissions${calendar ? " + Calendar" : ""}.`);
      console.error(manual ? "Open this link in any browser:\n" : "If the browser does not open, paste this link into it:\n");
      console.error(flow.url + "\n");
      let r;
      if (manual) {
        console.error('After approving, the browser shows "This site can\'t be reached" at 127.0.0.1. Copy that whole address.');
        const pasted = await prompt("Paste the address here: ");
        r = await flow.completeFromRedirect(pasted);
      } else {
        openBrowser(flow.url);
        r = await flow.done;
      }
      console.error(`Connected ${r.email} as "${r.alias}" (login stored encrypted).`);
      console.error(`Granted: ${r.scopes.join(" ") || "(not reported)"}`);
      return;
    }

    case "accounts":
    case "list": {
      const list = new AccountManager().listAccounts();
      if (!list.length) {
        console.log("No accounts yet. Run: gmail-mcp-multi auth <alias> <email>");
        return;
      }
      for (const a of list) {
        console.log(
          `${a.isDefault ? "*" : " "} ${a.alias.padEnd(16)} ${a.email.padEnd(36)} ${(a.type ?? "gmail").padEnd(6)} ${a.authenticated ? "signed in" : "NOT signed in"}${a.calendar ? "  +calendar" : ""}${a.mode ? `  (limited to ${a.mode})` : ""}`
        );
      }
      return;
    }

    case "doctor": {
      const accounts = new AccountManager();
      console.log(`Config folder: ${accounts.root}`);
      const keys = accounts.getOAuthKeysPath();
      try {
        loadClientKeys(keys);
        console.log(`OAuth client:  OK (${keys})`);
      } catch (e) {
        const hasGmail = accounts.listAccounts().some((a) => (a.type ?? "gmail") === "gmail");
        console.log(`OAuth client:  ${hasGmail ? "MISSING" : "not set (only needed for Gmail accounts)"} - ${(e as Error).message}`);
      }
      const migrated = accounts.migrateCredentials();
      if (migrated.length) console.log(`Encrypted:     ${migrated.join(", ")} (were plain text)`);
      console.log(`Encryption:    AES-256-GCM, key in ${accounts.secrets.describe()}`);
      const audit = new AuditLog(accounts.root);
      console.log(`Audit log:     ${audit.enabled ? audit.file : "off"}`);
      const mail = new MailRegistry(accounts);
      const list = accounts.listAccounts();
      if (!list.length) console.log("Accounts:      none yet");
      for (const a of list) {
        try {
          const s = await mail.with(a, (p) => p.inboxStatus());
          console.log(`  OK   ${a.alias.padEnd(16)} ${(a.type ?? "gmail").padEnd(6)} ${a.email} (inbox: ${s.unread} unread / ${s.total})`);
        } catch (e) {
          console.log(`  FAIL ${a.alias.padEnd(16)} ${(a.type ?? "gmail").padEnd(6)} ${(e as Error).message}`);
        }
      }
      await mail.closeAll();
      return;
    }

    case "default": {
      const acc = new AccountManager().setDefault(args[1] ?? "");
      console.log(`Default account is now ${acc.alias} (${acc.email}).`);
      return;
    }

    case "limit": {
      const [, alias, m] = args;
      if (!alias || !m) throw new Error(`Usage: gmail-mcp-multi limit <alias> <${MODES.join("|")}|none>`);
      const acc = new AccountManager().setAccountMode(alias, m === "none" ? undefined : parseMode(m));
      console.log(acc.mode ? `${acc.alias} is limited to ${acc.mode}.` : `${acc.alias} has no per-account limit.`);
      return;
    }

    case "remove": {
      const removed = new AccountManager().removeAccount(args[1] ?? "");
      console.log(removed ? `Removed ${args[1]}.` : `No account "${args[1]}".`);
      return;
    }

    case "audit": {
      const onlyChanges = takeBool(args, "--changes");
      const n = Number(args[1] ?? 20) || 20;
      const audit = new AuditLog(new AccountManager().root);
      for (const e of audit.read({ limit: n, onlyChanges }).reverse()) {
        const what = e.args ? Object.entries(e.args).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(" ") : "";
        console.log(`${e.ts}  ${e.ok ? "ok  " : "FAIL"} ${e.tool.padEnd(18)} ${what}${e.error ? `  -> ${e.error}` : ""}`);
      }
      return;
    }

    case "encrypt": {
      const accounts = new AccountManager();
      const migrated = accounts.migrateCredentials();
      console.log(migrated.length ? `Encrypted: ${migrated.join(", ")}` : "All stored logins are already encrypted.");
      console.log(`Key location: ${accounts.secrets.describe()}`);
      return;
    }

    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP()}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
