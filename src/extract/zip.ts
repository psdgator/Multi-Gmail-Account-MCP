import { unzipSync } from "fflate";

/**
 * Zip reading with bomb protection. fflate inflates each entry into a buffer of
 * its *declared* size (output is truncated, never grown), so capping declared
 * sizes caps memory even for archives that lie about their contents.
 */
export const ZIP_LIMITS = {
  maxEntries: 5000,
  /** Largest single entry we will inflate. */
  maxEntryBytes: 25 * 1024 * 1024,
  /** Total bytes we will inflate per archive. */
  maxTotalBytes: 50 * 1024 * 1024,
};

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
}

export interface ZipRead {
  files: Record<string, Uint8Array>;
  entries: ZipEntry[];
  /** Entries we refused to inflate (size limits). */
  skipped: string[];
  error?: string;
}

export class ZipLimitError extends Error {}

export function isZip(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05) && (data[3] === 0x04 || data[3] === 0x06);
}

/**
 * Inflate the entries `want` asks for (all if omitted) within the limits.
 * Throws ZipLimitError for archives that exceed them, Error for corrupt ones.
 */
export function safeUnzip(data: Uint8Array, want: (name: string) => boolean = () => true, limits = ZIP_LIMITS): ZipRead {
  const entries: ZipEntry[] = [];
  const skipped: string[] = [];
  let total = 0;
  let tooMany = false;
  let tooBig = false;
  const files = unzipSync(data, {
    filter: (f) => {
      if (f.name.endsWith("/")) return false;
      entries.push({ name: f.name, size: f.originalSize, compressedSize: f.size });
      if (entries.length > limits.maxEntries) {
        tooMany = true;
        return false;
      }
      if (!want(f.name)) return false;
      if (f.originalSize > limits.maxEntryBytes || total + f.originalSize > limits.maxTotalBytes) {
        skipped.push(f.name);
        if (total + f.originalSize > limits.maxTotalBytes) tooBig = true;
        return false;
      }
      total += f.originalSize;
      return true;
    },
  });
  if (tooMany) throw new ZipLimitError(`The archive has more than ${limits.maxEntries} entries; not opened for safety.`);
  if (skipped.length) {
    throw new ZipLimitError(
      `The archive expands to more than the safety limit (${Math.round(limits.maxEntryBytes / 1048576)} MB per file, ${Math.round(limits.maxTotalBytes / 1048576)} MB total); not opened. Use save_attachment instead.`
    );
  }
  void tooBig;
  return { files, entries, skipped };
}

const td = new TextDecoder("utf-8", { fatal: false });
export const utf8 = (u: Uint8Array | undefined) => (u ? td.decode(u) : "");
