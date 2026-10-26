# Accounts and multi-account behaviour

## Aliases

Every mailbox has an **alias**: a short name you choose when connecting it (`shop`, `work`, `personal`). You can refer to an account by its alias or its email address, in any letter case. Aliases may use letters, digits, `.`, `-` and `_`. The word `all` is reserved.

```bash
gmail-mcp-multi accounts
```

```
* shop             shop@gmail.com          gmail  signed in  +calendar
  work             me@company.com          gmail  signed in
  hosting          me@mydomain.gr          imap   signed in  (limited to readonly)
```

`*` marks the **default** account (`gmail-mcp-multi default <alias>`, or ask Claude to "make work my default"). With a single account, that account is the default automatically.

## The `account` argument

| You pass | Multi-account tools | Single-account tools |
|---|---|---|
| nothing | **every** account | the default account |
| `"shop"` / `"shop@gmail.com"` | that account | that account |
| `["shop", "work"]` or `"shop, work"` | those accounts | error: pick one |
| `"all"` | every account | error: pick one |

**Multi-account tools** run on all selected mailboxes in parallel and merge the results:
`search_emails`, `inbox_summary`, `needs_reply`, `daily_digest`, `find_newsletters`, `find_contact`, `list_labels`, `list_drafts`, `list_filters`, `list_events`, `list_calendars`, `find_free_time`.

Merged results are tagged with the account they came from, so Claude knows where to act next. If one account fails (expired login, network), the others still return, and the failure is listed under `errors`.

**Duplicates:** the same email often lands in two of your accounts (CC'd to both, or a message you sent from one account to the other). Search results show it **once** and list the other accounts under `alsoIn`. Matching uses the email's Message-ID.

**Finding a message without its account:** `read_email`, `read_thread`, `read_attachment` and `save_attachment` try the default account first and then the others when you don't name the account.

## Per-account limits

The server runs in one [mode](security.md#modes) (`readonly`, `drafts` or `full`). You can lower it for individual accounts, for example to keep a shared or sensitive mailbox read-only while drafting elsewhere:

```bash
gmail-mcp-multi limit work readonly
gmail-mcp-multi limit work none        # remove the limit
```

Limits only lower permissions. They never raise an account above the server mode.

## Account types

| Type | How it connects | Notes |
|---|---|---|
| `gmail` | Gmail API + Google OAuth | Labels, filters, threads, send-as addresses, signatures and Calendar. |
| `imap` | IMAP + SMTP with a password | Any mail provider. Labels are folders; no filters or Calendar. See [IMAP accounts](imap.md). |

## Calendar access

Calendar is opt-in per Gmail account. Connect (or re-connect) with calendar access:

```bash
gmail-mcp-multi auth shop shop@gmail.com --calendar
```

You can also ask Claude to reconnect with calendar=true. The Google Calendar API must be enabled in your Google Cloud project. Restart Claude afterwards so the calendar tools appear. See [Calendar](calendar.md).

## Removing an account

```bash
gmail-mcp-multi remove shop
```

This deletes the alias and its encrypted login from `~/.gmail-mcp`. To fully revoke access, also remove the app at <https://myaccount.google.com/permissions>.
