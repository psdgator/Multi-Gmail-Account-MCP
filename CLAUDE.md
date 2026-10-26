# gmail-mcp-multi: notes for AI-assisted development

## What this is
A local (stdio) MCP server giving Claude access to several Gmail accounts at once. Accounts have aliases; multi-account tools fan out in parallel and merge results tagged by account.

## Layout
- `src/index.ts`: CLI (`serve` default, `auth`, `accounts`, `doctor`, `default`, `limit`, `remove`)
- `src/server.ts`: builds the McpServer, registers tools, writes server instructions listing accounts
- `src/config.ts`: modes (readonly < drafts < full), config dir, owner-only file writes
- `src/accounts.ts`: config.json, alias/email resolution (`resolve(arg, allowMany)`), credentials paths
- `src/oauth.ts`: scopes per mode, loopback OAuth flow (127.0.0.1, PKCE, state), browser opening
- `src/gmail.ts`: cached Gmail clients per account, token refresh persistence, `fanOut`, error translation
- `src/mime.ts`: RFC 5322/MIME builder (RFC 2047 headers, RFC 2231 filenames, base64 bodies)
- `src/message.ts`: Gmail payload → clean message (charset-aware decoding, html→text, attachments)
- `src/tools/*`: tool definitions; each declares `minMode` and is only registered if the server mode allows it

## Rules
- Never add a tool that sends mail without `minMode: "full"`.
- Every tool touching one mailbox calls `ctx.accounts.resolve(arg, false)` and `requireMode` for writes.
- Multi-account tools must use `ctx.gmail.fanOut` and return per-account `errors` instead of failing.
- Nothing may print to stdout in server mode (stdio transport); log to stderr.

## Test
`npm test` builds, then runs unit tests and e2e tests (`test/e2e.test.ts`) that spawn the real server against `test/fake-gmail.ts`.
