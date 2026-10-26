import * as readline from "node:readline/promises";
import type { Mode } from "../config.js";

/** Extra CLI commands contributed by optional modules (IMAP, HTTP...). */
export type Command = (args: string[], mode: Mode) => Promise<void>;
export const extraCommands: Record<string, { help: string; run: Command }> = {};

export function takeFlag(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (i === -1) continue;
    const a = args[i];
    if (a.includes("=")) {
      args.splice(i, 1);
      return a.slice(a.indexOf("=") + 1);
    }
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  }
  return undefined;
}

export function takeBool(args: string[], ...names: string[]): boolean {
  let found = false;
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1) {
      args.splice(i, 1);
      found = true;
    }
  }
  return found;
}

export async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
