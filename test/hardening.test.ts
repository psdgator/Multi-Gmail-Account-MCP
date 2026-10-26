import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountManager } from "../src/accounts.js";
import { extractInProcess } from "../src/extract/index.js";
import { assertPdfExpansionOk, PdfTooLargeError } from "../src/extract/pdf.js";
import { htmlToText, isRiskyFilename, MAX_HTML_CHARS, safeFilename } from "../src/message.js";
import { checkPath } from "../src/paths.js";
import { registerProviderFactory } from "../src/providers/registry.js";
import type { MailProvider } from "../src/providers/types.js";
import { createServer } from "../src/server.js";
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

  it("flags programs, scripts, shortcuts and shell profiles", () => {
    for (const n of ["setup.exe", "invoice.pdf.exe", "run.BAT", "x.ps1", "a.lnk", "b.js", "c.msi", "d.command", "e.iso", "bashrc", "zshrc", "Microsoft.PowerShell_profile.ps1"]) {
      expect(isRiskyFilename(n), n).toBe(true);
    }
    for (const n of ["invoice.pdf", "photo.jpg", "notes.txt", "sheet.xlsx", "archive.zip", "profile.pdf"]) {
      expect(isRiskyFilename(n), n).toBe(false);
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

function pdfWithFlateStream(compressed: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    compressed,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n", "latin1"),
  ]);
}

async function deflateZeros(totalBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const d = zlib.createDeflate({ level: 9 });
  d.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise((r) => d.on("end", r));
  const block = Buffer.alloc(1024 * 1024);
  for (let left = totalBytes; left > 0; left -= block.length) {
    if (!d.write(left >= block.length ? block : block.subarray(0, left))) await new Promise((r) => d.once("drain", r));
  }
  d.end();
  await done;
  return Buffer.concat(chunks);
}

describe("PDF decompression bombs", () => {
  it("measures FlateDecode streams against a budget", async () => {
    const pdf = pdfWithFlateStream(zlib.deflateSync(Buffer.alloc(4 * 1024 * 1024)));
    expect(() => assertPdfExpansionOk(pdf, 1024 * 1024)).toThrow(PdfTooLargeError);
    expect(() => assertPdfExpansionOk(pdf, 8 * 1024 * 1024)).not.toThrow();
  });

  it("refuses a PDF that inflates past the default budget before parsing it", async () => {
    const pdf = pdfWithFlateStream(await deflateZeros(300 * 1024 * 1024));
    expect(pdf.length).toBeLessThan(2 * 1024 * 1024);
    const r = await extractInProcess(pdf, "bomb.pdf", "application/pdf");
    expect(r.kind).toBe("unsupported");
    expect(r.note).toMatch(/expands to more than/);
  }, 30_000);
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
