/**
 * Small RTF-to-text converter: paragraphs, tabs, \uN unicode escapes and \'hh
 * bytes in the document code page (\ansicpg1253 for Greek). Skips destinations
 * such as font tables, pictures and {\*...} groups.
 */

const SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer", "headerl", "headerr", "footerl", "footerr",
  "listtable", "listoverridetable", "rsidtbl", "generator", "xmlnstbl", "themedata", "colorschememapping", "datastore", "latentstyles",
]);

export function rtfToText(rtf: string): string {
  let codepage = "windows-1252";
  const cp = rtf.match(/\\ansicpg(\d+)/);
  if (cp) codepage = `windows-${cp[1]}`;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(codepage);
  } catch {
    decoder = new TextDecoder("windows-1252");
  }

  let out = "";
  const stack: { skip: boolean; uc: number }[] = [];
  let skip = false;
  let uc = 1;
  let pendingSkip = 0;
  let bytes: number[] = [];
  const flushBytes = () => {
    if (bytes.length) {
      if (!skip) out += decoder.decode(new Uint8Array(bytes));
      bytes = [];
    }
  };

  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i];
    if (ch === "{") {
      flushBytes();
      stack.push({ skip, uc });
      if (rtf.startsWith("{\\*", i)) skip = true;
      continue;
    }
    if (ch === "}") {
      flushBytes();
      const s = stack.pop();
      if (s) {
        skip = s.skip;
        uc = s.uc;
      }
      continue;
    }
    if (ch === "\\") {
      const next = rtf[i + 1];
      if (next === "'") {
        const hex = rtf.substr(i + 2, 2);
        i += 3;
        if (pendingSkip > 0) {
          pendingSkip--;
          continue;
        }
        bytes.push(parseInt(hex, 16));
        continue;
      }
      flushBytes();
      if (next === "\\" || next === "{" || next === "}") {
        if (!skip) out += next;
        i++;
        continue;
      }
      if (next === "~") {
        if (!skip) out += " ";
        i++;
        continue;
      }
      if (next === "\n" || next === "\r") {
        if (!skip) out += "\n";
        i++;
        continue;
      }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1, i + 40));
      if (!m) {
        i++;
        continue;
      }
      i += m[0].length;
      const word = m[1];
      const num = m[2] !== undefined ? Number(m[2]) : undefined;
      if (SKIP_DESTINATIONS.has(word)) skip = true;
      else if (word === "par" || word === "line" || word === "row") out += skip ? "" : "\n";
      else if (word === "tab" || word === "cell") out += skip ? "" : "\t";
      else if (word === "uc" && num !== undefined) uc = num;
      else if (word === "u" && num !== undefined) {
        if (!skip) out += String.fromCharCode(num < 0 ? num + 65536 : num);
        pendingSkip = uc;
      }
      continue;
    }
    if (ch === "\r" || ch === "\n") continue;
    if (pendingSkip > 0) {
      pendingSkip--;
      continue;
    }
    flushBytes();
    if (!skip) out += ch;
  }
  flushBytes();
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
