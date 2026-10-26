import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { AccountManager, ImapServerConfig } from "../accounts.js";
import { parseMode } from "../config.js";
import { extraCommands, takeBool, takeFlag } from "./common.js";

const USAGE = `Usage: gmail-mcp-multi add-imap <alias> <email> --host <imap host> [--port 993] [--starttls] [--user <login>]
                [--smtp-host <host>] [--smtp-port 465|587] [--no-smtp] [--name "Display Name"]
                [--signature "text"] [--mode readonly|drafts|full] [--allow-insecure-tls]
  Hetzner (KonsoleH / your-server.de):  --host mail.your-server.de   (SMTP: same host, 465)`;

/** Read a line from the terminal without echoing it. */
export async function readHidden(question: string): Promise<string> {
  const env = process.env.GMAIL_MCP_IMAP_PASSWORD;
  if (env) return env;
  const stdin = process.stdin;
  process.stderr.write(question);
  if (!stdin.isTTY) {
    // Piped input: read one line.
    return new Promise((resolve) => {
      let buf = "";
      const onData = (d: Buffer) => {
        buf += d.toString("utf8");
        const i = buf.indexOf("\n");
        if (i !== -1) {
          stdin.off("data", onData);
          stdin.pause();
          process.stderr.write("\n");
          resolve(buf.slice(0, i).replace(/\r$/, ""));
        }
      };
      stdin.on("data", onData);
      stdin.resume();
    });
  }
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("Cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export async function verifyImap(imap: ImapServerConfig, email: string, password: string): Promise<{ unread: number; total: number; folders: string[] }> {
  const c = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    doSTARTTLS: imap.secure ? undefined : imap.allowInsecureTls ? undefined : true,
    auth: { user: imap.user || email, pass: password },
    tls: { rejectUnauthorized: !imap.allowInsecureTls },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: 20_000,
  });
  c.on("error", () => undefined);
  await c.connect();
  try {
    const s = await c.status("INBOX", { messages: true, unseen: true });
    const folders = (await c.list()).map((f) => f.path);
    return { unread: (s && s.unseen) || 0, total: (s && s.messages) || 0, folders };
  } finally {
    await c.logout().catch(() => c.close());
  }
}

export async function verifySmtp(smtp: ImapServerConfig, email: string, password: string): Promise<void> {
  const t = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure && !smtp.allowInsecureTls,
    auth: { user: smtp.user || email, pass: password },
    tls: { rejectUnauthorized: !smtp.allowInsecureTls },
    connectionTimeout: 20_000,
  });
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

extraCommands["add-imap"] = {
  help: `  gmail-mcp-multi add-imap <alias> <email> --host <imap host> [...]
                                                  Connect an IMAP mailbox (e.g. Hetzner: --host mail.your-server.de);
                                                  asks for the password and checks it before saving`,
  run: async (argv) => {
    const args = [...argv];
    const host = takeFlag(args, "--host");
    const portFlag = takeFlag(args, "--port");
    const starttls = takeBool(args, "--starttls");
    const user = takeFlag(args, "--user");
    const smtpHost = takeFlag(args, "--smtp-host");
    const smtpPortFlag = takeFlag(args, "--smtp-port");
    const noSmtp = takeBool(args, "--no-smtp");
    const name = takeFlag(args, "--name");
    const signature = takeFlag(args, "--signature");
    const modeFlag = takeFlag(args, "--mode");
    const insecure = takeBool(args, "--allow-insecure-tls");
    const [alias, email] = args;
    if (!alias || !email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(USAGE);

    const accounts = new AccountManager();
    const existing = accounts.getAccount(alias);
    if (existing && (existing.type ?? "gmail") !== "imap") throw new Error(`"${alias}" is a Gmail account. Pick another alias for the IMAP mailbox.`);
    const prevImap = existing?.imap;
    const imapHost = host ?? prevImap?.host;
    if (!imapHost) {
      throw new Error(`Missing --host (the IMAP server).\n  Hetzner: --host mail.your-server.de\n  For Gmail addresses use "gmail-mcp-multi auth" instead.\n\n${USAGE}`);
    }
    const imapPort = Number(portFlag ?? prevImap?.port ?? (starttls ? 143 : 993));
    const imap: ImapServerConfig = {
      host: imapHost,
      port: imapPort,
      secure: starttls ? false : portFlag ? imapPort !== 143 : prevImap?.secure ?? true,
      ...(user ?? prevImap?.user ? { user: user ?? prevImap?.user } : {}),
      ...(insecure ? { allowInsecureTls: true } : {}),
    };
    let smtp: ImapServerConfig | undefined;
    if (!noSmtp) {
      const sp = Number(smtpPortFlag ?? existing?.smtp?.port ?? 465);
      smtp = {
        host: smtpHost ?? existing?.smtp?.host ?? imapHost,
        port: sp,
        secure: sp === 465,
        ...(imap.user ? { user: imap.user } : {}),
        ...(insecure ? { allowInsecureTls: true } : {}),
      };
    }

    const password = await readHidden(`Password for ${imap.user || email} at ${imap.host}: `);
    if (!password) throw new Error("No password given.");

    process.stderr.write(`Checking IMAP login at ${imap.host}:${imap.port}${imap.secure ? " (TLS)" : " (STARTTLS)"}... `);
    let status;
    try {
      status = await verifyImap(imap, email, password);
    } catch (err) {
      process.stderr.write("failed\n");
      const e = err as { authenticationFailed?: boolean; message?: string; code?: string };
      throw new Error(e.authenticationFailed ? "Login rejected: wrong password or login name (try --user with the full mailbox login)." : `Could not connect: ${e.code ?? ""} ${e.message ?? err}`);
    }
    process.stderr.write(`ok (INBOX: ${status.unread} unread / ${status.total})\n`);

    if (smtp) {
      process.stderr.write(`Checking SMTP login at ${smtp.host}:${smtp.port}... `);
      try {
        await verifySmtp(smtp, email, password);
        process.stderr.write("ok\n");
      } catch (err) {
        process.stderr.write(`failed (${(err as Error).message}); saved anyway. Sending (full mode only) will not work until SMTP is fixed.\n`);
      }
    }

    accounts.addAccount(alias, email, modeFlag ? parseMode(modeFlag) : undefined, {
      type: "imap",
      imap,
      ...(smtp ? { smtp } : {}),
      ...(name ? { displayName: name } : {}),
      ...(signature ? { signature } : {}),
    });
    if (noSmtp && existing?.smtp) accounts.updateAccount(alias, { smtp: undefined });
    accounts.saveCredentials(alias, { password });
    console.error(`Connected ${email} as "${alias}" (IMAP; password stored encrypted).`);
    console.error(`Folders: ${status.folders.join(", ")}`);
  },
};
