import type { SearchObject } from "imapflow";

/**
 * Translates Gmail search syntax into an imapflow search object, so the same
 * queries work for IMAP mailboxes.
 *
 * Applied faithfully:
 *   from: to: cc: bcc: subject: (incl. "quoted phrases"), free words and "phrases" (IMAP TEXT),
 *   is:unread / is:read / is:starred / is:unstarred / is:draft / is:answered,
 *   after: before: (YYYY/MM/DD, YYYY-MM-DD or a Unix timestamp), larger: smaller: (k/m),
 *   rfc822msgid:, negation with a leading "-", "a OR b", grouping with ( ) and { } (OR-group),
 *   and, at the top level only (not negated, not inside a group):
 *   in:inbox|sent|drafts|trash|spam|archive|anywhere, label:<folder> / in:<folder>,
 *   has:attachment, newer_than: / older_than: (h/d/w/m/y; exact to the second, checked after
 *   the server search because IMAP SINCE/BEFORE only know whole days).
 *
 * Everything else is NOT applied and is listed in `ignored` (the provider returns it as
 * SearchResult.ignored): Gmail-only operators (category:, is:important, list:, filename:,
 * deliveredto:, has:drive ...), unknown operators, negated or grouped location operators
 * (-in:sent, (label:x OR ...)), has:attachment / newer_than: inside a group, invalid dates
 * or sizes, and unbalanced parentheses. When `ignored` is non-empty the results can be
 * broader (or narrower) than the query asked for; bulk actions must refuse such queries.
 */

export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "all";

export interface ImapQuery {
  /** Where to look: special folders by role, named folders, or every folder. */
  roles: FolderRole[];
  folders: string[];
  anywhere: boolean;
  criteria: SearchObject;
  /** Exact lower bound on the internal date (top-level newer_than:). */
  notBefore?: Date;
  /** Exact upper bound on the internal date (top-level older_than:). */
  notAfter?: Date;
  hasAttachment?: boolean;
  ignored: string[];
}

type Crit = [key: string, value: unknown];

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
    const opm = /^([a-zA-Z_]+):/.exec(s.slice(j));
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
    case "older": {
      // Inside a group: whole days (IMAP BEFORE), i.e. never broader than asked.
      const d = relative(v, now);
      return d ? ["before", startOfUtcDay(d)] : skip(" (invalid period)");
    }
    case "newer_than":
    case "newer":
      // Only exact at the top level (handled by the caller); IMAP SINCE would round to whole days.
      return relative(v, now) ? skip(nested ? " (inside a group: not supported for IMAP)" : "") : skip(" (invalid period)");
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

/** One node as a list of AND-ed criteria (empty = nothing applicable). */
function nodeCrits(n: Node, now: Date, ignored: string[]): Crit[] {
  switch (n.type) {
    case "term": {
      const c = termCrit(n.tok, now, ignored, true);
      if (!c) return [];
      return [n.tok.neg ? ["not", { [c[0]]: c[1] }] : c];
    }
    case "and":
      return n.items.flatMap((x) => nodeCrits(x, now, ignored));
    case "or": {
      const alts: SearchObject[] = [];
      for (const x of n.items) {
        const cs = nodeCrits(x, now, ignored);
        if (cs.length) alts.push(buildCriteria(cs));
      }
      if (!alts.length) return [];
      return alts.length === 1 ? Object.entries(alts[0]) as Crit[] : [["or", alts]];
    }
    case "not": {
      const cs = nodeCrits(n.item, now, ignored);
      return cs.length ? [["not", buildCriteria(cs)]] : [];
    }
  }
}

export function parseGmailQuery(query: string, now = new Date()): ImapQuery {
  const q: ImapQuery = { roles: [], folders: [], anywhere: false, criteria: {}, ignored: [] };
  const tree = new Parser(tokenize(query ?? ""), q.ignored).seq();
  const top = tree.type === "and" ? tree.items : [tree];
  const crits: Crit[] = [];

  for (const n of top) {
    if (n.type !== "term") {
      crits.push(...nodeCrits(n, now, q.ignored));
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
    if ((t.op === "newer_than" || t.op === "newer" || t.op === "older_than" || t.op === "older") && relative(t.value, now)) {
      const d = relative(t.value, now)!;
      // "newer" and "-older" mean the same thing, and vice versa.
      const isNewer = (t.op === "newer_than" || t.op === "newer") !== t.neg;
      if (isNewer) {
        q.notBefore = !q.notBefore || d > q.notBefore ? d : q.notBefore;
        crits.push(["since", startOfUtcDay(d)]); // whole days on the server, exact after
      } else {
        q.notAfter = !q.notAfter || d < q.notAfter ? d : q.notAfter;
        crits.push(["before", new Date(startOfUtcDay(d).getTime() + 86_400_000)]);
      }
      continue;
    }
    const c = termCrit(t, now, q.ignored, false);
    if (!c) continue;
    crits.push(t.neg ? ["not", { [c[0]]: c[1] }] : c);
  }

  q.criteria = crits.length ? buildCriteria(crits) : { all: true };
  return q;
}
