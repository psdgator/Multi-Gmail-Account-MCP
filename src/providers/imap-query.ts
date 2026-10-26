import type { SearchObject } from "imapflow";

/**
 * Translates Gmail search syntax into an imapflow search object, so the same
 * queries work for IMAP mailboxes.
 *
 * Applied faithfully:
 *   from: to: cc: bcc: subject: (incl. "quoted phrases"), free words and "phrases" (IMAP TEXT),
 *   is:unread / is:read / is:starred / is:unstarred / is:draft / is:answered,
 *   after: before: (YYYY/MM/DD or YYYY-MM-DD = whole days on the server; a Unix timestamp =
 *   exact to the second), larger: smaller: (k/m), rfc822msgid:, newer_than: / older_than:
 *   (h/d/w/m/y, exact to the second), negation with a leading "-", "a OR b", grouping with
 *   ( ) and { } (OR-group), and, at the top level only (not negated, not inside a group):
 *   in:inbox|sent|drafts|trash|spam|archive|anywhere, label:<folder> / in:<folder>, has:attachment.
 *
 * Exactness: IMAP FROM/TO/CC/BCC match substrings, and SINCE/BEFORE only know whole days (in
 * the server's time zone). So a full address (from:bob@x.com) must be exactly one of that
 * field's addresses (not "notbob@x.com"), and timestamps / newer_than: / older_than: are
 * compared with the internal date to the second. The server search is made a little broader
 * where needed and the provider narrows it afterwards: top-level parts through `addrs`,
 * `notBefore` and `notAfter`; parts inside OR / NOT groups through `exact` (evaluated as UID
 * sets). A partial value (from:bob, from:@x.com) keeps IMAP's substring meaning.
 *
 * Everything else is NOT applied and is listed in `ignored` (the provider returns it as
 * SearchResult.ignored): Gmail-only operators (category:, is:important, list:, filename:,
 * deliveredto:, has:drive ...), unknown operators, negated or grouped location operators
 * (-in:sent, (label:x OR ...)), has:attachment inside a group, invalid dates, periods or
 * sizes, unbalanced parentheses, and a non-empty query with no usable term at all ("OR",
 * "-", '""'). When `ignored` is non-empty the results can be broader (or narrower) than the
 * query asked for; bulk actions must refuse such queries. The empty query means all mail.
 */

export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "all";
export type AddrField = "from" | "to" | "cc" | "bcc";

/** A part the server can only approximate; the provider checks it exactly. */
export type ExactLeaf =
  /** The field holds exactly this address (lower case), compared with the parsed envelope. */
  | { kind: "addr"; field: AddrField; addr: string }
  /** INTERNALDATE >= at (since) or < at (!since). */
  | { kind: "time"; since: boolean; at: Date };

/** The query as a tree; "crit" leaves are exact on the server. */
export type QNode =
  | { t: "crit"; crit: Crit }
  | { t: "exact"; leaf: ExactLeaf }
  | { t: "and"; items: QNode[] }
  | { t: "or"; items: QNode[] }
  | { t: "not"; item: QNode };

export interface ImapQuery {
  /** Where to look: special folders by role, named folders, or every folder. */
  roles: FolderRole[];
  folders: string[];
  anywhere: boolean;
  /** Server search. Exact, or broader where `addrs` / `notBefore` / `notAfter` / `exact` narrow it. */
  criteria: SearchObject;
  /** Top-level full addresses, checked on the fetched envelopes (neg: must NOT be there). */
  addrs: { field: AddrField; addr: string; neg: boolean }[];
  /** Exact lower bound on the internal date (top-level newer_than:, after:<timestamp>). */
  notBefore?: Date;
  /** Exact upper bound (exclusive) on the internal date (top-level older_than:, before:<timestamp>). */
  notAfter?: Date;
  /** Top-level groups that contain exact parts under OR / NOT; each must hold as well. */
  exact: QNode[];
  hasAttachment?: boolean;
  ignored: string[];
}

export type Crit = [key: string, value: unknown];

export interface Token {
  neg: boolean;
  op?: string;
  value: string;
  or?: boolean;
  /** Grouping punctuation: "(" ")" "{" "}" (a "-" before "(" / "{" sets neg). */
  group?: "(" | ")" | "{" | "}";
}

/**
 * Split into tokens, keeping quoted values together and separating grouping
 * punctuation: from:"Μαρία Π" -"x y" OR (a OR b) {c d}
 */
export function tokenize(q: string): Token[] {
  const out: Token[] = [];
  const s = q ?? "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if ((ch === "-" && (s[i + 1] === "(" || s[i + 1] === "{")) || ch === "(" || ch === "{") {
      const neg = ch === "-";
      const g = (neg ? s[i + 1] : ch) as "(" | "{";
      out.push({ neg, value: g, group: g });
      i += neg ? 2 : 1;
      continue;
    }
    if (ch === ")" || ch === "}") {
      out.push({ neg: false, value: ch, group: ch });
      i++;
      continue;
    }
    // A term: [-][op:]("quoted"|bare)
    let j = i;
    let neg = false;
    if (s[j] === "-") {
      neg = true;
      j++;
    }
    let op: string | undefined;
    const opm = /^([a-zA-Z_][a-zA-Z0-9_]*):/.exec(s.slice(j)); // digits too: rfc822msgid:
    if (opm) {
      op = opm[1].toLowerCase();
      j += opm[0].length;
    }
    let value = "";
    if (s[j] === '"') {
      const end = s.indexOf('"', j + 1);
      value = end === -1 ? s.slice(j + 1) : s.slice(j + 1, end);
      j = end === -1 ? s.length : end + 1;
    } else {
      let k = j;
      while (k < s.length && !/\s/.test(s[k]) && s[k] !== ")" && s[k] !== "}") k++;
      value = s.slice(j, k);
      j = k;
    }
    i = j;
    if (!op && !neg && value === "OR") {
      out.push({ neg: false, value: "OR", or: true });
      continue;
    }
    if (!op && !neg && value === "AND") continue; // Gmail's AND is implicit
    if (!op && !value) continue; // a lone "-"
    out.push({ neg, op, value });
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

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * Midnight (UTC) `days` days after the UTC day of `d`. IMAP SINCE/BEFORE compare whole days in
 * the server's (or the message's) time zone, up to 14 hours away from UTC, so day bounds one
 * day wider than the UTC day are always broader than an exact instant bound, and day bounds
 * two days further are always inside it. Always midnight: imapflow moves a non-midnight
 * BEFORE to the next day.
 */
export const dayPlus = (d: Date, days: number) => new Date(startOfUtcDay(d).getTime() + days * 86_400_000);

/** A complete address (local@domain.tld): matched exactly. Anything else is a substring. */
const FULL_ADDR = /^[^\s@<>()",;:]+@[^\s@<>()",;:.]+(?:\.[^\s@<>()",;:.]+)+$/;
const TIMESTAMP = /^\d{9,11}$/;

const isAddrOp = (op: string | undefined): op is AddrField => op === "from" || op === "to" || op === "cc" || op === "bcc";

/** A full address term (from:bob@x.com), or undefined. */
function fullAddr(t: Token): { field: AddrField; addr: string } | undefined {
  return isAddrOp(t.op) && FULL_ADDR.test(t.value) ? { field: t.op, addr: t.value.toLowerCase() } : undefined;
}

/**
 * An exact time bound: newer_than: / older_than: (relative) or after: / before: with a Unix
 * timestamp. Negation flips the direction ("-older_than:3d" = newer than 3 days). Plain
 * dates (YYYY/MM/DD) are left to the server as whole days.
 */
function timeBound(t: Token, now: Date): { since: boolean; at: Date } | undefined {
  switch (t.op) {
    case "newer_than":
    case "newer":
    case "older_than":
    case "older": {
      const at = relative(t.value, now);
      return at ? { since: (t.op === "newer_than" || t.op === "newer") !== t.neg, at } : undefined;
    }
    case "after":
    case "since":
    case "before":
      return TIMESTAMP.test(t.value) ? { since: (t.op !== "before") !== t.neg, at: new Date(Number(t.value) * 1000) } : undefined;
  }
  return undefined;
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

// ---------- syntax tree ----------

type Node = { type: "term"; tok: Token } | { type: "and"; items: Node[] } | { type: "or"; items: Node[] } | { type: "not"; item: Node };

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Token[],
    private readonly ignored: string[]
  ) {}

  private peek(): Token | undefined {
    return this.toks[this.i];
  }

  /** A sequence (implicit AND) until `end` or the end of input. */
  seq(end?: ")" | "}"): Node {
    const items: Node[] = [];
    for (;;) {
      const t = this.peek();
      if (!t) {
        if (end) this.ignored.push("unbalanced parentheses");
        break;
      }
      if (t.group === ")" || t.group === "}") {
        if (end && t.group === end) {
          this.i++;
          break;
        }
        // Stray closer: skip it, but say so.
        this.ignored.push(`unbalanced "${t.group}"`);
        this.i++;
        continue;
      }
      if (t.or) {
        // A leading/dangling OR: nothing to join.
        this.i++;
        continue;
      }
      items.push(this.orExpr());
    }
    return items.length === 1 ? items[0] : { type: "and", items };
  }

  private orExpr(): Node {
    const items = [this.unary()];
    while (this.peek()?.or) {
      this.i++;
      const t = this.peek();
      if (!t || t.group === ")" || t.group === "}" || t.or) break;
      items.push(this.unary());
    }
    return items.length === 1 ? items[0] : { type: "or", items };
  }

  private unary(): Node {
    const t = this.toks[this.i++];
    if (t.group === "(" || t.group === "{") {
      let node: Node;
      if (t.group === "(") node = this.seq(")");
      else {
        // {a b c} is Gmail's OR-group.
        const inner = this.seq("}");
        node = inner.type === "and" ? { type: "or", items: inner.items } : inner;
      }
      return t.neg ? { type: "not", item: node } : node;
    }
    return { type: "term", tok: t };
  }
}

/** Criterion for a simple term, or undefined (recorded in `ignored`). `where` describes the context for messages. */
function termCrit(t: Token, now: Date, ignored: string[], nested: boolean): Crit | undefined {
  const v = t.value;
  const label = `${t.neg ? "-" : ""}${t.op ? `${t.op}:` : ""}${v}`;
  const skip = (why = "") => {
    ignored.push(`${label}${why}`);
    return undefined;
  };
  switch (t.op) {
    case undefined:
      return v ? ["text", v] : undefined;
    case "from":
    case "to":
    case "cc":
    case "bcc":
    case "subject":
      return v ? [t.op, v] : skip();
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
      return skip();
    case "after":
    case "since": {
      const d = parseDate(v);
      return d ? ["since", d] : skip(" (invalid date)");
    }
    case "before": {
      const d = parseDate(v);
      return d ? ["before", d] : skip(" (invalid date)");
    }
    case "older_than":
    case "older":
    case "newer_than":
    case "newer":
      return skip(" (invalid period)"); // valid ones are exact time bounds (timeBound)
    case "larger": {
      const n = size(v);
      return n !== undefined ? ["larger", n] : skip(" (invalid size)");
    }
    case "smaller": {
      const n = size(v);
      return n !== undefined ? ["smaller", n] : skip(" (invalid size)");
    }
    case "rfc822msgid": {
      if (!v) return skip();
      const id = v.startsWith("<") ? v : `<${v}>`;
      return ["header", { "message-id": id }];
    }
    case "in":
    case "label":
      return skip(nested ? " (inside a group: not supported for IMAP)" : " (negated folders are not supported for IMAP)");
    case "has":
      return skip(v.toLowerCase() === "attachment" ? " (inside a group: not supported for IMAP)" : "");
  }
  return skip();
}

/** A syntax node as a query tree (undefined = nothing applicable; the reason is in `ignored`). */
function toQNode(n: Node, now: Date, ignored: string[]): QNode | undefined {
  switch (n.type) {
    case "term": {
      const t = n.tok;
      const tb = timeBound(t, now);
      if (tb) return { t: "exact", leaf: { kind: "time", ...tb } };
      const fa = fullAddr(t);
      const c = fa ? undefined : termCrit(t, now, ignored, true);
      if (!fa && !c) return undefined;
      const leaf: QNode = fa ? { t: "exact", leaf: { kind: "addr", ...fa } } : { t: "crit", crit: c! };
      return t.neg ? { t: "not", item: leaf } : leaf;
    }
    case "and":
    case "or": {
      const items = n.items.map((x) => toQNode(x, now, ignored)).filter((x): x is QNode => Boolean(x));
      if (!items.length) return undefined;
      return items.length === 1 ? items[0] : { t: n.type, items };
    }
    case "not": {
      const item = toQNode(n.item, now, ignored);
      return item ? { t: "not", item } : undefined;
    }
  }
}

/** Does the tree need the provider's exact checks (addresses, time bounds)? */
export function hasExact(n: QNode): boolean {
  switch (n.t) {
    case "crit":
      return false;
    case "exact":
      return true;
    case "and":
    case "or":
      return n.items.some(hasExact);
    case "not":
      return hasExact(n.item);
  }
}

/** A tree without exact leaves as a list of AND-ed server criteria. */
function toCrits(n: QNode): Crit[] {
  switch (n.t) {
    case "crit":
      return [n.crit];
    case "exact":
      throw new Error("internal: an exact check has no IMAP search criterion");
    case "and":
      return n.items.flatMap(toCrits);
    case "or": {
      const alts = n.items.map((x) => buildCriteria(toCrits(x)));
      return alts.length === 1 ? (Object.entries(alts[0]) as Crit[]) : [["or", alts]];
    }
    case "not":
      return [["not", buildCriteria(toCrits(n.item))]];
  }
}

/** Server criteria for a tree that is exact on the server, else undefined. */
export function compileNode(n: QNode): SearchObject | undefined {
  return hasExact(n) ? undefined : buildCriteria(toCrits(n));
}

export function parseGmailQuery(query: string, now = new Date()): ImapQuery {
  const q: ImapQuery = { roles: [], folders: [], anywhere: false, criteria: {}, addrs: [], exact: [], ignored: [] };
  const tree = new Parser(tokenize(query ?? ""), q.ignored).seq();
  const top = tree.type === "and" ? tree.items : [tree];
  const crits: Crit[] = [];

  for (let n of top) {
    // "-(x)" around a single term is just "-x".
    if (n.type === "not" && n.item.type === "term") n = { type: "term", tok: { ...n.item.tok, neg: !n.item.tok.neg } };
    if (n.type !== "term") {
      const qn = toQNode(n, now, q.ignored);
      if (!qn) continue;
      if (hasExact(qn)) q.exact.push(qn);
      else crits.push(...toCrits(qn));
      continue;
    }
    const t = n.tok;
    // Location and post-filtered operators are only exact at the top level.
    if ((t.op === "in" || t.op === "label") && !t.neg) {
      const word = t.value.toLowerCase();
      if (word === "anywhere") q.anywhere = true;
      else if (t.op === "in" && ROLE_WORDS[word]) q.roles.push(ROLE_WORDS[word]);
      else if (t.value) q.folders.push(t.value);
      else q.ignored.push(`${t.op}:`);
      continue;
    }
    if (t.op === "has" && t.value.toLowerCase() === "attachment") {
      q.hasAttachment = !t.neg;
      continue;
    }
    const tb = timeBound(t, now);
    if (tb) {
      // A day wider on the server, exact to the second afterwards.
      if (tb.since) {
        q.notBefore = !q.notBefore || tb.at > q.notBefore ? tb.at : q.notBefore;
        crits.push(["since", dayPlus(tb.at, -1)]);
      } else {
        q.notAfter = !q.notAfter || tb.at < q.notAfter ? tb.at : q.notAfter;
        crits.push(["before", dayPlus(tb.at, 2)]);
      }
      continue;
    }
    const fa = fullAddr(t);
    if (fa) {
      // Substring on the server (never narrower), exact on the envelope afterwards. A negated
      // address is not sent: IMAP's NOT FROM would also drop "notbob@x.com".
      q.addrs.push({ ...fa, neg: t.neg });
      if (!t.neg) crits.push([fa.field, t.value]);
      continue;
    }
    const c = termCrit(t, now, q.ignored, false);
    if (!c) continue;
    crits.push(t.neg ? ["not", { [c[0]]: c[1] }] : c);
  }

  const usable =
    crits.length || q.exact.length || q.addrs.length || q.roles.length || q.folders.length || q.anywhere || q.hasAttachment !== undefined || q.notBefore || q.notAfter;
  // Only the empty query means "all mail"; "OR", "-", '""' or blanks must not silently become it.
  if (!usable && (query ?? "") !== "" && !q.ignored.length) q.ignored.push("no usable search terms");
  q.criteria = crits.length ? buildCriteria(crits) : { all: true };
  return q;
}
