import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { extractInProcess } from "../src/extract/index.js";
import { odsText, wordXmlToText } from "../src/extract/office.js";
import { embeddedJpegs } from "../src/extract/pdf.js";
import { rtfToText } from "../src/extract/rtf.js";
import { tidyText } from "../src/extract/text.js";
import { xmlTokens } from "../src/extract/xml.js";
import { makeScannedPdf } from "./attachment-fixtures.js";

/** Hostile inputs must stay fast (linear time) and bounded in memory. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_INDEX = path.join(ROOT, "dist", "extract", "index.js");

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
}

const docx = (documentXml: string) =>
  Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(documentXml) }));

describe("linear-time XML tokenizer", () => {
  const hostile: Record<string, string> = {
    "unclosed tags": "<a ".repeat(20000),
    "unclosed tags with names": "<w:t ".repeat(20000),
    "unterminated quotes": '<a x="'.repeat(20000),
    "quotes containing tags": '<a x="<a x="'.repeat(10000) + ">",
    "unterminated comments": "<!--".repeat(20000),
    "unterminated CDATA": "<![CDATA[".repeat(20000),
    "processing instructions": "<?".repeat(20000),
    "declarations": "<!x".repeat(20000),
    "closing tags without end": "</a".repeat(20000),
    "lone angle brackets": "<".repeat(100000),
  };
  for (const [label, xml] of Object.entries(hostile)) {
    it(`stays fast on ${label}`, () => {
      const { ms } = timed(() => {
        let n = 0;
        for (const _ of xmlTokens(xml)) n++;
        return n;
      });
      expect(ms).toBeLessThan(1000);
    });
  }

  it("a hostile .docx (20k unclosed tags) reads in well under a second", async () => {
    const t = performance.now();
    const r = await extractInProcess(docx(`<w:document><w:body>${"<a ".repeat(20000)}<w:p><w:r><w:t>ok</w:t></w:r></w:p></w:body></w:document>`), "x.docx", "");
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.kind).toBe("text");
    expect(r.text).toContain("ok");
  });

  it("keeps the normal token stream unchanged", () => {
    const toks = [...xmlTokens('<?xml version="1.0"?><!DOCTYPE x><a b="1>2" c=\'q\'>x &amp; y<![CDATA[<raw>]]><!-- c --><br/><e f="g" /></a>')];
    expect(toks).toEqual([
      { type: "open", name: "a", attrs: ' b="1>2" c=\'q\'' },
      { type: "text", text: "x & y" },
      { type: "text", text: "<raw>" },
      { type: "self", name: "br", attrs: "" },
      { type: "self", name: "e", attrs: ' f="g" ' },
      { type: "close", name: "a" },
    ]);
  });

  it("treats a tag interrupted by \"<\" as text", () => {
    const toks = [...xmlTokens("<a <b>text</b>")];
    expect(toks).toEqual([
      { type: "text", text: "a " },
      { type: "open", name: "b", attrs: "" },
      { type: "text", text: "text" },
      { type: "close", name: "b" },
    ]);
  });
});

describe("other extractors stay linear", () => {
  it("scanned-PDF image scan with thousands of markers", () => {
    const enc = new TextEncoder();
    const variants = [
      "%PDF-1.4\n" + "x".repeat(1000) + "/DCTDecode ".repeat(50000),
      "%PDF-1.4\n" + "1 0 obj << /Subtype /Image /Filter /DCTDecode >> stream\n".repeat(20000),
      "%PDF-1.4\n" + "obj /DCTDecode stream ".repeat(20000) + "endstream ".repeat(50000),
    ];
    for (const v of variants) {
      const { ms } = timed(() => embeddedJpegs(enc.encode(v)));
      expect(ms).toBeLessThan(1500);
    }
  });

  it("still finds the page image of a real scanned PDF", async () => {
    const jpegs = embeddedJpegs(await makeScannedPdf());
    expect(jpegs).toHaveLength(1);
    expect(jpegs[0]).toMatchObject({ width: 16, height: 12 });
    expect(jpegs[0].data[jpegs[0].data.length - 2]).toBe(0xff);
    expect(jpegs[0].data[jpegs[0].data.length - 1]).toBe(0xd9);
  });

  it("long runs of spaces (RTF, Word cells, tidy)", () => {
    const spaces = " ".repeat(300000);
    expect(timed(() => rtfToText(`{\\rtf1 ${spaces}x}`)).ms).toBeLessThan(1000);
    expect(timed(() => tidyText(`${spaces}x${spaces}\n${"\t".repeat(300000)}y`)).ms).toBeLessThan(1000);
    const cell = `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a${spaces}</w:t></w:r></w:p><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const { value, ms } = timed(() => wordXmlToText(cell));
    expect(ms).toBeLessThan(1000);
    expect(value).toBe("a / b");
  });

  it("tidyText keeps the old behaviour", () => {
    expect(tidyText("  a  \t\nb\n\n\n\nc  ")).toBe("a\nb\n\nc");
  });
});

describe("OpenDocument spreadsheet caps", () => {
  it("a few KB of repeat attributes can't expand into millions of cells", () => {
    const sheet = (i: number) =>
      `<table:table table:name="S${i}"><table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="100000" office:value="1"/><table:table-cell table:number-columns-repeated="100000"><text:p>v</text:p></table:table-cell></table:table-row></table:table>`;
    const xml = `<office:document-content><office:body><office:spreadsheet>${Array.from({ length: 2000 }, (_, i) => sheet(i)).join("")}</office:spreadsheet></office:body></office:document-content>`;
    expect(xml.length).toBeLessThan(600_000);
    const { value, ms } = timed(() => odsText({ "content.xml": strToU8(xml) }));
    expect(ms).toBeLessThan(5000);
    expect(value.text.length).toBeLessThan(6_000_000);
    const firstRow = value.text.split("\n")[1];
    expect(firstRow.split(",").length).toBeLessThanOrEqual(500);
    expect(value.notes.join(" ")).toMatch(/too large to show completely/);
  });
});

describe("worker isolation (compiled build)", () => {
  const haveDist = fs.existsSync(DIST_INDEX) && fs.existsSync(path.join(ROOT, "dist", "extract", "worker.js"));
  const load = async () => (await import(pathToFileURL(DIST_INDEX).href)) as typeof import("../src/extract/index.js");
  afterEach(() => {
    delete process.env.GMAIL_MCP_EXTRACT_TIMEOUT_MS;
    delete process.env.GMAIL_MCP_EXTRACT_MEMORY_MB;
  });

  it.runIf(haveDist)("reads files in a worker thread", async () => {
    const { extractAttachment } = await load();
    const r = await extractAttachment(Buffer.from("Γεια σου, κόσμε"), "a.txt", "text/plain; charset=utf-8");
    expect(r).toMatchObject({ kind: "text", text: "Γεια σου, κόσμε" });
  });

  it.runIf(haveDist)("stops a slow extraction at the time limit", async () => {
    const { extractAttachment } = await load();
    process.env.GMAIL_MCP_EXTRACT_TIMEOUT_MS = "1";
    const r = await extractAttachment(Buffer.from("hello"), "a.txt", "text/plain");
    expect(r.kind).toBe("unsupported");
    expect(r.note).toMatch(/took longer than 1 ms and was stopped/);
  });

  it.runIf(haveDist)("stops an extraction that exceeds the memory cap", async () => {
    const { extractAttachment } = await load();
    process.env.GMAIL_MCP_EXTRACT_MEMORY_MB = "32";
    const files = {
      "[Content_Types].xml": strToU8("<Types/>"),
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      "xl/sharedStrings.xml": strToU8(`<sst>${"<si><t>x</t></si>".repeat(1_300_000)}</sst>`),
      "xl/worksheets/sheet1.xml": strToU8("<worksheet><sheetData/></worksheet>"),
    };
    const r = await extractAttachment(zipSync(files), "big.xlsx", "");
    expect(r.kind).toBe("unsupported");
    expect(r.note).toMatch(/memory limit 32 MB/);
  }, 30000);

  it.runIf(haveDist)("nothing reaches stdout (MCP stdio safety)", () => {
    const script = `
      const { extractAttachment } = await import(${JSON.stringify(pathToFileURL(DIST_INDEX).href)});
      await extractAttachment(Buffer.from("%PDF-1.4\\n1 0 obj << /Type /Catalog >> endobj\\ntrailer << /Root 1 0 R >>\\n%%EOF"), "broken.pdf", "application/pdf");
      await extractAttachment(Buffer.from("%PDF-1.7\\n garbage garbage"), "bad.pdf", "application/pdf");
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60000 });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("");
  });
});
