import { convert } from "html-to-text";
import type { gmail_v1 } from "@googleapis/gmail";

/**
 * The provider-neutral message shape returned by every tool, plus helpers that
 * turn Gmail API payloads into it. (The IMAP provider builds the same shape.)
 */

type Part = gmail_v1.Schema$MessagePart;

export interface AttachmentInfo {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
}

export interface CleanMessage {
  account: string;
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  labels: string[];
  unread: boolean;
  starred: boolean;
  snippet?: string;
  body?: string;
  bodyFormat?: "text" | "html-converted";
  bodyTruncated?: boolean;
  attachments?: AttachmentInfo[];
  /** RFC Message-ID header (threading, and de-duplicating across accounts). */
  rfcMessageId?: string;
  references?: string;
  /** Extra headers requested by the tool (lower-case names). */
  headers?: Record<string, string>;
  /** Same message also found in these accounts (cross-account de-duplication). */
  alsoIn?: string[];
}

export function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  const n = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === n)?.value ?? undefined;
}

function charsetOf(part: Part): string {
  const ct = header(part.headers ?? undefined, "Content-Type") ?? "";
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return (m?.[1] ?? "utf-8").toLowerCase();
}

/** Decode base64url body data honoring the part's charset (UTF-8, ISO-8859-7, windows-1253...). */
export function decodeBody(data: string | null | undefined, charset = "utf-8"): string {
  if (!data) return "";
  const buf = Buffer.from(data, "base64url");
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

function isAttachment(part: Part): boolean {
  const disp = header(part.headers ?? undefined, "Content-Disposition") ?? "";
  return Boolean(part.filename) || /^\s*attachment/i.test(disp);
}

export function walkParts(root: Part | undefined, visit: (p: Part) => void): void {
  if (!root) return;
  visit(root);
  for (const child of root.parts ?? []) walkParts(child, visit);
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "a", options: { hideLinkHrefIfSameAsText: true, ignoreHref: false } },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })),
      { selector: "table", options: { uppercaseHeaderCells: false } },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractBody(payload: Part | undefined): { text: string; format: "text" | "html-converted" } {
  let plain: string | undefined;
  let html: string | undefined;
  walkParts(payload, (p) => {
    if (isAttachment(p)) return;
    const mt = (p.mimeType ?? "").toLowerCase();
    if (mt === "text/plain" && plain === undefined && p.body?.data) plain = decodeBody(p.body.data, charsetOf(p));
    if (mt === "text/html" && html === undefined && p.body?.data) html = decodeBody(p.body.data, charsetOf(p));
  });
  if (plain !== undefined && plain.trim()) return { text: plain.replace(/\r\n/g, "\n").trim(), format: "text" };
  if (html !== undefined) return { text: htmlToText(html), format: "html-converted" };
  return { text: "", format: "text" };
}

export function listAttachments(payload: Part | undefined): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  walkParts(payload, (p) => {
    if (!p.body?.attachmentId && !(p.filename && p.body?.data)) return;
    if (!p.filename) return;
    const disp = header(p.headers ?? undefined, "Content-Disposition") ?? "";
    out.push({
      partId: p.partId ?? "",
      filename: p.filename,
      mimeType: p.mimeType ?? "application/octet-stream",
      size: p.body?.size ?? 0,
      inline: /^\s*inline/i.test(disp) || Boolean(header(p.headers ?? undefined, "Content-ID")),
    });
  });
  return out;
}

export function findPart(payload: Part | undefined, pred: (p: Part) => boolean): Part | undefined {
  let found: Part | undefined;
  walkParts(payload, (p) => {
    if (!found && pred(p)) found = p;
  });
  return found;
}

export type LabelNames = Map<string, string>;

const SYSTEM_LABELS: Record<string, string> = {
  CATEGORY_PERSONAL: "Primary",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

export function labelName(id: string, names?: LabelNames): string {
  return names?.get(id) ?? SYSTEM_LABELS[id] ?? id;
}

export function toClean(
  account: string,
  msg: gmail_v1.Schema$Message,
  opts: { body?: boolean; maxBodyChars?: number; labelNames?: LabelNames; headers?: string[] } = {}
): CleanMessage {
  const h = msg.payload?.headers ?? undefined;
  const labelIds = msg.labelIds ?? [];
  const internal = msg.internalDate ? new Date(Number(msg.internalDate)) : undefined;
  const out: CleanMessage = {
    account,
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    date: internal ? internal.toISOString() : header(h, "Date") ?? "",
    from: header(h, "From") ?? "",
    to: header(h, "To") ?? "",
    subject: header(h, "Subject") ?? "(no subject)",
    labels: labelIds.filter((l) => l !== "UNREAD" && l !== "STARRED").map((l) => labelName(l, opts.labelNames)),
    unread: labelIds.includes("UNREAD"),
    starred: labelIds.includes("STARRED"),
  };
  const cc = header(h, "Cc");
  if (cc) out.cc = cc;
  const replyTo = header(h, "Reply-To");
  if (replyTo) out.replyTo = replyTo;
  const rfcId = header(h, "Message-ID") ?? header(h, "Message-Id");
  if (rfcId) out.rfcMessageId = rfcId;
  if (opts.headers?.length) {
    const extra: Record<string, string> = {};
    for (const name of opts.headers) {
      const v = header(h, name);
      if (v !== undefined) extra[name.toLowerCase()] = v;
    }
    if (Object.keys(extra).length) out.headers = extra;
  }

  if (opts.body) {
    const { text, format } = extractBody(msg.payload ?? undefined);
    const max = opts.maxBodyChars ?? 20000;
    out.body = text.length > max ? text.slice(0, max) : text;
    out.bodyFormat = format;
    if (text.length > max) out.bodyTruncated = true;
    const atts = listAttachments(msg.payload ?? undefined);
    if (atts.length) out.attachments = atts;
    const refs = header(h, "References");
    if (refs) out.references = refs;
  } else if (msg.snippet) {
    out.snippet = decodeEntities(msg.snippet);
  }
  return out;
}

/** Gmail snippets come HTML-entity encoded. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Make a filename safe to write on Windows/macOS/Linux. */
export function safeFilename(name: string): string {
  const base = name.replace(/^.*[\\/]/, "");
  let s = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").trim();
  if (!s || s === "." || s === "..") s = "attachment";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  return s.slice(0, 200);
}
