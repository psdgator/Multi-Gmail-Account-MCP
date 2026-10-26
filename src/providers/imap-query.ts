import type { SearchObject } from "imapflow";

/**
 * Translates the common subset of Gmail search syntax into an imapflow search
 * object, so the same queries work for IMAP mailboxes.
 *
 * Supported: from: to: cc: bcc: subject: (incl. "quoted phrases"), is:unread / is:read /
 * is:starred / is:unstarred / is:draft / is:answered, after: before: (YYYY/MM/DD or
 * YYYY-MM-DD), newer_than: older_than: (Nd / Nw / Nm / Ny), larger: smaller: (k/m),
 * rfc822msgid:, has:attachment (checked after the search), in:inbox / sent / drafts /
 * trash / spam / archive / anywhere, label:<folder> (or in:<folder>), free words and
 * "phrases" (IMAP TEXT), negation with a leading "-", and "a OR b".
 * Unknown operators (category:, is:important, has:drive, ...) are ignored and reported.
 */

export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "all";

export interface ImapQuery {
  /** Where to look: special folders by role, named folders, or every folder. */
  roles: FolderRole[];
  folders: string[];
  anywhere: boolean;
  criteria: SearchObject;
  /** Exact lower bound (newer_than: has hour precision that IMAP SINCE lacks). */
  notBefore?: Date;
  hasAttachment?: boolean;
  ignored: string[];
}

type Crit = [key: string, value: unknown];

interface Token {
  neg: boolean;
  op?: string;
  value: string;
  or?: boolean;
}

/** Split into tokens, keeping quoted values together: from:"Γιάννα Π" -"x y" OR */
export function tokenize(q: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(-)?(?:([a-zA-Z_]+):)?(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const [, neg, op, quoted, bare] = m;
    const value = quoted ?? bare ?? "";
    if (!op && !neg && value === "OR") {
      out.push({ neg: false, value: "OR", or: true });
      continue;
    }
    if (!op && (value === "(" || value === ")" || value === "{" || value === "}")) continue;
    out.push({ neg: Boolean(neg), op: op?.toLowerCase(), value: value.replace(/^[({]+|[)}]+$/g, "") });
  }
  return out;
}

function parseDate(v: string): Date | undefined {
  const m = v.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (/^\d{9,11}$/.test(v)) return new Date(Number(v) * 1000);
  return undefined;
}

function relative(v: string, now: Date): Date | undefined {
  const m = v.match(/^(\d+)([dwmyh])$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const d = new Date(now);
  switch (m[2].toLowerCase()) {
    case "h":
      d.setTime(d.getTime() - n * 3_600_000);
      break;
    case "d":
      d.setTime(d.getTime() - n * 86_400_000);
      break;
    case "w":
      d.setTime(d.getTime() - n * 7 * 86_400_000);
      break;
    case "m":
      d.setUTCMonth(d.getUTCMonth() - n);
      break;
    case "y":
      d.setUTCFullYear(d.getUTCFullYear() - n);
      break;
  }
  return d;
}

function size(v: string): number | undefined {
  const m = v.match(/^(\d+(?:\.\d+)?)([km]?)b?$/i);
  if (!m) return undefined;
  const mult = m[2].toLowerCase() === "m" ? 1024 * 1024 : m[2].toLowerCase() === "k" ? 1024 : 1;
  return Math.round(Number(m[1]) * mult);
}

const ROLE_WORDS: Record<string, FolderRole> = {
  inbox: "inbox",
  sent: "sent",
  draft: "drafts",
  drafts: "drafts",
  trash: "trash",
  bin: "trash",
  spam: "junk",
  junk: "junk",
  archive: "archive",
  all: "all",
};

/**
 * imapflow search objects cannot repeat a key and have no AND operator, so
 * repeated criteria are nested: { from: a, or: [ { from: b } ] } (a one-element
 * OR is just its operand) or { not: { not: {...} } } when "or" is taken.
 */
export function buildCriteria(list: Crit[]): SearchObject {
  const base: Record<string, unknown> = {};
  const rest: Crit[] = [];
  for (const [k, v] of list) {
    if (k in base) rest.push([k, v]);
    else base[k] = v;
  }
  if (rest.length) {
    const nested = buildCriteria(rest);
    if (!("or" in base)) base.or = [nested];
    else if (!("not" in base)) base.not = { not: nested };
    else return { or: [base], not: { not: nested } } as SearchObject;
  }
  return base as SearchObject;
}

function critFor(t: Token, now: Date, q: ImapQuery): Crit | undefined {
  const v = t.value;
  switch (t.op) {
    case undefined:
      return v ? ["text", v] : undefined;
    case "from":
    case "to":
    case "cc":
    case "bcc":
    case "subject":
      return [t.op, v];
    case "is":
      switch (v.toLowerCase()) {
        case "unread":
          return ["seen", false];
        case "read":
          return ["seen", true];
        case "starred":
        case "flagged":
          return ["flagged", true];
        case "unstarred":
          return ["flagged", false];
        case "draft":
          return ["draft", true];
        case "answered":
        case "replied":
          return ["answered", true];
      }
      q.ignored.push(`is:${v}`);
      return undefined;
    case "after":
    case "since": {
      const d = parseDate(v);
      if (d) return ["since", d];
      break;
    }
    case "before": {
      const d = parseDate(v);
      if (d) return ["before", d];
      break;
    }
    case "newer_than":
    case "newer": {
      const d = relative(v, now);
      if (d) {
        if (!t.neg) q.notBefore = !q.notBefore || d > q.notBefore ? d : q.notBefore;
        return ["since", new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))];
      }
      break;
    }
    case "older_than":
    case "older": {
      const d = relative(v, now);
      if (d) return ["before", d];
      break;
    }
    case "larger": {
      const n = size(v);
      if (n !== undefined) return ["larger", n];
      break;
    }
    case "smaller": {
      const n = size(v);
      if (n !== undefined) return ["smaller", n];
      break;
    }
    case "rfc822msgid": {
      const id = v.startsWith("<") ? v : `<${v}>`;
      return ["header", { "message-id": id }];
    }
  }
  q.ignored.push(`${t.op}:${v}`);
  return undefined;
}

export function parseGmailQuery(query: string, now = new Date()): ImapQuery {
  const q: ImapQuery = { roles: [], folders: [], anywhere: false, criteria: {}, ignored: [] };
  const tokens = tokenize(query ?? "");
  const crits: Crit[] = [];
  let pendingOr: Crit | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.or) continue;

    // Location operators.
    if ((t.op === "in" || t.op === "label") && !t.neg) {
      const word = t.value.toLowerCase();
      if (word === "anywhere") q.anywhere = true;
      else if (t.op === "in" && ROLE_WORDS[word]) q.roles.push(ROLE_WORDS[word]);
      else q.folders.push(t.value);
      continue;
    }
    if (t.op === "has") {
      if (t.value.toLowerCase() === "attachment") q.hasAttachment = !t.neg;
      else q.ignored.push(`has:${t.value}`);
      continue;
    }
    if (t.op === "category" || t.op === "list" || t.op === "filename" || t.op === "deliveredto") {
      q.ignored.push(`${t.op}:${t.value}`);
      continue;
    }

    let c = critFor(t, now, q);
    if (!c) continue;
    if (t.neg) c = ["not", { [c[0]]: c[1] }];

    // "a OR b OR c": collect into one or-list.
    const nextIsOr = tokens[i + 1]?.or;
    if (pendingOr || nextIsOr) {
      const item = { [c[0]]: c[1] };
      if (pendingOr) (pendingOr[1] as unknown[]).push(item);
      else {
        pendingOr = ["or", [item]];
        crits.push(pendingOr);
      }
      if (!nextIsOr) pendingOr = undefined;
      continue;
    }
    crits.push(c);
  }

  q.criteria = crits.length ? buildCriteria(crits) : { all: true };
  return q;
}
