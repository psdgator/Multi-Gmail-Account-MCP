import * as crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { calendar, calendar_v3 } from "@googleapis/calendar";
import { z } from "zod";
import type { AccountConfig } from "../accounts.js";
import { explainGoogleError, googleAuthFor, RETRY_CONFIG } from "../providers/gmail.js";
import { mapLimit } from "../util.js";
import { multiAccountArg, READ_ONLY, register, requireMode, singleAccountArg, ToolContext, WRITES } from "./common.js";

/** Multi-account Google Calendar (Gmail accounts connected with calendar access). */

export function localTimeZone(): string {
  return process.env.GMAIL_MCP_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Offset (minutes) of `tz` at instant `at`. */
function tzOffsetMinutes(tz: string, at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Local wall-clock time in `tz` → UTC Date. */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMinutes(tz, new Date(guess));
  const t = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(tz, new Date(t));
  return new Date(guess - off2 * 60_000);
}

function ymdIn(tz: string, at: Date): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at).split("-").map(Number);
  return [parts[0], parts[1], parts[2]];
}

/** "today" | "tomorrow" | "YYYY-MM-DD" | ISO datetime → Date (start of day for dates, in tz). */
export function parseWhen(input: string | undefined, tz: string, fallback: Date): Date {
  if (!input) return fallback;
  const s = input.trim().toLowerCase();
  const now = new Date();
  const [y, m, d] = ymdIn(tz, now);
  if (s === "today" || s === "σήμερα") return zonedTime(y, m, d, 0, 0, tz);
  if (s === "tomorrow" || s === "αύριο") return new Date(zonedTime(y, m, d, 0, 0, tz).getTime() + 86_400_000);
  if (s === "now") return now;
  const dm = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dm) return zonedTime(Number(dm[1]), Number(dm[2]), Number(dm[3]), 0, 0, tz);
  const t = Date.parse(input);
  if (Number.isFinite(t)) return new Date(t);
  throw new Error(`Could not understand the date "${input}". Use today, tomorrow, YYYY-MM-DD or an ISO date-time.`);
}

export function calendarApi(ctx: ToolContext, acc: AccountConfig): calendar_v3.Calendar {
  if ((acc.type ?? "gmail") !== "gmail") throw new Error(`Calendar is only available for Gmail accounts ("${acc.alias}" is ${acc.type}).`);
  if (!acc.calendar) {
    throw new Error(`Calendar access is not enabled for "${acc.alias}". Re-connect it with calendar access (authenticate with calendar=true, or CLI: auth ${acc.alias} ${acc.email} --calendar).`);
  }
  const rootUrl = process.env.GMAIL_MCP_API_ROOT || undefined;
  return calendar({ version: "v3", auth: googleAuthFor(ctx.accounts, acc) as never, retryConfig: RETRY_CONFIG, ...(rootUrl ? { rootUrl } : {}) } as calendar_v3.Options);
}

const calListCache = new Map<string, { at: number; items: calendar_v3.Schema$CalendarListEntry[] }>();

async function calendarsOf(api: calendar_v3.Calendar, alias: string, which: "selected" | "all" = "selected") {
  const hit = calListCache.get(alias);
  const items =
    hit && Date.now() - hit.at < 10 * 60_000 ? hit.items : ((await api.calendarList.list({ maxResults: 250 })).data.items ?? []);
  calListCache.set(alias, { at: Date.now(), items });
  return which === "all" ? items : items.filter((c) => c.selected || c.primary);
}

export interface EventSummary {
  account: string;
  calendar: string;
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  meetLink?: string;
  organizer?: string;
  attendees?: { email: string; name?: string; response?: string }[];
  status?: string;
  htmlLink?: string;
}

function toEvent(account: string, calName: string, e: calendar_v3.Schema$Event): EventSummary {
  const allDay = Boolean(e.start?.date && !e.start?.dateTime);
  return {
    account,
    calendar: calName,
    id: e.id ?? "",
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    allDay,
    ...(e.location ? { location: e.location } : {}),
    ...(e.hangoutLink ? { meetLink: e.hangoutLink } : {}),
    ...(e.organizer?.email ? { organizer: e.organizer.displayName ? `${e.organizer.displayName} <${e.organizer.email}>` : e.organizer.email } : {}),
    ...(e.attendees?.length
      ? { attendees: e.attendees.slice(0, 30).map((a) => ({ email: a.email ?? "", ...(a.displayName ? { name: a.displayName } : {}), ...(a.responseStatus ? { response: a.responseStatus } : {}) })) }
      : {}),
    ...(e.status && e.status !== "confirmed" ? { status: e.status } : {}),
    ...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
  };
}

const startKey = (e: EventSummary) => (e.allDay ? `${e.start}T00:00:00Z` : new Date(e.start).toISOString());

/** Events of one account between two instants, across its selected calendars. */
export async function eventsFor(ctx: ToolContext, acc: AccountConfig, timeMin: Date, timeMax: Date, opts: { q?: string; max?: number } = {}): Promise<EventSummary[]> {
  const api = calendarApi(ctx, acc);
  try {
    const cals = await calendarsOf(api, acc.alias);
    const perCal = await mapLimit(cals, 4, async (c) => {
      const res = await api.events.list({
        calendarId: c.id!,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: Math.min(250, opts.max ?? 50),
        ...(opts.q ? { q: opts.q } : {}),
      });
      return (res.data.items ?? []).filter((e) => e.status !== "cancelled").map((e) => toEvent(acc.alias, c.summaryOverride ?? c.summary ?? c.id ?? "", e));
    });
    return perCal.flat().sort((a, b) => (startKey(a) < startKey(b) ? -1 : 1)).slice(0, opts.max ?? 50);
  } catch (err) {
    throw explainGoogleError(acc.alias, err);
  }
}

function calendarAccounts(ctx: ToolContext, account: string | string[] | undefined) {
  const accs = ctx.accounts.resolve(account, true);
  const usable = accs.filter((a) => (a.type ?? "gmail") === "gmail" && a.calendar);
  const skipped = accs.filter((a) => !usable.includes(a)).map((a) => ({ account: a.alias, reason: (a.type ?? "gmail") !== "gmail" ? "not a Gmail account" : "calendar access not enabled" }));
  if (!usable.length) {
    throw new Error(
      "No account has Google Calendar access yet. Re-connect an account with calendar=true (authenticate tool) or `gmail-mcp-multi auth <alias> <email> --calendar`, and enable the Google Calendar API in your Google Cloud project."
    );
  }
  return { usable, skipped };
}

async function fanOutCal<T>(ctx: ToolContext, accs: AccountConfig[], fn: (acc: AccountConfig) => Promise<T>) {
  const ok: { account: AccountConfig; value: T }[] = [];
  const errors: { account: string; error: string }[] = [];
  await mapLimit(accs, 4, async (acc) => {
    try {
      ok.push({ account: acc, value: await fn(acc) });
    } catch (err) {
      errors.push({ account: acc.alias, error: (err as Error).message });
    }
  });
  return { ok, errors };
}

/** Calendar tools are only offered when some account has calendar access (or GMAIL_MCP_CALENDAR=1). */
const hasCalendar = (c: ToolContext) => process.env.GMAIL_MCP_CALENDAR === "1" || c.accounts.listAccounts().some((a) => a.calendar);

export function registerCalendarTools(server: McpServer, ctx: ToolContext): void {
  register(server, ctx, {
    name: "list_events",
    when: hasCalendar,
    title: "Calendar: list events (all accounts)",
    description:
      "List Google Calendar events across all connected accounts with calendar access (merged, sorted by start time). " +
      'Use for "what\'s on my calendar today / this week". Dates: today, tomorrow, YYYY-MM-DD or ISO date-time; times are in the computer\'s time zone.',
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {
      account: multiAccountArg(ctx),
      from: z.string().optional().describe('Start (default "today").'),
      to: z.string().optional().describe("End (exclusive). Default: from + days."),
      days: z.number().int().min(1).max(60).optional().describe("Length of the window in days when `to` is not given (default 1)."),
      query: z.string().optional().describe("Free-text filter (title, description, location, attendees)."),
      maxPerAccount: z.number().int().min(1).max(250).optional(),
    },
    run: async ({ account, from, to, days, query, maxPerAccount }) => {
      const tz = localTimeZone();
      const start = parseWhen(from ?? "today", tz, new Date());
      const end = to ? parseWhen(to, tz, new Date()) : new Date(start.getTime() + (days ?? 1) * 86_400_000);
      const { usable, skipped } = calendarAccounts(ctx, account);
      const { ok, errors } = await fanOutCal(ctx, usable, (acc) => eventsFor(ctx, acc, start, end, { q: query, max: maxPerAccount }));
      const events = ok.flatMap((r) => r.value).sort((a, b) => (startKey(a) < startKey(b) ? -1 : 1));
      return { timeZone: tz, from: start.toISOString(), to: end.toISOString(), count: events.length, events, ...(skipped.length ? { skipped } : {}), ...(errors.length ? { errors } : {}) };
    },
  });

  register(server, ctx, {
    name: "list_calendars",
    when: hasCalendar,
    title: "Calendar: list calendars",
    description: "List the Google calendars of each account with calendar access (and which ones are included in list_events).",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: { account: multiAccountArg(ctx) },
    run: async ({ account }) => {
      const { usable, skipped } = calendarAccounts(ctx, account);
      const { ok, errors } = await fanOutCal(ctx, usable, async (acc) => {
        const items = await calendarsOf(calendarApi(ctx, acc), acc.alias, "all").catch((e) => {
          throw explainGoogleError(acc.alias, e);
        });
        return items.map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary, primary: Boolean(c.primary), included: Boolean(c.selected || c.primary), access: c.accessRole }));
      });
      return { accounts: ok.map((r) => ({ account: r.account.alias, calendars: r.value })), ...(skipped.length ? { skipped } : {}), ...(errors.length ? { errors } : {}) };
    },
  });

  register(server, ctx, {
    name: "find_free_time",
    when: hasCalendar,
    title: "Calendar: find free time across accounts",
    description:
      "Find free slots when you are free in ALL connected calendars at once (busy time from every account is combined). " +
      "Defaults: next 5 working days, 09:00-18:00 local time, 30-minute slots.",
    minMode: "readonly",
    annotations: READ_ONLY,
    input: {
      account: multiAccountArg(ctx),
      from: z.string().optional().describe('Start day (default "today").'),
      days: z.number().int().min(1).max(30).optional().describe("How many days to look at (default 5)."),
      durationMinutes: z.number().int().min(5).max(600).optional().describe("Length of the slot needed (default 30)."),
      workStart: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Working day start, "09:00".'),
      workEnd: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Working day end, "18:00".'),
      includeWeekends: z.boolean().optional(),
      maxSlots: z.number().int().min(1).max(50).optional(),
    },
    run: async (a) => {
      const tz = localTimeZone();
      const day0 = parseWhen(a.from ?? "today", tz, new Date());
      const nDays = a.days ?? 5;
      const dur = (a.durationMinutes ?? 30) * 60_000;
      const [ws, we] = [a.workStart ?? "09:00", a.workEnd ?? "18:00"].map((t) => t.split(":").map(Number));
      const { usable, skipped } = calendarAccounts(ctx, a.account);
      const rangeEnd = new Date(day0.getTime() + (a.includeWeekends ? nDays : nDays * 2 + 3) * 86_400_000);
      const { ok, errors } = await fanOutCal(ctx, usable, async (acc) => {
        const api = calendarApi(ctx, acc);
        try {
          const cals = (await calendarsOf(api, acc.alias)).filter((c) => c.accessRole === "owner" || c.primary);
          const res = await api.freebusy.query({ requestBody: { timeMin: day0.toISOString(), timeMax: rangeEnd.toISOString(), items: cals.map((c) => ({ id: c.id! })) } });
          return Object.values(res.data.calendars ?? {}).flatMap((c) => (c.busy ?? []).map((b) => [Date.parse(b.start!), Date.parse(b.end!)] as [number, number]));
        } catch (err) {
          throw explainGoogleError(acc.alias, err);
        }
      });
      const busy = ok.flatMap((r) => r.value).sort((x, y) => x[0] - y[0]);
      const slots: { start: string; end: string; day: string }[] = [];
      const now = Date.now();
      let daysDone = 0;
      for (let i = 0; daysDone < nDays && i < nDays * 3 && slots.length < (a.maxSlots ?? 10); i++) {
        const dayStart = new Date(day0.getTime() + i * 86_400_000 + 12 * 3_600_000);
        const [y, m, d] = ymdIn(tz, dayStart);
        const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        if (!a.includeWeekends && (weekday === 0 || weekday === 6)) continue;
        daysDone++;
        let cursor = Math.max(zonedTime(y, m, d, ws[0], ws[1], tz).getTime(), now);
        const endOfDay = zonedTime(y, m, d, we[0], we[1], tz).getTime();
        for (const [bs, be] of busy) {
          if (be <= cursor || bs >= endOfDay) continue;
          if (bs - cursor >= dur) slots.push({ day: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, start: new Date(cursor).toISOString(), end: new Date(bs).toISOString() });
          cursor = Math.max(cursor, be);
        }
        if (endOfDay - cursor >= dur) slots.push({ day: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, start: new Date(cursor).toISOString(), end: new Date(endOfDay).toISOString() });
      }
      return { timeZone: tz, durationMinutes: a.durationMinutes ?? 30, accountsChecked: ok.map((r) => r.account.alias), freeSlots: slots.slice(0, a.maxSlots ?? 10), ...(skipped.length ? { skipped } : {}), ...(errors.length ? { errors } : {}) };
    },
  });

  register(server, ctx, {
    name: "create_event",
    when: hasCalendar,
    title: "Calendar: create an event",
    description:
      "Create a Google Calendar event in one account (full mode only). Invitations are NOT emailed unless notifyAttendees=true. " +
      "start/end: ISO date-time (local time zone if no offset) or YYYY-MM-DD for all-day events.",
    minMode: "full",
    annotations: WRITES,
    input: {
      account: singleAccountArg(ctx),
      summary: z.string().min(1),
      start: z.string(),
      end: z.string().optional().describe("Default: start + 1 hour (or the same day for all-day)."),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional().describe("Email addresses."),
      addMeet: z.boolean().optional().describe("Add a Google Meet link."),
      notifyAttendees: z.boolean().optional().describe("Email invitations to attendees (default false)."),
      calendarId: z.string().optional().describe('Default "primary".'),
    },
    run: async (a) => {
      const [acc] = ctx.accounts.resolve(a.account, false);
      requireMode(ctx, acc, "full", "create_event");
      const api = calendarApi(ctx, acc);
      const tz = localTimeZone();
      const allDay = /^\d{4}-\d{2}-\d{2}$/.test(a.start.trim());
      let start: calendar_v3.Schema$EventDateTime;
      let end: calendar_v3.Schema$EventDateTime;
      if (allDay) {
        const s = a.start.trim();
        const e = a.end?.trim() ?? new Date(Date.parse(`${s}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        start = { date: s };
        end = { date: e };
      } else {
        const hasOffset = (v: string) => /(Z|[+-]\d{2}:?\d{2})$/.test(v.trim());
        const sStr = a.start.trim();
        const eStr = a.end?.trim();
        start = hasOffset(sStr) ? { dateTime: new Date(sStr).toISOString() } : { dateTime: sStr.length === 16 ? `${sStr}:00` : sStr, timeZone: tz };
        if (eStr) end = hasOffset(eStr) ? { dateTime: new Date(eStr).toISOString() } : { dateTime: eStr.length === 16 ? `${eStr}:00` : eStr, timeZone: tz };
        else {
          const m = sStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
          const startMs = hasOffset(sStr) || !m ? Date.parse(sStr) : zonedTime(+m[1], +m[2], +m[3], +m[4], +m[5], tz).getTime();
          if (!Number.isFinite(startMs)) throw new Error(`Could not understand start "${a.start}".`);
          end = { dateTime: new Date(startMs + 3_600_000).toISOString() };
        }
      }
      try {
        const res = await api.events.insert({
          calendarId: a.calendarId ?? "primary",
          sendUpdates: a.notifyAttendees ? "all" : "none",
          conferenceDataVersion: a.addMeet ? 1 : 0,
          requestBody: {
            summary: a.summary,
            description: a.description,
            location: a.location,
            start,
            end,
            attendees: a.attendees?.map((email) => ({ email })),
            ...(a.addMeet ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
          },
        });
        return { status: "created", account: acc.alias, event: toEvent(acc.alias, a.calendarId ?? "primary", res.data), invitationsSent: Boolean(a.notifyAttendees && a.attendees?.length) };
      } catch (err) {
        throw explainGoogleError(acc.alias, err);
      }
    },
  });
}
