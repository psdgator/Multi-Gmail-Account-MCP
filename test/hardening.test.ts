import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountManager } from "../src/accounts.js";
import { htmlToText, isSavableFilename, MAX_HTML_CHARS, safeFilename } from "../src/message.js";
import { checkPath } from "../src/paths.js";
import { registerProviderFactory } from "../src/providers/registry.js";
import type { MailProvider } from "../src/providers/types.js";
import { createServer } from "../src/server.js";
import { localDayStart, zonedTime } from "../src/tools/calendar.js";
import { _test as cleanupTest } from "../src/tools/cleanup.js";
import { confirmWithUser, type ToolContext } from "../src/tools/common.js";

describe("path policy hardening", () => {
  let home: string;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GMAIL_MCP_HOME: process.env.GMAIL_MCP_HOME, GMAIL_MCP_ALLOWED_DIRS: process.env.GMAIL_MCP_ALLOWED_DIRS };
  beforeAll(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gmm-hard-")));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.GMAIL_MCP_HOME = path.join(home, ".gmail-mcp");
    delete process.env.GMAIL_MCP_ALLOWED_DIRS;
    for (const d of ["Documents", "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup", "Library/LaunchAgents", "Library/CloudStorage/Drive"]) {
      fs.mkdirSync(path.join(home, d), { recursive: true });
    }
    fs.writeFileSync(path.join(home, "Documents", "a.txt"), "x");
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const startup = () => path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "run.txt");

  it("allowing the home folder (or AppData itself) does not unblock startup folders", () => {
    for (const allowed of [home, path.join(home, "AppData"), path.join(home, "Library")]) {
      process.env.GMAIL_MCP_ALLOWED_DIRS = allowed;
      try {
        expect(() => checkPath(startup(), "write")).toThrow(/protected/);
        expect(() => checkPath(path.join(home, "Library", "LaunchAgents", "x.plist"), "write")).toThrow(/protected/);
      } finally {
        delete process.env.GMAIL_MCP_ALLOWED_DIRS;
      }
    }
  });

  it("the most specific allowed folder decides, whatever the order", () => {
    const temp = path.join(home, "AppData", "Local", "Temp", "jobs");
    fs.mkdirSync(temp, { recursive: true });
    for (const list of [[home, temp], [temp, home]]) {
      process.env.GMAIL_MCP_ALLOWED_DIRS = list.join(path.delimiter);
      try {
        expect(checkPath(path.join(temp, "a.pdf"), "write")).toBe(path.join(temp, "a.pdf"));
        expect(() => checkPath(startup(), "write")).toThrow(/protected/);
      } finally {
        delete process.env.GMAIL_MCP_ALLOWED_DIRS;
      }
    }
  });

  it("cloud-drive folders under ~/Library stay usable", () => {
    expect(checkPath(path.join(home, "Library", "CloudStorage", "Drive", "out.pdf"), "write")).toBe(path.join(home, "Library", "CloudStorage", "Drive", "out.pdf"));
  });

  it("refuses network and device paths in any slash mix", () => {
    for (const p of ["\\/evil/share/x", "/\\evil\\share\\x", "\\\\?\\UNC\\evil\\share\\x", "\\\\.\\pipe\\x", "//?/C:/x", "\\\\evil@SSL\\x"]) {
      expect(() => checkPath(p, "write"), p).toThrow(/UNC|device/);
    }
  });

  it("refuses to read a file with several hard links", () => {
    if (process.platform === "win32") return;
    const target = path.join(home, "Documents", "a.txt");
    const link = path.join(home, "Documents", "b.txt");
    fs.linkSync(target, link);
    expect(() => checkPath(link, "read")).toThrow(/hard links/);
    fs.unlinkSync(link);
    expect(checkPath(target, "read")).toBe(target);
  });
});

describe("attachment file names", () => {
  it("strips bidi/format characters and leading dots", () => {
    expect(safeFilename("invoice\u202Efdp.exe")).not.toMatch(/\u202E/);
    expect(safeFilename("..bashrc")).not.toMatch(/^\./);
    expect(safeFilename(" .profile")).not.toMatch(/^[ .]/);
  });

  it("shortening keeps the extension and can't leave a trailing dot or space", () => {
    for (const n of ["a".repeat(195) + ".exe.txt-padding", "a".repeat(196) + ".lnk xx", "b".repeat(300) + ".pdf"]) {
      const out = safeFilename(n);
      expect(out.length, n).toBeLessThanOrEqual(200);
      expect(out, n).not.toMatch(/[. ]$/);
    }
    expect(safeFilename("b".repeat(300) + ".pdf")).toMatch(/b\.pdf$/);
  });

  it("only saves documents, images, design files, media and plain archives", () => {
    for (const n of ["invoice.pdf", "photo.JPG", "notes.txt", "sheet.xlsx", "archive.zip", "logo.ai", "die-cut.svg", "part.stl", "print.3mf", "song.mp3"]) {
      expect(isSavableFilename(n), n).toBe(true);
    }
    for (const n of [
      "setup.exe", "invoice.pdf.exe", "run.BAT", "x.ps1", "a.lnk", "b.js", "c.msi", "d.command", "e.iso", "bashrc", "Microsoft.PowerShell_profile.ps1",
      "x.library-ms", "x.searchConnector-ms", "x.theme", "x.settingcontent-ms", "x.appref-ms", "x.website", "x.chm", "x.url", "x.docm", "x.xlsm",
      "x.webloc", "x.terminal", "x.mpkg", "x.html", "noextension", "x.cab", "x.one",
    ]) {
      expect(isSavableFilename(n), n).toBe(false);
    }
  });

  it("GMAIL_MCP_SAVE_EXTRA_TYPES adds types", () => {
    expect(isSavableFilename("plan.skp")).toBe(false);
    process.env.GMAIL_MCP_SAVE_EXTRA_TYPES = ".skp, dwf";
    try {
      expect(isSavableFilename("plan.skp")).toBe(true);
      expect(isSavableFilename("plan.dwf")).toBe(true);
    } finally {
      delete process.env.GMAIL_MCP_SAVE_EXTRA_TYPES;
    }
  });
});

describe("confirmWithUser fails closed", () => {
  const ctxWith = (caps: unknown, elicit: () => Promise<unknown>) =>
    ({ server: { server: { getClientCapabilities: () => ({ elicitation: caps }), elicitInput: elicit } } }) as unknown as ToolContext;

  it("reports unsupported when the client can't ask", async () => {
    expect(await confirmWithUser({} as ToolContext, "ok?")).toBe("unsupported");
    expect(await confirmWithUser(ctxWith(undefined, async () => ({})), "ok?")).toBe("unsupported");
    expect(await confirmWithUser(ctxWith({ url: {} }, async () => ({})), "ok?")).toBe("unsupported");
  });

  it("only an explicit yes counts", async () => {
    expect(await confirmWithUser(ctxWith({}, async () => ({ action: "accept", content: { confirm: true } })), "ok?")).toBe("accepted");
    expect(await confirmWithUser(ctxWith({ form: {} }, async () => ({ action: "accept", content: { confirm: false } })), "ok?")).toBe("declined");
    expect(await confirmWithUser(ctxWith({}, async () => ({ action: "accept" })), "ok?")).toBe("declined");
    expect(await confirmWithUser(ctxWith({}, async () => ({ action: "cancel" })), "ok?")).toBe("declined");
    expect(
      await confirmWithUser(
        ctxWith({}, async () => {
          throw new Error("timeout");
        }),
        "ok?"
      )
    ).toBe("declined");
  });
});

const DIST_EXTRACT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "extract", "index.js");

/**
 * Script that writes a tiny PDF whose page content is Flate-compressed twice and inflates to
 * `mb` MB, then reads it through the worker and reports the peak memory it saw. Everything
 * runs in a child process (Linux keeps a parent's peak RSS across fork, so the parent must
 * stay small, and the child samples its own RSS).
 */
const bombScript = (mb: number, file: string) => `
  import * as fs from "node:fs";
  import * as zlib from "node:zlib";
  const deflateStream = async (chunks) => {
    const out = []; const d = zlib.createDeflate({ level: 9 });
    d.on("data", (c) => out.push(c)); const done = new Promise((r) => d.on("end", r));
    for (const c of chunks()) if (!d.write(c)) await new Promise((r) => d.once("drain", r));
    d.end(); await done; return Buffer.concat(out);
  };
  const block = Buffer.alloc(1024 * 1024, 0x20);
  const once = await deflateStream(function* () {
    yield Buffer.from("BT /F1 24 Tf 72 720 Td (BOMB) Tj ET\\n");
    for (let i = 0; i < ${mb}; i++) yield block;
  });
  const data = await deflateStream(function* () { yield once; });
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>"];
  const parts = [Buffer.from("%PDF-1.7\\n")]; const offsets = []; let pos = parts[0].length;
  const push = (b) => { parts.push(b); pos += b.length; };
  objs.forEach((o, i) => { offsets.push(pos); push(Buffer.from((i + 1) + " 0 obj\\n" + o + "\\nendobj\\n")); });
  offsets.push(pos);
  push(Buffer.from("4 0 obj\\n<< /Length " + data.length + " /Filter [/FlateDecode /FlateDecode] >>\\nstream\\n")); push(data); push(Buffer.from("\\nendstream\\nendobj\\n"));
  const xref = pos;
  push(Buffer.from("xref\\n0 5\\n0000000000 65535 f \\n" + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \\n").join("") + "trailer\\n<< /Size 5 /Root 1 0 R >>\\nstartxref\\n" + xref + "\\n%%EOF\\n"));
  const pdf = Buffer.concat(parts);
  const { extractAttachment } = await import(${JSON.stringify(pathToFileURL(DIST_EXTRACT).href)});
  if (global.gc) global.gc();
  const base = process.memoryUsage.rss(); let peak = base;
  const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 5);
  const r = await extractAttachment(pdf, "bomb.pdf", "application/pdf");
  clearInterval(iv);
  process.stderr.write(JSON.stringify({ kind: r.kind, note: r.note, pdfBytes: pdf.length, growthMb: Math.round((peak - base) / 1048576) }) + "\\n");
`;

describe("decompression bombs", () => {
  it.runIf(fs.existsSync(DIST_EXTRACT))("a tiny PDF that inflates to 1 GB is stopped well before that", () => {
    const runner = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gmm-bomb-")), "run.mjs"); // a file, not -e: workers inherit execArgv
    fs.writeFileSync(runner, bombScript(1024, runner));
    const child = spawnSync(process.execPath, ["--expose-gc", runner], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, GMAIL_MCP_EXTRACT_MEMORY_MB: "64", GMAIL_MCP_EXTRACT_TIMEOUT_MS: "60000" },
    });
    expect(child.status, child.stderr).toBe(0);
    const r = JSON.parse(child.stderr.trim().split("\n").pop()!);
    expect(r.pdfBytes).toBeLessThan(64 * 1024);
    expect(r.kind).toBe("unsupported");
    expect(r.note).toMatch(/memory limit 64 MB/);
    // Budget: 64 MB × 1.5 + 128 MB of growth, plus a little overshoot.
    expect(r.growthMb).toBeLessThan(400);
  }, 150_000);
});

describe("DST-safe day boundaries", () => {
  const local = (d: Date, tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

  it("a skipped time moves forward, a repeated one takes the earlier instant", () => {
    expect(local(zonedTime(2026, 3, 29, 3, 30, "Europe/Athens"), "Europe/Athens")).toBe("2026-03-29, 04:30");
    expect(local(zonedTime(2026, 3, 8, 2, 30, "America/New_York"), "America/New_York")).toBe("2026-03-08, 03:30");
    expect(zonedTime(2026, 11, 1, 1, 30, "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z"); // EDT, the first 01:30
  });

  it("days start at the first instant of the day, even when midnight doesn't exist", () => {
    for (const [tz, y, m, d] of [
      ["America/Santiago", 2026, 9, 6],
      ["America/Havana", 2026, 3, 8],
      ["Asia/Beirut", 2026, 3, 29],
      ["Europe/Athens", 2026, 3, 29],
      ["Australia/Lord_Howe", 2026, 10, 4],
    ] as const) {
      const start = zonedTime(y, m, d, 0, 0, tz);
      const prevEnd = localDayStart(new Date(start.getTime() - 3_600_000 * 12), 1, tz);
      expect(prevEnd.getTime(), `${tz}`).toBe(start.getTime());
      // The instant just before the day start belongs to the previous calendar day.
      expect(local(new Date(start.getTime() - 60_000), tz).slice(0, 10), tz).not.toBe(local(start, tz).slice(0, 10));
      expect(local(start, tz).slice(0, 10), tz).toBe(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      const next = localDayStart(start, 1, tz);
      expect(local(next, tz).slice(0, 10), tz).not.toBe(local(start, tz).slice(0, 10));
      expect(local(new Date(next.getTime() - 60_000), tz).slice(0, 10), tz).toBe(local(start, tz).slice(0, 10));
    }
  });
});

describe("bulk_cleanup refuses vague searches", () => {
  it("no terms, or an empty group, whatever the mailbox", () => {
    for (const q of ["-", "OR", " ", "\u200b", "()", "in:inbox -()", 'in:inbox -("")', "-(x OR ())", "from:", "OR OR", "-{}", '""']) {
      expect(cleanupTest.vagueQuery(q), JSON.stringify(q)).toBeDefined();
    }
    for (const q of ["in:inbox", "from:a@b.example older_than:30d", "category:promotions", "subject:(a b)", "older_than:1y -is:starred"]) {
      expect(cleanupTest.vagueQuery(q), q).toBeUndefined();
    }
  });
});

describe("unsubscribe address checks (round 3)", () => {
  it("SIIT and private IPv4 behind NAT64/6to4 are refused; public ones behind them are allowed", () => {
    for (const ip of ["::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b:1::808:808", "2002:c0a8:101::1", "2002:7f00:1::"]) {
      expect(cleanupTest.isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["64:ff9b::808:808", "2002:808:808::1", "2606:4700::1111"]) expect(cleanupTest.isPrivateIp(ip), ip).toBe(false);
  });
});

describe("HTML bodies", () => {
  it("very large HTML is cut before conversion", () => {
    const html = "<p>hello world</p>".repeat(Math.ceil((MAX_HTML_CHARS * 1.5) / 18));
    const t0 = Date.now();
    const text = htmlToText(html);
    expect(text).toMatch(/only the first part was converted/);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);

  it("normal HTML is unchanged", () => {
    expect(htmlToText("<h1>Hi</h1><p>there</p>")).toBe("Hi\n\nthere");
  });
});

describe("send_draft", () => {
  it("does not send the same draft twice when called concurrently", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-send-"));
    const accounts = new AccountManager(root);
    accounts.addAccount("box", "me@box.example", undefined, { type: "imap", imap: { host: "imap.example", port: 993, secure: true } });
    accounts.saveCredentials("box", { password: "x" });
    let sends = 0;
    const stub = {
      kind: "imap",
      account: accounts.requireAccount("box"),
      capabilities: { labels: false, filters: false, calendar: false, send: true },
      explain: (e: unknown) => e as Error,
      sendDraft: async () => {
        sends++;
        await new Promise((r) => setTimeout(r, 50));
        return { messageId: "<m@x>" };
      },
    } as unknown as MailProvider;
    registerProviderFactory("imap", () => stub);
    const { server } = createServer("full", { accounts });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const call = () => client.callTool({ name: "send_draft", arguments: { account: "box", draftId: "d1" } }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
    const [r1, r2] = await Promise.all([call(), call()]);
    expect(sends).toBe(1);
    expect([r1.isError, r2.isError].filter(Boolean)).toHaveLength(1);
    expect((r1.isError ? r1 : r2).content[0].text).toMatch(/already being sent/);
    // Once finished, the lock is released.
    const r3 = await call();
    expect(r3.isError).toBeFalsy();
    expect(sends).toBe(2);
    await client.close();
  });
});
