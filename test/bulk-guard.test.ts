import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AccountManager } from "../src/accounts.js";
import { registerProviderFactory } from "../src/providers/registry.js";
import type { MailProvider } from "../src/providers/types.js";
import { createServer } from "../src/server.js";

describe("bulk_cleanup guard", () => {
  it("refuses when the mailbox could not apply the whole query", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmm-guard-"));
    const accounts = new AccountManager(root);
    accounts.addAccount("box", "me@box.example", undefined, { type: "imap", imap: { host: "imap.example", port: 993, secure: true } });
    accounts.saveCredentials("box", { password: "x" });
    const modified: string[][] = [];
    const stub = {
      kind: "imap",
      account: accounts.requireAccount("box"),
      capabilities: { labels: false, filters: false, calendar: false, send: false },
      explain: (e: unknown) => e as Error,
      search: async () => ({ messages: [{ account: "box", id: "INBOX:1", threadId: "t", date: "", from: "", to: "", subject: "", labels: [], unread: false, starred: false }], ignored: ["category:promotions"] }),
      modify: async (ids: string[]) => {
        modified.push(ids);
        return { added: [], removed: [] };
      },
    } as unknown as MailProvider;
    registerProviderFactory("imap", () => stub);
    const { server } = createServer("drafts", { accounts });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const res = (await client.callTool({ name: "bulk_cleanup", arguments: { account: "box", query: "category:promotions older_than:30d", action: "archive" } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/can't be applied exactly.*category:promotions/);
    expect(modified).toHaveLength(0);
    await client.close();
  });
});
