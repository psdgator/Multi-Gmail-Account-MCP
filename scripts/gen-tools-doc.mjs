#!/usr/bin/env node
// Generates docs/tools.md from the live server, so the reference never drifts
// from the code. Run after `npm run build`:  node scripts/gen-tools-doc.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-doc-"));
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ accounts: [{ alias: "work", email: "you@example.com", calendar: true }] }));

async function toolsIn(mode) {
  const client = new Client({ name: "docgen", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist", "index.js"), "--mode", mode],
      env: { ...process.env, GMAIL_MCP_HOME: home, GMAIL_MCP_KEYRING: "0", GMAIL_MCP_AUDIT: "off" },
      stderr: "ignore",
    })
  );
  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts().catch(() => ({ prompts: [] }));
  await client.close();
  return { tools, prompts };
}

const byMode = {};
for (const m of ["readonly", "drafts", "full"]) byMode[m] = await toolsIn(m);
const minMode = (name) => ["readonly", "drafts", "full"].find((m) => byMode[m].tools.some((t) => t.name === name));

const LOCAL_ONLY = new Set(["authenticate", "save_attachment"]);
const GROUPS = [
  ["Accounts & safety", ["list_accounts", "authenticate", "set_default_account", "view_audit_log"]],
  ["Reading (one or all accounts)", ["search_emails", "inbox_summary", "read_email", "read_thread", "read_attachment", "save_attachment", "list_labels", "list_drafts", "list_filters"]],
  ["Triage", ["needs_reply", "daily_digest", "find_newsletters", "find_contact"]],
  ["Writing", ["create_draft", "forward_email", "delete_draft", "send_email", "send_draft"]],
  ["Organizing & clean-up", ["modify_emails", "create_label", "bulk_cleanup", "unsubscribe", "trash_emails", "create_filter", "delete_filter"]],
  ["Calendar (accounts connected with calendar access)", ["list_events", "list_calendars", "find_free_time", "create_event"]],
];

const all = byMode.full.tools;
const known = new Set(GROUPS.flatMap(([, n]) => n));
const others = all.map((t) => t.name).filter((n) => !known.has(n));
if (others.length) GROUPS.push(["Other", others]);

const typeOf = (s) => {
  if (!s) return "";
  if (s.anyOf) return s.anyOf.map(typeOf).join(" or ");
  if (s.enum) return s.enum.map((v) => `\`${v}\``).join(" \\| ");
  if (s.type === "array") return `${typeOf(s.items)}[]`;
  return s.type ?? "";
};
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

let md = `# Tool reference

_Generated from the server by \`node scripts/gen-tools-doc.mjs\`. Do not edit by hand._

Every tool that reads mail takes an optional \`account\`: an alias, an email address, a list, or \`"all"\`.
**Multi-account** tools use every connected account when \`account\` is omitted; single-account tools use the default account.

**Mode** is the lowest server mode that offers the tool (\`readonly\` < \`drafts\` < \`full\`). A per-account limit can lower it further.
Tools marked *local only* are not offered in hosted (HTTP) mode.

`;

for (const [title, names] of GROUPS) {
  const tools = names.map((n) => all.find((t) => t.name === n)).filter(Boolean);
  if (!tools.length) continue;
  md += `## ${title}\n\n| Tool | Mode | What it does |\n|---|---|---|\n`;
  for (const t of tools) {
    const multi = /ALL connected accounts|all accounts|ALL accounts/i.test(JSON.stringify(t.inputSchema?.properties?.account ?? {})) ? " · multi-account" : "";
    md += `| [\`${t.name}\`](#${t.name}) | ${minMode(t.name)}${multi}${LOCAL_ONLY.has(t.name) ? " · local only" : ""} | ${esc(t.annotations?.title ?? t.title ?? "")} |\n`;
  }
  md += "\n";
  for (const t of tools) {
    md += `### ${t.name}\n\n${t.description}\n\n`;
    const props = t.inputSchema?.properties ?? {};
    const req = new Set(t.inputSchema?.required ?? []);
    const rows = Object.entries(props);
    if (rows.length) {
      md += `| Parameter | Type | Required | Description |\n|---|---|---|---|\n`;
      for (const [name, s] of rows) {
        const desc = name === "account" ? (String(s.description).startsWith("Which mailbox") ? "Alias, email, list, or `\"all\"`. Default: all accounts." : "Alias or email. Default: the default account.") : s.description;
        md += `| \`${name}\` | ${esc(typeOf(s))} | ${req.has(name) ? "yes" : ""} | ${esc(desc)} |\n`;
      }
      md += "\n";
    }
    const a = t.annotations ?? {};
    md += `_${a.readOnlyHint ? "Read-only." : a.destructiveHint ? "Changes or removes data; Claude should confirm with you first." : "Makes changes."}_\n\n`;
  }
}

const prompts = byMode.full.prompts;
if (prompts.length) {
  md += `## Prompts (slash commands)\n\n| Prompt | What it does | Arguments |\n|---|---|---|\n`;
  for (const p of prompts) md += `| \`${p.name}\` | ${esc(p.description)} | ${(p.arguments ?? []).map((a) => `\`${a.name}\``).join(", ")} |\n`;
  md += "\n";
}

fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "tools.md"), md);
fs.rmSync(home, { recursive: true, force: true });
console.log(`docs/tools.md: ${all.length} tools, ${prompts.length} prompts`);
