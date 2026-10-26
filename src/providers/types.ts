import type { AccountConfig, AccountType } from "../accounts.js";
import type { CleanMessage } from "../message.js";

/**
 * Everything tools need from a mailbox, independent of how it is reached
 * (Gmail API or IMAP/SMTP). Tools only talk to this interface; Gmail-only
 * features (filters, Calendar) check `capabilities` first.
 *
 * Conventions:
 * - Message ids and thread ids are opaque strings owned by the provider.
 * - Errors meaning "this id does not exist here" must have a message that starts
 *   with "Not found" (read tools use that to try the next account).
 */

export interface Identity {
  email: string;
  displayName?: string;
  /** HTML (Gmail) or plain text (IMAP) signature. */
  signature?: string;
  signatureIsHtml?: boolean;
  isDefault?: boolean;
}

export interface OriginalHeaders {
  from: string;
  to: string;
  cc: string;
  replyTo?: string;
  subject: string;
  date?: string;
  rfcMessageId?: string;
  references?: string;
  threadId?: string;
  /** RFC 2369 / 8058 unsubscribe headers, when present. */
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
}

export interface SearchOptions {
  query: string;
  max: number;
  pageToken?: string;
  includeSpamTrash?: boolean;
  /** Extra headers to return in `CleanMessage.headers` (e.g. "List-Unsubscribe"). */
  headers?: string[];
  /** Only ids are needed (bulk actions): providers may skip fetching headers. */
  idsOnly?: boolean;
}

export interface SearchResult {
  messages: CleanMessage[];
  next?: string;
  estimate?: number;
}

export interface InboxStatus {
  unread: number;
  total: number;
  unreadThreads?: number;
}

export interface MessageChanges {
  markRead?: boolean;
  markUnread?: boolean;
  star?: boolean;
  unstar?: boolean;
  archive?: boolean;
  moveToInbox?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
}

export interface AttachmentData {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface DraftInfo {
  draftId: string;
  messageId: string;
  threadId?: string;
  openUrl?: string;
}

export interface DraftSummary {
  draftId: string;
  messageId?: string;
  threadId?: string;
  to?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

export interface Label {
  id: string;
  name: string;
  type?: string;
}

export interface NeedsReplyOptions {
  /** Look back this many days. */
  days: number;
  /** Max conversations to return. */
  max: number;
  /** Only threads where the last incoming message is at least this old. */
  olderThanHours: number;
  /** Skip newsletters, notifications and no-reply senders. */
  skipAutomated: boolean;
  /** Override the base search (Gmail syntax). */
  query?: string;
}

export interface NeedsReplyItem {
  account: string;
  threadId: string;
  lastMessageId: string;
  from: string;
  subject: string;
  snippet?: string;
  receivedAt: string;
  waitingHours: number;
  messagesInThread: number;
  youRepliedEarlier: boolean;
  hasDraft: boolean;
  unread: boolean;
}

export interface NeedsReplyResult {
  items: NeedsReplyItem[];
  scanned: number;
  skippedAutomated: number;
}

export interface Capabilities {
  /** Arbitrary labels (Gmail) vs. folders only. */
  labels: boolean;
  filters: boolean;
  calendar: boolean;
  /** Sending needs SMTP for IMAP accounts. */
  send: boolean;
}

export interface MailProvider {
  readonly kind: AccountType;
  readonly account: AccountConfig;
  readonly capabilities: Capabilities;

  /** Addresses (and signatures) this mailbox sends as. First/isDefault is the primary. */
  identities(): Promise<Identity[]>;
  search(opts: SearchOptions): Promise<SearchResult>;
  inboxStatus(): Promise<InboxStatus>;
  getMessage(id: string, opts: { maxBodyChars?: number }): Promise<CleanMessage>;
  getThread(threadId: string, opts: { maxBodyChars?: number }): Promise<CleanMessage[]>;
  getOriginalHeaders(id: string): Promise<OriginalHeaders>;
  /** Attachment by partId or filename; with neither, the only attachment. */
  getAttachment(messageId: string, sel: { partId?: string; filename?: string }): Promise<AttachmentData>;
  listLabels(): Promise<Label[]>;
  createLabel(name: string): Promise<Label>;
  modify(ids: string[], changes: MessageChanges): Promise<{ added: string[]; removed: string[] }>;
  trash(ids: string[]): Promise<number>;
  saveDraft(raw: string, threadId?: string): Promise<DraftInfo>;
  listDrafts(max: number): Promise<DraftSummary[]>;
  deleteDraft(draftId: string): Promise<void>;
  send(raw: string, threadId?: string): Promise<{ messageId?: string; threadId?: string }>;
  sendDraft(draftId: string): Promise<{ messageId?: string; threadId?: string }>;
  needsReply(opts: NeedsReplyOptions): Promise<NeedsReplyResult>;
  /** Web link to open a message/thread, if the provider has one. */
  webUrl?(threadOrMessageId: string): string | undefined;
  /** Translate a provider error into a friendly one. */
  explain(err: unknown): Error;
  /** Release connections (IMAP). */
  close?(): Promise<void>;
}

export function unsupported(account: AccountConfig, feature: string): Error {
  return new Error(`${feature} is not available for "${account.alias}" (${account.type ?? "gmail"} account).`);
}

/** Heuristic: automated / bulk mail that never needs a personal reply. */
export function looksAutomated(from: string, headers: Record<string, string | undefined>): boolean {
  if (/(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@|notify@|bounces?[@+.-]|newsletter|news@|info@mailchimp|@.*\.mcsv\.net)/i.test(from)) return true;
  if (headers["list-unsubscribe"] || headers["list-id"]) return true;
  const auto = headers["auto-submitted"];
  if (auto && auto.toLowerCase() !== "no") return true;
  const prec = (headers["precedence"] ?? "").toLowerCase();
  return prec === "bulk" || prec === "list" || prec === "junk";
}
