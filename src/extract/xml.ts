/** Minimal, dependency-free XML tokenizer for Office/OpenDocument parts. */

export type XmlToken =
  | { type: "open"; name: string; attrs: string }
  | { type: "close"; name: string }
  | { type: "self"; name: string; attrs: string }
  | { type: "text"; text: string };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "amp") return "&";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const cp = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

const LT = 60; // <
const GT = 62; // >
const SLASH = 47; // /
const DQ = 34; // "
const SQ = 39; // '

const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; // A-Z a-z _
const isNameChar = (c: number) => isNameStart(c) || (c >= 48 && c <= 57) || c === 58 || c === 46 || c === 45; // 0-9 : . -

/**
 * Linear-time tokenizer: every character is looked at a bounded number of times,
 * so malformed or hostile input (thousands of unclosed tags, unterminated quotes
 * or comments) cannot make it slow. Real Office XML never has a raw "<" inside a
 * tag, so a "<" before the closing ">" marks the tag as malformed; its text is then
 * emitted as plain text (the "<" itself is dropped), as before.
 */
export function* xmlTokens(xml: string): Generator<XmlToken> {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      yield { type: "text", text: decodeXmlEntities(xml.slice(i)) };
      return;
    }
    if (lt > i) yield { type: "text", text: decodeXmlEntities(xml.slice(i, lt)) };

    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) {
        yield { type: "text", text: xml.slice(lt + 9) };
        return;
      }
      yield { type: "text", text: xml.slice(lt + 9, end) };
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) return; // unterminated comment: the rest is comment
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) return;
      i = end + 2;
      continue;
    }
    if (xml.charCodeAt(lt + 1) === 33 /* ! */) {
      // DOCTYPE and other declarations
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) return;
      i = end + 1;
      continue;
    }

    // Element tag: <name ...>, </name>, <name .../>
    let k = lt + 1;
    const closing = xml.charCodeAt(k) === SLASH;
    if (closing) k++;
    if (!isNameStart(xml.charCodeAt(k))) {
      i = lt + 1; // not a tag; drop the "<", keep scanning as text
      continue;
    }
    const nameStart = k;
    while (k < n && isNameChar(xml.charCodeAt(k))) k++;
    const name = xml.slice(nameStart, k);
    const bodyStart = k;
    let quote = 0;
    let gt = -1;
    for (; k < n; k++) {
      const c = xml.charCodeAt(k);
      if (c === LT) break; // malformed: "<" inside a tag (also inside a quoted value)
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === DQ || c === SQ) quote = c;
      else if (c === GT) {
        gt = k;
        break;
      }
    }
    if (gt === -1) {
      i = lt + 1; // malformed/unterminated tag: treat as text from after the "<"
      continue;
    }
    if (closing) yield { type: "close", name };
    else {
      const body = xml.slice(bodyStart, gt);
      if (body.endsWith("/")) yield { type: "self", name, attrs: body.slice(0, -1) };
      else yield { type: "open", name, attrs: body };
    }
    i = gt + 1;
  }
}

/** Value of an attribute (namespace prefix optional: attr(a, "r:id") or attr(a, "id")). */
export function attr(attrs: string, name: string): string | undefined {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = `\\s*=\\s*(?:"([^"]*)"|'([^']*)')`;
  const exact = new RegExp(`(?:^|\\s)${esc(name)}${value}`).exec(attrs);
  const m = exact ?? (name.includes(":") ? null : new RegExp(`(?:^|\\s)[\\w.-]+:${esc(name)}${value}`).exec(attrs));
  return m ? decodeXmlEntities(m[1] ?? m[2] ?? "") : undefined;
}

/** Local name without namespace prefix. */
export const local = (name: string) => name.slice(name.indexOf(":") + 1);
