# Changelog

## 0.3.0 (2026-10-26)

First release as **multi-gmail-account-mcp** (fork of dmorrill/gmail-mcp-multi).

### Added
- **IMAP accounts** next to Gmail: any IMAP/SMTP mailbox (Hetzner, cPanel, Dovecot…), with Gmail-style search, drafts, folders as labels, needs-reply and SMTP sending. Added with `add-imap`.
- **Read attachments** (`read_attachment`): PDF (page ranges, scanned pages as images), DOCX, XLSX, PPTX, ODT/ODS, RTF, text/CSV/HTML, `.eml`, ZIP listings, and images returned for Claude to view.
- **Triage:** `needs_reply` (conversations waiting on you, across accounts), `daily_digest`, and prompts `morning-digest` and `reply-queue`.
- **Tidy up:** `find_newsletters`, `unsubscribe` (RFC 8058 one-click or mailto), and `bulk_cleanup` (archive / mark read / label / trash by query, always with a preview and confirm token).
- `forward_email` (as a draft, with attachments), `find_contact` (accent-insensitive, all accounts).
- **Google Calendar** (opt-in per account): `list_events`, `list_calendars`, `find_free_time` across all calendars, and `create_event`.
- **Hosted mode** (`serve-http`) for claude.ai custom connectors: Streamable HTTP with a built-in OAuth 2.1 server (password login, dynamic client registration, PKCE, rotating refresh tokens). Ships with Docker + Caddy and systemd files.
- **Safety:**
  - logins encrypted at rest (AES-256-GCM, key in the OS keychain)
  - an audit log plus a `view_audit_log` tool
  - automatic retries for reads only
  - a sign-in from the wrong Google account is refused
  - cross-account de-duplication (`alsoIn`)
- CLI: `audit`, `encrypt`, `add-imap`, `serve-http`, `http-logout`, `auth --manual/--calendar`.
- Documentation in `docs/` (setup, usage, accounts, IMAP, attachments, Calendar, hosted mode, security, troubleshooting, development, generated tool reference).
- Release workflow for npm and the MCP Registry.

### Security (fixed before release, from an independent review)
- **Labels:**
  - Drafts mode can no longer trash or spam mail by applying system labels; Trash/Spam/Sent/Drafts are refused.
  - IMAP refuses the matching folders.
- **IMAP drafts:**
  - `delete_draft` / `send_draft` only act on real drafts.
  - A sent draft whose clean-up fails reports a warning instead of risking a second send, and is never sent again.
- **IMAP folders:** localised Trash/Junk/Drafts/Sent/All Mail names are protected; mail can't be moved out of All Mail or Drafts; deletes use `UID EXPUNGE`, and on servers without UIDPLUS nothing is expunged if another app left messages marked deleted in that folder.
- **Query handling:**
  - IMAP queries report the parts they can't apply.
  - IMAP `from:`/`to:`/`cc:`/`bcc:` with a full address match that exact address (not look-alikes); `after:`/`before:` timestamps, negated `older_than:` and grouped `newer_than:` are applied exactly; `rfc822msgid:` works; queries with no usable terms (`OR`, `-`, `()`) are refused instead of matching everything.
  - `bulk_cleanup` refuses such queries, and asks you directly through MCP elicitation when the client supports it.
- **Local files:**
  - reading and writing is limited to allowed folders (no hidden, app-data/startup, config, system or network paths); hosted mode has no local file access
  - allowing the home folder no longer opens up AppData / ~/Library
  - network paths are refused in any slash style before the disk is touched
  - files with several hard links are not read
- **Saved attachments:** only known safe file types are saved (documents, images, design and CAD files, media, fonts, plain archives; `GMAIL_MCP_SAVE_EXTRA_TYPES` adds more); invisible direction-changing characters and leading dots are removed from names, and shortening a name can't leave a trailing dot; files get the Mark of the Web on Windows and the quarantine flag on macOS.
- **Unsubscribe:** the one-click check is now DNS-rebinding-safe and also refuses IPv4-mapped, SIIT and other tunnelled private IPv6 forms (public addresses behind NAT64/6to4 still work); mailto unsubscribes are limited to one address with a fixed body.
- **Attachments:**
  - reading runs in a worker thread with time and memory limits, one at a time
  - decompression bombs are stopped by a per-buffer size cap inside the worker and a process-memory watchdog
  - an installed copy refuses to read attachments if the worker is missing, instead of reading without limits
  - parsers are linear-time; the ODS expansion is capped
- **Confirmations** (elicitation) fail closed: no answer, a timeout or an error counts as "no".
- **Very large HTML emails** are cut before conversion.
- **send_draft:** overlapping sends of the same draft are refused. On IMAP, a draft is only sent if it can be removed afterwards, and a sent draft loses its draft flag first, so no other process or restart can send it again.
- **bulk_cleanup** refuses vague searches (no terms, a lone `-`/`OR`, empty groups like `()`) for Gmail and IMAP, and IMAP reports empty groups instead of dropping them.
- **Local files:** with several `GMAIL_MCP_ALLOWED_DIRS`, the most specific one decides.
- **Release workflow:** tests and publishing in separate jobs, OIDC token only in the publish job, install scripts disabled there, actions pinned by commit and the registry publisher by checksum.
- **Hosted mode:**
  - sign-out works across processes; changing the password signs everyone out
  - one password guess per sign-in request; password checks run one at a time server-wide (about 2.5 guesses per second in total), with a bounded queue
  - rate limits on the sign-in endpoints; lockout is per IP / IPv6 /64, escalating to the /48, with no global lock-out of the owner
  - limiter and pending sign-in maps are bounded
  - the auth file is written atomically under a cross-process lock (so `http-logout` can't be undone by a server writing at the same moment), refuses to overwrite changes made by another process, and fails closed if it can't be re-read (`http-logout` resets it)
  - client registration keeps only the metadata the server needs (8 kB request limit, 4 kB per stored client) and is rate-limited per IPv4 address / IPv6 /48
  - your sign-in can't be crowded out: locked networks get an answer at once, each network may hold only a few places in the password queue and a limited number of pending sign-ins and never-used clients, and never-used clients expire
  - sign-ins are logged with the client address
  - unused OAuth clients are evicted
  - refresh tokens have a grace window
  - one shared mail connection pool
  - stricter redirect-prefix matching
- **Encryption key:** never replaced while encrypted logins exist; key fingerprints in envelopes.
- **Gmail:** search pages beyond 500 results; per-minute quota errors get a clear "wait a minute" message.
- **Reply-all:** works with group addresses (`undisclosed-recipients:;`).
- **Calendar:** times are parsed in the configured time zone; "tomorrow" and day ranges are correct across daylight-saving changes, including zones where midnight is skipped; skipped times move forward; calendar tools appear without a restart.

### Changed
- Internals rebuilt around a provider layer (`MailProvider`) so every tool works for Gmail and IMAP.
- Package renamed to `multi-gmail-account-mcp`. The `gmail-mcp-multi` command still works.

## 0.2.0 (2026-10-26)

- Rewritten on the current MCP SDK. Merged the open upstream PRs: OAuth (#7, #13), attachments (#9, #14), RFC 2047 subjects (#10), labels and filters (#11), and secure credential files (#15).
- Multi-account fan-out: search, inbox summary, labels, drafts and filters across all accounts.
- Modes: `readonly`, `drafts` (default, never sends) and `full`, with per-account limits.
- Clean bodies (charset-aware, HTML converted to text), threads, replies with threading, send-as and signatures.

## 0.1.0

- Upstream scaffold by Elle Morrill.
