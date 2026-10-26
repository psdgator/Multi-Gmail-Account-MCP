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
| Labels | Folders. `addLabels` **copies** the message into the folder; `removeLabels` (when the message is in that folder) moves it back to INBOX. `create_label "Clients/Acme"` creates nested folders. Trash, Junk/Spam, Drafts, Sent and All Mail can't be used as labels, so labels can never trash or spam mail. Use `trash_emails` (full mode) to trash. These folders are found by their special-use flag, or by name in English, German, French, Spanish, Italian, Portuguese, Dutch, Polish, Russian, Turkish and Greek (for example Papelera, Cestino, Корзина, Kosz, Lixeira, Prullenbak, Çöp Kutusu, Κάδος, Correo no deseado, Posta indesiderata, Спам, Pourriel). |
| Archive | Moves to the Archive folder (special-use `\Archive`, or a folder named Archive; created if missing). Mail in **All Mail** (special-use `\All`, e.g. Gmail's `[Gmail]/All Mail`) or **Drafts** is never archived or moved to INBOX: moving out of All Mail deletes the message on Gmail, and drafts are handled with the draft tools. Such requests are refused before anything changes. |
| Trash | Moves to Trash (`\Trash`). |
| Drafts | Saved in the Drafts folder with the `\Draft` flag. Open them in your mail app (Thunderbird, webmail). `delete_draft` and `send_draft` only accept messages that are in the Drafts folder **and** carry the `\Draft` flag. Anything else, or any message in a mailbox without a Drafts folder, is refused. `send_draft` sends a draft once: a second call for the same draft while it is being sent fails at once with "already being sent", and a draft that was sent (even if removing it afterwards failed) is not sent again by the same server process. |
| Sent | Sent through SMTP (full mode only). A copy is saved in Sent, and **Bcc is removed** from the transmitted message. |
| Threads | Rebuilt from `Message-ID` / `References` / `In-Reply-To` across INBOX, Sent and Archive. |
| Starred / unread | `\Flagged` / `\Seen` flags. |
| Filters, Calendar | Not available (Gmail only). |

Message ids look like `INBOX:1234` (folder:UID). A message gets a new id when it moves to another folder; the move result tells you the new id.

### Deleting and moving safely

Removing a message from a folder (deleting a draft, or a move on a server without the `MOVE` extension) ends with an IMAP `EXPUNGE`. With the `UIDPLUS` extension (Dovecot, Cyrus, Gmail, most current servers) only the messages acted on are removed (`UID EXPUNGE`). Without it, a plain `EXPUNGE` would also erase every other message in that folder that another mail app has marked as deleted but not yet removed. So on such servers the action is only done when no other message there is marked deleted; otherwise it is refused with a message asking you to empty or compact that folder in your mail app first. Moves on servers with `MOVE` never need this. A small gap remains on such servers: if another mail app marks a message deleted in the few moments between the check and the `EXPUNGE`, that message is removed too. Servers with `UIDPLUS` don't have this gap.

`send_draft` checks this **before** sending, so a draft is only sent when it can be removed afterwards. After sending, the message first loses its `\Draft` flag and is then removed. If removing fails, the email is reported as sent with a warning, and because it is no longer flagged as a draft, no other window or restarted server will send it again.

## Search syntax supported for IMAP

Supported:
- `from:` `to:` `cc:` `bcc:` `subject:` (also with `"quoted phrases"`)
- free words and `"phrases"` (searched in headers and body)
- `is:unread` `is:read` `is:starred` `is:unstarred` `is:draft` `is:answered`
- `after:` / `before:` with `YYYY/MM/DD` or a Unix timestamp, and `newer_than:` / `older_than:` with `Nh`, `Nd`, `Nw`, `Nm`, `Ny`
- `has:attachment`
- `larger:` / `smaller:` (`5m`, `200k`)
- `rfc822msgid:` (e.g. `rfc822msgid:abc123@mail.example.com`)
- `in:inbox` `in:sent` `in:drafts` `in:trash` `in:spam` `in:archive` `in:anywhere`
- `label:<folder>` (or `in:<folder>`)
- negation with `-`, `a OR b`, grouping with `( )`, and `{a b}` (Gmail's OR-group)

By default only INBOX is searched (Gmail searches everything except Spam/Trash; use `in:anywhere` for that on IMAP).

**Exact matching.** IMAP itself searches `FROM`/`TO`/`CC`/`BCC` as substrings and dates as whole days. This MCP server checks the results so they are exact, as in Gmail:
- A full address (`from:bob@client.example`) matches only mail where that field holds exactly this address (case-insensitive), not `notbob@client.example` or `bob@client.example.evil.com`. `-from:bob@client.example` leaves out only that exact address. A partial value (`from:bob`, `from:@client.example`) still matches as a substring.
- `newer_than:`, `older_than:` and `after:` / `before:` with a Unix timestamp are checked against the message's received time to the second (`after:` includes the instant, `before:` excludes it). `after:` / `before:` with a plain date (`2026/10/01`) mean whole days, as the mail server counts them.
- Both work everywhere in a query: at the top level, negated, and inside `( )`, `{ }`, `OR` and `-( )` groups, e.g. `-(older_than:30d)` or `(from:a@x.com OR from:b@y.com)`.

**Not supported, and reported:** `category:`, `is:important`, `has:drive`/`has:youtube`, `list:`, `filename:`, `deliveredto:`, unknown operators, invalid dates, periods or sizes, and unbalanced parentheses. Also reported:
- negated folders (`-in:sent`, `-label:x`)
- folders or `has:attachment` inside a group, e.g. `(in:sent OR from:a)`
- a query with no usable term at all, such as `OR`, `-`, `""` or only spaces ("no usable search terms"). Only the empty query means "all mail".

Nothing is dropped silently. The search result lists these parts under `ignored`, because the matches may then be broader than the query intended. Bulk actions (`bulk_cleanup`) refuse to run on such a query, so rephrase it with supported operators.

Greek and other non-ASCII search terms are sent as UTF-8. Most servers, including Dovecot at Hetzner, match them in decoded headers and bodies.

## Connections

The server keeps one IMAP connection per account, opened on first use and closed after 5 minutes idle. If the connection drops, it reconnects automatically. A command that was already running is never repeated (no duplicate drafts or moves).
