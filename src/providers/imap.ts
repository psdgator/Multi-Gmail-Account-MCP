import * as crypto from "node:crypto";
import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type ListResponse, type MessageAddressObject, type MessageEnvelopeObject, type MessageStructureObject, type SearchObject } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { AccountConfig, AccountManager, ImapServerConfig } from "../accounts.js";
import { htmlToText, type AttachmentInfo, type CleanMessage } from "../message.js";
import { emailOf, hoursSince, mapLimit } from "../util.js";
import { compileNode, dayPlus, type AddrField, type ExactLeaf, type FolderRole, parseGmailQuery, type QNode } from "./imap-query.js";
import { registerProviderFactory } from "./registry.js";
import {
  AttachmentData,
  DraftInfo,
  DraftSummary,
  Identity,
  InboxStatus,
  Label,
  looksAutomated,
  MailProvider,
  MessageChanges,
  NeedsReplyItem,
  NeedsReplyOptions,
  NeedsReplyResult,
  OriginalHeaders,
  SearchOptions,
  SearchResult,
} from "./types.js";

/**
 * Any IMAP mailbox (Hetzner, Dovecot, cPanel, Outlook IMAP, ...) behind the same
 * MailProvider interface as Gmail.
 *
 * Ids: message id = "<url-encoded folder>:<uid>", thread id = base64url of the
 * conversation's root Message-ID. Labels are folders: adding a label copies the
 * message into that folder, removing it moves the message back to INBOX.
 */

const IDLE_CLOSE_MS = 5 * 60_000;
const BASE_HEADERS = ["message-id", "references", "in-reply-to"];

export function encodeId(path: string, uid: number): string {
  return `${encodeURIComponent(path)}:${uid}`;
}

export function decodeId(id: string): { path: string; uid: number } | undefined {
  const i = id.lastIndexOf(":");
  if (i <= 0) return undefined;
  const uid = Number(id.slice(i + 1));
  if (!Number.isInteger(uid) || uid <= 0) return undefined;
  try {
    return { path: decodeURIComponent(id.slice(0, i)), uid };
  } catch {
    return undefined;
  }
}

const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s: string) => {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return "";
  }
};

/** Parse raw header lines (Buffer from FETCH BODY[HEADER.FIELDS]) into a lower-case map. */
export function parseHeaderBlock(buf: Buffer | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!buf) return out;
  const text = buf.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!(k in out)) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

function msgIds(v: string | undefined): string[] {
  return (v ?? "").match(/<[^<>\s]+>/g) ?? [];
}

/** Root of the conversation: first References entry, else In-Reply-To, else own id. */
export function rootId(h: { references?: string; inReplyTo?: string; messageId?: string }): string | undefined {
  return msgIds(h.references)[0] ?? msgIds(h.inReplyTo)[0] ?? msgIds(h.messageId)[0];
}

/** Envelope addresses as "Name <addr>" text. Group markers (undisclosed-recipients:;) have no address and are skipped. */
function fmtAddrs(list: MessageAddressObject[] | undefined): string {
  return (list ?? [])
    .filter((a) => typeof a.address === "string" && a.address.includes("@") && !/[\s;:<>]/.test(a.address))
    .map((a) => (a.name ? `${/[",<>@]/.test(a.name) ? `"${a.name.replace(/"/g, "'")}"` : a.name} <${a.address ?? ""}>` : a.address ?? ""))
    .join(", ");
}

function addrText(a: AddressObject | AddressObject[] | undefined): string {
  if (!a) return "";
  return (Array.isArray(a) ? a : [a]).map((x) => x.text).filter(Boolean).join(", ");
}

function hasAttachment(bs: MessageStructureObject | undefined): boolean {
  if (!bs) return false;
  const disp = (bs.disposition ?? "").toLowerCase();
  if (disp === "attachment") return true;
  if ((bs.dispositionParameters?.filename || bs.parameters?.name) && !bs.type.startsWith("multipart/") && disp !== "inline") return true;
  return (bs.childNodes ?? []).some(hasAttachment);
}

function toDate(d: Date | string | undefined): Date {
  const x = d instanceof Date ? d : d ? new Date(d) : new Date(0);
  return Number.isNaN(x.getTime()) ? new Date(0) : x;
}

/** Does the envelope field hold exactly this (lower-case) address? Group markers have none. */
function envelopeHas(env: MessageEnvelopeObject | undefined, field: AddrField, addr: string): boolean {
  return (env?.[field] ?? []).some((a) => (a.address ?? "").trim().toLowerCase() === addr);
}

/** UIDs as a compact IMAP sequence set ("1:3,7"). */
export function uidRanges(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

const intersect = (a: Set<number>, b: Set<number>) => new Set([...a].filter((x) => b.has(x)));
const minus = (a: Set<number>, b: Set<number>) => new Set([...a].filter((x) => !b.has(x)));

/** Add Date and Message-ID if missing (Gmail adds these itself; IMAP servers don't). */
export function ensureHeaders(raw: string, fromEmail: string): { raw: string; messageId: string } {
  const end = raw.indexOf("\r\n\r\n");
  const head = end === -1 ? raw : raw.slice(0, end);
  const existing = head.match(/^message-id:\s*(<[^>]+>)/im)?.[1];
  const lines: string[] = [];
  if (!/^date:/im.test(head)) lines.push(`Date: ${new Date().toUTCString().replace("GMT", "+0000")}`);
  const domain = emailOf(fromEmail).split("@")[1] || "localhost";
  const messageId = existing ?? `<${crypto.randomUUID()}@${domain}>`;
  if (!existing) lines.push(`Message-ID: ${messageId}`);
  return { raw: lines.length ? `${lines.join("\r\n")}\r\n${raw}` : raw, messageId };
}

/** Remove the Bcc header before handing a message to SMTP (recipients stay in the envelope). */
export function stripBcc(raw: string): string {
  const end = raw.indexOf("\r\n\r\n");
  if (end === -1) return raw;
  const head = raw.slice(0, end).replace(/^bcc:.*(?:\r\n[ \t].*)*\r\n?/gim, "");
  return `${head.replace(/\r\n$/, "")}${raw.slice(end)}`;
}

const ROLE_SPECIAL: Record<Exclude<FolderRole, "inbox">, string> = {
  sent: "\\Sent",
  drafts: "\\Drafts",
  trash: "\\Trash",
  junk: "\\Junk",
  archive: "\\Archive",
  all: "\\All",
};

/**
 * Folder names by role, for servers without special-use flags: English, German, French,
 * Spanish, Italian, Portuguese, Dutch, Polish, Russian, Turkish and Greek, as used by common
 * webmail (Roundcube, Gmail, Outlook) translations. Names are compared NFC-normalized.
 */
const ROLE_NAMES: Record<Exclude<FolderRole, "inbox">, RegExp> = {
  sent: /^(sent|sent items|sent mail|sent messages|gesendet|gesendete elemente|envoyés|éléments envoyés|enviados|elementos enviados|posta inviata|itens enviados|verzonden|verzonden items|wysłane|elementy wysłane|отправленные|gönderilenler|απεσταλμένα|σταλμένα)$/iu,
  drafts: /^(drafts?|entwürfe|brouillons|borradores|bozze|rascunhos|concepten|kopie robocze|черновики|taslaklar|πρόχειρα)$/iu,
  trash: /^(trash|deleted|deleted items|deleted messages|bin|papierkorb|gelöschte elemente|corbeille|éléments supprimés|papelera|elementos eliminados|cestino|posta eliminata|lixeira|itens excluídos|prullenbak|verwijderde items|kosz|elementy usunięte|корзина|удаленные|удалённые|çöp kutusu|silinmiş öğeler|κάδος|διαγραμμένα)$/iu,
  junk: /^(junk|spam|junk e-?mail|junk-e-mail|bulk mail|pourriel|courrier indésirable|correo no deseado|posta indesiderata|lixo eletrônico|ongewenste e-mail|wiadomości-śmieci|спам|нежелательная почта|gereksiz e-posta|ανεπιθύμητα)$/iu,
  archive: /^(archive|archives|archiv|αρχείο|αρχειοθέτηση)$/iu,
  all: /^(all mail|all|alle nachrichten|tous les messages|tutti i messaggi|вся почта|όλα τα μηνύματα)$/iu,
};

const namedAs = (role: Exclude<FolderRole, "inbox">, name: string) => ROLE_NAMES[role].test(name.normalize("NFC").trim());

interface Folder {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  selectable: boolean;
}

export class ImapProvider implements MailProvider {
  readonly kind = "imap" as const;
  readonly capabilities;
  private client?: ImapFlow;
  private connecting?: Promise<ImapFlow>;
  private idleTimer?: NodeJS.Timeout;
  private folderCache?: { at: number; list: Folder[] };
  /** Drafts being sent right now, and drafts already sent (by folder:uid): never send one twice. */
  private sendingDrafts = new Set<string>();
  private sentDrafts = new Set<string>();

  constructor(
    readonly account: AccountConfig,
    private readonly password: string
  ) {
    if (!account.imap) throw new Error(`"${account.alias}" has no IMAP server configured. Run: gmail-mcp-multi add-imap ${account.alias}`);
    this.capabilities = { labels: false, filters: false, calendar: false, send: Boolean(account.smtp) };
  }

  // ---------- connection ----------

  private get imap(): ImapServerConfig {
    return this.account.imap!;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  private async conn(): Promise<ImapFlow> {
    this.touch();
    if (this.client?.usable) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const c = new ImapFlow({
          host: this.imap.host,
          port: this.imap.port,
          secure: this.imap.secure,
          doSTARTTLS: this.imap.secure ? undefined : this.imap.allowInsecureTls ? undefined : true,
          auth: { user: this.imap.user || this.account.email, pass: this.password },
          tls: { rejectUnauthorized: !this.imap.allowInsecureTls },
          logger: false,
          emitLogs: false,
          disableAutoIdle: true,
          connectionTimeout: 20_000,
          greetingTimeout: 15_000,
          socketTimeout: 120_000,
        });
        c.on("error", () => {
          /* surfaced through the failing command */
        });
        c.on("close", () => {
          if (this.client === c) this.client = undefined;
        });
        await c.connect();
        this.client = c;
        return c;
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  /**
   * Run `fn` with `path` selected. If the connection dropped before `fn` started,
   * reconnect once; never repeat `fn` itself (no duplicate APPEND/MOVE).
   */
  private async withBox<T>(path: string, fn: (c: ImapFlow) => Promise<T>, readOnly = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let started = false;
      const c = await this.conn();
      let lock: { release(): void } | undefined;
      try {
        lock = await c.getMailboxLock(path, { readOnly });
        started = true;
        return await fn(c);
      } catch (err) {
        if (!started && attempt === 0 && !c.usable) {
          this.client = undefined;
          continue;
        }
        const e = err as { mailboxMissing?: boolean; serverResponseCode?: string; responseText?: string };
        if (!started && (e.mailboxMissing || /NONEXISTENT|doesn't exist|does not exist|not found/i.test(`${e.serverResponseCode ?? ""} ${e.responseText ?? ""}`))) {
          throw new Error(`Not found in "${this.account.alias}": folder "${path}" does not exist.`);
        }
        throw err;
      } finally {
        lock?.release();
      }
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const c = this.client;
    this.client = undefined;
    if (c?.usable) await c.logout().catch(() => c.close());
  }

  // ---------- folders ----------

  async folders(): Promise<Folder[]> {
    if (this.folderCache && Date.now() - this.folderCache.at < 5 * 60_000) return this.folderCache.list;
    const c = await this.conn();
    const raw: ListResponse[] = await c.list();
    const list = raw.map((m) => ({
      path: m.path,
      name: m.name,
      delimiter: m.delimiter || "/",
      specialUse: m.specialUse,
      selectable: !m.flags.has("\\Noselect") && !m.flags.has("\\NonExistent"),
    }));
    this.folderCache = { at: Date.now(), list };
    return list;
  }

  /** Folder for a role (special-use flag first, then common names in several languages). */
  async roleFolder(role: FolderRole, create = false): Promise<string | undefined> {
    if (role === "inbox") return "INBOX";
    const list = await this.folders();
    const found = list.find((f) => f.specialUse === ROLE_SPECIAL[role]) ?? list.find((f) => f.selectable && namedAs(role, f.name));
    if (found) return found.path;
    if (!create) return undefined;
    const name = role.charAt(0).toUpperCase() + role.slice(1);
    const c = await this.conn();
    const r = await c.mailboxCreate(name);
    this.folderCache = undefined;
    return r.path;
  }

  /**
   * Folders that labels must never move or copy mail into or out of: Trash, Junk/Spam,
   * Drafts, Sent and All Mail (by special-use flag or by name in several languages).
   * Returns the role, or undefined for an ordinary folder.
   */
  private protectedRole(f: Folder): "trash" | "junk" | "drafts" | "sent" | "all" | undefined {
    for (const role of ["trash", "junk", "drafts", "sent", "all"] as const) {
      if (f.specialUse === ROLE_SPECIAL[role] || namedAs(role, f.name) || namedAs(role, f.path)) return role;
    }
    return undefined;
  }

  private refuseProtected(f: Folder, verb: "add" | "remove"): void {
    const role = this.protectedRole(f);
    if (!role) return;
    const why = {
      trash: verb === "add" ? 'Moving mail to Trash is not done with labels; use trash_emails (full mode).' : "Restore it with moveToInbox instead.",
      junk: "Marking or unmarking spam is not supported.",
      drafts: "The Drafts folder is managed with create_draft / delete_draft.",
      sent: "The Sent folder can't be changed with labels.",
      all: "The All Mail folder can't be changed with labels.",
    }[role];
    throw new Error(`"${f.path}" is the ${role} folder of "${this.account.alias}"; it can't be ${verb === "add" ? "added as a label" : "removed as a label"}. ${why}`);
  }

  /**
   * Moving mail OUT of All Mail removes it from every label (Gmail turns it into a deletion),
   * and drafts are managed with the draft tools: refuse archive / moveToInbox from those.
   */
  private async refuseMoveFrom(path: string): Promise<void> {
    const f = (await this.folders()).find((x) => x.path === path) ?? { path, name: path.split(/[/.]/).pop() ?? path, delimiter: "/", selectable: true };
    const role = this.protectedRole(f);
    if (role === "all") {
      throw new Error(`"${path}" is the All Mail folder of "${this.account.alias}": moving mail out of it would delete it. Archive or move it from INBOX or its label folder instead.`);
    }
    if (role === "drafts") {
      throw new Error(`"${path}" is the Drafts folder of "${this.account.alias}": drafts are not archived or moved. Use send_draft or delete_draft.`);
    }
  }

  /**
   * Removing messages ends in EXPUNGE. With UIDPLUS that is "UID EXPUNGE <these uids>". Without
   * it, a plain EXPUNGE would also remove every other message flagged \Deleted in the folder
   * (for example by another mail app that hides deletions until it compacts), so it is only
   * allowed when no other message there carries \Deleted. A server with MOVE needs no
   * EXPUNGE for moves.
   */
  private async refuseUnsafeExpunge(c: ImapFlow, path: string, uids: number[], forMove: boolean): Promise<void> {
    if (c.capabilities.has("UIDPLUS") || (forMove && c.capabilities.has("MOVE"))) return;
    const mine = new Set(uids);
    const others = [...(await this.uidSearch(c, { deleted: true }))].filter((u) => !mine.has(u));
    if (others.length) {
      throw new Error(
        `[${this.account.alias}] Not changing "${path}": this server has no UIDPLUS${forMove ? " or MOVE" : ""}, so removing a message would also erase ${others.length} other message(s) there that another mail app marked as deleted. ` +
          "Empty or compact that folder in your mail app first."
      );
    }
  }

  /** Before moving out of several folders: refuse up front, so nothing is half done. */
  private async precheckMoves(moves: [path: string, uids: number[]][]): Promise<void> {
    const c = await this.conn();
    if (c.capabilities.has("UIDPLUS") || c.capabilities.has("MOVE")) return;
    for (const [path, uids] of moves) await this.withBox(path, (cl) => this.refuseUnsafeExpunge(cl, path, uids, true), true);
  }

  /** Resolve a user-given folder/label name (case-insensitive path or leaf name; "/" works as separator). */
  async findFolder(name: string): Promise<Folder | undefined> {
    const list = await this.folders();
    const want = name.trim().toLowerCase();
    return (
      list.find((f) => f.path.toLowerCase() === want) ??
      list.find((f) => f.path.split(f.delimiter).join("/").toLowerCase() === want) ??
      list.find((f) => f.name.toLowerCase() === want)
    );
  }

  private async searchFolders(q: ReturnType<typeof parseGmailQuery>, includeSpamTrash?: boolean): Promise<string[]> {
    const list = await this.folders();
    if (q.anywhere) {
      const skip = includeSpamTrash ? new Set<string>() : new Set(list.filter((f) => f.specialUse === "\\Trash" || f.specialUse === "\\Junk").map((f) => f.path));
      return list.filter((f) => f.selectable && !skip.has(f.path) && f.specialUse !== "\\All").map((f) => f.path);
    }
    const out: string[] = [];
    for (const role of q.roles) {
      const p = await this.roleFolder(role);
      if (!p) throw new Error(`Not found in "${this.account.alias}": no ${role} folder.`);
      out.push(p);
    }
    for (const name of q.folders) {
      const f = await this.findFolder(name);
      if (!f) throw new Error(`Not found in "${this.account.alias}": no folder "${name}". Use list_labels to see folders.`);
      out.push(f.path);
    }
    if (!out.length) out.push("INBOX");
    if (includeSpamTrash && !q.roles.length && !q.folders.length) {
      for (const role of ["junk", "trash"] as const) {
        const p = await this.roleFolder(role);
        if (p && !out.includes(p)) out.push(p);
      }
    }
    return [...new Set(out)];
  }

  // ---------- message shaping ----------

  private summary(path: string, m: FetchMessageObject, extraHeaders: string[] = []): CleanMessage {
    const env = m.envelope ?? {};
    const h = parseHeaderBlock(m.headers);
    const flags = m.flags ?? new Set<string>();
    const root = rootId({ references: h["references"], inReplyTo: h["in-reply-to"] ?? env.inReplyTo, messageId: h["message-id"] ?? env.messageId });
    const out: CleanMessage = {
      account: this.account.alias,
      id: encodeId(path, m.uid),
      threadId: root ? b64u(root) : encodeId(path, m.uid),
      date: toDate(m.internalDate ?? env.date).toISOString(),
      from: fmtAddrs(env.from),
      to: fmtAddrs(env.to),
      subject: env.subject || "(no subject)",
      labels: [path],
      unread: !flags.has("\\Seen"),
      starred: flags.has("\\Flagged"),
    };
    const cc = fmtAddrs(env.cc);
    if (cc) out.cc = cc;
    const replyTo = fmtAddrs(env.replyTo);
    if (replyTo && replyTo !== out.from) out.replyTo = replyTo;
    const rfc = msgIds(h["message-id"] ?? env.messageId)[0];
    if (rfc) out.rfcMessageId = rfc;
    if (extraHeaders.length) {
      const extra: Record<string, string> = {};
      for (const name of extraHeaders) {
        const v = h[name.toLowerCase()];
        if (v !== undefined) extra[name.toLowerCase()] = v;
      }
      if (Object.keys(extra).length) out.headers = extra;
    }
    return out;
  }

  private attachmentsOf(parsed: ParsedMail): (AttachmentInfo & { content: Buffer })[] {
    return parsed.attachments.map((a, i) => ({
      partId: String(i + 1),
      filename: a.filename || `attachment-${i + 1}${a.contentType === "message/rfc822" ? ".eml" : ""}`,
      mimeType: a.contentType || "application/octet-stream",
      size: a.size ?? a.content?.length ?? 0,
      inline: a.contentDisposition === "inline" || Boolean(a.related),
      content: a.content,
    }));
  }

  private fromParsed(path: string, uid: number, flags: Set<string>, internalDate: Date | string | undefined, parsed: ParsedMail, maxBodyChars?: number): CleanMessage {
    const refs = Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references;
    const root = rootId({ references: refs, inReplyTo: parsed.inReplyTo, messageId: parsed.messageId });
    let text = (parsed.text ?? "").replace(/\r\n/g, "\n").trim();
    let format: "text" | "html-converted" = "text";
    if (!text && parsed.html) {
      text = htmlToText(parsed.html);
      format = "html-converted";
    }
    const max = maxBodyChars ?? 20000;
    const out: CleanMessage = {
      account: this.account.alias,
      id: encodeId(path, uid),
      threadId: root ? b64u(root) : encodeId(path, uid),
      date: toDate(internalDate ?? parsed.date).toISOString(),
      from: addrText(parsed.from),
      to: addrText(parsed.to),
      subject: parsed.subject || "(no subject)",
      labels: [path],
      unread: !flags.has("\\Seen"),
      starred: flags.has("\\Flagged"),
      body: text.length > max ? text.slice(0, max) : text,
      bodyFormat: format,
    };
    if (text.length > max) out.bodyTruncated = true;
    const cc = addrText(parsed.cc);
    if (cc) out.cc = cc;
    const replyTo = addrText(parsed.replyTo);
    if (replyTo) out.replyTo = replyTo;
    if (parsed.messageId) out.rfcMessageId = parsed.messageId;
    if (refs) out.references = refs;
    const atts = this.attachmentsOf(parsed).map(({ content: _c, ...rest }) => rest);
    if (atts.length) out.attachments = atts;
    return out;
  }

  private parseIdOrThrow(id: string): { path: string; uid: number } {
    const p = decodeId(id);
    if (!p) throw new Error(`Not found in "${this.account.alias}" (not an IMAP message id: ${id}).`);
    return p;
  }

  private async fetchSource(id: string): Promise<{ path: string; uid: number; source: Buffer; flags: Set<string>; internalDate?: Date | string }> {
    const { path, uid } = this.parseIdOrThrow(id);
    return this.withBox(
      path,
      async (c) => {
        const m = await c.fetchOne(String(uid), { uid: true, source: true, flags: true, internalDate: true }, { uid: true });
        if (!m || !m.source) throw new Error(`Not found in "${this.account.alias}" (message ${id} no longer exists).`);
        return { path, uid, source: m.source, flags: m.flags ?? new Set(), internalDate: m.internalDate };
      },
      true
    );
  }

  // ---------- MailProvider ----------

  explain(err: unknown): Error {
    const e = err as {
      message?: string;
      code?: string;
      authenticationFailed?: boolean;
      responseText?: string;
      serverResponseCode?: string;
      responseCode?: number;
      command?: string;
    };
    const alias = this.account.alias;
    const msg = `${e?.message ?? ""} ${e?.responseText ?? ""} ${e?.serverResponseCode ?? ""}`;
    if (/^Not found/.test(e?.message ?? "") || /not available for|Sending needs SMTP/.test(e?.message ?? "")) return e as Error;
    if (e?.authenticationFailed || /AUTHENTICATIONFAILED|authentication failed|invalid credentials|LOGIN failed/i.test(msg)) {
      return new Error(`IMAP login failed for "${alias}" (${this.imap.user || this.account.email} at ${this.imap.host}). Check the password with: gmail-mcp-multi add-imap ${alias} ${this.account.email} --host ${this.imap.host}`);
    }
    if (e?.code === "EAUTH") {
      return new Error(`SMTP login failed for "${alias}" (${this.account.smtp?.host}). Check the password / SMTP settings with: gmail-mcp-multi add-imap ${alias}`);
    }
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|Connection not available|NoConnection/i.test(`${e?.code ?? ""} ${msg}`)) {
      return new Error(`Cannot reach the mail server for "${alias}" (${this.imap.host}:${this.imap.port}): ${e?.code ?? e?.message}`);
    }
    if (/certificate|self[- ]signed|CERT_|unable to verify/i.test(msg)) {
      return new Error(`TLS certificate problem talking to ${this.imap.host} for "${alias}": ${e?.message}. (Only for your own test servers: --allow-insecure-tls.)`);
    }
    return new Error(`[${alias}] ${(e?.message ?? String(err)).trim()}${e?.responseText && !e.message?.includes(e.responseText) ? ` (${e.responseText})` : ""}`);
  }

  async identities(): Promise<Identity[]> {
    const primary: Identity = {
      email: this.account.email,
      displayName: this.account.displayName,
      signature: this.account.signature,
      signatureIsHtml: false,
      isDefault: true,
    };
    return [
      primary,
      ...(this.account.extraAddresses ?? []).map((e) => ({ email: e, displayName: this.account.displayName, signature: this.account.signature, signatureIsHtml: false })),
    ];
  }

  async search(o: SearchOptions): Promise<SearchResult> {
    const q = parseGmailQuery(o.query);
    const boxes = await this.searchFolders(q, o.includeSpamTrash);
    const offset = o.pageToken ? Math.max(0, Number(o.pageToken) || 0) : 0;
    const want = offset + o.max;
    const extra = (o.headers ?? []).map((h) => h.toLowerCase());
    const headerList = [...new Set([...BASE_HEADERS, ...extra])];
    let estimate = 0;

    const perBox = await mapLimit(boxes, 1, (path) =>
      this.withBox(
        path,
        async (c) => {
          let uids = (await c.search(q.criteria as SearchObject, { uid: true })) || [];
          // Groups with exact parts (addresses, time bounds under OR / NOT), as UID sets.
          if (q.exact.length && uids.length) {
            let set = new Set(uids);
            for (const n of q.exact) set = await this.exactSet(c, n, set);
            uids = [...set];
          }
          uids.sort((a, b) => b - a);
          estimate += uids.length;
          const found: CleanMessage[] = [];
          // Newest UIDs first, in batches, until enough pass the client-side filters.
          for (let i = 0; i < uids.length && found.length < want && i < 2000; i += 100) {
            const batch = uids.slice(i, i + 100);
            for await (const m of c.fetch(
              batch.join(","),
              { uid: true, envelope: true, flags: true, internalDate: true, headers: headerList, ...(q.hasAttachment !== undefined ? { bodyStructure: true } : {}) },
              { uid: true }
            )) {
              if (q.hasAttachment !== undefined && hasAttachment(m.bodyStructure) !== q.hasAttachment) continue;
              if (q.notBefore && toDate(m.internalDate) < q.notBefore) continue;
              if (q.notAfter && toDate(m.internalDate) >= q.notAfter) continue;
              if (!q.addrs.every((a) => envelopeHas(m.envelope, a.field, a.addr) !== a.neg)) continue;
              found.push(this.summary(path, m, extra));
            }
            found.sort((a, b) => (a.date < b.date ? 1 : -1));
          }
          return found;
        },
        true
      )
    );

    const merged = perBox.flat().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const page = merged.slice(offset, offset + o.max);
    const more = merged.length > offset + o.max || estimate > offset + o.max;
    return {
      messages: page,
      next: more && page.length ? String(offset + o.max) : undefined,
      estimate,
      ...(q.ignored.length ? { ignored: [...q.ignored] } : {}),
    };
  }

  /** UID search that fails loudly: a refused search must not turn into "no matches" (under NOT that would match everything). */
  private async uidSearch(c: ImapFlow, crit: SearchObject): Promise<Set<number>> {
    const r = await c.search(crit, { uid: true });
    if (!Array.isArray(r)) throw new Error(`[${this.account.alias}] The mail server refused a search.`);
    return new Set(r);
  }

  /** Fetch `query` for these UIDs (in chunks, so commands stay short). */
  private async fetchEach(c: ImapFlow, uids: Iterable<number>, query: FetchQueryObject, fn: (m: FetchMessageObject) => void): Promise<void> {
    const list = [...uids];
    for (let i = 0; i < list.length; i += 500) {
      for await (const m of c.fetch(uidRanges(list.slice(i, i + 500)), { uid: true, ...query }, { uid: true })) fn(m);
    }
  }

  /** The UIDs in `within` that match `n` exactly (in the selected folder). */
  private async exactSet(c: ImapFlow, n: QNode, within: Set<number>): Promise<Set<number>> {
    if (!within.size) return within;
    const server = compileNode(n);
    if (server) return intersect(await this.uidSearch(c, server), within);
    switch (n.t) {
      case "exact":
        return this.leafSet(c, n.leaf, within);
      case "and": {
        let r = within;
        for (const x of n.items) r = await this.exactSet(c, x, r);
        return r;
      }
      case "or": {
        const r = new Set<number>();
        let rest = within;
        for (const x of n.items) {
          const hit = await this.exactSet(c, x, rest);
          for (const u of hit) r.add(u);
          rest = minus(rest, hit);
        }
        return r;
      }
      case "not":
        return minus(within, await this.exactSet(c, n.item, within));
      default:
        throw new Error("internal: unexpected query node");
    }
  }

  private async leafSet(c: ImapFlow, leaf: ExactLeaf, within: Set<number>): Promise<Set<number>> {
    const out = new Set<number>();
    if (leaf.kind === "addr") {
      // The server's substring match is a superset; keep those whose envelope has the exact address.
      const cand = intersect(await this.uidSearch(c, { [leaf.field]: leaf.addr } as SearchObject), within);
      await this.fetchEach(c, cand, { envelope: true }, (m) => {
        if (envelopeHas(m.envelope, leaf.field, leaf.addr)) out.add(m.uid);
      });
      return out;
    }
    // Whole days on the server are certain more than a day away from the bound; only the
    // three days around it need the internal date.
    const sure = await this.uidSearch(c, leaf.since ? { since: dayPlus(leaf.at, 2) } : { before: dayPlus(leaf.at, -1) });
    const cand = intersect(await this.uidSearch(c, leaf.since ? { since: dayPlus(leaf.at, -1) } : { before: dayPlus(leaf.at, 2) }), within);
    const band = minus(cand, sure);
    for (const u of cand) if (sure.has(u)) out.add(u);
    await this.fetchEach(c, band, { internalDate: true }, (m) => {
      if ((toDate(m.internalDate) >= leaf.at) === leaf.since) out.add(m.uid);
    });
    return out;
  }

  async inboxStatus(): Promise<InboxStatus> {
    const c = await this.conn();
    const s = await c.status("INBOX", { messages: true, unseen: true });
    if (!s) throw new Error(`[${this.account.alias}] could not read INBOX status.`);
    return { unread: s.unseen ?? 0, total: s.messages ?? 0 };
  }

  async getMessage(id: string, opts: { maxBodyChars?: number }): Promise<CleanMessage> {
    const m = await this.fetchSource(id);
    const parsed = await simpleParser(m.source);
    return this.fromParsed(m.path, m.uid, m.flags, m.internalDate, parsed, opts.maxBodyChars);
  }

  async getThread(threadId: string, opts: { maxBodyChars?: number }): Promise<CleanMessage[]> {
    const direct = decodeId(threadId);
    if (direct) return [await this.getMessage(threadId, opts)];
    const root = unb64u(threadId);
    if (!/^<[^<>\s]+>$/.test(root)) throw new Error(`Not found in "${this.account.alias}" (not an IMAP thread id).`);
    const boxes = ["INBOX", ...((await Promise.all((["sent", "archive"] as const).map((r) => this.roleFolder(r)))).filter(Boolean) as string[])];
    const criteria = { or: [{ header: { "message-id": root } }, { header: { references: root } }, { header: { "in-reply-to": root } }] } as SearchObject;
    const out: CleanMessage[] = [];
    const seen = new Set<string>();
    for (const path of [...new Set(boxes)]) {
      const items = await this.withBox(
        path,
        async (c) => {
          const uids = ((await c.search(criteria, { uid: true })) || []).slice(-50);
          const res: { uid: number; source: Buffer; flags: Set<string>; internalDate?: Date | string }[] = [];
          if (!uids.length) return res;
          for await (const m of c.fetch(uids.join(","), { uid: true, source: true, flags: true, internalDate: true }, { uid: true })) {
            if (m.source) res.push({ uid: m.uid, source: m.source, flags: m.flags ?? new Set(), internalDate: m.internalDate });
          }
          return res;
        },
        true
      );
      for (const it of items) {
        const parsed = await simpleParser(it.source);
        const key = parsed.messageId ?? `${path}:${it.uid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(this.fromParsed(path, it.uid, it.flags, it.internalDate, parsed, opts.maxBodyChars ?? 8000));
      }
    }
    if (!out.length) throw new Error(`Not found in "${this.account.alias}" (thread ${threadId}).`);
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  async getOriginalHeaders(id: string): Promise<OriginalHeaders> {
    const { path, uid } = this.parseIdOrThrow(id);
    return this.withBox(
      path,
      async (c) => {
        const m = await c.fetchOne(String(uid), { uid: true, envelope: true, headers: [...BASE_HEADERS, "list-unsubscribe", "list-unsubscribe-post"] }, { uid: true });
        if (!m) throw new Error(`Not found in "${this.account.alias}" (message ${id}).`);
        const env = m.envelope ?? {};
        const h = parseHeaderBlock(m.headers);
        const rfc = msgIds(h["message-id"] ?? env.messageId)[0];
        const root = rootId({ references: h["references"], inReplyTo: h["in-reply-to"] ?? env.inReplyTo, messageId: rfc });
        return {
          from: fmtAddrs(env.from),
          to: fmtAddrs(env.to),
          cc: fmtAddrs(env.cc),
          replyTo: fmtAddrs(env.replyTo) || undefined,
          subject: env.subject ?? "",
          date: env.date ? toDate(env.date).toUTCString() : undefined,
          rfcMessageId: rfc,
          references: h["references"],
          threadId: root ? b64u(root) : undefined,
          listUnsubscribe: h["list-unsubscribe"],
          listUnsubscribePost: h["list-unsubscribe-post"],
        };
      },
      true
    );
  }

  async getAttachment(messageId: string, sel: { partId?: string; filename?: string }): Promise<AttachmentData> {
    const m = await this.fetchSource(messageId);
    const parsed = await simpleParser(m.source);
    const atts = this.attachmentsOf(parsed);
    let target = sel.partId
      ? atts.find((a) => a.partId === sel.partId)
      : sel.filename
        ? atts.find((a) => a.filename.toLowerCase() === sel.filename!.toLowerCase())
        : undefined;
    if (!target && !sel.partId && !sel.filename && atts.length === 1) target = atts[0];
    if (!target) {
      throw new Error(atts.length ? `Attachment not found. Available: ${atts.map((a) => `${a.filename} (partId ${a.partId})`).join(", ")}` : "This email has no attachments.");
    }
    return { filename: target.filename, mimeType: target.mimeType, data: target.content };
  }

  async listLabels(): Promise<Label[]> {
    this.folderCache = undefined;
    const list = await this.folders();
    return list
      .filter((f) => f.selectable)
      .map((f) => ({ id: f.path, name: f.path, type: f.path === "INBOX" || f.specialUse ? "system" : "user" }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "system" ? -1 : 1));
  }

  async createLabel(name: string): Promise<Label> {
    const existing = await this.findFolder(name);
    if (existing) return { id: existing.path, name: existing.path, type: "user" };
    const c = await this.conn();
    const r = await c.mailboxCreate(name.split("/").filter(Boolean));
    this.folderCache = undefined;
    return { id: r.path, name: r.path, type: "user" };
  }

  private groupByBox(ids: string[]): Map<string, number[]> {
    const groups = new Map<string, number[]>();
    for (const id of ids) {
      const p = this.parseIdOrThrow(id);
      groups.set(p.path, [...(groups.get(p.path) ?? []), p.uid]);
    }
    return groups;
  }

  async modify(ids: string[], c: MessageChanges): Promise<{ added: string[]; removed: string[]; moved?: Record<string, string> }> {
    if (c.archive && c.moveToInbox) throw new Error("Conflicting changes: archive and moveToInbox.");
    if (c.markRead && c.markUnread) throw new Error("Conflicting changes: markRead and markUnread.");
    if (c.star && c.unstar) throw new Error("Conflicting changes: star and unstar.");
    const added: string[] = [];
    const removed: string[] = [];
    const moved: Record<string, string> = {};

    const addFolders: string[] = [];
    for (const name of c.addLabels ?? []) {
      const f = await this.findFolder(name);
      if (!f) throw new Error(`Folder "${name}" does not exist in ${this.account.alias}. Use list_labels, or create_label first.`);
      this.refuseProtected(f, "add");
      addFolders.push(f.path);
    }
    const removeFolders: string[] = [];
    for (const name of c.removeLabels ?? []) {
      const f = await this.findFolder(name);
      if (!f) throw new Error(`Folder "${name}" does not exist in ${this.account.alias}.`);
      this.refuseProtected(f, "remove");
      removeFolders.push(f.path);
    }
    const archive = c.archive ? await this.roleFolder("archive", true) : undefined;
    if (!(c.markRead || c.markUnread || c.star || c.unstar || c.archive || c.moveToInbox || addFolders.length || removeFolders.length)) {
      throw new Error("Nothing to change.");
    }
    const groups = this.groupByBox(ids);
    const moveTarget = (path: string): string | undefined => {
      let target: string | undefined;
      if (archive && path !== archive) target = archive;
      if (c.moveToInbox && path !== "INBOX") target = "INBOX";
      if (removeFolders.includes(path)) target = target ?? "INBOX";
      return target;
    };
    // Checked for every folder BEFORE anything changes.
    for (const path of groups.keys()) if (moveTarget(path)) await this.refuseMoveFrom(path);
    await this.precheckMoves([...groups].filter(([path]) => moveTarget(path)));

    for (const [path, uids] of groups) {
      await this.withBox(path, async (cl) => {
        const range = uids.join(",");
        const target = moveTarget(path);
        if (target) await this.refuseUnsafeExpunge(cl, path, uids, true);
        if (c.markRead) await cl.messageFlagsAdd(range, ["\\Seen"], { uid: true });
        if (c.markUnread) await cl.messageFlagsRemove(range, ["\\Seen"], { uid: true });
        if (c.star) await cl.messageFlagsAdd(range, ["\\Flagged"], { uid: true });
        if (c.unstar) await cl.messageFlagsRemove(range, ["\\Flagged"], { uid: true });
        for (const dest of addFolders) if (dest !== path) await cl.messageCopy(range, dest, { uid: true });
        if (target) {
          const r = await cl.messageMove(range, target, { uid: true });
          for (const uid of uids) {
            const nu = r && r.uidMap ? r.uidMap.get(uid) : undefined;
            moved[encodeId(path, uid)] = nu ? encodeId(target, nu) : target;
          }
        }
      });
    }
    if (c.markRead) removed.push("UNREAD");
    if (c.markUnread) added.push("UNREAD");
    if (c.star) added.push("STARRED");
    if (c.unstar) removed.push("STARRED");
    if (c.archive) removed.push("INBOX");
    if (c.moveToInbox) added.push("INBOX");
    added.push(...addFolders);
    removed.push(...removeFolders);
    return { added, removed, ...(Object.keys(moved).length ? { moved } : {}) };
  }

  async trash(ids: string[]): Promise<number> {
    const trash = await this.roleFolder("trash", true);
    const groups = this.groupByBox(ids);
    await this.precheckMoves([...groups].filter(([path]) => path !== trash));
    let n = 0;
    for (const [path, uids] of groups) {
      await this.withBox(path, async (c) => {
        if (path === trash) return;
        await this.refuseUnsafeExpunge(c, path, uids, true);
        await c.messageMove(uids.join(","), trash!, { uid: true });
        n += uids.length;
      });
    }
    return n;
  }

  async saveDraft(raw: string, threadId?: string): Promise<DraftInfo> {
    const drafts = await this.roleFolder("drafts", true);
    const { raw: full, messageId } = ensureHeaders(raw, this.account.email);
    const c = await this.conn();
    const r = await c.append(drafts!, full, ["\\Draft", "\\Seen"]);
    let uid = r && r.uid;
    if (!uid) {
      uid = await this.withBox(drafts!, async (cl) => ((await cl.search({ header: { "message-id": messageId } }, { uid: true })) || []).pop(), true);
    }
    if (!uid) throw new Error(`[${this.account.alias}] The draft was saved but could not be located in ${drafts}.`);
    const id = encodeId(drafts!, uid);
    return { draftId: id, messageId: id, threadId };
  }

  async listDrafts(max: number): Promise<DraftSummary[]> {
    const drafts = await this.roleFolder("drafts");
    if (!drafts) return [];
    const r = await this.search({ query: `label:"${drafts.replace(/"/g, "")}"`, max });
    return r.messages.map((m) => ({ draftId: m.id, messageId: m.id, threadId: m.threadId, to: m.to, subject: m.subject, date: m.date }));
  }

  /**
   * A draft = a message in the Drafts folder carrying the \Draft flag. Anything else is
   * refused, so delete_draft / send_draft can never touch received or sent mail.
   */
  private async requireDraft(draftId: string): Promise<{ path: string; uid: number; drafts: string }> {
    const { path, uid } = this.parseIdOrThrow(draftId);
    const drafts = await this.roleFolder("drafts");
    if (!drafts) throw new Error(`"${this.account.alias}" has no Drafts folder, so ${draftId} is not a draft. Refusing.`);
    if (path !== drafts) throw new Error(`${draftId} is not in the Drafts folder (${drafts}) of "${this.account.alias}". Refusing.`);
    const flags = await this.withBox(
      path,
      async (c) => {
        const m = await c.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
        if (!m) throw new Error(`Not found in "${this.account.alias}" (draft ${draftId}).`);
        return m.flags ?? new Set<string>();
      },
      true
    );
    if (!flags.has("\\Draft")) throw new Error(`${draftId} in ${drafts} is not marked as a draft (no \\Draft flag). Refusing.`);
    return { path, uid, drafts };
  }

  async deleteDraft(draftId: string): Promise<void> {
    const { path, uid } = await this.requireDraft(draftId);
    await this.withBox(path, async (c) => {
      // UID EXPUNGE of this one draft when the server has UIDPLUS; otherwise only when no other
      // message in Drafts is waiting to be expunged (see refuseUnsafeExpunge).
      await this.refuseUnsafeExpunge(c, path, [uid], false);
      const ok = await c.messageDelete(String(uid), { uid: true });
      if (!ok) throw new Error(`Not found in "${this.account.alias}" (draft ${draftId}).`);
    });
  }

  private transport() {
    const s = this.account.smtp;
    if (!s) throw new Error(`Sending needs SMTP settings for "${this.account.alias}". Re-run: gmail-mcp-multi add-imap ${this.account.alias} ${this.account.email} --host ${this.imap.host} --smtp-host <host>`);
    return nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      requireTLS: !s.secure && !s.allowInsecureTls,
      auth: { user: s.user || this.imap.user || this.account.email, pass: this.password },
      tls: { rejectUnauthorized: !s.allowInsecureTls },
      connectionTimeout: 20_000,
    });
  }

  async send(raw: string, threadId?: string): Promise<{ messageId?: string; threadId?: string }> {
    const transport = this.transport();
    const { raw: full } = ensureHeaders(raw, this.account.email);
    const parsed = await simpleParser(full);
    const rcpts = [parsed.to, parsed.cc, parsed.bcc]
      .flatMap((a) => (!a ? [] : Array.isArray(a) ? a : [a]))
      .flatMap((a) => a.value.map((v) => v.address).filter((x): x is string => Boolean(x)));
    if (!rcpts.length) throw new Error("No recipients.");
    const fromAddr = (parsed.from?.value[0]?.address || this.account.email).toLowerCase();
    try {
      await transport.sendMail({ envelope: { from: fromAddr, to: [...new Set(rcpts)] }, raw: stripBcc(full) });
    } finally {
      transport.close();
    }
    // Keep a copy in Sent, like a mail client would.
    let sentId: string | undefined;
    try {
      const sent = await this.roleFolder("sent", true);
      const c = await this.conn();
      const r = await c.append(sent!, full, ["\\Seen"]);
      if (r && r.uid) sentId = encodeId(sent!, r.uid);
    } catch (err) {
      console.error(`[gmail-mcp-multi] sent, but could not save a copy to Sent for ${this.account.alias}:`, (err as Error).message);
    }
    return { messageId: sentId, threadId };
  }

  async sendDraft(draftId: string): Promise<{ messageId?: string; threadId?: string; warning?: string }> {
    const { path, uid } = this.parseIdOrThrow(draftId);
    const key = encodeId(path, uid);
    // Taken before the first await, so a second call for the same draft can't slip in.
    if (this.sendingDrafts.has(key)) throw new Error(`Draft ${draftId} of "${this.account.alias}" is already being sent; not sending it twice.`);
    if (this.sentDrafts.has(key)) throw new Error(`Draft ${draftId} of "${this.account.alias}" was already sent; not sending it again. Delete it by hand if it is still there.`);
    this.sendingDrafts.add(key);
    try {
      const { drafts } = await this.requireDraft(draftId); // checked BEFORE anything is sent
      const m = await this.fetchSource(draftId);
      const r = await this.send(m.source.toString("utf8"));
      this.sentDrafts.add(key);
      // Sent. From here on never throw: a retry would send the email twice.
      try {
        await this.deleteDraft(draftId);
      } catch (err) {
        return {
          ...r,
          warning: `The email WAS sent, but the draft could not be removed from ${drafts} (${(err as Error).message}). Delete it by hand; do not send it again.`,
        };
      }
      return r;
    } finally {
      this.sendingDrafts.delete(key);
    }
  }

  async needsReply(o: NeedsReplyOptions): Promise<NeedsReplyResult> {
    const own = new Set((await this.identities()).map((i) => i.email.toLowerCase()));
    const since = new Date(Date.now() - o.days * 86_400_000);
    const sinceDay = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
    const hdrs = [...BASE_HEADERS, "list-unsubscribe", "list-id", "auto-submitted", "precedence"];

    const fetchBox = async (path: string, limit: number) =>
      this.withBox(
        path,
        async (c) => {
          const uids = ((await c.search({ since: sinceDay }, { uid: true })) || []).sort((a, b) => b - a).slice(0, limit);
          const res: { m: FetchMessageObject; h: Record<string, string> }[] = [];
          if (!uids.length) return res;
          for await (const m of c.fetch(uids.join(","), { uid: true, envelope: true, flags: true, internalDate: true, headers: hdrs }, { uid: true })) {
            res.push({ m, h: parseHeaderBlock(m.headers) });
          }
          return res;
        },
        true
      );

    const inbox = await fetchBox("INBOX", Math.min(300, Math.max(50, o.max * 5)));
    const sentPath = await this.roleFolder("sent");
    const sent = sentPath ? await fetchBox(sentPath, 500) : [];
    const draftsPath = await this.roleFolder("drafts");
    const drafts = draftsPath ? await fetchBox(draftsPath, 200) : [];

    const threadOf = (h: Record<string, string>, env: { inReplyTo?: string; messageId?: string } | undefined) =>
      rootId({ references: h["references"], inReplyTo: h["in-reply-to"] ?? env?.inReplyTo, messageId: h["message-id"] ?? env?.messageId }) ?? "";

    // Sent replies per thread (by root id) and per referenced message id.
    const sentByThread = new Map<string, Date[]>();
    const referenced = new Set<string>();
    for (const s of sent) {
      const root = threadOf(s.h, s.m.envelope);
      const d = toDate(s.m.internalDate);
      sentByThread.set(root, [...(sentByThread.get(root) ?? []), d]);
      for (const id of [...msgIds(s.h["in-reply-to"]), ...msgIds(s.h["references"])]) referenced.add(id);
    }
    const draftRefs = new Set(drafts.flatMap((d) => [...msgIds(d.h["in-reply-to"]), ...msgIds(d.h["references"])]));

    // Latest incoming message per thread.
    const latest = new Map<string, { m: FetchMessageObject; h: Record<string, string>; count: number }>();
    let skippedAutomated = 0;
    for (const it of inbox) {
      const from = fmtAddrs(it.m.envelope?.from);
      if (own.has(emailOf(from))) continue;
      const root = threadOf(it.h, it.m.envelope) || `uid:${it.m.uid}`;
      const prev = latest.get(root);
      if (!prev || toDate(it.m.internalDate) > toDate(prev.m.internalDate)) latest.set(root, { ...it, count: (prev?.count ?? 0) + 1 });
      else prev.count++;
    }

    const now = Date.now();
    const items: NeedsReplyItem[] = [];
    for (const [root, it] of latest) {
      const from = fmtAddrs(it.m.envelope?.from);
      if (o.skipAutomated && looksAutomated(from, it.h)) {
        skippedAutomated++;
        continue;
      }
      const received = toDate(it.m.internalDate);
      const rfc = msgIds(it.h["message-id"] ?? it.m.envelope?.messageId)[0];
      const sentDates = sentByThread.get(root) ?? [];
      if ((rfc && referenced.has(rfc)) || sentDates.some((d) => d > received)) continue; // answered
      const receivedAt = received.toISOString();
      const waitingHours = hoursSince(receivedAt, now);
      if (waitingHours < o.olderThanHours) continue;
      items.push({
        account: this.account.alias,
        threadId: root.startsWith("<") ? b64u(root) : encodeId("INBOX", it.m.uid),
        lastMessageId: encodeId("INBOX", it.m.uid),
        from,
        subject: it.m.envelope?.subject || "(no subject)",
        receivedAt,
        waitingHours,
        messagesInThread: it.count + sentDates.length,
        youRepliedEarlier: sentDates.some((d) => d <= received),
        hasDraft: Boolean(rfc && draftRefs.has(rfc)),
        unread: !(it.m.flags ?? new Set()).has("\\Seen"),
      });
    }
    items.sort((a, b) => b.waitingHours - a.waitingHours);
    return { items: items.slice(0, o.max), scanned: latest.size, skippedAutomated };
  }
}

registerProviderFactory("imap", (accounts: AccountManager, account: AccountConfig) => {
  const creds = accounts.loadCredentials<{ password?: string }>(account.alias);
  if (!creds.password) throw new Error(`No password stored for "${account.alias}". Run: gmail-mcp-multi add-imap ${account.alias} ${account.email} --host <server>`);
  return new ImapProvider(account, creds.password);
});
