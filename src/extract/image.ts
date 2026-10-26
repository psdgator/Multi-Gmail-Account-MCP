/** Image sniffing for attachments Claude should *look at* (vision does the OCR). */

/** Anthropic's API accepts images up to 5 MB base64-encoded and 8000 px per side. */
export const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 1024; // ~3.75 MB raw
export const MAX_IMAGE_SIDE = 8000;

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export function sniffImage(d: Uint8Array): ImageType | undefined {
  if (d.length >= 8 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return "image/png";
  if (d.length >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return "image/jpeg";
  if (d.length >= 6 && d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x38) return "image/gif";
  if (d.length >= 12 && d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 && d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50) return "image/webp";
  return undefined;
}

/** Width/height from the file header, without decoding pixels. */
export function imageSize(d: Uint8Array, type: ImageType): { width: number; height: number } | undefined {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  try {
    if (type === "image/png" && d.length >= 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (type === "image/gif" && d.length >= 10) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < d.length) {
        if (d[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = d[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = dv.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
        }
        i += 2 + len;
      }
    }
    if (type === "image/webp" && d.length >= 30) {
      const chunk = String.fromCharCode(d[12], d[13], d[14], d[15]);
      if (chunk === "VP8X") return { width: 1 + (d[24] | (d[25] << 8) | (d[26] << 16)), height: 1 + (d[27] | (d[28] << 8) | (d[29] << 16)) };
      if (chunk === "VP8L") {
        const b = dv.getUint32(21, true);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8 ") return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
  } catch {
    /* malformed header */
  }
  return undefined;
}
