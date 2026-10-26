# Troubleshooting

Start with `gmail-mcp-multi doctor`. It checks the OAuth client file, the encryption key, and each account.

| Symptom | Cause and fix |
|---|---|
| **The tools don't show up in Claude** | Fully quit Claude (tray icon → Quit) and reopen it. Check the config with *Settings → Developer → Edit Config*. The Microsoft Store version of Claude on Windows uses a different config location than `%APPDATA%\Claude`, so always open it from that menu. Look at the server log under *Settings → Developer*. |
| `'tsc' is not recognized` during `npm install` | Your system sets `NODE_ENV=production`, so npm skips dev tools. Use `npm install --include=dev`. |
| `Google OAuth client file not found` | Save the *Desktop app* client JSON as `~/.gmail-mcp/oauth-keys.json` ([Setup § 2](setup.md#2-create-a-google-oauth-client-once)). |
| "Google hasn't verified this app" | Expected for a personal OAuth app. Click **Advanced → Go to … (unsafe)**. |
| "Access blocked: … app is blocked" on a Workspace account | The Workspace admin must trust the client ID: *Admin console → Security → API controls → App access control*. |
| `The Google sign-in for "x" has expired or was revoked` (`invalid_grant`) | Reconnect the account. If this happens **every 7 days**, your OAuth app is still in *Testing*: publish it (*Google Auth Platform → Audience → Publish app*). |
| `You signed in as a@…, but "x" is meant for b@…` | You picked the wrong Google account in the browser. Run `auth` again and choose the right one (or pass `--allow-different-email`). |
| `was connected with fewer permissions than this action needs` | The account was connected in a lower mode or without calendar access. Reconnect with `--mode full` and/or `--calendar`. |
| `The Google API for this action is not enabled` | Enable the Gmail API or Google Calendar API in your Cloud project. |
| `Could not decrypt stored credentials` | The encryption key changed (new machine, keychain reset, or a different `GMAIL_MCP_MASTER_KEY`). Reconnect the account. |
| `No OS keychain available; stored the encryption key in …master.key` | Normal on headless Linux. Set `GMAIL_MCP_MASTER_KEY` to keep the key outside the config folder. |
| `… is outside the folders this server may use` / `… hidden file` / `… protected location` | Attachments can only be read from, and saved to, normal folders under your home folder. Add other folders with `GMAIL_MCP_ALLOWED_DIRS` (e.g. `D:\Work`). See [Security → Local files](security.md#local-files). |
| `… is a program, script or shortcut` from `save_attachment` | The server doesn't save executable or script files from email. If you trust the sender, download it from Gmail yourself. |
| `This PDF expands to more than 256 MB when decompressed` | The PDF is unusually large inside (or built to exhaust memory). Use `save_attachment` and open it in a PDF viewer. |
| `Draft … is already being sent` | Two send requests for the same draft overlapped. Check *Sent* before trying again. |
| `This search can't be applied exactly on "x"` | `bulk_cleanup` refuses queries the mailbox can't apply exactly (IMAP and Gmail-only operators). Rephrase without the listed parts. |
| `encrypted with a different key` / `Not creating a new key over existing encrypted logins` | The encryption key is missing or different (new machine, keychain reset, changed `GMAIL_MCP_MASTER_KEY`). Restore it, or remove and reconnect the accounts. |
| `IMAP login failed for "x"` | Wrong password or login name. Run `gmail-mcp-multi add-imap x …` again. See [IMAP](imap.md). |
| `… this server has no UIDPLUS …` (IMAP) | Another mail app left messages marked deleted in that folder, and the server can't remove just one. Empty that folder's deleted messages in your mail app (often "Compact" or "Expunge"), then try again. |
| `… is the All Mail folder …` (IMAP) | Moving mail out of All Mail would delete it. Act on it from INBOX or its label folder instead. |
| `Calendar access is not enabled for "x"` | Reconnect with `--calendar` ([Calendar](calendar.md)). |
| Search finds nothing on an IMAP account | IMAP searches INBOX by default; add `in:anywhere`. Gmail-only operators like `category:` are ignored. |
| `pageToken only works when searching a single account` | Name one account when paging through results. |
| `The matching emails changed since the preview` | Mail arrived or moved between preview and confirmation of `bulk_cleanup`. Run a new preview. |
| The browser doesn't open for sign-in | Copy the link printed in the terminal (or returned by `authenticate`) into a browser. On a server use `auth … --manual`. |
| Hosted mode: claude.ai says it can't connect | Check `https://your-host/healthz`, DNS, and that ports 80/443 reach Caddy. See [Hosted mode](hosted.md#troubleshooting). |

Still stuck? Open an issue at <https://github.com/psdgator/Multi-Gmail-Account-MCP/issues> with the output of `gmail-mcp-multi doctor`. Remove email addresses first if you prefer.
