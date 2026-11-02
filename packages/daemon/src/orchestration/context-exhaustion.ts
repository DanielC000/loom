import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { resolveTranscriptFile, type TranscriptHarness } from "../sessions/transcript.js";
import { detectContextExhaustionInTail, type ContextExhaustionMatch } from "../pty/claude-transcript.js";

/**
 * Card 66ff7321 (part C of 8c7dfc65) — a small, INDEPENDENT, stateless tail-reader for the
 * context-exhaustion detector. Deliberately does NOT share state/offsets with c5b234aa's mid-turn ctx
 * sampler or 22072f12's planned shared incremental tail-reader plumbing (manager ruling, 2026-11-02,
 * card 66ff7321) — it re-reads the last CONTEXT_EXHAUSTION_TAIL_BYTES of the CURRENT transcript file
 * fresh on every call, resolving the path from the LIVE engineSessionId/cwd the caller passes in, so
 * an engine-session-id rotation (card 8a5bd0d0) is always followed. A future consolidation into
 * 22072f12's shared reader should fold this bounded read in, not duplicate it a third time.
 */
export const CONTEXT_EXHAUSTION_TAIL_BYTES = 65536;

/** Read the last `maxBytes` of `file` — never throws; a missing/unreadable file reads as "". */
function readTailBytes(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort */ } }
  }
}

/**
 * Bounded tail-read + detect, in one call. `harness` mirrors `Session.harness` — omit/pass "claude"
 * for a claude-harness session; a codex session's transcript is a different wire format entirely
 * (out of scope for this card) and simply never matches, so callers don't need a separate guard here,
 * though they should still skip calling this for a codex worker to avoid a wasted read.
 */
export function checkContextExhaustion(
  cwd: string, engineSessionId: string | null | undefined, harness?: TranscriptHarness,
): ContextExhaustionMatch | null {
  if (!engineSessionId) return null;
  const file = resolveTranscriptFile(cwd, engineSessionId, harness);
  if (!file) return null;
  const tail = readTailBytes(file, CONTEXT_EXHAUSTION_TAIL_BYTES);
  if (!tail) return null;
  return detectContextExhaustionInTail(tail);
}
