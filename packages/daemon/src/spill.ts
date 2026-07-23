import fs from "node:fs";
import path from "node:path";
import { sessionScratchDir } from "./paths.js";

/** Below the cap: nothing was written, the caller inlines its payload as before. */
export interface SpillInline {
  inline: true;
}

/** Above the cap: `text` was written verbatim to `file` (UTF-8, real line breaks) — `chars` is its length. */
export interface SpillFile {
  inline: false;
  file: string;
  chars: number;
}

export type SpillResult = SpillInline | SpillFile;

/**
 * Persist `text` to `sessionId`'s own scratch dir (grep/Read-pageable — UTF-8, written verbatim so any
 * real line breaks the caller already shaped into `text` survive) when it exceeds `capChars`; a no-op
 * ({inline:true}) otherwise, so a caller under the cap is byte-identical to not calling this at all.
 * Deterministic path (`subdir`/`key`, not a fresh name per call) so repeated pulls of the same content
 * overwrite rather than accumulate scratch-dir garbage.
 *
 * Generalizes the pattern `SessionService.spillMergePatch` established for worker_merge's oversized
 * fullDiff (card 605988ab, following auditor finding 8a942a95): Loom decides to spill and controls the
 * format BEFORE a giant string ever reaches the MCP tool-result cap, rather than relying on the host
 * engine's own opaque overflow-spill (which JSON-escapes embedded newlines into a single unpageable
 * line). Callers must hand this ALREADY-shaped plain text — never re-run it through `JSON.stringify`,
 * or the very newlines this exists to preserve get escaped away again.
 */
export function spillTextIfLarge(sessionId: string, subdir: string, key: string, text: string, capChars: number): SpillResult {
  if (text.length <= capChars) return { inline: true };
  const dir = path.join(sessionScratchDir(sessionId), subdir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, key);
  fs.writeFileSync(file, text, "utf8");
  return { inline: false, file, chars: text.length };
}
