import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkPath } from "./paths.js";

/** Builds RFC 5322 / MIME messages for drafts and sending. UTF-8 safe (Greek etc.). */

export interface Attachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface MailInput {
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Attachment[];
}

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".html": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".ai": "application/postscript",
  ".eps": "application/postscript",
  ".psd": "image/vnd.adobe.photoshop",
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function loadAttachments(paths: string[] | undefined): Attachment[] {
  if (!paths?.length) return [];
  let total = 0;
  return paths.map((p) => {
    // Only files in allowed folders (home, GMAIL_MCP_ALLOWED_DIRS), never hidden/system/config files.
    const full = checkPath(p, "read");
    const content = fs.readFileSync(full);
    total += content.length;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachments exceed Gmail's 25 MB limit.");
    }
    return { filename: path.basename(full), mimeType: mimeTypeFor(full), content };
  });
}

function assertNoNewlines(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain line breaks.`);
  return value;
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/**
 * RFC 2047 encoded-words, split so each stays under 75 chars and never cuts
 * a multi-byte character in half. Returns ASCII input unchanged.
 */
export function encodeWords(value: string): string {
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** Format one address: `a@b.com`, `Name <a@b.com>`, or `"Last, First" <a@b.com>`. */
export function formatAddress(input: string): string {
  const raw = assertNoNewlines("Address", input.trim());
  const m = raw.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (!m) {
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(raw)) throw new Error(`Not a valid email address: "${input}"`);
    return raw;
  }
  let name = m[1].trim().replace(/^"(.*)"$/, "$1");
  const addr = m[2];
  if (!name) return addr;
  if (!isAscii(name)) return `${encodeWords(name)} <${addr}>`;
  if (/[()<>\[\]:;@\\,."]/.test(name)) name = `"${name.replace(/(["\\])/g, "\\$1")}"`;
  return `${name} <${addr}>`;
}

/** Split "a@b.com, Name <c@d.com>" into addresses, respecting quotes and angle brackets. */
export function splitAddresses(list: string | string[] | undefined): string[] {
  if (!list) return [];
  const items = Array.isArray(list) ? list : [list];
  const out: string[] = [];
  for (const item of items) {
    let cur = "";
    let quoted = false;
    let angle = 0;
    for (const ch of item) {
      if (ch === '"') quoted = !quoted;
      if (!quoted && ch === "<") angle++;
      if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
      if (!quoted && angle === 0 && (ch === "," || ch === ";")) {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  // RFC 5322 group syntax ("undisclosed-recipients:;", "Team: a@x, b@y;"): drop the group
  // label and keep only real addresses.
  return out
    .map((a) => a.replace(/^[^"<>@:]*:\s*/, "").replace(/;\s*$/, "").trim())
    .filter((a) => a.includes("@"));
}

const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n").replace(/\r\n$/, "");
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
const boundary = () => `=_gmm_${crypto.randomBytes(12).toString("hex")}`;

function textPart(type: "plain" | "html", content: string): string {
  return [
    `Content-Type: text/${type}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(crlf(content), "utf8").toString("base64")),
  ].join("\r\n");
}

/** RFC 2231 filename parameter (plus a legacy `name=` for old clients). */
function fileParams(filename: string): { disposition: string; name: string } {
  const safe = assertNoNewlines("Filename", filename).replace(/["\\]/g, "_");
  if (isAscii(safe)) return { disposition: `filename="${safe}"`, name: `name="${safe}"` };
  const star = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return { disposition: `filename*=UTF-8''${star}`, name: `name="${encodeWords(safe)}"` };
}

function attachmentPart(a: Attachment): string {
  const p = fileParams(a.filename);
  return [
    `Content-Type: ${assertNoNewlines("MIME type", a.mimeType)}; ${p.name}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; ${p.disposition}`,
    "",
    wrap76(a.content.toString("base64")),
  ].join("\r\n");
}

function multipart(subtype: "alternative" | "mixed", parts: string[]): string {
  const b = boundary();
  return [`Content-Type: multipart/${subtype}; boundary="${b}"`, "", ...parts.map((p) => `--${b}\r\n${p}`), `--${b}--`, ""].join(
    "\r\n"
  );
}

export function buildMime(input: MailInput): string {
  const headers: string[] = [];
  if (input.from) headers.push(`From: ${formatAddress(input.from)}`);
  const to = splitAddresses(input.to).map(formatAddress);
  const cc = splitAddresses(input.cc).map(formatAddress);
  const bcc = splitAddresses(input.bcc).map(formatAddress);
  if (to.length) headers.push(`To: ${to.join(",\r\n ")}`);
  if (cc.length) headers.push(`Cc: ${cc.join(",\r\n ")}`);
  if (bcc.length) headers.push(`Bcc: ${bcc.join(",\r\n ")}`);
  if (input.replyTo) headers.push(`Reply-To: ${formatAddress(input.replyTo)}`);
  headers.push(`Subject: ${encodeWords(assertNoNewlines("Subject", input.subject ?? ""))}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${assertNoNewlines("In-Reply-To", input.inReplyTo)}`);
  if (input.references) headers.push(`References: ${assertNoNewlines("References", input.references)}`);
  headers.push("MIME-Version: 1.0");

  const text = input.text ?? "";
  const body = input.html ? multipart("alternative", [textPart("plain", text), textPart("html", input.html)]) : textPart("plain", text);

  const atts = input.attachments ?? [];
  const content = atts.length ? multipart("mixed", [body, ...atts.map(attachmentPart)]) : body;

  return `${headers.join("\r\n")}\r\n${content}`;
}

/** Prefix "Re: " unless the subject already has a reply prefix (incl. Greek "ΑΠ:"/"Απ:"). */
export function replySubject(subject: string | undefined): string {
  const s = (subject ?? "").trim();
  if (/^(re|aw|sv|απ|ΑΠ|Απ)\s*:/i.test(s)) return s;
  return `Re: ${s}`;
}
