import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { ExtractOptions, ExtractResult } from "./index.js";

/**
 * Runs one attachment extraction off the main thread (see extractAttachment).
 * Anything a parser prints goes to stderr: the parent pipes this worker's
 * stdout and stderr to its own stderr, never to its stdout.
 */
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

const job = workerData as { data: Uint8Array; filename: string; mimeType: string; opts: ExtractOptions; memoryMb?: number };

/**
 * The worker's heap limit doesn't cover typed arrays, and decoders grow their output buffer
 * by doubling, so one decompression-bomb step can allocate hundreds of MB at once (faster
 * than the parent's memory watchdog can react). Refuse any single byte buffer larger than the
 * memory limit. Only this worker's globals are changed.
 */
let refusedAllocation = false;
if (job.memoryMb) {
  const max = job.memoryMb * 1024 * 1024;
  const guard = <T extends abstract new (...args: never[]) => unknown>(Native: T): T => {
    const guarded: T = new Proxy(Native, {
      construct(target, args: unknown[], newTarget) {
        if (typeof args[0] === "number" && args[0] > max) {
          refusedAllocation = true;
          throw new RangeError(`Refusing to allocate ${Math.round(args[0] / 1024 / 1024)} MB (memory limit ${job.memoryMb} MB).`);
        }
        return Reflect.construct(target as never, args, newTarget === guarded ? target : newTarget) as object;
      },
    });
    return guarded;
  };
  globalThis.Uint8Array = guard(Uint8Array);
  globalThis.ArrayBuffer = guard(ArrayBuffer);
}

// Imported after the guard is in place.
const { extractInProcess } = await import("./index.js");
let result: ExtractResult = await extractInProcess(job.data, job.filename, job.mimeType, job.opts);
if (refusedAllocation) {
  result = {
    kind: "unsupported",
    format: path.extname(job.filename).replace(".", "").toLowerCase() || "unknown",
    truncated: false,
    note: `This file is too large to read here (memory limit ${job.memoryMb} MB). Use save_attachment to open it.`,
  };
}
parentPort!.postMessage(result);
