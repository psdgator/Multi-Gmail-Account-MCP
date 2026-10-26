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
