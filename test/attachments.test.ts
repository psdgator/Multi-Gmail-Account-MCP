import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractAttachment } from "../src/extract/index.js";
import { imageSize } from "../src/extract/image.js";
import { parsePageRange } from "../src/extract/pdf.js";
import { rtfToText } from "../src/extract/rtf.js";
import { decodeText } from "../src/extract/text.js";
import { attr, decodeXmlEntities } from "../src/extract/xml.js";
import {
  encode1253,
  greekFont,
  JPEG_16x12,
  makeDocx,
  makeOds,
  makeOdt,
  makePdf,
  makePptx,
  makeScannedPdf,
  makeXlsx,
  makeZip,
  PNG_1x1,
} from "./attachment-fixtures.js";

describe("PDF", () => {
  it("extracts text page by page and honours page ranges", async () => {
    const pdf = await makePdf({ pages: 3 });
    const all = await extractAttachment(pdf, "invoice.pdf", "application/pdf");
    expect(all).toMatchObject({ kind: "text", format: "pdf", totalPages: 3, pagesShown: [1, 2, 3], truncated: false });
    expect(all.text).toContain("--- Page 1 ---\nInvoice INV-2026-1");
    expect(all.text).toContain("Total: 300.00 EUR");
    const some = await extractAttachment(pdf, "invoice.pdf", "application/pdf", { pages: "2-" });
    expect(some.pagesShown).toEqual([2, 3]);
    expect(some.text).not.toContain("INV-2026-1\n");
  });

  it("reads Greek text when a Unicode font is embedded", async () => {
    if (!greekFont()) return; // no system font with Greek glyphs on this machine
    const r = await extractAttachment(await makePdf({ greek: true, pages: 1 }), "τιμολόγιο.pdf", "application/pdf");
    expect(r.text).toContain("Τιμολόγιο για UrbanStickers");
  });

  it("returns page images for scanned PDFs", async () => {
    const r = await extractAttachment(await makeScannedPdf(), "scan.pdf", "application/pdf");
    expect(r.kind).toBe("text");
    expect(r.note).toMatch(/looks scanned/);
    expect(r.images).toHaveLength(1);
    expect(r.images![0]).toMatchObject({ mimeType: "image/jpeg", width: 16, height: 12 });
    expect(Buffer.from(r.images![0].base64, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("stops early for long PDFs and says how to continue", async () => {
    const r = await extractAttachment(await makePdf({ pages: 40 }), "long.pdf", "application/pdf", { maxChars: 500 });
    expect(r.truncated).toBe(true);
    expect(r.note).toMatch(/pages/);
    expect(r.text!.length).toBeLessThanOrEqual(500);
  });

  it("parses page ranges", () => {
    expect([...parsePageRange("1-3, 5", 10)!]).toEqual([1, 2, 3, 5]);
    expect([...parsePageRange("8-", 10)!]).toEqual([8, 9, 10]);
    expect(parsePageRange(undefined, 10)).toBeUndefined();
    expect(() => parsePageRange("abc", 10)).toThrow(/Invalid page range/);
  });

  it("does not print to stdout while parsing (MCP stdio safety)", async () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: unknown }).write = (chunk: string) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await extractAttachment(Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF"), "broken.pdf", "application/pdf");
    } finally {
      (process.stdout as unknown as { write: unknown }).write = orig;
    }
    expect(writes.join("")).toBe("");
  });
});

describe("Office and OpenDocument", () => {
  it("Word: paragraphs, tabs, breaks, tables, footers; skips deleted text and field codes", async () => {
    const r = await extractAttachment(makeDocx(), "προσφορά.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(r).toMatchObject({ kind: "text", format: "docx" });
    expect(r.text).toContain("Προσφορά για αυτοκόλλητα βιτρίνας");
    expect(r.text).toContain("Τιμή:\t120 & ΦΠΑ\nLine two");
    expect(r.text).toContain("Είδος | Ποσότητα\nΒινύλιο / ματ | 3");
    expect(r.text).toContain("--- Footer ---\nUrbanStickers, Θεσσαλονίκη");
    expect(r.text).not.toContain("deleted text");
    expect(r.text).not.toContain("PAGE");
  });

  it("Excel: sheets as CSV with shared/inline strings, dates, booleans, formulas, gaps, hidden sheets", async () => {
    const r = await extractAttachment(makeXlsx(), "orders.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(r.sheets).toEqual(["Παραγγελίες", "Secret"]);
    expect(r.text).toContain('=== Sheet: Παραγγελίες ===\nΠελάτης,,"Ποσό, € ""τελικό"""');
    expect(r.text).toContain("Acme Α.Ε.,2026-10-26,1234.5,TRUE");
    expect(r.text).toContain("Inline ✓,2026-01-02,Πελάτηςx");
    expect(r.text).not.toContain("phonetic");
    expect(r.text).toContain("=== Sheet: Secret (hidden) ===\nhidden data");
    const one = await extractAttachment(makeXlsx(), "orders.xlsx", "", { sheet: "secret" });
    expect(one.text).toBe("=== Sheet: Secret (hidden) ===\nhidden data");
    const missing = await extractAttachment(makeXlsx(), "orders.xlsx", "", { sheet: "nope" });
    expect(missing.note).toMatch(/No sheet named "nope"/);
  });

  it("Excel: caps very long sheets", async () => {
    const r = await extractAttachment(makeXlsx({ rows: 1500 }), "big.xlsx", "");
    expect(r.note).toMatch(/more than 1000 rows/);
  });

  it("PowerPoint: slides in presentation order with speaker notes", async () => {
    const r = await extractAttachment(makePptx(), "deck.pptx", "");
    expect(r).toMatchObject({ format: "pptx", slides: 2 });
    expect(r.text).toBe("--- Slide 1 ---\nΠρώτη διαφάνεια\n[Speaker notes] Μην ξεχάσεις το δείγμα\n\n--- Slide 2 ---\nSecond slide\nΤιμές 2027");
  });

  it("OpenDocument text and spreadsheet (incl. huge repeated empty rows)", async () => {
    const odt = await extractAttachment(makeOdt(), "doc.odt", "");
    expect(odt.format).toBe("odt");
    expect(odt.text).toBe("Τίτλος\nΓραμμή  με\tκενά\nA / A2 | B");
    const ods = await extractAttachment(makeOds(), "sheet.ods", "");
    expect(ods.format).toBe("ods");
    expect(ods.text).toBe("=== Sheet: Φύλλο1 ===\nΌνομα,\"12,50\"");
  });
});

describe("text family", () => {
  it("decodes windows-1253 Greek CSV without a declared charset", async () => {
    const r = await extractAttachment(encode1253("Όνομα,Τιμή\r\nΑυτοκόλλητο βιτρίνας,12.5\r\n"), "export.csv", "text/csv");
    expect(r).toMatchObject({ kind: "text", format: "csv", charset: "windows-1253" });
    expect(r.text).toBe("Όνομα,Τιμή\nΑυτοκόλλητο βιτρίνας,12.5\n");
  });

  it("honours BOMs and declared charsets", () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Γεια")]))).toEqual({ text: "Γεια", charset: "utf-8" });
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x93, 0x03]))).toEqual({ text: "Γ", charset: "utf-16le" });
    expect(decodeText(Buffer.from([0xc3]), "iso-8859-7").text).toBe("Γ");
    expect(decodeText(Buffer.from("café", "latin1")).charset).toBe("windows-1252");
    expect(decodeText(Buffer.from("Müller, José, Café Crème, Zoë", "latin1")).text).toBe("Müller, José, Café Crème, Zoë");
    expect(decodeText(encode1253("Γεια")).charset).toBe("windows-1253");
  });

  it("converts HTML, keeps JSON, reads .eml and RTF", async () => {
    const html = await extractAttachment(Buffer.from("<html><body><h1>Order</h1><p>Hello <b>Μαρία</b></p><script>x()</script></body></html>"), "o.html", "text/html");
    expect(html.text).toBe("Order\n\nHello Μαρία");
    const json = await extractAttachment(Buffer.from('{"a":1}'), "data.json", "application/json");
    expect(json.text).toBe('{"a":1}');
    const eml = [
      "From: =?UTF-8?B?zpzOsc+Bzq/OsQ==?= <maria@acme.example>",
      "To: urbanstickersgr@gmail.com",
      "Subject: =?UTF-8?B?zqDPgc6/z4POv8+Bzqw=?=",
      "Date: Mon, 26 Oct 2026 09:00:00 +0200",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Σας στέλνω τα σχέδια.",
    ].join("\r\n");
    const e = await extractAttachment(Buffer.from(eml), "fwd.eml", "message/rfc822");
    expect(e.format).toBe("eml");
    expect(e.text).toMatch(/From: "?Μαρία"? <maria@acme\.example>/);
    expect(e.text).toMatch(/Subject: Προσ/);
    expect(e.text).toContain("Σας στέλνω τα σχέδια.");
    const rtf = await extractAttachment(Buffer.from("{\\rtf1\\ansi\\ansicpg1253{\\fonttbl{\\f0 Arial;}}\\f0 \\'c3\\'e5\\'e9\\'e1 \\u963?\\par Line2\\tab X}", "latin1"), "note.rtf", "application/rtf");
    expect(rtf.text).toBe("Γεια σ\nLine2\tX");
  });

  it("rtfToText skips font tables and starred groups", () => {
    expect(rtfToText("{\\rtf1{\\fonttbl{\\f0 Times;}}{\\*\\generator Word;}Hello\\par World}")).toBe("Hello\nWorld");
  });
});

describe("images", () => {
  it("returns PNG/JPEG for Claude to view, with dimensions", async () => {
    const png = await extractAttachment(PNG_1x1, "logo.png", "image/png");
    expect(png).toMatchObject({ kind: "image", format: "png" });
    expect(png.images![0]).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    const jpg = await extractAttachment(JPEG_16x12, "photo.JPG", "application/octet-stream");
    expect(jpg.images![0]).toMatchObject({ mimeType: "image/jpeg", width: 16, height: 12 });
    expect(imageSize(JPEG_16x12, "image/jpeg")).toEqual({ width: 16, height: 12 });
  });

  it("refuses images too large to show", async () => {
    const big = Buffer.concat([PNG_1x1.subarray(0, 33), Buffer.alloc(4 * 1024 * 1024)]);
    const r = await extractAttachment(big, "huge.png", "image/png");
    expect(r.kind).toBe("unsupported");
    expect(r.note).toMatch(/save_attachment/);
  });
});

describe("archives and safety", () => {
  it("lists ZIP contents and reads small documents inside", async () => {
    const r = await extractAttachment(makeZip({ "readme.txt": "Hello from the zip", "files/orders.xlsx": makeXlsx(), "art/logo.png": PNG_1x1 }), "pack.zip", "application/zip");
    expect(r.format).toBe("zip");
    expect(r.text).toContain("ZIP archive with 3 file(s)");
    expect(r.text).toContain("art/logo.png (");
    expect(r.text).toContain("--- readme.txt ---\nHello from the zip");
    expect(r.text).toContain("--- files/orders.xlsx ---\n=== Sheet: Παραγγελίες ===");
  });

  it("refuses zip bombs (declared sizes over the limit)", async () => {
    const bomb = Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": new Uint8Array(30 * 1024 * 1024) }));
    expect(bomb.length).toBeLessThan(200 * 1024);
    const r = await extractAttachment(bomb, "bomb.docx", "");
    expect(r.kind).toBe("unsupported");
    expect(r.note).toMatch(/safety limit/);
  });

  it("survives archives that lie about their size", async () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(65);
    const b = Buffer.from(zipSync({ "a.txt": big }));
    b.writeUInt32LE(100, 22); // local header: uncompressed size
    const cd = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    b.writeUInt32LE(100, cd + 24); // central directory: uncompressed size
    const r = await extractAttachment(b, "liar.zip", "application/zip");
    expect(r.text).toContain("--- a.txt ---\n" + "A".repeat(100));
    expect(r.text!.length).toBeLessThan(1000);
  });

  it("never throws on damaged files", async () => {
    const pdf = await extractAttachment(Buffer.from("%PDF-1.7\n garbage garbage"), "bad.pdf", "application/pdf");
    expect(pdf.kind === "unsupported" || pdf.kind === "text").toBe(true);
    const zip = await extractAttachment(makeDocx().subarray(0, 60), "cut.docx", "");
    expect(zip.kind).toBe("unsupported");
    expect(zip.note).toMatch(/Could not read/);
    const ole = await extractAttachment(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]), "old.doc", "application/msword");
    expect(ole.note).toMatch(/Old binary Office/);
    const bin = await extractAttachment(Buffer.from([0, 1, 2, 3, 0, 0, 255, 254, 0]), "x.bin", "application/octet-stream");
    expect(bin.kind).toBe("unsupported");
  });

  it("caps output size", async () => {
    const r = await extractAttachment(Buffer.from("x".repeat(50000)), "big.txt", "text/plain", { maxChars: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(1000);
    expect(r.note).toMatch(/first 1000 of 50000/);
  });
});

describe("xml helpers", () => {
  it("decodes entities and reads attributes with or without prefixes", () => {
    expect(decodeXmlEntities("&lt;a&gt; &amp; &#913;&#x3b2; &quot;x&apos;")).toBe("<a> & Αβ \"x'");
    expect(attr(' r:id="rId1" name="A &amp; B"', "r:id")).toBe("rId1");
    expect(attr(' r:id="rId1"', "id")).toBe("rId1");
    expect(attr(' name="A &amp; B"', "name")).toBe("A & B");
    expect(attr(' xname="no"', "name")).toBeUndefined();
  });
});
