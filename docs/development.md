# Development

```bash
git clone https://github.com/psdgator/Multi-Gmail-Account-MCP.git
cd Multi-Gmail-Account-MCP
npm install            # builds dist/ too (use --include=dev if NODE_ENV=production)
npm test               # build + all tests (no real mail is touched)
npm run dev            # tsc --watch
npm run docs           # regenerate docs/tools.md from the live server
```

## Architecture

```
src/
├── index.ts            CLI entry: serve (stdio) | auth | accounts | doctor | default | limit | remove | audit | encrypt
├── extensions.ts       optional modules (attachments, IMAP, HTTP) — one import each
├── server.ts           builds an McpServer; toolGroups; server instructions listing the accounts
├── config.ts           modes, config folder, owner-only file writes
├── accounts.ts         config.json, aliases, account resolution (`resolve(arg, allowMany)`)
├── secrets.ts          AES-256-GCM secret store; key from env / OS keychain / key file
├── audit.ts            JSON-lines audit log, argument redaction
├── oauth.ts            Google scopes per mode, loopback OAuth (PKCE + state), wrong-account check
├── mime.ts             RFC 5322/MIME builder (RFC 2047/2231, base64, multipart)
├── message.ts          CleanMessage shape; Gmail payload → clean text, attachments
├── providers/
│   ├── types.ts        MailProvider interface (what every mailbox must do)
│   ├── registry.ts     MailRegistry: provider per account, with(), fanOut()
│   ├── gmail.ts        Gmail API provider, retries, error translation
│   ├── imap.ts         IMAP/SMTP provider (imapflow + nodemailer)
│   └── imap-query.ts   Gmail query syntax → IMAP SEARCH
├── extract/            attachment text extraction (PDF, Office, text, ZIP, images)
├── tools/              MCP tools, grouped (read, compose, organize, digest, cleanup, calendar, attachments, accounts)
├── cli/                extra CLI commands (add-imap, serve-http)
└── http/               hosted mode: Streamable HTTP + OAuth 2.1 authorization server
```

### Key ideas

- **Providers.** Tools never call Gmail or IMAP directly. They ask `ctx.mail` for a `MailProvider` and use the interface in `providers/types.ts`. Gmail-only features (filters, Calendar) go through `ctx.mail.gmail(acc)`, which fails clearly for other account types.
- **Multi-account.** `ctx.accounts.resolve(arg, true)` turns `account` into a list, and `ctx.mail.fanOut()` runs the work in parallel. It collects per-account `errors` instead of failing the whole call. Merge results with `mergeAndDedupe()` when they're messages.
- **Modes.** Each tool declares `minMode`. `register()` only offers tools the server mode allows. Write tools also call `requireMode(ctx, acc, …)` so per-account limits apply.
- **Audit.** `register()` logs every call (redacted) to the audit log. You get this for free when adding a tool.
- **Errors.** Providers translate errors in `explain()`. "Not found" errors must start with `Not found`, because the read tools rely on that to try the next account.

### Adding a tool

1. Pick (or create) a file in `src/tools/` and add a `register(server, ctx, { name, title, description, minMode, annotations, input, run })` call.
2. Write the description for the model: what it does, when to use it, what's multi-account, and any safety rule (e.g. "preview first").
3. Use `multiAccountArg(ctx)` / `singleAccountArg(ctx)` for the `account` parameter.
4. Add tests (see below) and run `npm run docs`.

### Adding a provider

Implement `MailProvider` and register it with `registerProviderFactory("<type>", factory)` from a module imported in `extensions.ts`. Add the type to `AccountType` in `accounts.ts`.

## Tests

Everything runs offline:

| File | What it covers |
|---|---|
| `test/unit.test.ts` | MIME building (round-tripped through `mailparser`), message parsing, accounts, modes |
| `test/core.test.ts` | Encryption, audit log, de-duplication, retries |
| `test/e2e.test.ts` | The real server over stdio against `test/fake-gmail.ts`: modes, multi-account search, drafts |
| `test/features.test.ts` | needs-reply, digest, newsletters, bulk clean-up, contacts, forward, Calendar, audit |
| `test/attachments*.test.ts` | Text extraction for every format, zip-bomb guards, read_attachment end to end |
| `test/imap.test.ts` | IMAP provider against an in-memory IMAP server (`hoodiecrow-imap`) and SMTP server |
| `test/http.test.ts` | Hosted mode: OAuth flow, PKCE, refresh rotation, Origin/Host checks, MCP over HTTP |
| `test/oauth.test.ts` | Loopback sign-in URL, state, cancellation |

Tests never touch your OS keychain (`GMAIL_MCP_KEYRING=0` in `vitest.config.ts`). Live tests against your real accounts: `npm run smoke` (read-only; `-- --draft` also creates and deletes a draft).

CI runs `npm test` on Linux and Windows with Node 22 and 24.

## Releasing

1. Bump `version` in `package.json`, `server.json` (both places) and `src/version.ts`, and update `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v0.3.0 && git push origin v0.3.0`.
3. `.github/workflows/release.yml` tests, publishes to npm with provenance (needs the `NPM_TOKEN` repository secret), and publishes `server.json` to the MCP Registry (GitHub OIDC; name `io.github.psdgator/multi-gmail-account-mcp`).
