import fs from "node:fs";

/**
 * Shared resume-doc size-warning check (card 809cc4b5) — factored out of `platform-lead-prompt.ts`'s
 * `composeResumeDocOperationalNotes` so the SAME check + threshold + message covers both the Platform
 * Lead's resume doc AND a project manager's `Orchestrator Log.md`, instead of drifting into two
 * near-duplicate implementations.
 *
 * Threshold derivation: a real Loom resume doc broke the harness `Read` tool at 60,522 bytes / ~26.6k
 * tokens (~2.3 bytes/token for dense markdown) — well under the 256KB byte cap but already past the
 * tighter ~25k-token cap, which is the one that actually bites. That puts the real break point around
 * ~57KB for prose this dense. Warn with real margin below THAT, not just under the byte cap.
 */
export const RESUME_DOC_WARN_BYTES = 45 * 1024;

/**
 * Returns a `[loom:resume-doc-size]` warning note if `absPath` exists and is at/over
 * {@link RESUME_DOC_WARN_BYTES}, else `""`. NEVER throws: a missing file (nothing written yet), a
 * permission error, or a locked file all resolve to "nothing to warn about" — this runs on both a
 * spawn-composition path and a periodic watcher tick, neither of which may ever fail on a stat error.
 */
export function resumeDocSizeWarning(absPath: string): string {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size < RESUME_DOC_WARN_BYTES) return "";
    const kb = Math.round(stat.size / 1024);
    return (
      `[loom:resume-doc-size] Your resume doc (\`${absPath}\`) is ~${kb}KB, nearing the harness ` +
      `Read caps (~256KB / ~25k tokens) — a successor's first Read of it could fail. Rotate it now per ` +
      `your doctrine's size budget: move the current doc to \`<name>.archive/<YYYY-MM-DD>-NN.md\`, then ` +
      `start a fresh active doc holding only current state.`
    );
  } catch {
    return "";
  }
}
