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
} as const;

/**
 * Smallest Google scope set for each mode.
 *
 * Note: Google has no scope that allows drafts but forbids sending, so in
 * "drafts" mode the guarantee that nothing is sent comes from this server not
 * exposing any send tool.
 */
export function scopesForMode(mode: Mode): string[] {
  switch (mode) {
    case "readonly":
      return [SCOPE.readonly];
    case "drafts":
      return [SCOPE.modify];
    case "full":
      return [SCOPE.modify, SCOPE.settings];
  }
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

export interface AuthFlow {
  /** URL the user must open to sign in. */
  url: string;
  /** Resolves once the account is saved (or rejects on error / timeout). */
  done: Promise<{ alias: string; email: string; scopes: string[] }>;
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

/**
 * Start the OAuth "loopback" flow for one account: listens on 127.0.0.1 on a
 * random port, waits for Google's redirect, exchanges the code (with PKCE),
 * checks which mailbox actually signed in, and saves the tokens.
 */
export async function startAuthFlow(
  accounts: AccountManager,
  opts: { alias: string; emailHint?: string; mode: Mode; timeoutMs?: number }
): Promise<AuthFlow> {
  const { alias, emailHint, mode } = opts;
  const keys = loadClientKeys(accounts.getOAuthKeysPath(alias));
  const scopes = scopesForMode(mode);
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
  const close = () => {
    if (timer) clearTimeout(timer);
    server.close();
  };

  const done = new Promise<{ alias: string; email: string; scopes: string[] }>((resolve, reject) => {
    timer = setTimeout(() => {
      close();
      reject(new Error(`Sign-in for "${alias}" timed out. Run authenticate again.`));
    }, opts.timeoutMs ?? 10 * 60 * 1000);

    server.on("request", async (req, res) => {
      const reqUrl = new URL(req.url || "/", redirectUri);
      if (reqUrl.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const send = (status: number, html: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      };
      try {
        const error = reqUrl.searchParams.get("error");
        if (error) {
          send(400, page("Sign-in cancelled", `Google returned: ${escapeHtml(error)}. You can close this tab.`, false));
          close();
          reject(new Error(`Google sign-in failed: ${error}`));
          return;
        }
        const code = reqUrl.searchParams.get("code");
        if (!code || reqUrl.searchParams.get("state") !== state) {
          send(400, page("Invalid response", "Missing code or state mismatch. Start the sign-in again.", false));
          return;
        }

        const { tokens } = await client.getToken({ code, codeVerifier });
        client.setCredentials(tokens);
        const rootUrl = process.env.GMAIL_MCP_API_ROOT || undefined;
        const g = gmail({ version: "v1", auth: client, ...(rootUrl ? { rootUrl } : {}) });
        const profile = await g.users.getProfile({ userId: "me" });
        const email = profile.data.emailAddress;
        if (!email) throw new Error("Google did not return the mailbox address.");

        const granted = (tokens.scope || "").split(/\s+/).filter(Boolean);
        accounts.addAccount(alias, email, undefined);
        accounts.saveCredentials(alias, tokens);

        const mismatch =
          emailHint && emailHint.toLowerCase() !== email.toLowerCase()
            ? `<br><br><b>Note:</b> you signed in as ${escapeHtml(email)}, not ${escapeHtml(emailHint)}.`
            : "";
        send(
          200,
          page(
            "Gmail account connected",
            `<b>${escapeHtml(email)}</b> is now available to Claude as <b>${escapeHtml(alias)}</b>.${mismatch}<br><br>You can close this tab.`,
            true
          )
        );
        close();
        resolve({ alias, email, scopes: granted });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send(500, page("Something went wrong", escapeHtml(msg), false));
        close();
        reject(e instanceof Error ? e : new Error(msg));
      }
    });
  });

  return { url, done, cancel: close };
}
