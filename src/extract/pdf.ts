import { MAX_IMAGE_BYTES } from "./image.js";

/** PDF text extraction with unpdf (pdf.js, pure JS) + embedded-JPEG fallback for scanned PDFs. */

export interface PdfText {
  pages: { page: number; text: string }[];
  totalPages: number;
  stoppedEarly: boolean;
}

/** "1-3,5" -> Set{1,2,3,5}; undefined = all. Capped at 2000 entries. */
export function parsePageRange(spec: string | undefined, total: number): Set<number> | undefined {
  if (!spec || !spec.trim()) return undefined;
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+)?)?$/);
    if (!m) throw new Error(`Invalid page range "${spec}". Use e.g. "1-3,5".`);
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : part.includes("-") ? total : a;
    for (let i = Math.max(1, a); i <= Math.min(b, total) && out.size < 2000; i++) out.add(i);
  }
  return out;
}

/** pdf.js may print warnings with console.log, which would corrupt the MCP stdio stream. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, info: console.info, warn: console.warn };
  const toStderr = (...a: unknown[]) => process.stderr.write(`[pdf] ${a.map(String).join(" ")}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

export async function pdfText(data: Uint8Array, opts: { pages?: string; maxChars: number }): Promise<PdfText> {
  return quietly(async () => {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(data), {
      verbosity: 0,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    } as never);
    try {
      const total = pdf.numPages;
      const wanted = parsePageRange(opts.pages, total);
      const pages: { page: number; text: string }[] = [];
      let chars = 0;
      let stoppedEarly = false;
      for (let i = 1; i <= total; i++) {
        if (wanted && !wanted.has(i)) continue;
        if (chars > opts.maxChars) {
          stoppedEarly = true;
          break;
        }
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
          if (typeof item.str !== "string") continue;
          text += item.str + (item.hasEOL ? "\n" : "");
        }
        text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        pages.push({ page: i, text });
        chars += text.length;
        page.cleanup();
      }
      return { pages, totalPages: total, stoppedEarly };
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
}

/**
 * Scanned PDFs are usually one JPEG per page. Pull the biggest embedded JPEG
 * streams straight out of the file so Claude can read them visually.
 * Only plain /DCTDecode streams (no extra filters) are taken.
 */
export function embeddedJpegs(data: Uint8Array, max = 2): { data: Uint8Array; width?: number; height?: number }[] {
  const s = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
  const found: { data: Uint8Array; width?: number; height?: number }[] = [];
  let idx = 0;
  while ((idx = s.indexOf("/DCTDecode", idx)) !== -1 && found.length < 50) {
    const dictStart = s.lastIndexOf("obj", idx);
    const streamKw = s.indexOf("stream", idx);
    idx += 10;
    if (dictStart === -1 || streamKw === -1 || streamKw - idx > 4096) continue;
    const dict = s.slice(dictStart, streamKw);
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    const filter = dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1] ?? "";
    if (filter.startsWith("[") && (filter.match(/\//g) ?? []).length > 1) continue; // chained filters
    let start = streamKw + 6;
    if (s[start] === "\r") start++;
    if (s[start] === "\n") start++;
    const end = s.indexOf("endstream", start);
    if (end === -1) continue;
    const bytes = data.subarray(start, end);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) continue;
    let last = bytes.length - 1;
    while (last > 1 && !(bytes[last - 1] === 0xff && bytes[last] === 0xd9)) last--;
    const jpeg = bytes.subarray(0, last + 1);
    if (jpeg.length > MAX_IMAGE_BYTES) continue;
    const width = Number(dict.match(/\/Width\s+(\d+)/)?.[1]) || undefined;
    const height = Number(dict.match(/\/Height\s+(\d+)/)?.[1]) || undefined;
    found.push({ data: jpeg, width, height });
  }
  return found.sort((a, b) => b.data.length - a.data.length).slice(0, max);
}
