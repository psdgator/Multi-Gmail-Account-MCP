# Calendar

Gmail accounts can optionally share their Google Calendar. Then Claude can see your day across all accounts at once, find time that's free in **every** calendar, and add events.

## Turn it on

1. In your Google Cloud project, enable the **Google Calendar API** (*APIs & Services → Library*).
2. Re-connect each account with calendar access:

   ```bash
   gmail-mcp-multi auth shop you@gmail.com --calendar
   ```

   You can also ask Claude: *"Reconnect shop with calendar access"*. That calls `authenticate` with `calendar=true`.
3. Restart Claude. The calendar tools only appear once at least one account has calendar access (or set `GMAIL_MCP_CALENDAR=1`).

Permissions requested: `calendar.readonly`, plus `calendar.events` when the server runs in `full` mode.

## Tools

| Tool | Mode | What it does |
|---|---|---|
| `list_events` | readonly | Events from all calendar accounts merged by start time. `from`/`to` accept `today`, `tomorrow`, `YYYY-MM-DD` or ISO times; `query` filters by text. |
| `list_calendars` | readonly | Each account's calendars and which ones are included. Calendars ticked in Google Calendar, plus the primary one, are included. |
| `find_free_time` | readonly | Slots of the requested length that are free in all accounts' calendars, within working hours (default 09:00 to 18:00, weekdays, next 5 days). |
| `create_event` | full | Adds an event (or an all-day event with `YYYY-MM-DD`). Optional attendees, location, and a Google Meet link. **Invitations are not emailed** unless `notifyAttendees: true`. |

`daily_digest` (and the `/morning-digest` prompt) include today's events for accounts with calendar access.

## Time zones

Times without an offset are read in the computer's time zone. Set `GMAIL_MCP_TIMEZONE` (e.g. `Europe/Athens`) to override it, which is useful on servers that run in UTC. Results include the `timeZone` they were computed in.
