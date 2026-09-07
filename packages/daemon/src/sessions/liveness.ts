import type { Db } from "../db.js";
import { engineTranscriptExists } from "./transcript.js";
import { claudeAdapter } from "../pty/claude-adapter.js";
import { codexAdapter } from "../pty/codex-adapter.js";

/**
 * Dead-ID detection (§12-Q5). A stored session is unresumable once its engine transcript
 * JSONL disappears from ~/.claude/projects. Proactively mark such sessions dead so the UI
 * greys them out BEFORE the user clicks resume — file-existence is the primary trigger
 * (resume-failure is only a backstop, in SessionService.resume).
 */
export function sweepDeadSessions(db: Db): number {
  let marked = 0;
  for (const s of db.listResumeCandidates()) {
    if (s.engineSessionId && !engineTranscriptExists(s.cwd, s.engineSessionId)) {
      db.setResumability(s.id, "dead");
      marked++;
    }
  }
  return marked;
}

/**
 * Watch the engine's transcript store; re-sweep when a transcript is removed (debounced). The watch
 * MECHANISM (which directory, what to debounce, how to survive a transient FS error) is claude-specific
 * and lives behind the `HarnessAdapter` seam (card 2b099e48) — routed through `claudeAdapter.watchLiveness`
 * (Code Review B1: this is the seam's real consumer, not just its own module) rather than importing
 * `pty/claude-doctrine.ts#watchClaudeLiveness` directly. This function owns only the generic "what to do
 * when it fires" — re-sweep this DB's dead-session bookkeeping. Return type inferred from the adapter's
 * own `watchLiveness` signature (Code Review B3: no cast — the prior `as FSWatcher` compiled today only
 * because `watchClaudeLiveness` happened to return one; it would have silently mistyped a future `null`
 * return as a live watcher and thrown at the caller's `.close()` instead of failing the build).
 */
export function watchClaudeProjects(db: Db, onChange?: (marked: number) => void) {
  return claudeAdapter.watchLiveness(() => { const n = sweepDeadSessions(db); if (n > 0) onChange?.(n); });
}

/**
 * Code Review M6 (card 353f6dc4): the codex sibling of {@link watchClaudeProjects} — same generic
 * `sweepDeadSessions` re-sweep, watching `~/.codex/sessions` (`codexAdapter.watchLiveness`) instead of
 * `~/.claude/projects`. `codexAdapter` was previously defined but imported by NOTHING in the real serving
 * code — this is the first real consumer, mirroring `claudeAdapter`'s own usage above exactly. Currently a
 * near-no-op in practice: `sweepDeadSessions` only acts on a session whose `engineSessionId` is already
 * set, and nothing yet populates `engineSessionId` for a codex session (codex has no SessionStart-hook
 * equivalent to report it the way claude's does) — a separate, larger, disclosed gap (see the multi-harness
 * parity matrix's own "Known gaps" note) that also means `worker_transcript` cannot yet read a codex
 * session's transcript at all, independent of this watcher. Wiring this now costs nothing and means the
 * day `engineSessionId` capture lands, dead-session detection for codex starts working with no further
 * change here.
 */
export function watchCodexSessions(db: Db, onChange?: (marked: number) => void) {
  return codexAdapter.watchLiveness(() => { const n = sweepDeadSessions(db); if (n > 0) onChange?.(n); });
}
