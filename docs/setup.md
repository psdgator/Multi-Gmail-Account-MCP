# Setup

This guide takes you from nothing to Claude reading several mailboxes. Allow about 15 minutes, most of it in Google Cloud Console (a one-time step).

- [1. Install](#1-install)
- [2. Create a Google OAuth client](#2-create-a-google-oauth-client-once)
- [3. Connect your accounts](#3-connect-your-accounts)
- [4. Add the server to Claude](#4-add-the-server-to-claude)
- [5. Check everything](#5-check-everything)
- [Updating and uninstalling](#updating-and-uninstalling)

IMAP mailboxes (any provider, e.g. Hetzner, cPanel, Fastmail) don't need Google Cloud at all; see [IMAP accounts](imap.md). To use the server from claude.ai on the web or your phone, see [Hosted mode](hosted.md).

## 1. Install

You need **Node.js 20.19 or newer** (`node --version`).

**From npm** (recommended):

```bash
npm install -g multi-gmail-account-mcp
```

This installs two equivalent commands: `multi-gmail-account-mcp` and the shorter `gmail-mcp-multi`. The examples below use `gmail-mcp-multi`.

**From source:**

```bash
git clone https://github.com/psdgator/Multi-Gmail-Account-MCP.git
cd Multi-Gmail-Account-MCP
npm install        # also builds dist/
```

From source, run commands as `node dist/index.js …` instead of `gmail-mcp-multi …`.

> **Windows tip:** if your system has `NODE_ENV=production` set, npm skips the build tools. Use `npm install --include=dev` instead.

## 2. Create a Google OAuth client (once)

Gmail access goes through your **own** Google Cloud project, so no third party ever holds your tokens.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and **create a project** (any name, e.g. "Gmail MCP").
   *Tip:* own it with a personal Gmail account rather than a Workspace account you might cancel later. Deleting the Workspace deletes the project.
2. **APIs & Services → Library**: enable the **Gmail API**. If you want Calendar features, also enable the **Google Calendar API**.
3. **Google Auth Platform → Get started**:
   - App name: anything (e.g. "Gmail MCP"); support email: yours.
   - Audience: **External**. This is what lets both @gmail.com and Workspace accounts use it.
   - Contact email: yours; accept the Google API Services User Data Policy.
4. **Branding**: add a home page and privacy policy link. The repository's [README](https://github.com/psdgator/Multi-Gmail-Account-MCP) and [PRIVACY.md](../PRIVACY.md) work. Add `github.com` (or your own domain) under *Authorized domains*.
5. **Audience → Publish app** (status: *In production*).
   If you leave it in *Testing*, Google expires every login after **7 days**. A published but unverified app is fine for personal use (up to 100 users). You'll see a one-time "Google hasn't verified this app" screen: click **Advanced → Go to … (unsafe)**.
6. **Clients → Create client → Desktop app** → **Download JSON**. Google shows the secret only once.
7. Save the file as:
   - macOS/Linux: `~/.gmail-mcp/oauth-keys.json`
   - Windows: `C:\Users\<you>\.gmail-mcp\oauth-keys.json`

   or point `GMAIL_MCP_OAUTH_KEYS` at it. To use a different Google project for one account, save that project's file as `~/.gmail-mcp/accounts/<alias>/oauth-keys.json`.

**Google Workspace accounts:** if sign-in says the app is blocked, the Workspace admin can allow it under *Admin console → Security → API controls → App access control → Manage third-party app access*. Add the OAuth client ID and set it to *Trusted*.

## 3. Connect your accounts

Give each mailbox a short **alias**. That's the name you'll use with Claude ("check the *shop* inbox").

```bash
gmail-mcp-multi auth shop shop@gmail.com
gmail-mcp-multi auth work me@company.com --calendar      # also allow Google Calendar
gmail-mcp-multi default shop                              # used when you don't name an account
```

A browser window opens. Pick the matching Google account and approve. If you sign in with a **different** Google account than the one you named, nothing is saved, which protects you from mixing accounts up.

You can also connect accounts from inside Claude once the server is added: *"Connect my Gmail personal@gmail.com as 'personal'"*. Claude calls the `authenticate` tool and the sign-in page opens.

Options:

| Flag | Meaning |
|---|---|
| `--mode readonly\|drafts\|full` | Permissions to request from Google (default: `drafts`). See [Security](security.md#modes). |
| `--calendar` | Also request Google Calendar access. |
| `--manual` | No browser on this machine (servers): open the link anywhere, then paste the address the browser lands on. |
| `--allow-different-email` | Accept a sign-in from a different address than the one given. |

Logins are stored **encrypted**. On Windows and macOS the key lives in the system keychain (Credential Manager / Keychain). See [Security](security.md#encryption-at-rest).

## 4. Add the server to Claude

### Claude desktop app

*Settings → Developer → Edit Config* opens `claude_desktop_config.json`. Add:

```json
{
  "mcpServers": {
    "gmail-multi": {
      "command": "npx",
      "args": ["-y", "multi-gmail-account-mcp", "--mode", "drafts"]
    }
  }
}
```

From source, use the full path instead:

```json
{
  "mcpServers": {
    "gmail-multi": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\you\\projects\\Multi-Gmail-Account-MCP\\dist\\index.js", "--mode", "drafts"]
    }
  }
}
```

Fully quit Claude (tray icon → Quit) and reopen it. The tools then appear under the connectors / tools menu, along with two slash commands: `morning-digest` and `reply-queue`.

> On Windows the Microsoft Store version of Claude keeps its config under `%LOCALAPPDATA%\Packages\Claude_…\` or `%LOCALAPPDATA%\Claude-Data\…`. Use *Edit Config* so you edit the right file.

### Claude Code

```bash
claude mcp add gmail-multi -- npx -y multi-gmail-account-mcp --mode drafts
```

### Other MCP clients (Cursor, Windsurf, VS Code…)

Use the same command and arguments in the client's MCP settings: `npx -y multi-gmail-account-mcp --mode drafts`.

## 5. Check everything

```bash
gmail-mcp-multi doctor
```

```
Config folder: C:\Users\you\.gmail-mcp
OAuth client:  OK (C:\Users\you\.gmail-mcp\oauth-keys.json)
Encryption:    AES-256-GCM, key in OS keychain
Audit log:     C:\Users\you\.gmail-mcp\audit.log
  OK   shop             gmail  shop@gmail.com (inbox: 8 unread / 13)
  OK   work             gmail  me@company.com (inbox: 0 unread / 43)
```

From source you can also run a live, read-only test through the MCP server: `npm run smoke` (add `-- --draft` to also create and delete a test draft).

Then try in Claude:

- *What's unread across all my accounts?*
- *Who am I supposed to get back to?*
- *Search shop for emails from DHL this month with attachments and read the invoice.*

More ideas in [Everyday use](usage.md).

## Updating and uninstalling

- **Update:** `npm install -g multi-gmail-account-mcp@latest` (or `git pull && npm install` from source), then restart Claude.
- **Disconnect an account:** `gmail-mcp-multi remove <alias>`. This deletes the stored login. Also revoke the app at <https://myaccount.google.com/permissions>.
- **Uninstall:** remove the entry from your Claude config, run `npm uninstall -g multi-gmail-account-mcp`, and delete the `~/.gmail-mcp` folder.
