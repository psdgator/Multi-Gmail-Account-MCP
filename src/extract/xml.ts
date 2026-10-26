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

const TOKEN_RE = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;

export function* xmlTokens(xml: string): Generator<XmlToken> {
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(xml))) {
    if (m[1] !== undefined) {
      yield { type: "text", text: m[1] };
    } else if (m[3] !== undefined) {
      const name = m[3];
      if (m[2] === "/") yield { type: "close", name };
      else if (m[5] === "/") yield { type: "self", name, attrs: m[4] ?? "" };
      else yield { type: "open", name, attrs: m[4] ?? "" };
    } else if (m[6] !== undefined) {
      yield { type: "text", text: decodeXmlEntities(m[6]) };
    }
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
