# Multi Gmail Account MCP

**Use all your mailboxes from Claude at once.** This MCP server connects any number of Gmail and IMAP accounts, so you can ask *"what's unread everywhere?"*, *"who am I supposed to get back to?"* or *"read the invoice the supplier sent to the shop inbox"*. Claude searches every mailbox together and tells you which account each email came from.

[![npm](https://img.shields.io/npm/v/multi-gmail-account-mcp)](https://www.npmjs.com/package/multi-gmail-account-mcp) [![CI](https://github.com/psdgator/Multi-Gmail-Account-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/psdgator/Multi-Gmail-Account-MCP/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

## Why this one

| | This server | Claude's built-in Gmail | Typical Gmail MCPs |
|---|---|---|---|
| Accounts | **Unlimited Gmail + IMAP** | 1 | Usually 1, or one per call |
| Search all inboxes in one go | **Yes, merged and de-duplicated** | No | Rarely |
| "Who's waiting for my reply?" across accounts | **Yes** | No | No |
| Read PDFs, Word, Excel and images in attachments | **Yes** | Partly | Rarely |
| Never sends unless you allow it | **Default (drafts mode)** | Asks per send | Usually sends freely |
| Logins encrypted, audit log of every action | **Yes** | n/a | Rarely |
| Works in claude.ai web & mobile | **Hosted mode** | Yes | Rarely |

## Features

- **Multi-account by design:**
  - Name mailboxes with aliases (`shop`, `work`, `personal`).
  - Search, summarize and triage all of them at once, or pick one.
  - Copies of the same email in two accounts are shown once.
- **Triage:**
  - `needs_reply` finds conversations waiting on you, oldest first.
  - `daily_digest` and the `/morning-digest` prompt give you a briefing.
  - `/reply-queue` drafts answers one by one.
- **Attachments:** read PDFs (page ranges, scanned pages), DOCX, XLSX, PPTX, ODT/ODS, RTF, CSV/HTML, `.eml` and ZIP without saving them, and let Claude look at images (OCR included, Greek too).
- **Writing (as drafts):**
  - threaded replies and reply-all
  - forwards with the original attachments
  - Gmail *Send mail as* addresses and signatures
  - local file attachments
- **Tidying:**
  - newsletter report and unsubscribe
  - bulk archive / mark read / label / trash, always with a preview
  - labels and filters
- **Calendar (optional):** events across all accounts, free time across every calendar, and creating events.
- **IMAP:** any mailbox (Hetzner, cPanel, Fastmail…) sits next to Gmail, with the same search syntax.
- **Safety:**
  - three modes (`readonly`, `drafts` = never sends, `full`) plus per-account limits
  - encrypted logins (OS keychain)
  - an audit log
  - refuses sign-ins from the wrong account
  - retries for reads only
- **Hosted mode:** run it on a small server with Docker and add it to claude.ai as a custom connector (OAuth 2.1, password-protected).

33 tools in total. See the **[tool reference](docs/tools.md)**.

## Quick start

```bash
npm install -g multi-gmail-account-mcp
```

1. **Google OAuth client (once):** create a Google Cloud project, enable the Gmail API, set the app to *External* and *In production*, create a *Desktop app* client, and save its JSON as `~/.gmail-mcp/oauth-keys.json`. [Step-by-step guide](docs/setup.md#2-create-a-google-oauth-client-once).
2. **Connect accounts:**

   ```bash
   gmail-mcp-multi auth shop shop@gmail.com
   gmail-mcp-multi auth work me@company.com --calendar
   gmail-mcp-multi add-imap company me@mydomain.com --host mail.example.com   # optional IMAP mailbox
   gmail-mcp-multi default shop
   gmail-mcp-multi doctor
   ```

3. **Add to Claude Desktop** (*Settings → Developer → Edit Config*), then restart Claude:

   ```json
   {
     "mcpServers": {
       "gmail-multi": { "command": "npx", "args": ["-y", "multi-gmail-account-mcp", "--mode", "drafts"] }
     }
   }
   ```

   Claude Code: `claude mcp add gmail-multi -- npx -y multi-gmail-account-mcp --mode drafts`

4. **Ask Claude:**
   - *Morning briefing.* (or `/morning-digest`)
   - *Who am I supposed to get back to?*
   - *Find the DHL invoices from October in all accounts and read the totals.*
   - *Draft a reply to Maria in Greek saying the order ships Thursday.*

## Modes

| Mode | Claude can |
|---|---|
| `readonly` | search, read, summarize, read attachments |
| `drafts` *(default)* | the above, plus drafts, forwards as drafts, labels, read/unread, archive, and bulk archive with preview. **Nothing is ever sent.** |
| `full` | the above, plus send, trash, unsubscribe, filters, and create calendar events |

Choose with `--mode`. Limit single accounts with `gmail-mcp-multi limit <alias> readonly`. Details: [Security](docs/security.md).

## Documentation

| | |
|---|---|
| [Setup](docs/setup.md) | Install, Google Cloud, connecting accounts, Claude Desktop/Code |
| [Everyday use](docs/usage.md) | What to ask Claude, by task |
| [Accounts](docs/accounts.md) | Aliases, defaults, multi-account behaviour, per-account limits |
| [IMAP accounts](docs/imap.md) | Non-Gmail mailboxes (Hetzner, cPanel…) |
| [Attachments](docs/attachments.md) | What can be read and the limits |
| [Calendar](docs/calendar.md) | Turning it on, free-time search, events |
| [Hosted mode](docs/hosted.md) | claude.ai web & mobile via Docker + Caddy |
| [Security & privacy](docs/security.md) | Modes, encryption, audit log, prompt injection, local files |
| [Configuration](docs/configuration.md) | CLI commands, environment variables, files |
| [Troubleshooting](docs/troubleshooting.md) | Common errors and fixes |
| [Tool reference](docs/tools.md) | Every tool and parameter (generated) |
| [Development](docs/development.md) | Architecture, tests, releasing |

## Credits

Forked from [dmorrill/gmail-mcp-multi](https://github.com/dmorrill/gmail-mcp-multi) by **Elle Morrill**. This fork merged the upstream community pull requests:

- **Dave Moudy:** secure credential files, install docs (#15)
- **Vadim Zaliva:** per-account OAuth clients, standalone auth, read-only switch (#13)
- **Bobby Marko:** attachments, RFC 2047 subjects, labels and filters (#9, #10, #11)
- attachment download (#14)

Maintained by **Antonis Papamichail** ([psdgator](https://github.com/psdgator)). Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed. Privacy: [PRIVACY.md](PRIVACY.md).
