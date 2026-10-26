import * as fs from "node:fs";
import { strToU8, zipSync } from "fflate";

/** Builds small but realistic attachment files in memory for the tests. */

export const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export const JPEG_16x12 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAMABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqD/9k=",
  "base64"
);

const z = (files: Record<string, string | Uint8Array>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]))));

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export function makeDocx(): Buffer {
  const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${p("Προσφορά για αυτοκόλλητα βιτρίνας")}
<w:p><w:r><w:t>Τιμή:</w:t></w:r><w:r><w:tab/><w:t>120 &amp; ΦΠΑ</w:t></w:r><w:r><w:br/><w:t>Line two</w:t></w:r></w:p>
<w:p><w:r><w:delText>deleted text</w:delText></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>
<w:tbl><w:tr><w:tc>${p("Είδος")}</w:tc><w:tc>${p("Ποσότητα")}</w:tc></w:tr>
<w:tr><w:tc>${p("Βινύλιο")}${p("ματ")}</w:tc><w:tc>${p("3")}</w:tc></w:tr></w:tbl>
${p("Ευχαριστούμε")}
</w:body></w:document>`;
  return z({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "word/document.xml": doc,
    "word/footer1.xml": `<w:ftr ${W}>${p("UrbanStickers, Θεσσαλονίκη")}</w:ftr>`,
  });
}

/** Excel serial for a UTC date (1900 system). */
export const excelSerial = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86400000 + 25569;

export function makeXlsx(opts: { rows?: number } = {}): Buffer {
  const extraRows = Array.from({ length: opts.rows ?? 0 }, (_, i) => `<row r="${i + 10}"><c r="A${i + 10}"><v>${i}</v></c></row>`).join("");
  return z({
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
<sheet name="Παραγγελίες" sheetId="1" r:id="rId1"/><sheet name="Secret" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Πελάτης</t></si><si><r><t>Kentia</t></r><r><t xml:space="preserve"> Α.Ε.</t></r></si><si><t>Ποσό, € "τελικό"</t><rPh><t>phonetic</t></rPh></si></sst>`,
    "xl/styles.xml": `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/></numFmts>
<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>${excelSerial(2026, 10, 26)}</v></c><c r="C2"><v>1234.5</v></c><c r="D2" t="b"><v>1</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Inline ✓</t></is></c><c r="B3" s="2"><v>${excelSerial(2026, 1, 2)}</v></c><c r="C3" t="str"><f>A1&amp;"x"</f><v>Πελάτηςx</v></c></row>
<row r="5"/>${extraRows}
</sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden data</t></is></c></row></sheetData></worksheet>`,
  });
}

export function makePptx(): Buffer {
  const slide = (texts: string[]) =>
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${texts
      .map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`)
      .join("")}</p:spTree></p:cSld></p:sld>`;
  return z({
    "[Content_Types].xml": `<Types/>`,
    "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide(["Second slide", "Τιμές 2027"]),
    "ppt/slides/slide2.xml": slide(["Πρώτη διαφάνεια"]),
    "ppt/slides/_rels/slide2.xml.rels": `<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    "ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:p="p" xmlns:a="a"><p:sp><p:txBody><a:p><a:r><a:t>Μην ξεχάσεις το δείγμα</a:t></a:r></a:p><a:p><a:fld type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp></p:notes>`,
  });
}

export function makeOdt(): Buffer {
  return z({
    mimetype: "application/vnd.oasis.opendocument.text",
    "content.xml": `<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:text>
<text:h>Τίτλος</text:h><text:p>Γραμμή<text:s text:c="2"/>με<text:tab/>κενά</text:p>
<table:table><table:table-row><table:table-cell><text:p>A</text:p><text:p>A2</text:p></table:table-cell><table:table-cell><text:p>B</text:p></table:table-cell></table:table-row></table:table>
</office:text></office:body></office:document-content>`,
  });
}

export function makeOds(): Buffer {
  return z({
    mimetype: "application/vnd.oasis.opendocument.spreadsheet",
    "content.xml": `<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:spreadsheet>
<table:table table:name="Φύλλο1"><table:table-row><table:table-cell><text:p>Όνομα</text:p></table:table-cell><table:table-cell office:value="12.5"><text:p>12,50</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1000"/></table:table-row>
<table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row></table:table>
</office:spreadsheet></office:body></office:document-content>`,
  });
}

export function encode1253(s: string): Buffer {
  const dec = new TextDecoder("windows-1253");
  const map = new Map<string, number>();
  for (let b = 0x80; b <= 0xff; b++) map.set(dec.decode(new Uint8Array([b])), b);
  return Buffer.from([...s].map((ch) => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : map.get(ch) ?? 0x3f)));
}

export function makeZip(inner: Record<string, Buffer | string>): Buffer {
  return z(Object.fromEntries(Object.entries(inner).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : new Uint8Array(v)])));
}

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
];

export function greekFont(): Buffer | undefined {
  for (const f of FONT_CANDIDATES) if (fs.existsSync(f)) return fs.readFileSync(f);
  return undefined;
}

export async function makePdf(opts: { greek?: boolean; pages?: number } = {}): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const n = opts.pages ?? 2;
  for (let i = 1; i <= n; i++) {
    const page = doc.addPage([400, 300]);
    page.drawText(`Invoice INV-2026-${i}`, { x: 30, y: 250, size: 14, font: helv });
    page.drawText(`Total: ${i * 100}.00 EUR`, { x: 30, y: 220, size: 12, font: helv });
  }
  if (opts.greek) {
    const fontBytes = greekFont();
    if (fontBytes) {
      const fontkit = (await import("@pdf-lib/fontkit")).default;
      doc.registerFontkit(fontkit);
      const f = await doc.embedFont(new Uint8Array(fontBytes), { subset: true });
      const page = doc.addPage([400, 300]);
      page.drawText("Τιμολόγιο για UrbanStickers", { x: 30, y: 250, size: 14, font: f });
    }
  }
  return Buffer.from(await doc.save());
}

export async function makeScannedPdf(): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const jpg = await doc.embedJpg(new Uint8Array(JPEG_16x12));
  const page = doc.addPage([160, 120]);
  page.drawImage(jpg, { x: 0, y: 0, width: 160, height: 120 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
