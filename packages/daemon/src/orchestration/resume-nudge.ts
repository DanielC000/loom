/**
 * PL Auditor finding #11: the shared tail appended to EVERY auto-resume nudge — both the daemon-restart
 * fleet resume (`resumeFleetOnBoot` in sessions/service.ts) AND the crash-recovery watchdog's bounded
 * auto-resume (crash-recovery-watcher.ts). ONE source of the string (DRY): any `claude --resume` — whether
 * the whole fleet on a daemon restart or one stranded/dead session the watcher revives — hits the SAME two
 * engine realities the engine does NOT preserve across the resume, so the resumed agent acts deliberately
 * instead of being surprised:
 *
 *   1. FILE-READ TRACKING RESET — the engine's per-session "you have Read this file" set is in-memory state
 *      that a `--resume` does NOT restore (confirmed first-hand: a post-resume Edit reports "File has not
 *      been read yet"). The daemon has NO API into that engine-internal state, so preserving it is infeasible;
 *      per the card's accepted fallback we NOTE the reset so the agent re-Reads intentionally before editing.
 *
 *   2. BARE-CONTINUE ABSORPTION (the "merge") — a session that was mid-turn when its pty was killed (e.g. the
 *      daemon-restart requester, which is mid-`daemon_restart`-call; or a worker that crashed mid-work) is
 *      auto-continued by the engine with a bare "Continue from where you left off." turn that lands BEFORE
 *      this nudge. That turn is an empty engine artifact the daemon can neither author nor suppress (it's not
 *      a Loom string — it originates in `claude --resume` of an interrupted transcript). Rather than leave the
 *      agent with a no-op turn THEN the real one, this single nudge is declared the authoritative resume
 *      context and MERGES the bare continue into itself: the agent is told to treat any preceding bare
 *      "continue" as the same turn. Phrased conditionally ("if … just before this") so it stays accurate for
 *      an idle session that was NOT mid-turn and therefore never saw one.
 */
export const RESUME_NUDGE_TAIL =
  ' (Note: this restart reset your file-read tracking — Read a file again before you Edit it, or the edit ' +
  'is rejected as "not read yet". And if your client auto-submitted a bare "Continue from where you left ' +
  'off." turn just before this message, that was an empty resume artifact with no content — THIS message is ' +
  'your resume context; treat them as a single turn.)';
