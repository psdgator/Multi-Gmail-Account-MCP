import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountManager } from "./accounts.js";
import type { Mode } from "./config.js";
import { GmailClient } from "./gmail.js";
import { registerAccountTools } from "./tools/accounts.js";
import { LabelCache, ToolContext } from "./tools/common.js";
import { registerComposeTools } from "./tools/compose.js";
import { registerOrganizeTools } from "./tools/organize.js";
import { registerReadTools } from "./tools/read.js";
import { VERSION } from "./version.js";

function instructions(ctx: ToolContext): string {
  const accounts = ctx.accounts.listAccounts();
  const list = accounts.length
    ? accounts.map((a) => `- ${a.alias}: ${a.email}${a.isDefault ? " (default)" : ""}${a.authenticated ? "" : " (not signed in yet)"}`).join("\n")
    : "- none yet: use the authenticate tool to connect one";
  const modeLine = {
    readonly: "READ-ONLY mode: you can search and read mail; nothing can be changed or sent.",
    drafts: "DRAFTS mode: you can read, organize (labels, read/unread, archive) and create drafts. Sending is disabled; the user sends drafts from Gmail.",
    full: "FULL mode: sending, trashing and filters are enabled. Only send when the user explicitly asks; otherwise create a draft.",
  }[ctx.mode];
  return [
    "Gmail access to several accounts at once.",
    "Connected accounts:",
    list,
    "",
    'Pick a mailbox with the "account" argument (alias or email). Search, inbox_summary, list_labels and list_drafts cover ALL accounts when account is omitted or "all"; results are tagged with their account. Always pass that account back when reading or acting on a message.',
    modeLine,
  ].join("\n");
}

export function createServer(mode: Mode, accounts = new AccountManager()): { server: McpServer; ctx: ToolContext } {
  const ctx: ToolContext = {
    accounts,
    gmail: new GmailClient(accounts),
    mode,
    labels: new LabelCache(),
    pendingAuth: new Map(),
  };
  const server = new McpServer({ name: "gmail-mcp-multi", version: VERSION }, { instructions: instructions(ctx) });
  registerAccountTools(server, ctx);
  registerReadTools(server, ctx);
  registerComposeTools(server, ctx);
  registerOrganizeTools(server, ctx);
  return { server, ctx };
}
