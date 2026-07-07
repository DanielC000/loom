// A small, dependency-free, size-bounded rotating log file. Node built-ins only.
//
// Why not fs.createWriteStream: rotation needs to rename the file out from under an open handle,
// which is fragile on Windows (an open WriteStream can hold an exclusive lock, and .end() is async
// so a rename could race the flush). Synchronous appendFileSync sidesteps that entirely — no handle
// is ever held across a rotate, at the cost of a blocking write per chunk. That trade is fine here:
// this is a diagnostic sink for daemon output, not a request hot path.
import fs from "node:fs";
import path from "node:path";

/**
 * Create a rotating log sink. `basePath` is the live file; on overflow it shifts basePath -> .1 ->
 * .2 -> … up to `maxFiles` total (the oldest beyond that is dropped), so total disk usage is bounded
 * at roughly `maxBytes * maxFiles`. Returns `{ append(chunk) }` — append is synchronous, best-effort,
 * and NEVER throws (a failed diagnostic write must never take down its caller).
 */
export function createRotatingLog({ basePath, maxBytes, maxFiles }) {
  let size = null; // lazily read from disk on first append, so construction never touches fs

  function rotate() {
    try {
      for (let i = maxFiles - 1; i >= 1; i--) {
        const src = i === 1 ? basePath : `${basePath}.${i - 1}`;
        const dst = `${basePath}.${i}`;
        if (!fs.existsSync(src)) continue;
        fs.rmSync(dst, { force: true }); // Windows renameSync fails if the destination exists
        fs.renameSync(src, dst);
      }
    } catch (err) {
      console.error(`[rotating-log] rotate failed for ${basePath} (continuing): ${err.message}`);
    }
  }

  return {
    append(chunk) {
      try {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (text.length === 0) return;
        fs.mkdirSync(path.dirname(basePath), { recursive: true });
        if (size === null) size = fs.existsSync(basePath) ? fs.statSync(basePath).size : 0;
        if (size + text.length > maxBytes) {
          rotate();
          size = 0;
        }
        fs.appendFileSync(basePath, text);
        size += text.length;
      } catch (err) {
        console.error(`[rotating-log] append failed for ${basePath} (continuing): ${err.message}`);
      }
    },
  };
}
