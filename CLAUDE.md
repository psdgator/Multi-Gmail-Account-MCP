# Multi Gmail Account MCP: notes for AI-assisted development

MCP server giving Claude access to many Gmail and IMAP accounts at once (aliases, merged search, triage, attachments, Calendar, hosted mode). Full architecture: docs/development.md.

## Rules
- Tools talk to `MailProvider` (src/providers/types.ts) via `ctx.mail`. Never call Gmail/IMAP directly from a tool. Gmail-only features go through `ctx.mail.gmail(acc)`.
- Multi-account tools: `ctx.accounts.resolve(arg, true)` + `ctx.mail.fanOut()`. Return per-account `errors`, don't fail the whole call; merge messages with `mergeAndDedupe()`.
- Every tool declares `minMode`. Nothing that sends, trashes, unsubscribes or creates filters/events may be below `full`. Write tools call `requireMode` for per-account limits.
- Bulk changes need a preview + confirm token (see `bulk_cleanup`).
- Never log email bodies or secrets (audit `redact` drops body/html/note/text/password/content/data).
- Nothing may print to stdout in stdio server mode; log to stderr.
- "Not found" errors from providers must start with `Not found` (read tools fall through to the next account).
- Keep docs in sync: `npm run docs` regenerates docs/tools.md; update CHANGELOG.md.

## Commands
- `npm test`: build + all tests offline (fake Gmail in test/fake-gmail.ts, in-memory IMAP/SMTP, HTTP OAuth). Tests never touch the OS keychain.
- `npm run smoke`: live read-only test against your real connected accounts.
- On Windows with `NODE_ENV=production`: `npm install --include=dev`.
