/** Charset-aware decoding for text attachments (UTF-8/16, Greek windows-1253 / ISO-8859-7, Latin). */

function tryDecode(buf: Uint8Array, charset: string, fatal = false): string | undefined {
  try {
    return new TextDecoder(charset, { fatal }).decode(buf);
  } catch {
    return undefined;
  }
}

const isGreek = (c: number) => (c >= 0x0370 && c <= 0x03ff) || (c >= 0x1f00 && c <= 0x1fff);
const isLatinLetter = (ch: string | undefined) => ch !== undefined && /[A-Za-z]/.test(ch);

/**
 * Does this windows-1253 decoding look like real Greek? Mostly-Greek non-ASCII
 * letters, and Greek letters not glued to Latin ones (Latin-1 text decoded as
 * 1253 gives words like "Cafι").
 */
function plausibleGreek(s: string): boolean {
  const chars = [...s];
  let greek = 0;
  let other = 0;
  let glued = 0;
  chars.forEach((ch, i) => {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) return;
    if (isGreek(c)) {
      greek++;
      if (isLatinLetter(chars[i - 1]) || isLatinLetter(chars[i + 1])) glued++;
    } else other++;
  });
  if (greek === 0) return false;
  return greek / (greek + other) >= 0.6 && glued / greek < 0.3;
}

export function charsetFromMime(mimeType: string): string | undefined {
  return mimeType.match(/charset\s*=\s*"?([^";\s]+)"?/i)?.[1]?.toLowerCase();
}

export function decodeText(data: Uint8Array, declaredCharset?: string): { text: string; charset: string } {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return { text: tryDecode(data.subarray(3), "utf-8") ?? "", charset: "utf-8" };
  if (data[0] === 0xff && data[1] === 0xfe) return { text: tryDecode(data.subarray(2), "utf-16le") ?? "", charset: "utf-16le" };
  if (data[0] === 0xfe && data[1] === 0xff) return { text: tryDecode(data.subarray(2), "utf-16be") ?? "", charset: "utf-16be" };
  if (declaredCharset && !/^(us-)?ascii$/i.test(declaredCharset)) {
    const t = tryDecode(data, declaredCharset);
    if (t !== undefined) return { text: t, charset: declaredCharset };
  }
  const utf = tryDecode(data, "utf-8", true);
  if (utf !== undefined) return { text: utf, charset: "utf-8" };
  // Legacy 8-bit: Greek Excel/Windows exports are usually windows-1253.
  const greek = tryDecode(data, "windows-1253") ?? "";
  if (plausibleGreek(greek)) return { text: greek, charset: "windows-1253" };
  return { text: tryDecode(data, "windows-1252") ?? "", charset: "windows-1252" };
}

/** Heuristic: does this buffer look like text (no NULs, mostly printable)? */
export function looksLikeText(data: Uint8Array): boolean {
  const n = Math.min(data.length, 4096);
  if (n === 0) return true;
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = data[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / n < 0.02;
}
