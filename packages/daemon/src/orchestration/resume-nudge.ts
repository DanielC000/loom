/**
 * The shared tail appended to EVERY auto-resume nudge — both the daemon-restart fleet resume
 * (`resumeFleetOnBoot` in sessions/service.ts) AND the crash-recovery watchdog's bounded auto-resume
 * (crash-recovery-watcher.ts). ONE source of the string (DRY): any `claude --resume` hits the SAME
 * engine-state-reset facts, so the resumed agent acts deliberately instead of being surprised.
 *
 * @decision a305669e — `--resume` starts on a NEW pty; the OLD one's whole process tree (background
 *  shells + file-read tracking) dies with it, host-wide on ANY restart/crash-resume — no daemon API
 *  exists to checkpoint or restore either, so this nudge discloses the loss instead of recovering it.
 *  @decision 0edda303 — the background-shells-killed claim above excludes a DELIBERATELY DETACHED child
 *  (e.g. the tracked dev-server helper) — narrow the CLAIM to the old pty's tree, never widen what gets
 *  killed to include detached children; the detachment is deliberate and such a child can survive.
 *  @decision 5d8dea5f — no bare-"Continue" disclaimer here: the daemon sends exactly ONE resume turn
 *  (this nudge itself), so there is nothing else to reconcile against — never reintroduce one.
 */
export const RESUME_NUDGE_TAIL =
  ' (Note: this restart reset your file-read tracking — Read a file again before you Edit it, or the edit ' +
  'is rejected as "not read yet". It also killed terminal-tied background shells (a status check now reads ' +
  '<status>killed</status>, expected) — but not a DETACHED process such as a tracked dev-server helper; ' +
  'check before any install step.)';

/**
 * The explicit, machine-checkable ORIGINATOR CLASS folded into every `[loom:daemon-restarted]` notice,
 * right after the tag. Composed at exactly the two sites that ever emit this tag, and nowhere else:
 * `RESTART_ORIGIN_AGENT` — sessions/service.ts's `resumeFleetOnBoot` (fires iff a `daemon_restart` tool
 * call captured a `RestartIntent` before exiting; `index.ts`'s boot branch is a strict, mutually
 * exclusive if/else, and the supervisor's own exit-75 relaunch is not a third shape here since
 * `RESTART_EXIT_CODE=75` is written only by `requestDaemonRestart`, which always writes the intent
 * first). `RESTART_ORIGIN_UNKNOWN` — `recoverCrashOrphanedWorkers`'s `cleanStop` branch only; the
 * SIBLING no-marker-at-all branch (`[loom:crash-recovered]`) deliberately carries no such clause, since
 * it already states an unambiguous non-agent cause in its own prose.
 *
 * @decision 7d3899cb — the notice states an ORIGINATOR CLASS (agent-initiated vs unknown), never a
 *  project/session/agent identity: a bare no-intent boot reads as unknown, never an invented
 *  `owner-initiated` label — it can never be distinguished from a genuine crash at boot.
 */
export const RESTART_ORIGIN_AGENT = "(origin: agent-initiated — a daemon_restart tool call)";
export const RESTART_ORIGIN_UNKNOWN =
  "(origin: unknown — no restart-intent was captured, so this could be a deliberate stop or a crash; " +
  "the daemon cannot tell which, and it was NOT triggered by an agent's daemon_restart call)";

/**
 * CONDITIONAL companion to RESUME_NUDGE_TAIL — appended only for a session whose raw-terminal composer
 * held an unsent human draft at restart-capture time (RestartResumeEntry.hadUnsentDraft, set from
 * PtyHost.isComposerDirty in liveFleetResumeSet). Unlike RESUME_NUDGE_TAIL's two facts (always true of
 * every resume), this one is true only for THAT session, so it is NOT folded into the shared tail.
 *
 * @decision sha:79af3725 — a SUBMITTED paste is durable across `--resume`; only a never-submitted draft
 *  is genuinely, silently lost — never conflate the two, and never guess at what a lost draft said.
 *  @decision 16c50cdd — durability re-validated against the REAL companion/system delivery path
 *  (`enqueueStdin`→`submit()`→`writeChunked()`), not just a raw-terminal write — the raw-write probe
 *  alone was not proof this path holds too; treat it as settled, not needing re-litigation.
 *  @decision 94721f95 — RETRACTED: the paste-tripwire race is a RECURRING upstream CLI issue across
 *  engine versions (measured: 53 recurrences at claude 2.1.220), not a closed 2.1.212 incident — if it
 *  resurfaces, suspect this same upstream race before assuming a new Loom write-path regression.
 */
export const DRAFT_LOSS_NOTE =
  ' (Note: at the moment of this restart you had an UNSENT draft sitting in your raw-terminal input box — ' +
  'never submitted, so it is not part of your resumed history. This is commonly a large pasted block of ' +
  'text, which the terminal may have shown collapsed as "[Pasted text #N]" before it could be sent. That ' +
  'draft did NOT survive the restart. If it comes up, or you see any "[Pasted text #N]"-style mention with ' +
  'no real content behind it, do not guess at what it said — tell whoever is asking that it was lost in the ' +
  'restart and ask them to resend it.)';

/**
 * The shared body of the "you reported blocked, don't resume as if nothing happened" nudge.
 * `deriveAwaitingReview` (report-resolution.ts) unified WHETHER a worker resumes into this branch, but
 * the resume TEXT itself used to stay independent literal copies across several call sites (the
 * daemon-restart boot path, the crash boot path's two `cleanStop` variants, and the crash-recovery
 * watchdog's isolated-resume path, each in `sessions/service.ts` or
 * `orchestration/crash-recovery-watcher.ts`) — so a re-wording on one path could silently drift from the
 * others with nothing to catch it. This function is now the ONE place that sentence is written.
 *
 * `prefix` carries everything that's genuinely specific to the call site — the `[loom:tag]` and the
 * lead-in sentence describing HOW the daemon/session came back (e.g. "The daemon was rebuilt + restarted
 * and you were resumed.", or "Your session died unexpectedly and Loom auto-resumed it.") — and is
 * prepended verbatim, with a separating space. `extra` is appended after the final period with NO
 * separator (matching every existing call site's own concatenation, e.g. the boot-diagnostics clause,
 * which already opens with its own leading space); omit it where a call site has nothing to add.
 * Deliberately does NOT include {@link RESUME_NUDGE_TAIL} or `draftNote` — callers append those
 * themselves, since not every call site attaches them the same way (the watchdog path appends
 * RESUME_NUDGE_TAIL to the built note afterward rather than inline).
 *
 * @decision cfffeda6 — this function exists so the blocked-resume sentence is written in exactly ONE
 *  place; never re-word it at an individual call site or add a new site with its own literal copy —
 *  edit `buildBlockedResumeNudgeBody` here, the one place it's written, not a loose regex elsewhere.
 *  @decision db05e657 — the underlying ruling this text implements: a recovered `blocked` worker gets
 *  this distinct nudge, never the generic continue-nudge, and never silence.
 *  @decision 24ed1edc — the SAME ruling reaches the crash-recovery watchdog's RUNTIME resume path too,
 *  not just the two boot paths — never re-implement it independently there.
 */
export function buildBlockedResumeNudgeBody(prefix: string, extra = ""): string {
  return `${prefix} Your last report to your manager was worker_report(blocked) — you are still waiting ` +
    `on an answer, not mid-work. Re-state your blocker to your manager (worker_report again) rather than ` +
    `resuming the task as if nothing happened.${extra}`;
}
