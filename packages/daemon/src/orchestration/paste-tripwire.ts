/**
 * Bare-pasted-text-placeholder tripwire (card eef4883c) — DETECTION ONLY.
 *
 * Background: 8a39f544 investigated owner pastes arriving over the Companion as a bare
 * `[Pasted text #N +M lines]` placeholder (silent content loss) and traced it to a transient UPSTREAM
 * `claude` CLI race pinned to v2.1.212 (fixed by 2.1.215) — NOT a Loom `submit()`/`writeChunked()` write
 * defect. No production write-fix was warranted. But the failure was SILENT — the owner lost paste
 * content with no signal — so this module gives a FUTURE recurrence of the same class a detectable
 * signal instead of vanishing unnoticed.
 *
 * This module is pure (no fs / no host state) so it unit-tests deterministically; host.ts calls it from
 * the Stop/StopFailure hook chokepoint with the turn's submitted text (`live.lastPrompt`) and the
 * transcript's recorded turn text for that SAME turn (`ContextStats.lastUserText`).
 */

/** Matches a placeholder-shaped token like "[Pasted text #3]" or "[Pasted text #3 +12 lines]" and NOTHING else. */
const BARE_PLACEHOLDER_RE = /^\[Pasted text #\d+[^\]]*\]$/;

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

/** Is `recordedText` NOTHING BUT a `[Pasted text #N...]` placeholder — not one embedded in other text? */
export function isBarePastedTextPlaceholder(recordedText: string): boolean {
  return BARE_PLACEHOLDER_RE.test(recordedText.trim());
}

/**
 * Trips iff BOTH hold: (1) the submitted turn was long/multi-line enough that the CLI's collapse could
 * plausibly apply, and (2) the transcript's recorded turn text for that same turn is ENTIRELY a bare
 * placeholder. Either arg missing (no submitted text captured, or no recorded user turn read back) →
 * false — there's nothing to compare.
 */
export function detectBarePastePlaceholderTripwire(
  submittedText: string | null | undefined,
  recordedText: string | null | undefined,
): boolean {
  if (!submittedText || !recordedText) return false;
  return couldCliCollapseToPlaceholder(submittedText) && isBarePastedTextPlaceholder(recordedText);
}
