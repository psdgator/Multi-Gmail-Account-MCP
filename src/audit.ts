import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Append-only local log of every tool call Claude makes: when, which tool,
 * which account(s), the identifying arguments (ids, recipients, subject, query)
 * and whether it worked. Email bodies are never logged.
 *
 * File: <config>/audit.log (JSON lines), rotated to audit.log.1 at 5 MB.
 * Disable with GMAIL_MCP_AUDIT=off.
 */

export interface AuditEntry {
  ts: string;
  tool: string;
  mode: string;
  accounts?: string[];
  args?: Record<string, unknown>;
  ok: boolean;
  error?: string;
  ms: number;
  via?: string;
}

const DROP = new Set(["body", "html", "note", "password", "content", "data", "signature", "text"]);
const MAX_ROTATE_BYTES = 5 * 1024 * 1024;

/** Keep what identifies an action, drop content and secrets, cap sizes. */
export function redact(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (DROP.has(k)) {
      out[k] = typeof v === "string" ? `[${v.length} chars]` : "[omitted]";
      continue;
    }
    if (typeof v === "string") out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    else if (Array.isArray(v)) out[k] = v.length > 20 ? [...v.slice(0, 20).map(String), `…+${v.length - 20}`] : v.map((x) => (typeof x === "string" && x.length > 200 ? `${x.slice(0, 200)}…` : x));
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = "[object]";
  }
  return out;
}

export class AuditLog {
  readonly file: string;
  readonly enabled: boolean;

  constructor(root: string) {
    this.file = path.join(root, "audit.log");
    this.enabled = !/^(off|0|false|no)$/i.test(process.env.GMAIL_MCP_AUDIT ?? "");
  }

  record(entry: Omit<AuditEntry, "ts">): void {
    if (!this.enabled) return;
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_ROTATE_BYTES) {
        fs.renameSync(this.file, `${this.file}.1`);
      }
      fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
    } catch (err) {
      console.error("[gmail-mcp-multi] audit log write failed:", (err as Error).message);
    }
  }

  /** Newest first. */
  read(opts: { limit?: number; tool?: string; account?: string; onlyChanges?: boolean; since?: string } = {}): AuditEntry[] {
    const files = [`${this.file}.1`, this.file].filter((f) => fs.existsSync(f));
    const lines = files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean));
    const entries: AuditEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < (opts.limit ?? 50); i--) {
      let e: AuditEntry;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (opts.tool && e.tool !== opts.tool) continue;
      if (opts.account && !(e.accounts ?? []).some((a) => a.toLowerCase() === opts.account!.toLowerCase())) continue;
      if (opts.onlyChanges && READ_ONLY_TOOLS.has(e.tool)) continue;
      if (opts.since && e.ts < opts.since) break;
      entries.push(e);
    }
    return entries;
  }
}

/** Tools that never change anything (filtered out by onlyChanges). Kept in sync by tests. */
export const READ_ONLY_TOOLS = new Set<string>();
