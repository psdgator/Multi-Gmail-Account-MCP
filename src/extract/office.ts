import { attr, local, xmlTokens } from "./xml.js";
import { utf8 } from "./zip.js";

/** Text extraction for OOXML (docx/xlsx/pptx) and OpenDocument (odt/ods) files. */

type Files = Record<string, Uint8Array>;

const tidy = (s: string) =>
  s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Resolve a relationship target relative to the folder of the part that owns it. */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${baseDir}/${target}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function relationships(files: Files, relsPath: string, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of xmlTokens(utf8(files[relsPath]))) {
    if ((t.type === "self" || t.type === "open") && local(t.name) === "Relationship") {
      const id = attr(t.attrs, "Id");
      const target = attr(t.attrs, "Target");
      if (id && target && attr(t.attrs, "TargetMode") !== "External") map.set(id, resolveTarget(baseDir, target));
    }
  }
  return map;
}

// ---------------------------------------------------------------- Word (docx)

/** WordprocessingML -> text. Paragraphs become lines; tables become "a | b | c" rows. */
export function wordXmlToText(xml: string): string {
  const out: string[] = [];
  let para = "";
  let inText = false;
  const tables: { cells: string[]; cell: string }[] = [];
  const flushPara = () => {
    if (tables.length) {
      const t = tables[tables.length - 1];
      t.cell += (t.cell ? "\n" : "") + para;
    } else out.push(para);
    para = "";
  };
  for (const tok of xmlTokens(xml)) {
    if (tok.type === "text") {
      if (inText) para += tok.text;
      continue;
    }
    const n = tok.name;
    if (tok.type === "open") {
      if (n === "w:t") inText = true;
      else if (n === "w:tbl") tables.push({ cells: [], cell: "" });
    } else if (tok.type === "self") {
      if (n === "w:tab" || n === "w:ptab") para += "\t";
      else if (n === "w:br" || n === "w:cr") para += "\n";
      else if (n === "w:noBreakHyphen") para += "-";
    } else {
      if (n === "w:t") inText = false;
      else if (n === "w:p") flushPara();
      else if (n === "w:tc" && tables.length) {
        const t = tables[tables.length - 1];
        t.cells.push(t.cell.trim().replace(/\s*\n\s*/g, " / "));
        t.cell = "";
      } else if (n === "w:tr" && tables.length) {
        const t = tables[tables.length - 1];
        const line = t.cells.join(" | ");
        t.cells = [];
        if (tables.length > 1) {
          const parent = tables[tables.length - 2];
          parent.cell += (parent.cell ? "\n" : "") + line;
        } else out.push(line);
      } else if (n === "w:tbl") {
        tables.pop();
        if (!tables.length) out.push("");
      }
    }
  }
  if (para) out.push(para);
  return tidy(out.join("\n"));
}

export function docxText(files: Files): string {
  const sections: string[] = [];
  const body = wordXmlToText(utf8(files["word/document.xml"]));
  sections.push(body);
  const extra = (prefix: string, label: string) =>
    Object.keys(files)
      .filter((f) => new RegExp(`^word/${prefix}\\d*\\.xml$`).test(f))
      .sort()
      .map((f) => wordXmlToText(utf8(files[f])))
      .filter((t) => t.trim())
      .map((t) => `--- ${label} ---\n${t}`);
  sections.push(...extra("header", "Header"), ...extra("footer", "Footer"));
  const notes = files["word/footnotes.xml"] ? wordXmlToText(utf8(files["word/footnotes.xml"])) : "";
  if (notes.trim()) sections.push(`--- Footnotes ---\n${notes}`);
  return tidy(sections.join("\n\n"));
}

// ---------------------------------------------------------------- Excel (xlsx)

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(code: string): boolean {
  const cleaned = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dmyhs]/i.test(cleaned) && !/^general$/i.test(cleaned.trim());
}

function excelSerialToIso(serial: number, date1904: boolean): string {
  const ms = Math.round((serial - (date1904 ? -1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

function sharedStrings(files: Files): string[] {
  const out: string[] = [];
  let cur = "";
  let inT = false;
  let inPhonetic = 0;
  for (const t of xmlTokens(utf8(files["xl/sharedStrings.xml"]))) {
    if (t.type === "text") {
      if (inT && !inPhonetic) cur += t.text;
      continue;
    }
    const n = local(t.name);
    if (t.type === "open") {
      if (n === "si") cur = "";
      else if (n === "t") inT = true;
      else if (n === "rPh") inPhonetic++;
    } else if (t.type === "close") {
      if (n === "t") inT = false;
      else if (n === "rPh") inPhonetic--;
      else if (n === "si") out.push(cur);
    } else if (t.type === "self" && n === "si") out.push("");
  }
  return out;
}

function dateStyles(files: Files): Set<number> {
  const xml = utf8(files["xl/styles.xml"]);
  const custom = new Map<number, string>();
  for (const t of xmlTokens(xml)) {
    if ((t.type === "self" || t.type === "open") && local(t.name) === "numFmt") {
      custom.set(Number(attr(t.attrs, "numFmtId")), attr(t.attrs, "formatCode") ?? "");
    }
  }
  const dates = new Set<number>();
  let inXfs = false;
  let idx = 0;
  for (const t of xmlTokens(xml)) {
    if (t.type !== "text" && local(t.name) === "cellXfs") {
      inXfs = t.type === "open";
      continue;
    }
    if (inXfs && (t.type === "self" || t.type === "open") && local(t.name) === "xf") {
      const id = Number(attr(t.attrs, "numFmtId") ?? 0);
      if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) dates.add(idx);
      idx++;
    }
  }
  return dates;
}

export interface SheetOptions {
  sheet?: string;
  maxRowsPerSheet?: number;
}

export function xlsxText(files: Files, opts: SheetOptions = {}): { text: string; sheets: string[]; notes: string[] } {
  const workbook = utf8(files["xl/workbook.xml"]);
  const rels = relationships(files, "xl/_rels/workbook.xml.rels", "xl");
  const date1904 = /date1904\s*=\s*"(1|true)"/i.test(workbook);
  const sheets: { name: string; path: string; hidden: boolean }[] = [];
  for (const t of xmlTokens(workbook)) {
    if ((t.type === "self" || t.type === "open") && local(t.name) === "sheet") {
      const rid = attr(t.attrs, "r:id") ?? attr(t.attrs, "id");
      const p = rid ? rels.get(rid) : undefined;
      if (p) sheets.push({ name: attr(t.attrs, "name") ?? p, path: p, hidden: /hidden/i.test(attr(t.attrs, "state") ?? "") });
    }
  }
  const strings = sharedStrings(files);
  const dates = dateStyles(files);
  const maxRows = opts.maxRowsPerSheet ?? 1000;
  const notes: string[] = [];
  const wanted = opts.sheet ? sheets.filter((s) => s.name.toLowerCase() === opts.sheet!.toLowerCase()) : sheets;
  if (opts.sheet && !wanted.length) notes.push(`No sheet named "${opts.sheet}". Sheets: ${sheets.map((s) => s.name).join(", ")}`);

  const blocks: string[] = [];
  for (const sh of wanted) {
    const rows: string[] = [];
    let row: string[] = [];
    let rowCount = 0;
    let cellRef = "";
    let cellType = "";
    let cellStyle = 0;
    let value = "";
    let inValue = false;
    let inInline = false;
    let stopped = false;
    for (const t of xmlTokens(utf8(files[sh.path]))) {
      if (t.type === "text") {
        if (inValue || inInline) value += t.text;
        continue;
      }
      const n = local(t.name);
      if (t.type === "open" && n === "row") {
        row = [];
      } else if ((t.type === "open" || t.type === "self") && n === "c") {
        cellRef = attr(t.attrs, "r") ?? "";
        cellType = attr(t.attrs, "t") ?? "";
        cellStyle = Number(attr(t.attrs, "s") ?? 0);
        value = "";
      } else if (t.type === "open" && n === "v") inValue = true;
      else if (t.type === "close" && n === "v") inValue = false;
      else if (t.type === "open" && n === "is") inInline = true;
      else if (t.type === "close" && n === "is") inInline = false;
      else if (t.type === "close" && n === "c") {
        let v = value;
        if (cellType === "s") v = strings[Number(value)] ?? "";
        else if (cellType === "b") v = value === "1" ? "TRUE" : "FALSE";
        else if (!cellType || cellType === "n") {
          const num = Number(value);
          if (value !== "" && Number.isFinite(num) && dates.has(cellStyle)) v = excelSerialToIso(num, date1904);
        }
        const idx = cellRef ? colIndex(cellRef) : row.length;
        if (idx < 500) {
          while (row.length < idx) row.push("");
          row[idx] = v;
        }
      } else if (t.type === "close" && n === "row") {
        while (row.length && row[row.length - 1] === "") row.pop();
        if (row.length) {
          rowCount++;
          if (rowCount > maxRows) {
            stopped = true;
            break;
          }
          rows.push(row.map(csvCell).join(","));
        }
      }
    }
    if (stopped) notes.push(`Sheet "${sh.name}" has more than ${maxRows} rows; only the first ${maxRows} are shown.`);
    blocks.push(`=== Sheet: ${sh.name}${sh.hidden ? " (hidden)" : ""} ===\n${rows.join("\n") || "(empty)"}`);
  }
  return { text: blocks.join("\n\n"), sheets: sheets.map((s) => s.name), notes };
}

// ---------------------------------------------------------------- PowerPoint (pptx)

function drawingText(xml: string): string {
  const lines: string[] = [];
  let line = "";
  let inT = false;
  let inField = 0;
  for (const t of xmlTokens(xml)) {
    if (t.type === "text") {
      if (inT && !inField) line += t.text;
      continue;
    }
    const n = t.name;
    if (t.type === "open") {
      if (n === "a:t") inT = true;
      else if (n === "a:fld") inField++;
    } else if (t.type === "close") {
      if (n === "a:t") inT = false;
      else if (n === "a:fld") inField--;
      else if (n === "a:p") {
        lines.push(line);
        line = "";
      }
    } else if (n === "a:br") line += "\n";
  }
  if (line) lines.push(line);
  return tidy(lines.join("\n"));
}

export function pptxText(files: Files): { text: string; slides: number } {
  const rels = relationships(files, "ppt/_rels/presentation.xml.rels", "ppt");
  let order: string[] = [];
  for (const t of xmlTokens(utf8(files["ppt/presentation.xml"]))) {
    if ((t.type === "self" || t.type === "open") && local(t.name) === "sldId") {
      const p = rels.get(attr(t.attrs, "r:id") ?? attr(t.attrs, "id") ?? "");
      if (p && files[p]) order.push(p);
    }
  }
  if (!order.length) {
    order = Object.keys(files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  }
  const blocks = order.map((p, i) => {
    let text = drawingText(utf8(files[p]));
    const slideRels = relationships(files, p.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels"), "ppt/slides");
    const notesPath = [...slideRels.values()].find((v) => /notesSlides\/notesSlide\d+\.xml$/.test(v));
    const notes = notesPath && files[notesPath] ? drawingText(utf8(files[notesPath])) : "";
    if (notes) text += `\n[Speaker notes] ${notes}`;
    return `--- Slide ${i + 1} ---\n${text || "(no text)"}`;
  });
  return { text: blocks.join("\n\n"), slides: order.length };
}

// ---------------------------------------------------------------- OpenDocument (odt/ods)

export function odtText(files: Files): string {
  const out: string[] = [];
  let para = "";
  let depth = 0;
  const rows: { cells: string[]; cell: string[] | null }[] = [];
  const emit = (line: string) => {
    const top = rows[rows.length - 1];
    if (top?.cell) top.cell.push(line);
    else out.push(line);
  };
  for (const t of xmlTokens(utf8(files["content.xml"]))) {
    if (t.type === "text") {
      if (depth > 0) para += t.text;
      continue;
    }
    const n = t.name;
    if (t.type === "open" && (n === "text:p" || n === "text:h")) depth++;
    else if (t.type === "close" && (n === "text:p" || n === "text:h")) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        emit(para);
        para = "";
      }
    } else if (t.type === "self" && n === "text:tab") para += "\t";
    else if (t.type === "self" && n === "text:line-break") para += "\n";
    else if (t.type === "self" && n === "text:s") para += " ".repeat(Math.min(50, Number(attr(t.attrs, "text:c") ?? 1)));
    else if (t.type === "open" && n === "table:table-row") rows.push({ cells: [], cell: null });
    else if (t.type === "open" && n === "table:table-cell" && rows.length) rows[rows.length - 1].cell = [];
    else if (t.type === "close" && n === "table:table-cell" && rows.length) {
      const top = rows[rows.length - 1];
      top.cells.push((top.cell ?? []).join(" / "));
      top.cell = null;
    } else if (t.type === "close" && n === "table:table-row" && rows.length) {
      emit(rows.pop()!.cells.join(" | "));
    }
  }
  return tidy(out.join("\n"));
}

export function odsText(files: Files, opts: SheetOptions = {}): { text: string; sheets: string[]; notes: string[] } {
  const maxRows = opts.maxRowsPerSheet ?? 1000;
  const blocks: { name: string; rows: string[] }[] = [];
  const notes: string[] = [];
  let cur: { name: string; rows: string[] } | undefined;
  let row: string[] = [];
  let cell = "";
  let inCell = false;
  let repeatCols = 1;
  let repeatRows = 1;
  let cellValue: string | undefined;
  for (const t of xmlTokens(utf8(files["content.xml"]))) {
    if (t.type === "text") {
      if (inCell) cell += t.text;
      continue;
    }
    const n = t.name;
    if (t.type === "open" && n === "table:table") {
      cur = { name: attr(t.attrs, "table:name") ?? `Sheet${blocks.length + 1}`, rows: [] };
      blocks.push(cur);
    } else if (t.type === "open" && n === "table:table-row") {
      row = [];
      repeatRows = Math.min(Number(attr(t.attrs, "table:number-rows-repeated") ?? 1), 1000);
    } else if ((t.type === "open" || t.type === "self") && (n === "table:table-cell" || n === "table:covered-table-cell")) {
      repeatCols = Number(attr(t.attrs, "table:number-columns-repeated") ?? 1);
      cellValue = attr(t.attrs, "office:date-value") ?? attr(t.attrs, "office:value") ?? attr(t.attrs, "office:boolean-value");
      cell = "";
      inCell = t.type === "open";
      if (t.type === "self") for (let i = 0; i < Math.min(repeatCols, 200); i++) row.push("");
    } else if (t.type === "close" && (n === "table:table-cell" || n === "table:covered-table-cell")) {
      inCell = false;
      const v = cell || cellValue || "";
      for (let i = 0; i < Math.min(repeatCols, v ? 200 : 200); i++) row.push(v);
    } else if (t.type === "self" && n === "text:s" && inCell) cell += " ";
    else if (t.type === "close" && n === "text:p" && inCell) cell += "\n";
    else if (t.type === "close" && n === "table:table-row" && cur) {
      while (row.length && row[row.length - 1] === "") row.pop();
      if (row.length) {
        const line = row.map((v) => csvCell(v.trim())).join(",");
        for (let i = 0; i < repeatRows && cur.rows.length < maxRows; i++) cur.rows.push(line);
        if (cur.rows.length >= maxRows) notes.push(`Sheet "${cur.name}" truncated to ${maxRows} rows.`);
      }
    }
  }
  const wanted = opts.sheet ? blocks.filter((b) => b.name.toLowerCase() === opts.sheet!.toLowerCase()) : blocks;
  return {
    text: wanted.map((b) => `=== Sheet: ${b.name} ===\n${b.rows.join("\n") || "(empty)"}`).join("\n\n"),
    sheets: blocks.map((b) => b.name),
    notes: [...new Set(notes)],
  };
}
