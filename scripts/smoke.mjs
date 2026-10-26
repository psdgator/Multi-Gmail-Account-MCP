#!/usr/bin/env node
// Live smoke test against your real, connected accounts, through the MCP server
// exactly as Claude uses it. Read-only (bulk_cleanup only previews), unless you pass
// --draft (creates a draft and a forward draft to yourself, then deletes them).
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

const nr = await call("needs_reply", { days: 14, maxPerAccount: 5 });
console.log(`\n== needs_reply (${nr._ms} ms): ${nr.count} waiting — ${nr.perAccount.map((a) => `${a.account}: ${a.waiting} (scanned ${a.scannedConversations}, skipped automated ${a.skippedAutomated})`).join("; ")}`);
for (const i of nr.items.slice(0, 5)) console.log(`  [${i.account}] waiting ${Math.round(i.waitingHours)}h  ${cut(i.from, 28).padEnd(28)}  ${cut(i.subject, 45)}${i.hasDraft ? "  (draft exists)" : ""}`);

const dg = await call("daily_digest", {});
console.log(`\n== daily_digest (${dg._ms} ms): ${JSON.stringify(dg.totals)}`);
for (const a of dg.accounts) console.log(`  ${a.account}: ${a.newSince.personal} personal, ${a.newSince.automated} automated in the last 24h; top automated: ${a.automatedSenders.slice(0, 3).map((s) => `${cut(s.from, 20)}×${s.count}`).join(", ") || "-"}`);

const nl = await call("find_newsletters", { days: 30, scanPerAccount: 100, top: 5 });
console.log(`\n== find_newsletters (${nl._ms} ms): scanned ${nl.emailsScanned}`);
for (const s2 of nl.senders) console.log(`  [${s2.account}] ${cut(s2.sender, 30).padEnd(30)} ×${s2.count}  one-click: ${s2.oneClick}`);

if (s.results[0]) {
  const who = s.results[0].from.replace(/<.*>/, "").replace(/"/g, "").trim().split(/\s+/)[0];
  if (who && who.length > 1) {
    const fc = await call("find_contact", { name: who, max: 3 });
    console.log(`\n== find_contact "${who}" (${fc._ms} ms): ${fc.contacts.map((c) => `${c.email} ×${c.count}`).join(", ") || "none"}`);
  }
}

const withAtt = await call("search_emails", { query: "has:attachment newer_than:60d", maxResults: 1 });
const am = withAtt.results[0];
if (am) {
  const full = await call("read_email", { messageId: am.id, account: am.account, maxBodyChars: 500 });
  const att = (full.attachments ?? []).find((a) => !a.inline) ?? full.attachments?.[0];
  if (att) {
    const res = await client.callTool({ name: "read_attachment", arguments: { messageId: am.id, account: am.account, partId: att.partId, maxChars: 2000 } });
    const info = JSON.parse(res.content[0].text);
    const kinds = res.content.map((c) => c.type).join("+");
    console.log(`\n== read_attachment ${am.account} "${cut(att.filename, 40)}" (${att.mimeType}): kind=${info.kind}, ${info.text ? info.text.length + " chars" : ""} content=${kinds}${info.note ? " note: " + cut(info.note, 80) : ""}`);
  }
}

const bc = await call("bulk_cleanup", { query: "category:promotions older_than:90d", action: "archive", max: 50 });
console.log(`\n== bulk_cleanup preview only (nothing changed): ${bc.matches} promotions older than 90 days in ${bc.account}${bc.capped ? "+" : ""}`);

const au = await call("view_audit_log", { limit: 3 });
console.log(`\n== view_audit_log: ${au.count} recent entries, file ${au.file}`);

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
  if (s.results[0]) {
    const fw = await call("forward_email", { messageId: s.results[0].id, sourceAccount: s.results[0].account, account: def.alias, to: def.email, note: "smoke test forward" });
    console.log(`== forward_email: ${fw.status} "${cut(fw.subject, 40)}" with ${fw.attachments.length} attachment(s)`);
    await call("delete_draft", { account: def.alias, draftId: fw.draftId });
    console.log(`== delete_draft: removed forward draft`);
  }
}

await client.close();
console.log("\nSmoke test finished OK.");
