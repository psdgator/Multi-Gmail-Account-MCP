# gmail-mcp-multi

A Gmail MCP server with native multi-account support. Manage multiple Gmail accounts from a single server instance.

Unlike other Gmail MCPs that require running separate server instances per account, this one lets you specify which account to use on each tool call—making it easy to manage personal and work inboxes from Claude Code, Cursor, or any MCP client.

## Features

- **Multi-account support** - Single server instance, unlimited Gmail accounts
- **Account aliases** - Use friendly names like "work" or "personal" instead of email addresses
- **Full Gmail API** - Search, read, send, label, and manage emails
- **Batch operations** - Bulk modify or delete emails efficiently
- **Auto token refresh** - Handles OAuth token refresh automatically

## Installation

This package is not published to npm yet, so install it from source:

```bash
git clone https://github.com/dmorrill/gmail-mcp-multi.git
cd gmail-mcp-multi
npm install
npm run build
```

That produces `dist/index.js`, which is the server entry point your MCP client
runs. Note the absolute path to it — you'll need it below.

## Quick Start

### 1. Set up Google Cloud OAuth

You'll need OAuth credentials from Google Cloud Console:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable the Gmail API
4. Create OAuth 2.0 credentials (Desktop app type)
5. Download the credentials JSON

### 2. Configure the MCP

Create `~/.gmail-mcp/oauth-keys.json` with your OAuth credentials.

### 3. Add to your MCP client

**Claude Code:**
```bash
claude mcp add gmail -- node /absolute/path/to/gmail-mcp-multi/dist/index.js
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):
```json
{
  "mcpServers": {
    "gmail": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/gmail-mcp-multi/dist/index.js"]
    }
  }
}
```

Both paths must be absolute. Claude Desktop in particular launches servers with a
minimal `PATH`, so a bare `node` may not resolve — use the output of `which node`.

### 4. Authenticate accounts

Authentication runs as a one-off Node script (it needs to open a browser and
listen on a localhost port, which doesn't fit inside an MCP request). After
`npm run build`, from the project checkout:

```bash
node dist/auth.js personal you@gmail.com
node dist/auth.js work you@company.com
```

Each invocation prints a Google authorization URL, listens on
`http://127.0.0.1:<random-port>` for the redirect, exchanges the code for
tokens, and writes them to `~/.gmail-mcp/accounts/<alias>/credentials.json`.

The script requests the `gmail.readonly` scope, so the resulting tokens
can never mutate the mailbox even if the MCP server is later started
without `--readonly`.

For multi-org setups (accounts in different Google Workspace
organizations), drop a per-account `oauth-keys.json` into
`~/.gmail-mcp/accounts/<alias>/` before running the script — see
"Configuration" below.

### 5. Use it!

```
search_emails({ account: "work", query: "in:inbox is:unread" })
search_emails({ account: "personal", query: "from:mom" })
```

## Tools

All tools that interact with Gmail require an `account` parameter (alias or email).

### Account Management
| Tool | Description |
|------|-------------|
| `list_accounts` | List all configured accounts and auth status |
| `authenticate` | Add or re-authenticate an account |

### Email Operations
| Tool | Description |
|------|-------------|
| `search_emails` | Search emails using Gmail query syntax |
| `read_email` | Get full content of an email by ID |
| `send_email` | Send a new email |
| `draft_email` | Create a draft |
| `modify_email` | Add/remove labels, mark read/unread |
| `delete_email` | Trash or permanently delete |
| `batch_modify_emails` | Bulk label operations |
| `batch_delete_emails` | Bulk delete |

### Label Management
| Tool | Description |
|------|-------------|
| `list_labels` | Get all labels for an account |
| `create_label` | Create a new label |
| `delete_label` | Delete a label |

## Configuration

Credentials are stored in `~/.gmail-mcp/`:

```
~/.gmail-mcp/
├── config.json           # Account aliases and settings
├── oauth-keys.json       # Your Google OAuth app credentials
└── accounts/
    ├── work/
    │   └── credentials.json
    └── personal/
        └── credentials.json
```

These files hold OAuth refresh tokens that grant ongoing access to your mailboxes.
The server creates its directories as `0700` and its credential files as `0600`, and
re-applies those permissions on startup to tighten anything left behind by an earlier
version. Never commit them or place them on a shared filesystem.

## Development

```bash
git clone https://github.com/dmorrill/gmail-mcp-multi.git
cd gmail-mcp-multi
npm install
npm run build
npm run dev
```

## Contributing

Contributions welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
