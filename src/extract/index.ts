import * as path from "node:path";
import { htmlToText } from "../message.js";
import { imageSize, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, sniffImage } from "./image.js";
import { docxText, odsText, odtText, pptxText, xlsxText } from "./office.js";
import { embeddedJpegs, pdfText } from "./pdf.js";
import { rtfToText } from "./rtf.js";
import { charsetFromMime, decodeText, looksLikeText } from "./text.js";
import { isZip, safeUnzip, utf8, ZipLimitError } from "./zip.js";

/**
 * Turn an attachment into something Claude can read: text for documents,
 * the image itself for pictures (Claude's vision reads them, Greek included).
 * Never throws for bad input: problems come back as `note`.
 */

export interface ExtractOptions {
  /** Cap on returned text (default 30000). */
  maxChars?: number;
  /** PDF page selection, e.g. "1-3,5". */
  pages?: string;
  /** Spreadsheet sheet name. */
  sheet?: string;
}

export interface ExtractedImage {
  base64: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface ExtractResult {
  kind: "text" | "image" | "unsupported";
  /** Detected format, e.g. "pdf", "docx", "xlsx", "csv", "png". */
  format: string;
  text?: string;
  truncated: boolean;
  note?: string;
  totalPages?: number;
  pagesShown?: number[];
  slides?: number;
  sheets?: string[];
  charset?: string;
  images?: ExtractedImage[];
}

const TEXT_EXT = new Set([".txt", ".csv", ".tsv", ".md", ".markdown", ".json", ".xml", ".log", ".ics", ".vcf", ".yaml", ".yml", ".ini", ".cfg", ".conf", ".sql", ".svg", ".tex", ".srt"]);
const HTML_EXT = new Set([".html", ".htm", ".xhtml"]);
const EML_EXT = new Set([".eml", ".mht", ".mhtml"]);

function finish(r: ExtractResult, maxChars: number): ExtractResult {
  if (r.text !== undefined && r.text.length > maxChars) {
    const total = r.text.length;
    r.text = r.text.slice(0, maxChars);
    r.truncated = true;
    const hint = r.format === "pdf" ? 'use "pages" to read further' : r.sheets ? 'use "sheet" to read one sheet' : 'raise "maxChars"';
    r.note = [r.note, `Showing the first ${maxChars} of ${total} characters; ${hint}.`].filter(Boolean).join(" ");
  }
  return r;
}

function imageResult(data: Uint8Array, mimeType: string, format: string): ExtractResult {
  const size = imageSize(data, mimeType as never);
  if (data.length > MAX_IMAGE_BYTES) {
    return {
      kind: "unsupported",
      format,
      truncated: false,
      note: `Image is ${(data.length / 1048576).toFixed(1)} MB, above the ~3.7 MB limit for showing images to Claude. Use save_attachment to open it.`,
    };
  }
  if (size && (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE)) {
    return { kind: "unsupported", format, truncated: false, note: `Image is ${size.width}x${size.height} px, above the ${MAX_IMAGE_SIDE}px limit. Use save_attachment.` };
  }
  return {
    kind: "image",
    format,
    truncated: false,
    images: [{ base64: Buffer.from(data).toString("base64"), mimeType, ...(size ?? {}) }],
  };
}

async function emlText(data: Uint8Array): Promise<string> {
  const { simpleParser } = await import("mailparser");
  const m = await simpleParser(Buffer.from(data));
  const addr = (a: unknown) => (Array.isArray(a) ? a.map((x) => x.text).join(", ") : (a as { text?: string } | undefined)?.text ?? "");
  const lines = [
    `From: ${addr(m.from)}`,
    `To: ${addr(m.to)}`,
    ...(m.cc ? [`Cc: ${addr(m.cc)}`] : []),
    `Date: ${m.date ? m.date.toISOString() : ""}`,
    `Subject: ${m.subject ?? ""}`,
    ...(m.attachments.length ? [`Attachments: ${m.attachments.map((a) => `${a.filename ?? "(unnamed)"} (${a.size} bytes)`).join(", ")}`] : []),
    "",
    (m.text && m.text.trim()) || (typeof m.html === "string" ? htmlToText(m.html) : ""),
  ];
  return lines.join("\n").trim();
}

function zipKind(names: Set<string>): string {
  if (names.has("word/document.xml")) return "docx";
  if (names.has("xl/workbook.xml")) return "xlsx";
  if (names.has("ppt/presentation.xml")) return "pptx";
  if (names.has("content.xml") && names.has("mimetype")) return "opendocument";
  return "zip";
}

const INNER_EXT = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".txt", ".csv", ".md", ".json", ".xml", ".html", ".htm", ".eml", ".rtf"]);

async function inner(data: Uint8Array, filename: string, mimeType: string, opts: ExtractOptions, depth: number): Promise<ExtractResult> {
  const maxChars = opts.maxChars ?? 30000;
  const ext = path.extname(filename).toLowerCase();
  const mt = mimeType.split(";")[0].trim().toLowerCase();
  const head = Buffer.from(data.subarray(0, 1024)).toString("latin1");

  // ---- PDF (incl. Illustrator .ai saved with PDF compatibility)
  if (head.includes("%PDF-")) {
    const pdf = await pdfText(data, { pages: opts.pages, maxChars });
    const text = pdf.pages.map((p) => `--- Page ${p.page} ---\n${p.text || "(no text on this page)"}`).join("\n\n");
    const textChars = pdf.pages.reduce((s, p) => s + p.text.replace(/\s/g, "").length, 0);
    const r: ExtractResult = {
      kind: "text",
      format: ext === ".ai" ? "ai (pdf-compatible)" : "pdf",
      text,
      truncated: pdf.stoppedEarly,
      totalPages: pdf.totalPages,
      pagesShown: pdf.pages.map((p) => p.page),
    };
    if (pdf.stoppedEarly) r.note = `Stopped after page ${pdf.pages[pdf.pages.length - 1]?.page} of ${pdf.totalPages}; use "pages" to read the rest.`;
    if (pdf.pages.length && textChars < 20 * pdf.pages.length) {
      const jpegs = embeddedJpegs(data);
      if (jpegs.length) {
        r.images = jpegs.map((j) => ({ base64: Buffer.from(j.data).toString("base64"), mimeType: "image/jpeg", width: j.width, height: j.height }));
        r.note = [r.note, `This PDF looks scanned (little or no text layer). ${jpegs.length === 1 ? "Its page image is" : `Its ${jpegs.length} largest page images are`} attached for you to read visually.`]
          .filter(Boolean)
          .join(" ");
      } else {
        r.note = [r.note, "This PDF has little or no text layer (scanned or outlined text). Use save_attachment to open it."].filter(Boolean).join(" ");
      }
    }
    return finish(r, maxChars);
  }

  // ---- Images
  const img = sniffImage(data);
  if (img) return imageResult(data, img, img.split("/")[1]);

  // ---- ZIP containers (Office, OpenDocument, plain archives)
  if (isZip(data)) {
    const listing = safeUnzip(data, () => false);
    const names = new Set(listing.entries.map((e) => e.name));
    const kind = zipKind(names);
    if (kind === "docx") {
      const z = safeUnzip(data, (n) => /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/.test(n));
      return finish({ kind: "text", format: "docx", text: docxText(z.files), truncated: false }, maxChars);
    }
    if (kind === "xlsx") {
      const z = safeUnzip(data, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(n));
      const x = xlsxText(z.files, { sheet: opts.sheet });
      return finish({ kind: "text", format: "xlsx", text: x.text, sheets: x.sheets, truncated: false, ...(x.notes.length ? { note: x.notes.join(" ") } : {}) }, maxChars);
    }
    if (kind === "pptx") {
      const z = safeUnzip(data, (n) => /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml)$/.test(n));
      const p = pptxText(z.files);
      return finish({ kind: "text", format: "pptx", text: p.text, slides: p.slides, truncated: false }, maxChars);
    }
    if (kind === "opendocument") {
      const z = safeUnzip(data, (n) => n === "mimetype" || n === "content.xml");
      const odType = utf8(z.files["mimetype"]).trim();
      if (odType.endsWith("spreadsheet")) {
        const x = odsText(z.files, { sheet: opts.sheet });
        return finish({ kind: "text", format: "ods", text: x.text, sheets: x.sheets, truncated: false, ...(x.notes.length ? { note: x.notes.join(" ") } : {}) }, maxChars);
      }
      return finish({ kind: "text", format: odType.endsWith("presentation") ? "odp" : "odt", text: odtText(z.files), truncated: false }, maxChars);
    }
    // Plain archive: list it, and read a few small documents inside.
    const listed = listing.entries
      .slice(0, 300)
      .map((e) => `${e.name} (${e.size.toLocaleString("en")} bytes)`)
      .join("\n");
    let text = `ZIP archive with ${listing.entries.length} file(s):\n${listed}${listing.entries.length > 300 ? `\n… and ${listing.entries.length - 300} more` : ""}`;
    if (depth === 0) {
      const readable = listing.entries.filter((e) => INNER_EXT.has(path.extname(e.name).toLowerCase()) && e.size <= 5 * 1024 * 1024).slice(0, 5);
      if (readable.length) {
        const z = safeUnzip(data, (n) => readable.some((e) => e.name === n));
        let budget = Math.max(0, maxChars - text.length);
        for (const e of readable) {
          if (budget <= 200 || !z.files[e.name]) break;
          const r = await inner(z.files[e.name], e.name, "", { maxChars: budget }, depth + 1);
          if (r.text) {
            const block = `\n\n--- ${e.name} ---\n${r.text}`;
            text += block;
            budget -= block.length;
          }
        }
      }
    }
    return finish({ kind: "text", format: "zip", text, truncated: false }, maxChars);
  }

  // ---- Formats we recognise but cannot read
  if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) {
    return {
      kind: "unsupported",
      format: ext.replace(".", "") || "ole2",
      truncated: false,
      note: "Old binary Office format (.doc/.xls/.ppt/.msg). Not readable here; ask for .docx/.xlsx/PDF or use save_attachment.",
    };
  }
  if (head.startsWith("%!PS")) return { kind: "unsupported", format: "postscript/eps", truncated: false, note: "PostScript/EPS print file; use save_attachment to open it." };
  if (head.startsWith("8BPS")) return { kind: "unsupported", format: "psd", truncated: false, note: "Photoshop file; use save_attachment to open it." };

  // ---- Text family
  if (head.startsWith("{\\rtf") || ext === ".rtf") {
    return finish({ kind: "text", format: "rtf", text: rtfToText(Buffer.from(data).toString("latin1")), truncated: false }, maxChars);
  }
  if (EML_EXT.has(ext) || mt === "message/rfc822") {
    return finish({ kind: "text", format: "eml", text: await emlText(data), truncated: false }, maxChars);
  }
  const textual = mt.startsWith("text/") || TEXT_EXT.has(ext) || HTML_EXT.has(ext) || /json|xml|csv|calendar|vcard|javascript/.test(mt);
  if (textual || looksLikeText(data)) {
    const { text, charset } = decodeText(data, charsetFromMime(mimeType));
    const isHtml = HTML_EXT.has(ext) || mt === "text/html" || (/^\s*<(!doctype html|html)/i.test(text) && !TEXT_EXT.has(ext));
    const format = isHtml ? "html" : ext.replace(".", "") || mt.split("/")[1] || "text";
    return finish({ kind: "text", format, text: isHtml ? htmlToText(text) : text.replace(/\r\n/g, "\n"), charset, truncated: false }, maxChars);
  }

  return {
    kind: "unsupported",
    format: ext.replace(".", "") || mt || "binary",
    truncated: false,
    note: `Can't read ${mimeType || "this file type"} (${data.length.toLocaleString("en")} bytes). Use save_attachment to open it.`,
  };
}

export async function extractAttachment(data: Uint8Array, filename: string, mimeType: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  try {
    return await inner(data, filename, mimeType, opts, 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "unsupported",
      format: path.extname(filename).replace(".", "").toLowerCase() || "unknown",
      truncated: false,
      note: err instanceof ZipLimitError ? msg : `Could not read this file (${msg.slice(0, 200)}). It may be damaged or password-protected; use save_attachment to open it.`,
    };
  }
}
