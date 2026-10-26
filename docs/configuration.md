# Configuration reference

Everything works with no configuration. These settings are for customising.

## Command line

| Command | What it does |
|---|---|
| `gmail-mcp-multi [--mode readonly\|drafts\|full]` | Run the MCP server on stdio (what Claude Desktop/Code start) |
| `gmail-mcp-multi auth <alias> <email> [--mode M] [--calendar] [--manual] [--allow-different-email]` | Connect or reconnect a Gmail account |
| `gmail-mcp-multi add-imap <alias> <email> --host H [options]` | Connect an IMAP mailbox ([options](imap.md#connect-a-mailbox)) |
| `gmail-mcp-multi accounts` | List accounts |
| `gmail-mcp-multi default <alias>` | Set the default account |
| `gmail-mcp-multi limit <alias> <mode\|none>` | Cap one account to a lower mode |
| `gmail-mcp-multi remove <alias>` | Disconnect an account and delete its stored login |
| `gmail-mcp-multi doctor` | Check the setup and test every account |
| `gmail-mcp-multi audit [N] [--changes]` | Show the last N logged actions |
| `gmail-mcp-multi encrypt` | Encrypt plain-text logins left by old versions; show where the key lives |
| `gmail-mcp-multi serve-http --public-url URL [...]` | Run hosted mode ([Hosted mode](hosted.md)) |
| `gmail-mcp-multi http-logout [--clients]` | Sign every device out of hosted mode |

`multi-gmail-account-mcp` is the same program under its package name.

## Environment variables

### General

| Variable | Default | Meaning |
|---|---|---|
| `GMAIL_MCP_HOME` | `~/.gmail-mcp` | Folder for config, encrypted logins, key file and audit log |
| `GMAIL_MCP_MODE` | `drafts` | Server mode, like `--mode` |
| `GMAIL_MCP_READONLY` | | `1` is the same as `--mode readonly` |
| `GMAIL_MCP_OAUTH_KEYS` | `<home>/oauth-keys.json` | Path to the Google OAuth client JSON |
| `GMAIL_MCP_TIMEZONE` | the computer's | Time zone for Calendar dates and times, e.g. `Europe/Athens` |
| `GMAIL_MCP_CALENDAR` | | `1` always offers the Calendar tools |
| `GMAIL_MCP_NO_BROWSER` | | `1` stops sign-in from opening a browser |

### Security

| Variable | Default | Meaning |
|---|---|---|
| `GMAIL_MCP_MASTER_KEY` | | 32-byte encryption key (64 hex chars or base64). Use it on servers and in Docker. **Back it up.** |
| `GMAIL_MCP_KEYRING` | | `0` disables the OS keychain (the key then goes to `<home>/master.key`) |
| `GMAIL_MCP_AUDIT` | on | `off` disables the audit log |
| `GMAIL_MCP_ALLOWED_DIRS` | | Extra folders (outside your home folder) that attachments may be read from and saved to. Separate them with `;` on Windows and `:` elsewhere, e.g. `D:\Work;E:\Clients`. |
| `GMAIL_MCP_SAVE_DIR` | `~/Downloads/gmail-mcp` | Default folder for `save_attachment` |
| `GMAIL_MCP_SAVE_EXTRA_TYPES` | | Extra file extensions `save_attachment` may save, e.g. `skp,dwf` ([safe types](security.md#local-files)) |

### Attachments

| Variable | Default | Meaning |
|---|---|---|
| `GMAIL_MCP_EXTRACT_TIMEOUT_MS` | `20000` | Time limit for reading one attachment |
| `GMAIL_MCP_EXTRACT_MEMORY_MB` | `512` | Memory limit for the attachment reader |
| `GMAIL_MCP_EXTRACT_CONCURRENCY` | `1` | How many attachments may be read at the same time (each one gets its own memory budget) |
| `GMAIL_MCP_EXTRACT_IN_PROCESS` | | `1` reads attachments without a worker thread and **without time or memory limits** (debugging only) |

### IMAP

| Variable | Meaning |
|---|---|
| `GMAIL_MCP_IMAP_PASSWORD` | Password for `add-imap` without the prompt (scripts) |

### Hosted mode

See [Hosted mode → Environment variables](hosted.md#environment-variables): `GMAIL_MCP_HTTP_PASSWORD` / `_FILE`, `GMAIL_MCP_PUBLIC_URL`, `GMAIL_MCP_HTTP_PORT`, `GMAIL_MCP_HTTP_HOST`, `GMAIL_MCP_TRUST_PROXY`, `GMAIL_MCP_HTTP_ALLOWED_REDIRECTS`, `GMAIL_MCP_HTTP_ALLOW_LOOPBACK`, `GMAIL_MCP_HTTP_ALLOWED_HOSTS`, `GMAIL_MCP_HTTP_ALLOWED_ORIGINS`.

### Development

| Variable | Meaning |
|---|---|
| `GMAIL_MCP_API_ROOT` | Send Google API calls to another base URL (used by the tests' fake Gmail) |

## Files in `GMAIL_MCP_HOME`

```
config.json                      accounts, aliases, default, per-account limits, IMAP servers
oauth-keys.json                  your Google OAuth client
master.key                       encryption key (only when there is no OS keychain)
audit.log, audit.log.1           action log (JSON lines)
http-auth.json                   hosted mode: OAuth clients and hashed tokens (encrypted)
http-auth.json.lock              hosted mode: exists only while http-auth.json is being changed
accounts/<alias>/credentials.json    encrypted login (OAuth tokens or IMAP password)
accounts/<alias>/oauth-keys.json     optional per-account Google OAuth client
```
