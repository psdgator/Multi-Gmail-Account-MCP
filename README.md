# gmail-mcp-multi

A Gmail MCP server that works with **many Gmail accounts at once**.

- Tell Claude *which* mailbox to use by a friendly alias: "check the **urbanstickers** inbox", "draft a reply from **psdgator**".
- Or ask across **all** of them: "what's unread in all my accounts?", "find every invoice from DHL this month". Results from every account are merged newest-first and tagged with the account they came from.
- **Safe by default**: the default `drafts` mode can read, organize and write drafts, but **cannot send**. You review and send from Gmail.

> Fork of [dmorrill/gmail-mcp-multi](https://github.com/dmorrill/gmail-mcp-multi). Upstream's `main` was an unfinished scaffold (no login, several tools missing). This fork merges the open community PRs (#7, #9, #10, #11, #13, #14, #15), rewrites the server on the current MCP SDK and adds real multi-account features. Credits below.

## Tools

| Tool | Mode | Accounts | What it does |
|---|---|---|---|
| `list_accounts` | readonly | – | Connected accounts, default, sign-in status |
| `authenticate` | readonly | one | Connect an account (opens Google sign-in in your browser) |
| `set_default_account` | readonly | one | Default for single-account tools |
| `search_emails` | readonly | **many** | Gmail query syntax; all accounts by default, merged and sorted |
| `inbox_summary` | readonly | **many** | Unread counts per inbox + newest unread messages |
| `read_email` | readonly | one | Clean text body (HTML converted), labels, attachment list |
| `read_thread` | readonly | one | Whole conversation |
| `list_labels` / `list_drafts` / `list_filters` | readonly | **many** | |
| `save_attachment` | readonly | one | Save an attachment to a local folder |
| `create_draft` | drafts | one | New mail or threaded reply / reply-all, send-as address, Gmail signature, attachments |
| `delete_draft` | drafts | one | |
| `modify_emails` | drafts | one | Mark read/unread, star, archive, move to Inbox, add/remove labels by **name** (bulk, up to 1000) |
| `create_label` | drafts | one | |
| `send_email` / `send_draft` | **full** | one | Send |
| `trash_emails` | **full** | one | Move to Trash |
| `create_filter` / `delete_filter` | **full** | one | Gmail filters |

The `account` argument takes an alias, an email address, a list, or `"all"`. Leave it out and the multi-account tools use **every** account, while single-account tools use the default account. `read_email` and `read_thread` will even find the message in the right account if you leave `account` out.

### Modes

| Mode | Google permission requested | Can do |
|---|---|---|
| `readonly` | `gmail.readonly` | search, read, list, save attachments |
| `drafts` (default) | `gmail.modify` | + drafts, labels, read/unread, archive. **No sending.** |
| `full` | `gmail.modify` + `gmail.settings.basic` | + send, trash, filters |

Start the server with `--mode readonly|drafts|full` (or `GMAIL_MCP_MODE`). You can also cap a single account lower, for example to keep one mailbox read-only: `gmail-mcp-multi limit psdgator readonly`.

> Google has no permission that allows drafts but blocks sending. In `drafts` mode the "never sends" guarantee comes from this server simply having no send tool, so keep the mode at `drafts` or `readonly` if that matters to you.

## Setup

Requires **Node.js 20.19+**.

### 1. Install

```bash
git clone https://github.com/psdgator/gmail-mcp-multi.git
cd gmail-mcp-multi
npm install        # also builds dist/
```

### 2. Create a Google OAuth client (once)

1. [Google Cloud Console](https://console.cloud.google.com/): create a project. Use a personal Gmail account as the owner if you might leave Google Workspace later.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **Google Auth Platform → Branding/Audience**: User type **External**. Add your addresses as test users, then press **Publish app** (status "In production").
   *If the app stays in "Testing", Google expires your logins every 7 days.* For personal use you'll see an "unverified app" warning once per account. Click *Advanced → Go to … (unsafe)*.
4. **Clients → Create client → Desktop app** → download the JSON.
5. Save it as `~/.gmail-mcp/oauth-keys.json` (Windows: `C:\Users\<you>\.gmail-mcp\oauth-keys.json`).

Google Workspace accounts: the Workspace admin may need to allow the app under *Security → API controls → App access control*.

### 3. Connect accounts

```bash
node dist/index.js auth urbanstickers urbanstickersgr@gmail.com
node dist/index.js auth psdgator antony@psdgator.com
node dist/index.js default urbanstickers
node dist/index.js doctor          # checks the setup and every account
```

Or, once the server is added to Claude, just say *"connect my work Gmail as 'work'"*. The `authenticate` tool opens the sign-in page for you.

### 4. Add to Claude

**Claude desktop app** (`claude_desktop_config.json`, *Settings → Developer → Edit Config*):

```json
{
  "mcpServers": {
    "gmail-multi": {
      "command": "node",
      "args": ["C:\\Users\\you\\projects\\gmail-mcp-multi\\dist\\index.js", "--mode", "drafts"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add gmail-multi -- node /path/to/gmail-mcp-multi/dist/index.js --mode drafts
```

## Files

```
~/.gmail-mcp/                 (override with GMAIL_MCP_HOME)
├── config.json               accounts, aliases, default, per-account limits
├── oauth-keys.json           your Google OAuth client
└── accounts/<alias>/
    ├── credentials.json      refresh token (owner-only permissions)
    └── oauth-keys.json       optional per-account OAuth client
```

To remove an account: `node dist/index.js remove <alias>`. You can also revoke access at <https://myaccount.google.com/permissions>.

## Development

```bash
npm run build
npm test      # unit tests + end-to-end tests against a fake Gmail API (no real mail touched)
```

`GMAIL_MCP_API_ROOT` points the server at another Gmail-compatible endpoint (used by the tests); `GMAIL_MCP_NO_BROWSER=1` stops it from opening a browser.

## Roadmap

- Remote (HTTP) mode so the same server can be added as a custom connector in Claude on the web and mobile
- Batch API for faster large searches; attachment text extraction (PDF/DOCX)
- Unified "daily digest" prompt across accounts

## Credits

- Original project and scaffold: **Elle Morrill** (dmorrill/gmail-mcp-multi)
- Secure credential storage, install docs: **Dave Moudy** (PR #15)
- Per-account OAuth clients, standalone auth, read-only switch: **Vadim Zaliva** (PR #13)
- Attachments, RFC 2047 subjects, labels and filters: **Bobby Marko** (PRs #9, #10, #11)
- Attachment download: PR #14
- Multi-account fan-out, modes, drafts/replies, rewrite: **Antonis Papamichail** ([psdgator](https://github.com/psdgator))

MIT licensed.
