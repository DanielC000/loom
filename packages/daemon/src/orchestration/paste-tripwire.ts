/**
 * Bare-pasted-text-placeholder tripwire (card eef4883c originally DETECTION ONLY; card 0f9268cc adds a
 * one-shot RECOVERY on top).
 *
 * Background: 8a39f544 investigated owner pastes arriving over the Companion as a bare
 * `[Pasted text #N +M lines]` placeholder (silent content loss) and traced it to a transient UPSTREAM
 * `claude` CLI race pinned to v2.1.212 (fixed by 2.1.215) — NOT a Loom `submit()`/`writeChunked()` write
 * defect. No production write-fix was warranted. But the failure was SILENT — the owner lost paste
 * content with no signal — so this module gives a recurrence of the same class a detectable signal
 * instead of vanishing unnoticed. Card 0f9268cc confirmed a DIFFERENT recurrence (claudeVersion 2.1.217,
 * past the 2.1.215 "fix") and, having ruled out PREVENTION (see host.ts's Stop-hook call site for why),
 * added automatic one-shot RECOVERY: re-inject the lost content as a corrective turn.
 *
 * This module is pure (no fs / no host state) so it unit-tests deterministically; host.ts calls it from
 * the Stop/StopFailure hook chokepoint with the turn's submitted text — `live.lastRawSubmit ?? live.
 * lastPrompt` (card 0f9268cc: the raw-terminal channel's baseline when set, else the structured submit()
 * channel's — see `Live.lastRawSubmit`'s doc for why the raw channel needed its own tracking) — and the
 * transcript's recorded turn text for that SAME turn (`ContextStats.lastUserText`).
 */

/**
 * Matches a placeholder-shaped token like "[Pasted text #3]" or "[Pasted text #3 +12 lines]" — ANYWHERE in
 * the recorded text, not just when it's the WHOLE string. Card 0f9268cc widened this from a whole-string-
 * only anchor: a composer message that mixes typed instructions with a paste (e.g. "Following up on:
 * [Pasted text #5 +3 lines] — see above") collapses exactly the same real content as a bare placeholder
 * does, and a plain-textarea web composer makes that mixed shape common — the old anchored regex missed it
 * entirely (see test (c), flipped from a negative to a positive case by this same change).
 */
const PLACEHOLDER_RE = /\[Pasted text #\d+[^\]]*\]/;

/**
 * Below this size (and single-line), the CLI's paste-collapse can't plausibly have produced a
 * placeholder — the interactive TUI only ever collapses a paste that is itself long or multi-line (see
 * the real-CLI findings cited in submit()'s doc comment, card ee082fbb). So a SHORT single-line submit
 * that happens to contain placeholder-shaped text is real typed/authored content, not a collapse
 * artifact, and must not trip the tripwire.
 */
export const PASTE_COLLAPSE_MIN_CHARS = 200;

/** Could the CLI's own paste-collapse plausibly have produced a placeholder for this submitted text? */
export function couldCliCollapseToPlaceholder(submittedText: string): boolean {
  return submittedText.includes("\n") || submittedText.length >= PASTE_COLLAPSE_MIN_CHARS;
}

/** Does `recordedText` CONTAIN a `[Pasted text #N...]` placeholder — whole-string OR embedded in other typed text? */
export function isBarePastedTextPlaceholder(recordedText: string): boolean {
  return PLACEHOLDER_RE.test(recordedText.trim());
}

/**
 * Trips iff ALL hold: (1) the submitted turn was long/multi-line enough that the CLI's collapse could
 * plausibly apply, (2) the transcript's recorded turn text for that same turn contains a placeholder —
 * anywhere in the text, not only when it's the text's entirety, and (3) that EXACT placeholder substring
 * is ABSENT from the submitted text.
 *
 * (3) is a false-positive guard, added after the embedded-match widening ((2), card 0f9268cc) was
 * validated against the real transcript corpus (18140 user turns) and found 18 embedded-match hits — ALL
 * of them someone (a worker report, a manager message, this very bug's own investigation) literally
 * TYPING the phrase "[Pasted text #N...]" while discussing this bug, not an actual CLI collapse. A
 * placeholder token is CLI-GENERATED: a genuine collapse artifact can, by construction, never appear in
 * the text Loom itself wrote to the pty — only in what the transcript records back. So if the SAME literal
 * substring is already present in `submittedText`, it was authored/typed, not collapsed, and must not
 * trip. This is a discriminating FIELD (checked from data already in hand), not a suppressing filter of
 * unknown correctness — see the project's own standing lesson on that distinction before touching this
 * again: over-suppressing (dropping ANY embedded match) would silently re-hide the very case (2) exists to
 * catch; this check only rules out the one shape that's structurally impossible to be a real collapse.
 *
 * KNOWN RESIDUAL (considered, accepted — not a gap to rediscover): guard (3) can over-suppress in one
 * narrow, coincidental case. If the submitted text happens to literally CONTAIN the exact token the CLI
 * then independently assigns on collapse (e.g. someone pastes a bug report about THIS bug, and the CLI's
 * own placeholder numbering — "#N" — happens to land on a value already quoted somewhere in that same
 * text), both submittedText and recordedText contain the identical substring for two UNRELATED reasons,
 * and the guard wrongly reads that as "authored, not collapsed" — a real loss goes unflagged. This needs
 * the collapsed-to N to coincide with an N already quoted in the content itself; rare enough to accept
 * rather than engineer around (any fix would need to distinguish WHY the substring is present, which
 * isn't derivable from these two strings alone).
 *
 * Either text arg missing (no submitted text captured, or no recorded user turn read back) → false —
 * there's nothing to compare.
 */
export function detectBarePastePlaceholderTripwire(
  submittedText: string | null | undefined,
  recordedText: string | null | undefined,
): boolean {
  if (!submittedText || !recordedText) return false;
  if (!couldCliCollapseToPlaceholder(submittedText)) return false;
  const match = recordedText.trim().match(PLACEHOLDER_RE);
  if (!match) return false;
  return !submittedText.includes(match[0]);
}

/**
 * Tag prefixed to a one-shot corrective re-injection (card 0f9268cc). Its ONLY job is making the recovery
 * turn recognizable to itself: `isPasteRecoveryAttempt` checks a LATER submittedText against this prefix
 * so host.ts's Stop-hook call site can tell "an ORIGINAL turn just collapsed" (schedule ONE recovery)
 * apart from "the RECOVERY re-injection ALSO collapsed" (escalate instead of recovering again — the
 * one-shot bound). This is pure content-based state — no counter/flag on `Live` to leak across turns —
 * so it's inherently correct across cases where an unrelated turn lands in between.
 */
export const PASTE_RECOVERY_TAG = "[loom:paste-recovery]";

/** Was `submittedText` itself a one-shot recovery re-injection, not an original human/agent turn? */
export function isPasteRecoveryAttempt(submittedText: string): boolean {
  return submittedText.startsWith(PASTE_RECOVERY_TAG);
}

/**
 * Build the one-shot corrective re-injection for a detected loss. `originalText` is the ORIGINAL
 * submittedText that collapsed (host.ts's `live.lastRawSubmit ?? live.lastPrompt` at detection time) —
 * Loom already holds the full text it wrote to the pty; the CLI is what failed to preserve it, so
 * resending it costs nothing new to reconstruct. Carries `PASTE_RECOVERY_TAG` so a second collapse on
 * THIS text is recognized by `isPasteRecoveryAttempt` instead of triggering a third attempt.
 */
export function buildPasteRecoveryText(originalText: string): string {
  return `${PASTE_RECOVERY_TAG} Your previous message's pasted content was lost to a CLI paste-collapse bug before you could see it — resending the original content now:\n\n${originalText}`;
}
