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
 *   IN-FLIGHT BACKGROUND SHELLS KILLED (PL Auditor finding a305669e) — a `--resume` is a NEW engine process
 *   attached to a NEW pty; the OLD pty (and everything node-pty's orphan-free containment (Job Object /
 *   process-group) was keeping alive under it — including any `run_in_background` Bash shells the agent had
 *   started) dies with it. This is OS-level process-tree teardown, not a Loom choice, and applies to EVERY
 *   live session torn down by the restart/crash — not just the one that caused it. There is no daemon API
 *   into the engine's background-task registry, so checkpointing/draining an arbitrary running shell across
 *   the gap is infeasible; per the same accepted-fallback shape as the file-read note, we NOTE the kill so
 *   the agent expects a bare `<status>killed</status>` on its next poll and re-launches what it still needs
 *   instead of spending a turn diagnosing it as a fresh failure.
 *
 * BARE-CONTINUE DISCLAIMER REMOVED (card 5d8dea5f): the tail used to ALSO carry a paragraph disclaiming the
 * engine's bare "Continue from where you left off." auto-submit (an empty artifact `claude --resume` emits
 * before this nudge for an interrupted transcript). That disclaimer is gone: the daemon contributes EXACTLY
 * ONE resume turn — the `[loom:daemon-restarted]` nudge — and that single turn IS the authoritative resume
 * context, so there is nothing for the agent to reconcile against and no need to spend a sentence on an
 * engine artifact. Removing it keeps the resume system-message to one coherent point (now two related
 * engine-state-reset facts: file-read tracking and in-flight background shells).
 */
export const RESUME_NUDGE_TAIL =
  ' (Note: this restart reset your file-read tracking — Read a file again before you Edit it, or the edit ' +
  'is rejected as "not read yet". It also killed any background shells you had running — a status check on ' +
  'one now returns <status>killed</status>; that\'s expected, not a new failure, so just re-launch what you ' +
  'still need.)';

/**
 * CONDITIONAL companion to RESUME_NUDGE_TAIL — appended only for a session whose raw-terminal composer
 * held an unsent human draft at restart-capture time (RestartResumeEntry.hadUnsentDraft, set from
 * PtyHost.isComposerDirty in liveFleetResumeSet). Unlike RESUME_NUDGE_TAIL's two facts (always true of
 * every resume), this one is true only for THAT session, so it is NOT folded into the shared tail.
 *
 * Real-engine probes (card: pasted-text-attachment-survives-restart) confirmed a SUBMITTED turn's pasted
 * text is fully durable — the engine resolves it to full content before persisting, and `--resume`
 * reconstructs it correctly every time. That original probe (`test/_probe-paste-resume.mjs`) validated this
 * via a single raw `writeStdin` write mimicking a human raw-terminal paste — NOT the companion/system
 * delivery path (`enqueueStdin` → `submit()` → `writeChunked()`, isolated `pty.write` calls for the bracket
 * markers). Task 16c50cdd re-validated the claim against that REAL path (`test/_probe-paste-companion.mjs`,
 * incl. the queued-while-busy/`drainPending` timing companion messages actually use) and it still holds on
 * claude 2.1.215. A real production incident (3 pastes on session 5db71873, all pinned to claude 2.1.212,
 * with zero recurrence across 8 later versions of continued use on the SAME session) showed a submitted
 * companion paste CAN collapse to a bare placeholder with no recoverable text — but that was a transient
 * upstream CLI race around Stop-hook timing, not a Loom defect, and does not reproduce on current tooling.
 * If pastes-losing-content resurfaces, suspect a CLI regression before Loom's write path. The ONE genuine gap
 * this note is actually about is a draft that was pasted/typed but never
 * submitted (Enter not yet pressed) at the moment of the restart: it lives only in the now-dead pty's (and
 * engine's) in-memory composer, commonly collapsed on-screen to a "[Pasted text #N]" placeholder, and is
 * not part of the transcript at all — so it is NOT replayed and NOT recoverable. Without this note that
 * loss is entirely silent (no dangling reference even appears); this makes it explicit instead of leaving
 * the resumed agent to either not notice or guess at content it never actually saw.
 */
export const DRAFT_LOSS_NOTE =
  ' (Note: at the moment of this restart you had an UNSENT draft sitting in your raw-terminal input box — ' +
  'never submitted, so it is not part of your resumed history. This is commonly a large pasted block of ' +
  'text, which the terminal may have shown collapsed as "[Pasted text #N]" before it could be sent. That ' +
  'draft did NOT survive the restart. If it comes up, or you see any "[Pasted text #N]"-style mention with ' +
  'no real content behind it, do not guess at what it said — tell whoever is asking that it was lost in the ' +
  'restart and ask them to resend it.)';
