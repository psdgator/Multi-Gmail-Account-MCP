#!/usr/bin/env node
// Live smoke test against your real, connected accounts, through the MCP server
// exactly as Claude uses it. Read-only, unless you pass --draft (creates a draft
// to yourself in the default account and deletes it again).
//
//   node scripts/smoke.mjs [--draft] [--query "newer_than:7d"]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const doDraft = args.includes("--draft");
const qi = args.indexOf("--query");
const query = qi >= 0 ? args[qi + 1] : "newer_than:7d";
const cut = (s, n = 60) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js"), "--mode", "drafts"] }));

async function call(name, a = {}) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: a });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`${name}: ${text}`);
  return { ...JSON.parse(text), _ms: Date.now() - t0 };
}

const accounts = await call("list_accounts");
console.log(`\n== list_accounts (${accounts.serverMode} mode)`);
for (const a of accounts.accounts) console.log(`  ${a.default ? "*" : " "} ${a.alias.padEnd(14)} ${a.email.padEnd(30)} ${a.signedIn ? "signed in" : "NOT signed in"}`);

const sum = await call("inbox_summary", { latest: 3 });
console.log(`\n== inbox_summary, all accounts (${sum._ms} ms): ${sum.totalUnread} unread in total`);
for (const a of sum.accounts) {
  console.log(`  ${a.account}: ${a.inboxUnread} unread / ${a.inboxTotal} in inbox`);
  for (const m of a.latest) console.log(`     - ${m.date.slice(0, 10)}  ${cut(m.from, 28).padEnd(28)}  ${cut(m.subject, 50)}`);
}
for (const e of sum.errors ?? []) console.log(`  ERROR ${e.account}: ${e.error}`);

const s = await call("search_emails", { query, maxResults: 3 });
console.log(`\n== search_emails "${query}" across all accounts (${s._ms} ms), merged newest-first:`);
for (const m of s.results) console.log(`  [${m.account}] ${m.date.slice(0, 16).replace("T", " ")}  ${cut(m.subject, 55)}`);
for (const e of s.errors ?? []) console.log(`  ERROR ${e.account}: ${e.error}`);

if (s.results[0]) {
  const m = s.results[0];
  const r = await call("read_email", { messageId: m.id, account: m.account, maxBodyChars: 2000 });
  console.log(`\n== read_email ${m.account}/${m.id} (${r._ms} ms)`);
  console.log(`  subject: ${cut(r.subject, 70)}\n  body: ${r.body.length} chars (${r.bodyFormat})${r.bodyTruncated ? ", truncated" : ""}; attachments: ${r.attachments?.length ?? 0}`);
  const t = await call("read_thread", { threadId: m.threadId });
  console.log(`  thread: ${t.messageCount} message(s), found in ${t.account} without being told which account`);
}

const l = await call("list_labels", {});
console.log(`\n== list_labels: ${l.accounts.map((a) => `${a.account}=${a.labels.length}`).join(", ")}`);

if (doDraft) {
  const def = accounts.accounts.find((a) => a.default) ?? accounts.accounts[0];
  const d = await call("create_draft", {
    account: def.alias,
    to: def.email,
    subject: "gmail-mcp-multi smoke test — δοκιμή",
    body: "Test draft created by scripts/smoke.mjs. Γεια σου! It will be deleted automatically.",
  });
  console.log(`\n== create_draft in ${def.alias}: ${d.status}, draftId ${d.draftId}, from ${d.from}`);
  const del = await call("delete_draft", { account: def.alias, draftId: d.draftId });
  console.log(`== delete_draft: removed ${del.deletedDraftId}`);
}

await client.close();
console.log("\nSmoke test finished OK.");
