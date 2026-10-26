import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Permission modes, from least to most powerful.
 *
 * - readonly: search, read, list. Nothing in Gmail changes.
 * - drafts:   readonly + create/delete drafts, labels, mark read/unread, archive.
 *             Nothing is ever sent. This is the default.
 * - full:     drafts + send, trash, filters.
 */
export const MODES = ["readonly", "drafts", "full"] as const;
export type Mode = (typeof MODES)[number];

export const DEFAULT_MODE: Mode = "drafts";

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export function parseMode(value: string | undefined, fallback: Mode = DEFAULT_MODE): Mode {
  if (value === undefined || value === "") return fallback;
  const v = value.trim().toLowerCase();
  if (v === "read-only" || v === "ro") return "readonly";
  if (isMode(v)) return v;
  throw new Error(`Unknown mode "${value}". Use one of: ${MODES.join(", ")}`);
}

/** True if `have` is at least as powerful as `need`. */
export function modeAllows(have: Mode, need: Mode): boolean {
  return MODES.indexOf(have) >= MODES.indexOf(need);
}

/** The weaker of two modes. */
export function minMode(a: Mode, b: Mode): Mode {
  return MODES.indexOf(a) <= MODES.indexOf(b) ? a : b;
}

/** Root directory for config and credentials. Override with GMAIL_MCP_HOME. */
export function configDir(): string {
  const override = process.env.GMAIL_MCP_HOME;
  if (override && override.trim()) return path.resolve(expandHome(override.trim()));
  return path.join(os.homedir(), ".gmail-mcp");
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Owner-only permissions for anything holding OAuth material. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Write a file that only the owner can read.
 *
 * The `mode` option is applied by the OS only when the file is created, so an
 * explicit chmod follows to also tighten files written by earlier versions.
 * (On Windows chmod only toggles the read-only bit; the user profile ACLs
 * already keep other users out.)
 */
export function writeSecureFile(filePath: string, data: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: FILE_MODE });
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    // Windows can refuse the rename while another process (e.g. antivirus)
    // holds the target open; fall back to an in-place write.
    fs.writeFileSync(filePath, data, { mode: FILE_MODE });
    fs.rmSync(tmp, { force: true });
  }
  try {
    fs.chmodSync(filePath, FILE_MODE);
  } catch {
    /* best effort */
  }
}

/** Create a directory only the owner can enter (tightens existing ones too). */
export function ensureSecureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  }
  try {
    fs.chmodSync(dirPath, DIR_MODE);
  } catch {
    /* best effort */
  }
}
