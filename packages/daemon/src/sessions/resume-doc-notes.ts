import fs from "node:fs";
import path from "node:path";

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

/** Platform default resume-doc basename — Loom's own convention (mirrors `PLATFORM_DEFAULTS.orchestration.resumeDocFilename`). */
export const DEFAULT_RESUME_DOC_FILENAME = "Orchestrator Log.md";

/**
 * Card c1f2f095 — resolve a project's manager resume-doc ABSOLUTE path from its vault dir + an optional
 * per-project `orchestration.resumeDocFilename` override. The ONE resolution function both
 * `composeManagerStartupPrompt` (spawn/recycle time) and `ResumeDocWatcher` (mid-session) call, so the
 * daemon-injected "Resume doc:" path and the size-watchdog's own check can never derive two different
 * answers — closing the drift this card exists to fix (a hand-written prompt line, or a second hardcoded
 * derivation, silently diverging from the real file on disk).
 *
 * Defense-in-depth: `filenameOverride` is ALREADY validated as a strict bare filename (no separators, no
 * `..`) by the agent-facing config schema (`mcp/platform.ts`'s `resumeDocFilenameSchema`) before it's ever
 * stored — but this resolver re-checks the joined result independently, rather than trusting that
 * upstream gate alone: if the resolved path ever ends up outside `vaultPath` (a bypassed/corrupted stored
 * value — e.g. a direct DB edit, or a future caller that skips the validator), it silently falls back to
 * the default filename rather than let the daemon vouch for an escaped path in a TRUSTED prompt block.
 */
export function resolveResumeDocPath(vaultPath: string, filenameOverride?: string | null): string {
  const filename = filenameOverride?.trim() || DEFAULT_RESUME_DOC_FILENAME;
  const resolvedVaultPath = path.resolve(vaultPath);
  const candidate = path.resolve(vaultPath, filename);
  const withinVault = candidate === resolvedVaultPath || candidate.startsWith(resolvedVaultPath + path.sep);
  if (!withinVault) return path.join(vaultPath, DEFAULT_RESUME_DOC_FILENAME);
  return path.join(vaultPath, filename);
}

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
