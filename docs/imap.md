# IMAP accounts

Any IMAP mailbox (Hetzner, Dovecot, cPanel, Plesk, Outlook.com IMAP, ...) can sit next to your Gmail accounts. All the multi-account tools (`search_emails`, `inbox_summary`, `needs_reply`, `list_drafts`, ...) include it, results are tagged with its alias, and the same Gmail-style queries work.

## Connect a mailbox

```bash
gmail-mcp-multi add-imap <alias> <email> --host <imap server> [options]
```

You are asked for the password (nothing is shown while you type). The login is checked against the server, and SMTP too if configured, before anything is saved. The password is stored encrypted (AES-256-GCM, with the key in your OS keychain), like the Gmail logins.

| Option | Default | Meaning |
|---|---|---|
| `--host` | (required) | IMAP server |
| `--port` | 993 | IMAP port (993 = TLS; 143 = STARTTLS) |
| `--starttls` | off | Use STARTTLS on port 143 instead of TLS on 993 |
| `--user` | the email | Login name, if it isn't the email address |
| `--smtp-host` | same as `--host` | Outgoing server, only used for sending in `full` mode |
| `--smtp-port` | 465 | 465 = TLS, 587 = STARTTLS |
| `--no-smtp` | | Don't configure sending |
| `--name` | | Display name for the From header of drafts |
| `--signature` | | Plain-text signature appended to drafts |
| `--mode` | | Cap this account (`readonly`, `drafts`, `full`) |
| `--allow-insecure-tls` | | Accept self-signed certificates **and plain-text connections**. Only for your own test servers. |

For non-interactive setups, set `GMAIL_MCP_IMAP_PASSWORD` instead of typing the password. Run the command again to change the password or settings.

### Hetzner (KonsoleH / your-server.de mail)

```bash
gmail-mcp-multi add-imap company you@yourdomain.com --host mail.your-server.de --name "Your Name"
```

- IMAP: `mail.your-server.de`, port 993 (TLS). SMTP: the same host, port 465 (TLS), or 587 with `--smtp-port 587`.
- The login is the full mailbox address. Use `--user` only if your mailbox has a different login name.
- If your mailboxes live on a managed server with its own name (for example `dediNNNN.your-server.de`), that host works too.

## How Gmail ideas map to IMAP

| Gmail | IMAP account |
|---|---|
| Labels | Folders. `addLabels` **copies** the message into the folder; `removeLabels` (when the message is in that folder) moves it back to INBOX. `create_label "Clients/Acme"` creates nested folders. Trash, Junk/Spam, Drafts, Sent and All Mail can't be used as labels (found by special-use flag or by name, in several languages), so labels can never trash or spam mail. Use `trash_emails` (full mode) to trash. |
| Archive | Moves to the Archive folder (special-use `\Archive`, or a folder named Archive; created if missing). |
| Trash | Moves to Trash (`\Trash`). |
| Drafts | Saved in the Drafts folder with the `\Draft` flag. Open them in your mail app (Thunderbird, webmail). `delete_draft` and `send_draft` only accept messages that are in the Drafts folder **and** carry the `\Draft` flag. Anything else, or any message in a mailbox without a Drafts folder, is refused. |
| Sent | Sent through SMTP (full mode only). A copy is saved in Sent, and **Bcc is removed** from the transmitted message. |
| Threads | Rebuilt from `Message-ID` / `References` / `In-Reply-To` across INBOX, Sent and Archive. |
| Starred / unread | `\Flagged` / `\Seen` flags. |
| Filters, Calendar | Not available (Gmail only). |

Message ids look like `INBOX:1234` (folder:UID). A message gets a new id when it moves to another folder; the move result tells you the new id.

## Search syntax supported for IMAP

Supported:
- `from:` `to:` `cc:` `bcc:` `subject:` (also with `"quoted phrases"`)
- free words and `"phrases"` (searched in headers and body)
- `is:unread` `is:read` `is:starred` `is:unstarred` `is:draft` `is:answered`
- `after:` / `before:` with `YYYY/MM/DD`, and `newer_than:` / `older_than:` with `Nh`, `Nd`, `Nw`, `Nm`, `Ny`
- `has:attachment`
- `larger:` / `smaller:` (`5m`, `200k`)
- `rfc822msgid:`
- `in:inbox` `in:sent` `in:drafts` `in:trash` `in:spam` `in:archive` `in:anywhere`
- `label:<folder>` (or `in:<folder>`)
- negation with `-`, `a OR b`, grouping with `( )`, and `{a b}` (Gmail's OR-group)

By default only INBOX is searched (Gmail searches everything except Spam/Trash; use `in:anywhere` for that on IMAP).

`newer_than:` / `older_than:` are exact (checked to the second) at the top level of a query. Inside a group, `older_than:` rounds to whole days, so it never matches more than asked.

**Not supported, and reported:** `category:`, `is:important`, `has:drive`/`has:youtube`, `list:`, `filename:`, `deliveredto:`, unknown operators, invalid dates or sizes, and unbalanced parentheses. Also reported:
- negated folders (`-in:sent`, `-label:x`)
- folders, `has:attachment` or `newer_than:` inside a group, e.g. `(in:sent OR from:a)`

Nothing is dropped silently. The search result lists these parts under `ignored`, because the matches may then be broader than the query intended. Bulk actions (`bulk_cleanup`) refuse to run on such a query, so rephrase it with supported operators.

Greek and other non-ASCII search terms are sent as UTF-8. Most servers, including Dovecot at Hetzner, match them in decoded headers and bodies.

## Connections

The server keeps one IMAP connection per account, opened on first use and closed after 5 minutes idle. If the connection drops, it reconnects automatically. A command that was already running is never repeated (no duplicate drafts or moves).
