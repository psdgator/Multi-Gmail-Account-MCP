import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { auth, gmail } from "@googleapis/gmail";
import type { AccountManager } from "./accounts.js";
import type { Mode } from "./config.js";

export const SCOPE = {
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  modify: "https://www.googleapis.com/auth/gmail.modify",
  settings: "https://www.googleapis.com/auth/gmail.settings.basic",
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  calendarEvents: "https://www.googleapis.com/auth/calendar.events",
} as const;

/**
 * Smallest Google scope set for each mode.
 *
 * Note: Google has no scope that allows drafts but forbids sending, so in
 * "drafts" mode the guarantee that nothing is sent comes from this server not
 * exposing any send tool.
 */
export function scopesForMode(mode: Mode, opts: { calendar?: boolean } = {}): string[] {
  const mail = mode === "readonly" ? [SCOPE.readonly] : mode === "drafts" ? [SCOPE.modify] : [SCOPE.modify, SCOPE.settings];
  if (!opts.calendar) return mail;
  return [...mail, SCOPE.calendarRead, ...(mode === "full" ? [SCOPE.calendarEvents] : [])];
}

export interface OAuthClientKeys {
  client_id: string;
  client_secret: string;
}

/** Load a Google OAuth client JSON ("installed" for Desktop apps, "web" also accepted). */
export function loadClientKeys(filePath: string): OAuthClientKeys {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Google OAuth client file not found at ${filePath}. Download the "Desktop app" OAuth client JSON from Google Cloud Console and save it there.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const k = raw.installed ?? raw.web ?? raw;
  if (!k?.client_id || !k?.client_secret) {
    throw new Error(`${filePath} does not look like a Google OAuth client file (missing client_id/client_secret).`);
  }
  return { client_id: k.client_id, client_secret: k.client_secret };
}

export function openBrowser(url: string): void {
  if (process.env.GMAIL_MCP_NO_BROWSER === "1") return;
  try {
    let child;
    if (process.platform === "win32") {
      // rundll32 avoids cmd.exe mangling the "&" characters in the URL.
      child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" });
    } else if (process.platform === "darwin") {
      child = spawn("open", [url], { detached: true, stdio: "ignore" });
    } else {
      child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    child.on("error", () => {
      /* no browser available; the URL is shown to the user instead */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

export interface AuthResult {
  alias: string;
  email: string;
  scopes: string[];
}

export interface AuthFlow {
  /** URL the user must open to sign in. */
  url: string;
  /** Resolves once the account is saved (or rejects on error / timeout). */
  done: Promise<AuthResult>;
  /**
   * Finish the flow from the URL Google redirected to (for headless servers:
   * the browser shows "can't connect to 127.0.0.1"; paste that address here).
   */
  completeFromRedirect: (redirectedUrl: string) => Promise<AuthResult>;
  cancel: () => void;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, ok: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f7f8">
<div style="text-align:center;max-width:520px;padding:24px">
<h1 style="color:${ok ? "#15803d" : "#b91c1c"};font-size:22px">${escapeHtml(title)}</h1>
<p style="color:#333;line-height:1.5">${body}</p></div></body></html>`;
}

export class WrongAccountError extends Error {}

/**
 * Start the OAuth "loopback" flow for one account: listens on 127.0.0.1 on a
 * random port, waits for Google's redirect, exchanges the code (with PKCE),
 * checks which mailbox actually signed in, and saves the tokens (encrypted).
 *
 * If `emailHint` is given and a different Google account signs in, the tokens
 * are discarded unless `allowDifferentEmail` is set.
 */
export async function startAuthFlow(
  accounts: AccountManager,
  opts: { alias: string; emailHint?: string; mode: Mode; calendar?: boolean; allowDifferentEmail?: boolean; timeoutMs?: number }
): Promise<AuthFlow> {
  const { alias, emailHint, mode } = opts;
  const keys = loadClientKeys(accounts.getOAuthKeysPath(alias));
  const scopes = scopesForMode(mode, { calendar: opts.calendar });
  const state = crypto.randomBytes(16).toString("hex");

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const client = new auth.OAuth2(keys.client_id, keys.client_secret, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state,
    login_hint: emailHint,
    include_granted_scopes: false,
    code_challenge: codeChallenge,
    code_challenge_method: "S256" as never,
  });

  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveDone!: (r: AuthResult) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<AuthResult>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  const close = () => {
    if (timer) clearTimeout(timer);
    server.close();
  };
  const settle = (err: Error | undefined, result?: AuthResult) => {
    if (settled) return;
    settled = true;
    close();
    if (err) rejectDone(err);
    else resolveDone(result!);
  };

  timer = setTimeout(() => settle(new Error(`Sign-in for "${alias}" timed out. Run authenticate again.`)), opts.timeoutMs ?? 10 * 60 * 1000);

  /** Exchange the code, verify the mailbox, save. */
  const finish = async (code: string): Promise<AuthResult> => {
    const { tokens } = await client.getToken({ code, codeVerifier });
    client.setCredentials(tokens);
    const rootUrl = process.env.GMAIL_MCP_API_ROOT || undefined;
    const g = gmail({ version: "v1", auth: client, ...(rootUrl ? { rootUrl } : {}) });
    const profile = await g.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress;
    if (!email) throw new Error("Google did not return the mailbox address.");
    if (emailHint && emailHint.toLowerCase() !== email.toLowerCase() && !opts.allowDifferentEmail) {
      await client.revokeToken(tokens.access_token ?? "").catch(() => undefined);
      throw new WrongAccountError(
        `You signed in as ${email}, but "${alias}" is meant for ${emailHint}. Nothing was saved; sign in again and pick ${emailHint}.`
      );
    }
    const granted = (tokens.scope || "").split(/\s+/).filter(Boolean);
    const hasCalendar = granted.some((s) => s.includes("/auth/calendar"));
    accounts.addAccount(alias, email, undefined, { type: "gmail", calendar: hasCalendar });
    accounts.saveCredentials(alias, tokens);
    return { alias, email, scopes: granted };
  };

  const handle = async (reqUrl: URL): Promise<{ status: number; html: string; result?: AuthResult; error?: Error; final: boolean }> => {
    const error = reqUrl.searchParams.get("error");
    if (error) {
      return { status: 400, html: page("Sign-in cancelled", `Google returned: ${escapeHtml(error)}. You can close this tab.`, false), error: new Error(`Google sign-in failed: ${error}`), final: true };
    }
    const code = reqUrl.searchParams.get("code");
    if (!code || reqUrl.searchParams.get("state") !== state) {
      return { status: 400, html: page("Invalid response", "Missing code or state mismatch. Start the sign-in again.", false), final: false };
    }
    try {
      const result = await finish(code);
      return {
        status: 200,
        html: page("Gmail account connected", `<b>${escapeHtml(result.email)}</b> is now available to Claude as <b>${escapeHtml(alias)}</b>.<br><br>You can close this tab.`, true),
        result,
        final: true,
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      return { status: e instanceof WrongAccountError ? 409 : 500, html: page(e instanceof WrongAccountError ? "Wrong Google account" : "Something went wrong", escapeHtml(err.message), false), error: err, final: true };
    }
  };

  server.on("request", async (req, res) => {
    const reqUrl = new URL(req.url || "/", redirectUri);
    if (reqUrl.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    const out = await handle(reqUrl);
    res.writeHead(out.status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(out.html);
    if (out.final) settle(out.error, out.result);
  });

  const completeFromRedirect = async (redirectedUrl: string): Promise<AuthResult> => {
    let u: URL;
    try {
      u = new URL(redirectedUrl.trim());
    } catch {
      throw new Error("That doesn't look like a URL. Paste the full address from the browser's address bar.");
    }
    const out = await handle(u);
    if (!out.final) throw new Error("The pasted address has no valid code/state. Use the address from this sign-in attempt.");
    settle(out.error, out.result);
    if (out.error) throw out.error;
    return out.result!;
  };

  return { url, done, completeFromRedirect, cancel: () => settle(new Error("cancelled")) };
}
