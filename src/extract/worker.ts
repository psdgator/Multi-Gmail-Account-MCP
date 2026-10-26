import { parentPort, workerData } from "node:worker_threads";
import { extractInProcess, ExtractOptions } from "./index.js";

/**
 * Runs one attachment extraction off the main thread (see extractAttachment).
 * Anything a parser prints goes to stderr: the parent pipes this worker's
 * stdout and stderr to its own stderr, never to its stdout.
 */
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

const job = workerData as { data: Uint8Array; filename: string; mimeType: string; opts: ExtractOptions };
const result = await extractInProcess(job.data, job.filename, job.mimeType, job.opts);
parentPort!.postMessage(result);
