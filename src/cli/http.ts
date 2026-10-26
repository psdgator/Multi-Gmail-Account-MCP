import * as fs from "node:fs";
import { AccountManager } from "../accounts.js";
import { AuthStore } from "../http/auth-store.js";
import { startHttpServer, validatePassword } from "../http/server.js";
import { extraCommands } from "./common.js";
import { VERSION } from "../version.js";

/** Minimal flag parsing (kept local so this module does not depend on index.ts helpers). */
function flag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  const a = args[i];
  if (a.includes("=")) {
    args.splice(i, 1);
    return a.slice(a.indexOf("=") + 1);
  }
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function readPassword(): string {
  const file = process.env.GMAIL_MCP_HTTP_PASSWORD_FILE;
  const pw = file ? fs.readFileSync(file, "utf8").replace(/\r?\n$/, "") : process.env.GMAIL_MCP_HTTP_PASSWORD;
  return validatePassword(pw);
}

function parseTrustProxy(v: string | undefined): string | number | boolean {
  if (v === undefined || v === "") return "loopback";
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

extraCommands["serve-http"] = {
  help: `  gmail-mcp-multi serve-http --public-url https://mail.example.com [--port 8787] [--host 127.0.0.1]
                                                  Hosted mode for claude.ai custom connectors (Streamable HTTP + OAuth).
                                                  Needs GMAIL_MCP_HTTP_PASSWORD (12+ chars). See docs/hosted.md
  gmail-mcp-multi http-logout [--clients]         Revoke all hosted-mode tokens (and registered clients); takes effect immediately`,
  run: async (args, mode) => {
    const publicUrl = flag(args, "--public-url") ?? process.env.GMAIL_MCP_PUBLIC_URL;
    if (!publicUrl) throw new Error("Pass --public-url https://your-host (or set GMAIL_MCP_PUBLIC_URL).");
    const port = Number(flag(args, "--port") ?? process.env.GMAIL_MCP_HTTP_PORT ?? 8787);
    const host = flag(args, "--host") ?? process.env.GMAIL_MCP_HTTP_HOST ?? "127.0.0.1";
    const trustProxy = parseTrustProxy(flag(args, "--trust-proxy") ?? process.env.GMAIL_MCP_TRUST_PROXY);
    const noLoopback = bool(args, "--no-loopback-redirects") || process.env.GMAIL_MCP_HTTP_ALLOW_LOOPBACK === "0";
    const running = await startHttpServer({
      mode,
      publicUrl,
      port,
      host,
      password: readPassword(),
      trustProxy,
      allowedRedirects: list(process.env.GMAIL_MCP_HTTP_ALLOWED_REDIRECTS),
      allowLoopbackRedirects: !noLoopback,
      allowedHosts: list(process.env.GMAIL_MCP_HTTP_ALLOWED_HOSTS),
      allowedOrigins: list(process.env.GMAIL_MCP_HTTP_ALLOWED_ORIGINS),
    });
    console.error(`gmail-mcp-multi ${VERSION} hosted mode (${mode}) listening on ${running.url}`);
    console.error(`Connector URL for Claude: ${running.mcpUrl}`);
    const stop = async () => {
      await running.close();
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  },
};

extraCommands["http-logout"] = {
  help: "",
  run: async (args) => {
    const alsoClients = bool(args, "--clients");
    const accounts = new AccountManager();
    const store = new AuthStore(accounts.root, accounts.secrets);
    const before = store.stats();
    const r = store.revokeAll(alsoClients);
    console.log(`Revoked ${r.tokens} tokens${alsoClients ? ` and ${r.clients} registered clients` : ""} (had ${before.clients} clients).`);
    console.log("A running server picks this up immediately; no restart needed.");
    console.log("Connected apps (e.g. claude.ai) must connect again and enter the server password.");
  },
};
