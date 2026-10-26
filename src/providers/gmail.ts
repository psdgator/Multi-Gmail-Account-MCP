import * as fs from "node:fs";
import { auth, gmail, gmail_v1 } from "@googleapis/gmail";
import type { AccountConfig, AccountManager } from "../accounts.js";
import { findPart, header, LabelNames, listAttachments, toClean } from "../message.js";
import { loadClientKeys } from "../oauth.js";
import { emailOf, hoursSince, mapLimit } from "../util.js";
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

/** Retry idempotent requests on 429/5xx/network errors; never retries POST (no double sends). */
export const RETRY_CONFIG = {
  retry: 3,
  retryDelay: 400,
  httpMethodsToRetry: ["GET", "HEAD", "PUT", "OPTIONS", "DELETE"],
  statusCodesToRetry: [
    [100, 199],
    [429, 429],
    [500, 599],
  ],
};

const META_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Reply-To", "Message-ID"];

/**
 * System labels that must never be set/removed through label tools: applying TRASH or
 * SPAM would delete mail outside full mode; DRAFT/SENT/CHAT are managed by Gmail.
 */
const FORBIDDEN_LABELS = new Set(["TRASH", "SPAM", "DRAFT", "SENT", "CHAT"]);

/** Friendlier errors for the things that actually go wrong with Gmail OAuth. */
export function explainGoogleError(alias: string, err: unknown): Error {
  const e = err as {
    message?: string;
    code?: number | string;
    status?: number;
    response?: { status?: number; data?: { error?: string | { message?: string } } };
  };
  const status = e?.response?.status ?? e?.status ?? (typeof e?.code === "number" ? e.code : undefined);
  const data = e?.response?.data?.error;
  const detail = typeof data === "string" ? data : data?.message;
  const msg = `${e?.message ?? ""} ${detail ?? ""}`;

  if (/invalid_grant/i.test(msg)) {
    return new Error(
      `The Google sign-in for "${alias}" has expired or was revoked. Run the authenticate tool for "${alias}" again. ` +
        `(If this happens every 7 days, your Google Cloud OAuth app is still in "Testing"; set it to "In production".)`
    );
  }
  // Google reports per-user quota as 403 or 429 ("Quota exceeded … per minute per user", "rateLimitExceeded").
  if ((status === 403 || status === 429) && /quota exceeded|rate ?limit/i.test(msg)) {
    return new Error(`Gmail's per-minute limit was reached for "${alias}" (too many requests in a short time). Wait a minute and try again.`);
  }
  if (status === 403 && /insufficient|scope|permission/i.test(msg)) {
    return new Error(
      `"${alias}" was connected with fewer permissions than this action needs. Re-run authenticate for "${alias}" with a higher mode (or with calendar access).`
    );
  }
  if (status === 403 && /has not been used|is disabled|accessNotConfigured/i.test(msg)) {
    return new Error(`[${alias}] The Google API for this action is not enabled in your Google Cloud project: ${detail ?? e?.message}`);
  }
  if (status === 404 || (status === 400 && /invalid id|invalid.*value|malformed/i.test(msg))) {
    return new Error(`Not found in "${alias}" (wrong id, or it belongs to a different account).`);
  }
  if (status === 429) {
    return new Error(`Gmail rate limit hit for "${alias}". Try again in a minute.`);
  }
  if (/^Not found|is not signed in|not available for/.test(e?.message ?? "")) return e as Error;
  return new Error(`[${alias}] ${e?.message ?? String(err)}`);
}

/** Builds authenticated Google API clients for an account (shared by Gmail and Calendar). */
export function googleAuthFor(accounts: AccountManager, account: AccountConfig) {
  const alias = account.alias;
  const credentials = accounts.loadCredentials<Record<string, unknown>>(alias);
  const keys = loadClientKeys(accounts.getOAuthKeysPath(alias));
  const oauth = new auth.OAuth2(keys.client_id, keys.client_secret);
  oauth.setCredentials(credentials);
  // Persist refreshed access tokens (and a rotated refresh token, if Google sends one).
  oauth.on("tokens", (tokens) => {
    const merged = { ...credentials, ...tokens } as Record<string, unknown>;
    if (!tokens.refresh_token) merged.refresh_token = credentials.refresh_token;
    Object.assign(credentials, merged);
    try {
      accounts.saveCredentials(alias, merged);
    } catch (err) {
      console.error(`[gmail-mcp-multi] could not save refreshed token for ${alias}:`, err);
    }
  });
  return oauth;
}

export function gmailApiFor(accounts: AccountManager, account: AccountConfig): gmail_v1.Gmail {
  if (!fs.existsSync(accounts.getCredentialsPath(account.alias))) {
    throw new Error(`"${account.alias}" (${account.email}) is not signed in yet. Run the authenticate tool for it.`);
  }
  const rootUrl = process.env.GMAIL_MCP_API_ROOT || undefined;
  return gmail({
    version: "v1",
    auth: googleAuthFor(accounts, account),
    retryConfig: RETRY_CONFIG,
    ...(rootUrl ? { rootUrl } : {}),
  } as gmail_v1.Options);
}

export const gmailUrl = (email: string, fragment: string) => `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#${fragment}`;

export class GmailProvider implements MailProvider {
  readonly kind = "gmail" as const;
  readonly capabilities;
  private labelCache?: { at: number; byId: LabelNames; byName: Map<string, string> };
  private identityCache?: { at: number; list: Identity[] };

  constructor(
    readonly account: AccountConfig,
    readonly api: gmail_v1.Gmail
  ) {
    this.capabilities = { labels: true, filters: true, calendar: Boolean(account.calendar), send: true };
  }

  explain(err: unknown): Error {
    return explainGoogleError(this.account.alias, err);
  }

  webUrl(threadId: string): string {
    return gmailUrl(this.account.email, `all/${threadId}`);
  }

  async labels(): Promise<{ byId: LabelNames; byName: Map<string, string> }> {
    if (this.labelCache && Date.now() - this.labelCache.at < 5 * 60_000) return this.labelCache;
    const res = await this.api.users.labels.list({ userId: "me" });
    const byId: LabelNames = new Map();
    const byName = new Map<string, string>();
    for (const l of res.data.labels ?? []) {
      if (!l.id || !l.name) continue;
      if (l.type !== "system") byId.set(l.id, l.name);
      byName.set(l.name.toLowerCase(), l.id);
      byName.set(l.id.toLowerCase(), l.id);
    }
    this.labelCache = { at: Date.now(), byId, byName };
    return this.labelCache;
  }

  async identities(): Promise<Identity[]> {
    if (this.identityCache && Date.now() - this.identityCache.at < 10 * 60_000) return this.identityCache.list;
    const sendAs = (await this.api.users.settings.sendAs.list({ userId: "me" }).catch(() => undefined))?.data.sendAs ?? [];
    const list: Identity[] = sendAs
      .filter((s) => s.sendAsEmail)
      .map((s) => ({
        email: s.sendAsEmail!,
        displayName: s.displayName ?? undefined,
        signature: s.signature ?? undefined,
        signatureIsHtml: true,
        isDefault: Boolean(s.isDefault),
      }));
    if (!list.some((i) => i.email.toLowerCase() === this.account.email.toLowerCase())) {
      list.unshift({ email: this.account.email, isDefault: !list.some((i) => i.isDefault) });
    }
    for (const extra of this.account.extraAddresses ?? []) {
      if (!list.some((i) => i.email.toLowerCase() === extra.toLowerCase())) list.push({ email: extra });
    }
    this.identityCache = { at: Date.now(), list };
    return list;
  }

  private async meta(ids: string[], extraHeaders: string[] = []) {
    const { byId } = await this.labels();
    const headers = [...META_HEADERS, ...extraHeaders];
    return mapLimit(ids, 8, async (id) => {
      const res = await this.api.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: headers });
      return toClean(this.account.alias, res.data, { labelNames: byId, headers: extraHeaders });
    });
  }

  async search(o: SearchOptions): Promise<SearchResult> {
    // messages.list returns at most 500 per page: page through for larger requests.
    const found: { id: string; threadId: string }[] = [];
    let pageToken = o.pageToken;
    let estimate = 0;
    do {
      const res = await this.api.users.messages.list({
        userId: "me",
        q: o.query,
        maxResults: Math.min(500, o.max - found.length),
        includeSpamTrash: o.includeSpamTrash ?? false,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const m of res.data.messages ?? []) if (m.id) found.push({ id: m.id, threadId: m.threadId ?? "" });
      estimate = Math.max(estimate, res.data.resultSizeEstimate ?? 0);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && found.length < o.max);
    if (o.idsOnly) {
      return {
        messages: found.map(({ id, threadId }) => ({ account: this.account.alias, id, threadId, date: "", from: "", to: "", subject: "", labels: [], unread: false, starred: false })),
        next: pageToken,
        estimate,
      };
    }
    return { messages: await this.meta(found.map((m) => m.id), o.headers), next: pageToken, estimate };
  }

  async inboxStatus(): Promise<InboxStatus> {
    const inbox = await this.api.users.labels.get({ userId: "me", id: "INBOX" });
    return { unread: inbox.data.messagesUnread ?? 0, total: inbox.data.messagesTotal ?? 0, unreadThreads: inbox.data.threadsUnread ?? 0 };
  }

  async getMessage(id: string, opts: { maxBodyChars?: number }) {
    const { byId } = await this.labels();
    const res = await this.api.users.messages.get({ userId: "me", id, format: "full" });
    return toClean(this.account.alias, res.data, { body: true, maxBodyChars: opts.maxBodyChars, labelNames: byId });
  }

  async getThread(threadId: string, opts: { maxBodyChars?: number }) {
    const { byId } = await this.labels();
    const res = await this.api.users.threads.get({ userId: "me", id: threadId, format: "full" });
    return (res.data.messages ?? []).map((m) => toClean(this.account.alias, m, { body: true, maxBodyChars: opts.maxBodyChars ?? 8000, labelNames: byId }));
  }

  async getOriginalHeaders(id: string): Promise<OriginalHeaders> {
    const orig = await this.api.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID", "Message-Id", "References", "List-Unsubscribe", "List-Unsubscribe-Post"],
    });
    const h = orig.data.payload?.headers ?? undefined;
    return {
      from: header(h, "From") ?? "",
      to: header(h, "To") ?? "",
      cc: header(h, "Cc") ?? "",
      replyTo: header(h, "Reply-To"),
      subject: header(h, "Subject") ?? "",
      date: header(h, "Date"),
      rfcMessageId: header(h, "Message-ID") ?? header(h, "Message-Id"),
      references: header(h, "References"),
      threadId: orig.data.threadId ?? undefined,
      listUnsubscribe: header(h, "List-Unsubscribe"),
      listUnsubscribePost: header(h, "List-Unsubscribe-Post"),
    };
  }

  async getAttachment(messageId: string, sel: { partId?: string; filename?: string }): Promise<AttachmentData> {
    const msg = await this.api.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const payload = msg.data.payload ?? undefined;
    const atts = listAttachments(payload);
    let target = sel.partId
      ? findPart(payload, (p) => p.partId === sel.partId)
      : sel.filename
        ? findPart(payload, (p) => (p.filename ?? "").toLowerCase() === sel.filename!.toLowerCase())
        : undefined;
    if (!target && !sel.partId && !sel.filename && atts.length === 1) target = findPart(payload, (p) => p.partId === atts[0].partId);
    if (!target || !target.filename) {
      throw new Error(
        atts.length
          ? `Attachment not found. Available: ${atts.map((a) => `${a.filename} (partId ${a.partId})`).join(", ")}`
          : "This email has no attachments."
      );
    }
    let data = target.body?.data ?? undefined;
    if (!data && target.body?.attachmentId) {
      const res = await this.api.users.messages.attachments.get({ userId: "me", messageId, id: target.body.attachmentId });
      data = res.data.data ?? undefined;
    }
    if (!data) throw new Error("Attachment has no data.");
    return { filename: target.filename, mimeType: target.mimeType ?? "application/octet-stream", data: Buffer.from(data, "base64url") };
  }

  async listLabels(): Promise<Label[]> {
    const res = await this.api.users.labels.list({ userId: "me" });
    return (res.data.labels ?? [])
      .map((l) => ({ id: l.id ?? "", name: l.name ?? "", type: l.type ?? undefined }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "system" ? -1 : 1));
  }

  async createLabel(name: string): Promise<Label> {
    const res = await this.api.users.labels.create({
      userId: "me",
      requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    this.labelCache = undefined;
    return { id: res.data.id ?? "", name: res.data.name ?? name, type: "user" };
  }

  async resolveLabelIds(names: string[] | undefined): Promise<string[]> {
    if (!names?.length) return [];
    const { byName } = await this.labels();
    return names.map((n) => {
      const id = FORBIDDEN_LABELS.has(n.trim().toUpperCase()) ? n.trim().toUpperCase() : byName.get(n.trim().toLowerCase());
      if (!id) throw new Error(`Label "${n}" does not exist in ${this.account.alias}. Use list_labels, or create_label first.`);
      if (FORBIDDEN_LABELS.has(id)) {
        throw new Error(
          `"${n}" can't be added or removed as a label. ${id === "TRASH" ? "Moving mail to Trash is only possible with trash_emails / bulk_cleanup in full mode." : "Gmail manages this label itself."}`
        );
      }
      return id;
    });
  }

  async modify(ids: string[], c: MessageChanges) {
    const add = new Set(await this.resolveLabelIds(c.addLabels));
    const remove = new Set(await this.resolveLabelIds(c.removeLabels));
    if (c.markRead) remove.add("UNREAD");
    if (c.markUnread) add.add("UNREAD");
    if (c.star) add.add("STARRED");
    if (c.unstar) remove.add("STARRED");
    if (c.archive) remove.add("INBOX");
    if (c.moveToInbox) add.add("INBOX");
    for (const id of add) if (remove.has(id)) throw new Error(`Conflicting changes for label ${id}.`);
    if (!add.size && !remove.size) throw new Error("Nothing to change.");
    await this.api.users.messages.batchModify({ userId: "me", requestBody: { ids, addLabelIds: [...add], removeLabelIds: [...remove] } });
    return { added: [...add], removed: [...remove] };
  }

  async trash(ids: string[]): Promise<number> {
    await mapLimit(ids, 8, (id) => this.api.users.messages.trash({ userId: "me", id }));
    return ids.length;
  }

  async saveDraft(raw: string, threadId?: string): Promise<DraftInfo> {
    const res =
      raw.length < 4 * 1024 * 1024
        ? await this.api.users.drafts.create({
            userId: "me",
            requestBody: { message: { raw: Buffer.from(raw).toString("base64url"), ...(threadId ? { threadId } : {}) } },
          })
        : await this.api.users.drafts.create({
            userId: "me",
            requestBody: { message: threadId ? { threadId } : {} },
            media: { mimeType: "message/rfc822", body: raw },
          });
    const messageId = res.data.message?.id ?? "";
    return {
      draftId: res.data.id ?? "",
      messageId,
      threadId: res.data.message?.threadId ?? undefined,
      openUrl: gmailUrl(this.account.email, `drafts?compose=${messageId}`),
    };
  }

  async listDrafts(max: number): Promise<DraftSummary[]> {
    const res = await this.api.users.drafts.list({ userId: "me", maxResults: max });
    return mapLimit(res.data.drafts ?? [], 8, async (d) => {
      const full = await this.api.users.drafts.get({ userId: "me", id: d.id!, format: "metadata" });
      const m = toClean(this.account.alias, full.data.message ?? {}, {});
      return { draftId: d.id ?? "", messageId: m.id, threadId: m.threadId, to: m.to, subject: m.subject, date: m.date, snippet: m.snippet };
    });
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.api.users.drafts.delete({ userId: "me", id: draftId });
  }

  async send(raw: string, threadId?: string) {
    const res =
      raw.length < 4 * 1024 * 1024
        ? await this.api.users.messages.send({
            userId: "me",
            requestBody: { raw: Buffer.from(raw).toString("base64url"), ...(threadId ? { threadId } : {}) },
          })
        : await this.api.users.messages.send({
            userId: "me",
            requestBody: threadId ? { threadId } : {},
            media: { mimeType: "message/rfc822", body: raw },
          });
    return { messageId: res.data.id ?? undefined, threadId: res.data.threadId ?? undefined };
  }

  async sendDraft(draftId: string) {
    const res = await this.api.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
    return { messageId: res.data.id ?? undefined, threadId: res.data.threadId ?? undefined };
  }

  async needsReply(o: NeedsReplyOptions): Promise<NeedsReplyResult> {
    const own = new Set((await this.identities()).map((i) => i.email.toLowerCase()));
    const q = o.query ?? `in:inbox -category:promotions -category:social -category:forums newer_than:${o.days}d`;
    const list = await this.api.users.threads.list({ userId: "me", q, maxResults: Math.min(100, o.max * 3) });
    const threads = list.data.threads ?? [];
    let skippedAutomated = 0;
    const now = Date.now();

    const results = await mapLimit(threads, 8, async (t): Promise<NeedsReplyItem | undefined> => {
      const full = await this.api.users.threads.get({
        userId: "me",
        id: t.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date", "List-Unsubscribe", "List-Id", "Auto-Submitted", "Precedence"],
      });
      const msgs = full.data.messages ?? [];
      const real = msgs.filter((m) => !(m.labelIds ?? []).includes("DRAFT"));
      const hasDraft = real.length !== msgs.length;
      const last = real[real.length - 1];
      if (!last) return undefined;
      const h = last.payload?.headers ?? undefined;
      const from = header(h, "From") ?? "";
      if (own.has(emailOf(from))) return undefined; // we answered last
      const hdrs: Record<string, string | undefined> = {
        "list-unsubscribe": header(h, "List-Unsubscribe"),
        "list-id": header(h, "List-Id"),
        "auto-submitted": header(h, "Auto-Submitted"),
        precedence: header(h, "Precedence"),
      };
      if (o.skipAutomated && looksAutomated(from, hdrs)) {
        skippedAutomated++;
        return undefined;
      }
      const receivedAt = last.internalDate ? new Date(Number(last.internalDate)).toISOString() : header(h, "Date") ?? "";
      const waitingHours = hoursSince(receivedAt, now);
      if (waitingHours < o.olderThanHours) return undefined;
      return {
        account: this.account.alias,
        threadId: t.id!,
        lastMessageId: last.id ?? "",
        from,
        subject: header(h, "Subject") ?? "(no subject)",
        snippet: last.snippet ?? undefined,
        receivedAt,
        waitingHours,
        messagesInThread: real.length,
        youRepliedEarlier: real.slice(0, -1).some((m) => own.has(emailOf(header(m.payload?.headers ?? undefined, "From") ?? ""))),
        hasDraft,
        unread: (last.labelIds ?? []).includes("UNREAD"),
      };
    });

    const items = results.filter((x): x is NeedsReplyItem => Boolean(x));
    items.sort((a, b) => b.waitingHours - a.waitingHours);
    return { items: items.slice(0, o.max), scanned: threads.length, skippedAutomated };
  }
}
