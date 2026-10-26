import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configDir, expandHome } from "./config.js";

/**
 * Which local paths tools may read (attach to an email) or write (save an attachment).
 *
 * Emails can try to steer Claude ("attach ~/.ssh/id_rsa", "save this to the Startup
 * folder"), so file access is limited to:
 *   - folders under your home directory, plus any listed in GMAIL_MCP_ALLOWED_DIRS
 *     (separated by the OS path delimiter: ";" on Windows, ":" elsewhere)
 * and never:
 *   - this server's config folder (encrypted logins, master key, audit log)
 *   - hidden files/folders (any path segment starting with "."), e.g. ~/.ssh, ~/.config
 *   - Windows AppData (includes the Startup folder) and macOS ~/Library (LaunchAgents)
 *   - /proc, /sys, /dev, /etc and network (UNC) paths
 * Symlinks are resolved before checking.
 */

function allowedRoots(): string[] {
  const extra = (process.env.GMAIL_MCP_ALLOWED_DIRS ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(expandHome(p)));
  return [os.homedir(), ...extra].map((p) => safeRealpath(p));
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const sameOrInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

function normalizeForCompare(p: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;
}

export class PathPolicyError extends Error {}

/** Resolve and check a path. For writes the path may not exist yet (its closest existing parent is checked). */
export function checkPath(input: string, mode: "read" | "write"): string {
  const raw = expandHome(input.trim());
  // Network paths, in any slash mix (\\host, //host, /\host, \/host, \\?\UNC\...). Checked
  // BEFORE touching the filesystem: on Windows even an existence check would contact the
  // host and leak the user's NTLM credentials.
  if (/^[\\/]{2}/.test(raw) || /^[\\/]{2}[?.][\\/]/.test(raw)) throw new PathPolicyError("Network (UNC) and device paths are not allowed.");
  let resolved = path.resolve(raw);
  if (/^[\\/]{2}/.test(resolved)) throw new PathPolicyError("Network (UNC) and device paths are not allowed.");

  // Resolve symlinks of the existing part of the path.
  let existing = resolved;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  resolved = path.join(safeRealpath(existing), ...tail);
  const cmp = normalizeForCompare(resolved);

  // Folders the user explicitly allowed (GMAIL_MCP_ALLOWED_DIRS) take precedence over the
  // home-folder rules (e.g. a work folder under AppData); the home folder gets the full checks.
  const roots = allowedRoots();
  const home = roots[0];
  // The most specific allowed folder decides (so "~;~/AppData/Local/Temp" allows Temp).
  const explicit = roots
    .slice(1)
    .filter((r) => sameOrInside(cmp, normalizeForCompare(r)))
    .sort((a, b) => b.length - a.length)[0];
  const root = explicit ?? (sameOrInside(cmp, normalizeForCompare(home)) ? home : undefined);
  if (!root) {
    throw new PathPolicyError(
      `"${input}" is outside the folders this server may use (your home folder${process.env.GMAIL_MCP_ALLOWED_DIRS ? " and GMAIL_MCP_ALLOWED_DIRS" : ""}). Add folders with GMAIL_MCP_ALLOWED_DIRS.`
    );
  }

  const alwaysDenied = [configDir(), "/proc", "/sys", "/dev", "/etc"].map((d) => normalizeForCompare(safeRealpath(d)));
  if (alwaysDenied.some((d) => sameOrInside(cmp, d))) {
    throw new PathPolicyError(`"${input}" is in a protected location (system or this server's own config).`);
  }
  // App data folders hold the Windows Startup folder and macOS LaunchAgents. They stay blocked
  // unless the user explicitly allowed a folder that is itself INSIDE them (allowing the whole
  // home folder or a parent does not unblock them). Cloud-drive folders under ~/Library are fine.
  const homeDenied = [path.join(os.homedir(), "AppData"), path.join(os.homedir(), "Library")].map((d) => normalizeForCompare(safeRealpath(d)));
  const cloudOk = [path.join(os.homedir(), "Library", "Mobile Documents"), path.join(os.homedir(), "Library", "CloudStorage")].map((d) =>
    normalizeForCompare(safeRealpath(d))
  );
  for (const d of homeDenied) {
    if (!sameOrInside(cmp, d)) continue;
    const explicitlyInside = explicit && sameOrInside(normalizeForCompare(explicit), d) && normalizeForCompare(explicit) !== d;
    if (explicitlyInside || cloudOk.some((c) => sameOrInside(cmp, c))) continue;
    throw new PathPolicyError(`"${input}" is in a protected location (app data / startup folders).`);
  }

  const rel = path.relative(normalizeForCompare(root), cmp);
  if (rel.split(path.sep).some((seg) => seg.startsWith("."))) {
    throw new PathPolicyError(`"${input}" is a hidden file or inside a hidden folder, which is not allowed.`);
  }
  if (mode === "read") {
    const st = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new PathPolicyError(`File not found: ${input}`);
    // A hard link can make a protected file appear inside an allowed folder.
    if (st.nlink > 1) throw new PathPolicyError(`"${input}" has multiple hard links; refusing to read it.`);
  }
  return resolved;
}

/** Default folder for saved attachments. */
export function defaultSaveDir(): string {
  return path.resolve(expandHome(process.env.GMAIL_MCP_SAVE_DIR || path.join(os.homedir(), "Downloads", "gmail-mcp")));
}
