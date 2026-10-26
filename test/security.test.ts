import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPath } from "../src/paths.js";
import { splitAddresses } from "../src/mime.js";
import { _test } from "../src/tools/cleanup.js";

describe("file path policy", () => {
  let home: string;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GMAIL_MCP_HOME: process.env.GMAIL_MCP_HOME, GMAIL_MCP_ALLOWED_DIRS: process.env.GMAIL_MCP_ALLOWED_DIRS };
  beforeAll(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gmm-home-")));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.GMAIL_MCP_HOME = path.join(home, ".gmail-mcp");
    delete process.env.GMAIL_MCP_ALLOWED_DIRS;
    for (const d of ["Documents", ".ssh", ".gmail-mcp", "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup", "Library/LaunchAgents"]) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.writeFileSync(path.join(home, "Documents", "offer.pdf"), "%PDF");
    fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "secret");
    fs.writeFileSync(path.join(home, ".gmail-mcp", "master.key"), "k");
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("allows normal files and folders under home", () => {
    expect(checkPath(path.join(home, "Documents", "offer.pdf"), "read")).toBe(path.join(home, "Documents", "offer.pdf"));
    expect(checkPath(path.join(home, "Downloads", "gmail-mcp"), "write")).toBe(path.join(home, "Downloads", "gmail-mcp"));
    expect(checkPath("~/Documents/offer.pdf", "read")).toBe(path.join(home, "Documents", "offer.pdf"));
  });

  it("refuses secrets, config, startup folders, outside paths and UNC", () => {
    expect(() => checkPath(path.join(home, ".ssh", "id_rsa"), "read")).toThrow(/hidden/);
    expect(() => checkPath(path.join(home, ".gmail-mcp", "master.key"), "read")).toThrow(/protected|hidden/);
    expect(() => checkPath(path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"), "write")).toThrow(/protected/);
    expect(() => checkPath(path.join(home, "Library", "LaunchAgents"), "write")).toThrow(/protected/);
    expect(() => checkPath(path.join(home, "Documents", "..", "..", "etc"), "write")).toThrow(/outside/);
    expect(() => checkPath("\\\\evil-server\\share\\x", "write")).toThrow(/UNC/);
    expect(() => checkPath("//evil-server/share/x", "read")).toThrow(/UNC/);
    if (process.platform !== "win32") expect(() => checkPath("/proc/self/environ", "read")).toThrow();
  });

  it("follows symlinks before checking", () => {
    if (process.platform === "win32") return;
    const link = path.join(home, "Documents", "innocent.pdf");
    fs.symlinkSync(path.join(home, ".ssh", "id_rsa"), link);
    expect(() => checkPath(link, "read")).toThrow(/hidden/);
  });

  it("an explicitly allowed folder inside AppData works, but hidden/config stay blocked", () => {
    const work = path.join(home, "AppData", "Local", "Temp", "jobs");
    fs.mkdirSync(path.join(work, ".secret"), { recursive: true });
    fs.writeFileSync(path.join(work, "a.pdf"), "x");
    fs.writeFileSync(path.join(work, ".secret", "k"), "x");
    expect(() => checkPath(path.join(work, "a.pdf"), "read")).toThrow(/protected/);
    process.env.GMAIL_MCP_ALLOWED_DIRS = work;
    try {
      expect(checkPath(path.join(work, "a.pdf"), "read")).toBe(path.join(work, "a.pdf"));
      expect(() => checkPath(path.join(work, ".secret", "k"), "read")).toThrow(/hidden/);
      expect(() => checkPath(path.join(home, "AppData", "Roaming", "x"), "write")).toThrow(/protected/);
    } finally {
      delete process.env.GMAIL_MCP_ALLOWED_DIRS;
    }
  });

  it("GMAIL_MCP_ALLOWED_DIRS adds folders outside home", () => {
    const extra = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gmm-extra-")));
    fs.writeFileSync(path.join(extra, "a.txt"), "x");
    expect(() => checkPath(path.join(extra, "a.txt"), "read")).toThrow(/outside/);
    process.env.GMAIL_MCP_ALLOWED_DIRS = extra;
    expect(checkPath(path.join(extra, "a.txt"), "read")).toBe(path.join(extra, "a.txt"));
    delete process.env.GMAIL_MCP_ALLOWED_DIRS;
  });
});

describe("address handling", () => {
  it("drops RFC 5322 group syntax instead of failing", () => {
    expect(splitAddresses("undisclosed-recipients:;")).toEqual([]);
    expect(splitAddresses("Team: a@x.gr, B <b@y.gr>;, c@z.gr")).toEqual(["a@x.gr", "B <b@y.gr>", "c@z.gr"]);
  });
});

describe("unsubscribe network safety", () => {
  it("blocks NAT64, 6to4 and Teredo too", () => {
    for (const ip of ["64:ff9b::a00:1", "2002:c0a8:101::1", "2001:0:4136:e378::1", "ff02::1"]) expect(_test.isPrivateIp(ip)).toBe(true);
  });
  it("sees through IPv4-mapped/compatible IPv6 in every notation, and reserved v4 ranges", () => {
    for (const ip of ["::ffff:7f00:1", "[::ffff:7f00:1]", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "::ffff:c0a8:101", "::7f00:1", "::127.0.0.1", "fec0::1", "198.18.0.1", "192.0.0.8", "0:0:0:0:0:ffff:0a00:0001"])
      expect(_test.isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "2a00:1450:4001:80b::200e", "1.1.1.1"]) expect(_test.isPrivateIp(ip), ip).toBe(false);
  });
});
