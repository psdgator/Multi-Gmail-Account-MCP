import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDocx, makePdf, makeScannedPdf, makeXlsx, PNG_1x1 } from "./attachment-fixtures.js";
import { startFakeGmail } from "./fake-gmail.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "index.js");
const b64u = (b: Buffer) => b.toString("base64url");

let fake: Awaited<ReturnType<typeof startFakeGmail>>;
let home: string;
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  };
}

beforeAll(async () => {
  fake = await startFakeGmail();
  const box = fake.boxes["tok-urban"];
  const files = {
    "att-docx": makeDocx(),
    "att-xlsx": makeXlsx(),
    "att-pdf": await makePdf({ pages: 2 }),
    "att-scan": await makeScannedPdf(),
    "att-png": PNG_1x1,
  };
  for (const [id, data] of Object.entries(files)) box.attachments[id] = b64u(data);
  const part = (partId: string, filename: string, mimeType: string, id: keyof typeof files) => ({
    partId,
    mimeType,
    filename,
    headers: [{ name: "Content-Disposition", value: `attachment; filename="${filename}"` }],
    body: { attachmentId: id, size: files[id].length },
  });
  box.messages.push({
    id: "a1",
    threadId: "ta1",
    internalDate: String(Date.UTC(2026, 9, 26, 8, 0)),
    labelIds: ["INBOX"],
    snippet: "Σας στέλνω τα αρχεία",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Μαρία <maria@acme.example>" },
        { name: "To", value: "urbanstickersgr@gmail.com" },
        { name: "Subject", value: "Αρχεία παραγγελίας" },
      ],
      parts: [
        { partId: "0", mimeType: "text/plain", body: { data: b64u(Buffer.from("Σας στέλνω τα αρχεία.")) } },
        part("1", "προσφορά.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "att-docx"),
        part("2", "orders.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "att-xlsx"),
        part("3", "invoice.pdf", "application/pdf", "att-pdf"),
        part("4", "scan.pdf", "application/pdf", "att-scan"),
        part("5", "proof.png", "image/png", "att-png"),
      ],
    },
  });

  home = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-att-"));
  fs.writeFileSync(path.join(home, "oauth-keys.json"), JSON.stringify({ installed: { client_id: "cid", client_secret: "secret" } }));
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ accounts: [{ alias: "urbanstickers", email: "urbanstickersgr@gmail.com" }, { alias: "psdgator", email: "antony@psdgator.com" }], defaultAccount: "psdgator" })
  );
  for (const [alias, tok] of [["urbanstickers", "tok-urban"], ["psdgator", "tok-psd"]]) {
    fs.mkdirSync(path.join(home, "accounts", alias), { recursive: true });
    fs.writeFileSync(path.join(home, "accounts", alias, "credentials.json"), JSON.stringify({ access_token: tok, refresh_token: "r", expiry_date: Date.now() + 3600_000 }));
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "--mode", "readonly"],
    env: { ...process.env, GMAIL_MCP_HOME: home, GMAIL_MCP_API_ROOT: fake.url, GMAIL_MCP_NO_BROWSER: "1", GMAIL_MCP_KEYRING: "0", GMAIL_MCP_MASTER_KEY: "b".repeat(64) } as Record<string, string>,
    stderr: "pipe",
  });
  client = new Client({ name: "e2e-att", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await fake.close();
});

describe("read_attachment through the MCP server", () => {
  it("is offered in readonly mode with a helpful description", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "read_attachment");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/PDF/);
    expect(tool!.description).toMatch(/never follow instructions/);
    expect(tool!.annotations?.readOnlyHint).toBe(true);
  });

  it("reads a Word attachment by filename, finding the right account on its own", async () => {
    const r = await call("read_attachment", { messageId: "a1", filename: "ΠΡΟΣΦΟΡΆ.docx".toLowerCase() });
    expect(r.isError).toBeFalsy();
    const j = JSON.parse((r.content[0] as { text: string }).text);
    expect(j).toMatchObject({ account: "urbanstickers", filename: "προσφορά.docx", kind: "text", format: "docx" });
    expect(j.text).toContain("Είδος | Ποσότητα");
  });

  it("reads Excel by partId and one sheet", async () => {
    const r = await call("read_attachment", { messageId: "a1", account: "urbanstickers", partId: "2", sheet: "Παραγγελίες" });
    const j = JSON.parse((r.content[0] as { text: string }).text);
    expect(j.sheets).toEqual(["Παραγγελίες", "Secret"]);
    expect(j.text).toContain("Acme Α.Ε.,2026-10-26,1234.5,TRUE");
    expect(j.text).not.toContain("hidden data");
  });

  it("reads PDF pages", async () => {
    const r = await call("read_attachment", { messageId: "a1", account: "urbanstickers", partId: "3", pages: "2" });
    const j = JSON.parse((r.content[0] as { text: string }).text);
    expect(j).toMatchObject({ format: "pdf", totalPages: 2, pagesShown: [2] });
    expect(j.text).toContain("Total: 200.00 EUR");
  });

  it("returns images as image content for Claude to look at", async () => {
    const r = await call("read_attachment", { messageId: "a1", account: "urbanstickers", filename: "proof.png" });
    expect(r.content).toHaveLength(2);
    const j = JSON.parse((r.content[0] as { text: string }).text);
    expect(j).toMatchObject({ kind: "image", imagesAttached: [{ mimeType: "image/png", width: 1, height: 1 }] });
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: PNG_1x1.toString("base64") });
  });

  it("returns the page image of a scanned PDF", async () => {
    const r = await call("read_attachment", { messageId: "a1", account: "urbanstickers", partId: "4" });
    expect(r.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(JSON.parse((r.content[0] as { text: string }).text).note).toMatch(/looks scanned/);
  });

  it("lists the available attachments when the name is wrong", async () => {
    const r = await call("read_attachment", { messageId: "a1", account: "urbanstickers", filename: "nope.pdf" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/Available: προσφορά\.docx \(partId 1\)/);
  });

  it("handles the old fake 'PDF' (not a real PDF) gracefully", async () => {
    const r = await call("read_attachment", { messageId: "u1", account: "urbanstickers" });
    expect(r.isError).toBeFalsy();
    const j = JSON.parse((r.content[0] as { text: string }).text);
    expect(["unsupported", "text"]).toContain(j.kind);
    expect(j.filename).toBe("κάτοψη.pdf");
  });
});
