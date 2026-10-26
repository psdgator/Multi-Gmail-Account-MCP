# Everyday use

You don't call tools yourself. You talk to Claude, and it picks the right tool. This page shows what you can ask, grouped by job, with the tool Claude uses in brackets. Replace the aliases (`shop`, `work`) with your own.

## Catch up

- *"Morning briefing."* or type the **`/morning-digest`** slash command (`daily_digest`). Gives unread counts, new personal mail since yesterday, newsletters as a count, what's waiting for your reply, and today's calendar, for every account.
- *"What's unread across all my accounts?"* (`inbox_summary`)
- *"Anything new in work since this morning?"* (`daily_digest` with `account: "work"`, `sinceHours`)

## Don't leave people waiting

- *"Who am I supposed to get back to?"* (`needs_reply`). Lists conversations where someone else wrote last and you haven't replied, oldest first. Newsletters and no-reply senders are skipped, and conversations where you already have a draft are flagged.
- **`/reply-queue`**: Claude goes through them one by one, proposes a reply in the thread's language, and saves it as a draft when you approve.
- *"Only show the ones waiting more than 2 days."* (`olderThanHours: 48`)

## Find things

- *"Find the DHL invoices from October in all accounts."* (`search_emails` with `from:dhl after:2026/10/01 has:attachment`)
- *"Show me the whole conversation with Maria about the shop window."* (`search_emails` → `read_thread`)
- *"What's Maria's email address?"* (`find_contact`, which ignores accents and searches every account)

Search uses Gmail's syntax everywhere: `from:`, `to:`, `subject:`, `is:unread`, `has:attachment`, `newer_than:7d`, `after:2026/10/01`, `label:Clients`, `in:sent`. IMAP accounts understand the common operators (see [IMAP](imap.md#search-syntax-supported-for-imap)). When the same email reached two of your accounts, it's shown once with `alsoIn`.

## Read attachments

- *"What's the total on the invoice in that email?"* (`read_attachment` on a PDF)
- *"Compare the sizes in the two Excel price lists Nikos sent."* (XLSX)
- *"Read the text on the photo the customer attached."* (images come back for Claude to look at)
- *"Save the print files from that email to my Desktop."* (`save_attachment`, local mode only)

Details and limits: [Attachments](attachments.md).

## Write (drafts by default)

- *"Draft a reply to Maria saying the vinyls are ready on Thursday."* (`create_draft` with `replyToMessageId`). Threaded, with the right recipients, subject and your Gmail signature.
- *"Reply all and attach C:\\Users\\me\\Desktop\\offer.pdf."* (`replyAll`, `attachments`)
- *"Forward that invoice to my accountant with a short note."* (`forward_email`, with the original attachments re-attached)
- *"Send it from my company address."* (`from:` uses a Gmail *Send mail as* address or an IMAP account's extra address)

Drafts land in the account's Drafts folder. You review and send them from Gmail or your mail app. In `full` mode Claude can also send, but only when you explicitly ask.

## Tidy up

- *"Which newsletters do I get the most?"* (`find_newsletters`)
- *"Archive everything from news@shop.example older than a month."* (`bulk_cleanup`). Claude **always shows a preview first** (how many emails, with a sample) and only acts after you agree.
- *"Mark all GitHub notifications as read in work."* (`bulk_cleanup` with `markRead`)
- *"Label the Acme emails as Clients/Acme."* (`create_label`, `modify_emails`)
- *"Unsubscribe from that newsletter and archive what's in the inbox."* (`unsubscribe` with `archiveExisting`; full mode)

## Calendar

Needs calendar access on the account ([Calendar](calendar.md)).

- *"What's on my calendar tomorrow?"* (`list_events`, all accounts merged)
- *"When am I free for an hour this week?"* (`find_free_time` checks every account's calendars together)
- *"Put the Acme delivery on Monday at 10."* (`create_event`; full mode, no invitations unless you ask)

## Check what Claude did

- *"What did you change in my mail today?"* (`view_audit_log` with `onlyChanges`)
- In a terminal: `gmail-mcp-multi audit 30 --changes`

## Tips

- Name the account when it matters ("in **work**…"). Leave it out to cover everything.
- Make your most-used account the default: *"Make shop my default account."*
- If a login expires, Claude will say so. Reconnect with *"reconnect shop"* (or `gmail-mcp-multi auth shop you@gmail.com`).
- Claude treats email content as untrusted. If an email contains instructions, it won't follow them.
