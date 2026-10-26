#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AccountManager } from "./accounts.js";
import { DEFAULT_MODE, Mode, MODES, parseMode } from "./config.js";
import { GmailClient } from "./gmail.js";
import { openBrowser, startAuthFlow } from "./oauth.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `gmail-mcp-multi ${VERSION} - Gmail MCP server for many accounts at once

Usage:
  gmail-mcp-multi [--mode readonly|drafts|full]   Run the MCP server on stdio (default mode: ${DEFAULT_MODE})
  gmail-mcp-multi auth <alias> [email] [--mode M] Connect an account (opens a browser)
  gmail-mcp-multi accounts                        List connected accounts
  gmail-mcp-multi doctor                          Check setup and test every account
  gmail-mcp-multi default <alias>                 Set the default account
  gmail-mcp-multi limit <alias> <mode|none>       Cap one account to a lower mode
  gmail-mcp-multi remove <alias>                  Disconnect an account and delete its token

Modes:
  readonly  search and read only
  drafts    read + labels/archive/mark read + create drafts; never sends (default)
  full      everything, including send, trash and filters

Files live in ~/.gmail-mcp (override with GMAIL_MCP_HOME). Put your Google OAuth
"Desktop app" client JSON at ~/.gmail-mcp/oauth-keys.json.
`;

function takeFlag(args: string[], ...names: string[]): string | undefined {
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

function takeBool(args: string[], ...names: string[]): boolean {
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

async function main() {
  const args = process.argv.slice(2);
  if (takeBool(args, "--help", "-h", "help")) {
    process.stdout.write(HELP);
    return;
  }
  if (takeBool(args, "--version", "-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const mode = resolveMode(args);
  const cmd = args[0] ?? "serve";

  switch (cmd) {
    case "serve": {
      const { server } = createServer(mode);
      await server.connect(new StdioServerTransport());
      console.error(`gmail-mcp-multi ${VERSION} running on stdio (${mode} mode)`);
      return;
    }

    case "auth": {
      const [, alias, email] = args;
      if (!alias) throw new Error("Usage: gmail-mcp-multi auth <alias> [email] [--mode readonly|drafts|full]");
      const accounts = new AccountManager();
      const flow = await startAuthFlow(accounts, { alias, emailHint: email, mode });
      console.error(`\nSign in to Google for "${alias}" (${mode} permissions).`);
      console.error("If the browser does not open, paste this link into it:\n");
      console.error(flow.url + "\n");
      openBrowser(flow.url);
      const r = await flow.done;
      console.error(`Connected ${r.email} as "${r.alias}".`);
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
          `${a.isDefault ? "*" : " "} ${a.alias.padEnd(16)} ${a.email.padEnd(36)} ${a.authenticated ? "signed in" : "NOT signed in"}${a.mode ? `  (limited to ${a.mode})` : ""}`
        );
      }
      return;
    }

    case "doctor": {
      const accounts = new AccountManager();
      console.log(`Config folder: ${accounts.root}`);
      const keys = accounts.getOAuthKeysPath();
      try {
        (await import("./oauth.js")).loadClientKeys(keys);
        console.log(`OAuth client:  OK (${keys})`);
      } catch (e) {
        console.log(`OAuth client:  MISSING - ${(e as Error).message}`);
      }
      const gmail = new GmailClient(accounts);
      const list = accounts.listAccounts();
      if (!list.length) console.log("Accounts:      none yet");
      for (const a of list) {
        try {
          const p = await gmail.with(a, async (g) => (await g.users.getProfile({ userId: "me" })).data);
          console.log(`  OK   ${a.alias} -> ${p.emailAddress} (${p.messagesTotal} messages)`);
        } catch (e) {
          console.log(`  FAIL ${a.alias} -> ${(e as Error).message}`);
        }
      }
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

    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
