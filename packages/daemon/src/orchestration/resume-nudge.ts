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

/**
 * Bound applied to every captured resume-failure reason before it's written into a durable event's
 * `detail` (`fleet_resume_failed`/`manager_crash_resume_failed`, sessions/service.ts). `resume()`'s own
 * 7 direct throw sites are short, static, identity-free strings ("session has no engine id to resume",
 * …) — but `resume()` also RE-THROWS whatever its `pty.spawn()` call (and everything it calls in turn,
 * e.g. `pty/claude-settings.ts`/`pty/claude-config.ts`) throws, and THOSE can carry an absolute host path
 * or a full session uuid (Code Review, card ee05750e B1/B2 — measured: an `EPERM …rename 'C:\Users\<real
 * username>\...'` message). This length bound alone does NOT redact that — see
 * {@link RESUME_KNOWN_SAFE_REASONS} and `normalizeResumeOneResult`'s own allowlist, the actual redaction
 * boundary; this constant only bounds the SIZE of whatever survives that allowlist.
 */
export const RESUME_FAILURE_REASON_MAX_CHARS = 200;

/**
 * Fail-closed ALLOWLIST of `resume()`'s own 7 static throw messages (sessions/service.ts) — the only
 * reason strings `normalizeResumeOneResult` ever passes through verbatim. Anything else (whatever
 * `resume()` re-throws from its `pty.spawn()` call, e.g. an OS error naming a host path or a session
 * uuid) is replaced with a generic, identity-free fallback. Deliberately an ALLOWLIST, not a
 * pattern-based stripper (Code Review B1: a redaction boundary must fail CLOSED — a pattern-stripper is
 * defeated by the first message shape nobody anticipated). The full, unsanitized message still reaches
 * the daemon log via each caller's own `console.warn` (host-local, never pushed to chat), so diagnosis
 * survives; only the chat/durable-event surface is sanitized.
 */
export const RESUME_KNOWN_SAFE_REASONS: ReadonlySet<string> = new Set([
  "session not found",
  "session has no engine id to resume",
  "session is no longer resumable (engine transcript missing)",
  "session is no longer resumable (worktree/cwd missing)",
  "session was recycled — a successor exists; only a manual (human) resume may force it",
  "session was administratively retired (its recycle successor was superseded by the predecessor) — only a manual (human) resume may force it",
  "project not found",
]);

/** The sanitized stand-in for any resume-failure reason NOT on {@link RESUME_KNOWN_SAFE_REASONS}. */
export const RESUME_UNKNOWN_REASON_FALLBACK = "unexpected error during resume";

/**
 * A `resumeOne` callback's return value — legacy callers (every existing test, and any future one) still
 * return a bare `boolean`; production's own default (sessions/service.ts) now returns the richer shape so
 * the real thrown message survives past it. `boolean` stays valid (`ok` with no `reason`) so no existing
 * caller needs to change.
 */
export type ResumeOneResult = boolean | { ok: boolean; reason?: string };

/**
 * Normalize a `resumeOne` result to `{ ok, reason }` — the ONE place both `resumeFleetOnBoot` and
 * `recoverCrashOrphanedWorkers` funnel a resume outcome through, so neither can forget the redaction or
 * the bound. `reason` is sanitized against the {@link RESUME_KNOWN_SAFE_REASONS} allowlist BEFORE being
 * truncated to {@link RESUME_FAILURE_REASON_MAX_CHARS} — an unrecognized reason (Code Review B1: anything
 * `resume()` re-throws from `pty.spawn()`, not just its own 7 static messages) becomes
 * {@link RESUME_UNKNOWN_REASON_FALLBACK} rather than being stored/rendered verbatim.
 */
export function normalizeResumeOneResult(r: ResumeOneResult): { ok: boolean; reason?: string } {
  // Code Review N1: an untyped .mjs stub returning undefined/null (or any non-object, non-boolean value)
  // used to mean "failed" under the old bare-boolean contract — treat it the same way here rather than
  // throwing a TypeError out of the un-wrapped resume loop (which would abort the entire fleet resume).
  if (!r || typeof r !== "object") return { ok: !!r };
  if (!r.reason) return { ok: r.ok };
  const safeReason = RESUME_KNOWN_SAFE_REASONS.has(r.reason) ? r.reason : RESUME_UNKNOWN_REASON_FALLBACK;
  const reason = safeReason.length > RESUME_FAILURE_REASON_MAX_CHARS
    ? `${safeReason.slice(0, RESUME_FAILURE_REASON_MAX_CHARS - 1)}…`
    : safeReason;
  return { ok: r.ok, reason };
}
