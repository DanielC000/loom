/**
 * PL Auditor finding #11: the shared tail appended to EVERY auto-resume nudge — both the daemon-restart
 * fleet resume (`resumeFleetOnBoot` in sessions/service.ts) AND the crash-recovery watchdog's bounded
 * auto-resume (crash-recovery-watcher.ts). ONE source of the string (DRY): any `claude --resume` — whether
 * the whole fleet on a daemon restart or one stranded/dead session the watcher revives — hits the SAME
 * engine reality the engine does NOT preserve across the resume, so the resumed agent acts deliberately
 * instead of being surprised:
 *
 *   FILE-READ TRACKING RESET — the engine's per-session "you have Read this file" set is in-memory state
 *   that a `--resume` does NOT restore (confirmed first-hand: a post-resume Edit reports "File has not
 *   been read yet"). The daemon has NO API into that engine-internal state, so preserving it is infeasible;
 *   per the card's accepted fallback we NOTE the reset so the agent re-Reads intentionally before editing.
 *
 * BARE-CONTINUE DISCLAIMER REMOVED (card 5d8dea5f): the tail used to ALSO carry a paragraph disclaiming the
 * engine's bare "Continue from where you left off." auto-submit (an empty artifact `claude --resume` emits
 * before this nudge for an interrupted transcript). That disclaimer is gone: the daemon contributes EXACTLY
 * ONE resume turn — the `[loom:daemon-restarted]` nudge — and that single turn IS the authoritative resume
 * context, so there is nothing for the agent to reconcile against and no need to spend a sentence on an
 * engine artifact. Removing it keeps the resume system-message to one coherent point (the file-read reset).
 */
export const RESUME_NUDGE_TAIL =
  ' (Note: this restart reset your file-read tracking — Read a file again before you Edit it, or the edit ' +
  'is rejected as "not read yet".)';
