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
 *
 * Card 4af5aefa (two live false positives observed by peer managers): the wording used to
 * assert the content "was lost ... before you could see it" — a claim about ENGINE/RECIPIENT
 * VISIBILITY. `detectBarePastePlaceholderTripwire` has no access to that: it only OBSERVES that the
 * transcript recorded a placeholder in place of the submitted text. Evidence is a proxy for the claim,
 * not the claim itself, so the wording now states only what was observed, and hands the recipient the
 * cheap own-artifact check (a reply they sent, a memory write, a turn count) instead of asserting
 * something the notice cannot actually see.
 *
 * Card 2d36337e: the "did you already act on that message?" framing this introduced still had a
 * discriminating-question gap — a real near-miss showed a recipient can truthfully answer "yes, I acted"
 * about a LATER message that built on this one's content, while never having seen THIS message at all.
 * "Have I acted?" and "does something I've done SINCE assume this?" are different questions; only the
 * second one catches a missed premise instead of reading a recovered predecessor as a redundant repeat.
 * The wording now asks the second one.
 */
export function buildPasteRecoveryText(originalText: string): string {
  return `${PASTE_RECOVERY_TAG} The transcript recorded a placeholder instead of your previous message's pasted content — it may not have reached you (a known upstream CLI paste-collapse race; see card eef4883c). Before dismissing this as already-handled: does anything you have done SINCE assume this content, not merely resemble something you recall seeing? A later message can be fully acted-on while still having depended on THIS one — check your own artifact (a reply you sent, a memory write, a turn count) for that, not just whether the topic feels familiar. Otherwise, here is the original content, resent:\n\n${originalText}`;
}

/**
 * Card b68d1f5b DoD-1 — the "compare the placeholder's stated line count against the delivered body"
 * check (adopted from a peer project manager's suggestion). Unlike `detectBarePastePlaceholderTripwire`
 * above (which needs `submittedText` — TEXT LOOM ITSELF WROTE — to compare against), this check works
 * from the RECORDED/delivered side alone: a `[Pasted text #N +M lines]` token surviving into the
 * transcript's recorded turn text always means those M lines never reached the engine (a placeholder is
 * never accompanied by its own expansion — if the paste had gone through, the placeholder wouldn't be
 * there at all). That is what makes it work "regardless of who wrote the text" (card's own framing) —
 * it covers the human-paste path `detectBarePastePlaceholderTripwire` structurally cannot see (a human
 * typing directly into their own terminal has no `submittedText` Loom ever captured).
 *
 * ⛔ HARD CONSTRAINT (card `abeac33a`, folded into `b68d1f5b` 2026-08-04): a naive version of this check
 * — "placeholder present ⇒ report a loss" — FIRES ON A CORRECT SEND. A stale placeholder TOKEN can be a
 * CLI-side rendering ghost: an EARLIER delivery's own placeholder (already fully delivered, at an OLDER
 * `gen`) re-rendering into a LATER, unrelated, correctly-delivered turn's recorded text. Nothing
 * daemon-side replayed it — the re-render is CLI-side — so by the time this check runs, the M lines it
 * names were never actually missing FROM THIS TURN; they were already accounted for, earlier.
 *
 * ✅ THE `gen` DISCRIMINATOR: `findExplainingWrittenGen` searches a bounded, `gen`-ordered history of
 * Loom's OWN writes for ANY entry — current gen or an older one — whose own line count matches the
 * placeholder's stated M. A match means this occurrence is EXPLAINED, one of two ways, and either way
 * this check must stay silent:
 *   - Matches the CURRENT gen's own entry → this is a real, FRESH collapse of THIS turn's own submission
 *     — but `detectBarePastePlaceholderTripwire` above already owns that case (full-text comparison,
 *     already gen-safe by construction, already wired to one-shot recovery). Flagging it again here
 *     would be a duplicate alarm, not a new finding.
 *   - Matches an OLDER gen's entry → the `abeac33a` stale-token ghost. That gen's content is already
 *     known-delivered (Loom wrote it and, if it had actually collapsed back then, the tripwire above
 *     would have already caught and recovered THAT turn) — this later re-appearance is a harmless
 *     CLI-side artifact, not a new loss.
 * Only a placeholder matching NO entry in the history is genuinely UNEXPLAINED — Loom has no record of
 * ever having written text that would produce this token, which is exactly the human/raw-terminal-paste
 * gap this check exists to close (a raw `writeStdin` turn never pushes into this history — only
 * `submit()` does — so a human paste that collapsed client-side is unexplainable by construction and
 * always surfaces here).
 *
 * ⚠️ THE BOUND, STATED EXPLICITLY (Code Review, card b68d1f5b): silence above is guaranteed ONLY for a
 * placeholder whose explaining write is still inside `Live.recentWrittenLineCounts`'s
 * `PASTE_LOSS_EXPLAIN_WINDOW` — beyond it, an explained token reads as unexplained and this check WILL
 * fire on a correct send, exactly the failure mode the hard constraint above names. This is a genuinely
 * SEPARATE, dedicated history from card c2c750a9's `Live.recentWrittenTurns` (8 entries, sized for that
 * detector's own sum+hash CONCATENATION, which needs full TEXT) — reusing that ring's window would have
 * inherited a bound picked for a different job: `abeac33a`'s own worked stale-token specimen was a
 * FIFTEEN-MINUTE gap between the explaining write and its re-render, and whether 8 intervening
 * submissions fit that gap is a property of session traffic, not of this check's logic. Because this
 * history stores only a `gen` plus two small integers per entry (see `WrittenLineCountEntry`) rather than
 * full text, it costs far less per entry than card c2c750a9's ring, which is what justifies giving it a
 * MUCH longer horizon (`PASTE_LOSS_EXPLAIN_WINDOW`, its own doc) without growing `Live`'s footprint the
 * way widening `COMPOSER_ACCUM_WINDOW` itself would have (that ring is card c2c750a9's own field, sized
 * for its own purpose — not this check's to grow as a side effect).
 *
 * ✅ CALIBRATION (card `abeac33a`, five specimens, 128.4–132.3 B/line, all kickoffs delivered intact):
 * `PASTE_LOSS_CALIBRATED_BYTES_PER_LINE` estimates lost BYTES from the placeholder's stated line count
 * for the alert message only — it is NOT part of the detection gate (presence of an unexplained
 * placeholder is itself the whole signal; the byte estimate just makes the alert legible). Deliberately
 * calibrated against PAYLOAD NEWLINES, never wrapped terminal display rows (a fixed 120-column pty only
 * ever ADDS rows via wrapping, so a row-count reading would undercount).
 */
export const PASTE_LOSS_CALIBRATED_BYTES_PER_LINE = 130;

/**
 * Card b68d1f5b Code Review — how many of the most-recent Loom-authored submissions
 * `Live.recentWrittenLineCounts` retains, per session, for `findExplainingWrittenGen`'s lookup above.
 * Deliberately its OWN constant, independent of card c2c750a9's `COMPOSER_ACCUM_WINDOW` (8) — that ring
 * is sized for a DIFFERENT job (its detector needs full TEXT to concatenate-and-hash a contiguous span;
 * this one only needs an unordered "was there EVER a write with this line count" membership test over
 * small integers). Picked 8x c2c750a9's own window — wide enough to meaningfully outlast the 8-entry
 * blind spot the abeac33a specimen's 15-minute gap could fall into, cheap enough (3 small integers per
 * entry vs a full text blob) that the memory argument that bounds THAT ring at 8 simply doesn't apply
 * here. NOT a claim this window is provably sufficient for every real gap — see the bound doc above on
 * `detectPastePlaceholderLengthLoss` for the residual this leaves, honestly stated rather than hidden
 * behind a bigger-sounding number.
 */
export const PASTE_LOSS_EXPLAIN_WINDOW = 64;

/** Matches a placeholder token AND captures its `#N` id plus its stated `+M lines` count (when present)
 *  — unlike `PLACEHOLDER_RE` above, this one only matches occurrences that carry a calibratable count. */
const PLACEHOLDER_WITH_COUNT_RE = /\[Pasted text #(\d+)(?:\s*\+(\d+)\s*lines?)?\]/g;

/**
 * Candidate line-count readings for a known-written text, under the two plausible conventions for what
 * the CLI's own "+M lines" counts (newline-delimited segments, or raw newline occurrences) — both are
 * checked so an off-by-one convention mismatch never turns a genuinely explainable placeholder into a
 * false "unexplained" alarm (the failure direction this whole check exists to avoid). Exported so host.ts
 * can compute the SAME candidates once, at write time, to populate `Live.recentWrittenLineCounts` — this
 * function is the only place that logic lives; the ring stores its OUTPUT (plain integers), never the
 * source text.
 */
export function computeWrittenLineCounts(text: string): number[] {
  const newlines = (text.match(/\n/g) ?? []).length;
  return [newlines, newlines + 1];
}

/** One entry of `Live.recentWrittenLineCounts` — a `gen` plus the candidate line-count readings
 *  `computeWrittenLineCounts` computed for that generation's written text AT WRITE TIME (never the text
 *  itself — see `PASTE_LOSS_EXPLAIN_WINDOW`'s doc for why this history is integer-only). */
export interface WrittenLineCountEntry {
  gen: number;
  lineCounts: readonly number[];
}

/** Does ANY entry in `recentWrittenLineCounts` (any gen — current or older, oldest-evicted at
 *  `PASTE_LOSS_EXPLAIN_WINDOW`) have a line count matching `statedLines`? Returns that entry's `gen` if
 *  so, else `null`. See this file's `gen`-discriminator doc above (on the exported detector below) for
 *  what a match at each position means. */
function findExplainingWrittenGen(
  statedLines: number,
  recentWrittenLineCounts: ReadonlyArray<WrittenLineCountEntry>,
): number | null {
  for (const entry of recentWrittenLineCounts) {
    if (entry.lineCounts.includes(statedLines)) return entry.gen;
  }
  return null;
}

export interface PasteLengthLossCandidate {
  /** The exact placeholder substring as it appeared in the recorded text, e.g. "[Pasted text #12 +21 lines]". */
  token: string;
  /** The CLI-assigned placeholder number ("#N"). */
  placeholderNum: number;
  /** The placeholder's own stated line count ("+M lines"). */
  statedLines: number;
  /** Calibrated estimate only (see `PASTE_LOSS_CALIBRATED_BYTES_PER_LINE`'s doc) — not measured. */
  estimatedBytesLost: number;
}

/**
 * DoD-1's detector. Returns every placeholder occurrence in `recordedText` that is BOTH calibratable (has
 * a stated `+M lines` count) AND unexplained by anything Loom has a record of writing (see the `gen`
 * discriminator doc above, INCLUDING its stated bound) — i.e. a genuine, otherwise-invisible delivery
 * gap. Empty array ⇒ nothing to report (either no placeholder at all, or every one found is explained).
 *
 * `submittedText` is OPTIONAL and, when given, only feeds the SAME false-positive guard
 * `detectBarePastePlaceholderTripwire` already validated (card 0f9268cc, 18140 real transcript turns): a
 * placeholder-shaped substring the sender's own submitted text ALSO contains verbatim was typed/quoted,
 * not CLI-collapsed, and must not be reported as a loss. Passing `null`/`undefined` (the human-paste case
 * this detector exists for — Loom never captured what was typed) simply skips that guard; every other
 * guard (the `gen` discriminator) still applies in full.
 *
 * `recentWrittenLineCounts` is `Live.recentWrittenLineCounts` — the dedicated, integer-only history (see
 * `PASTE_LOSS_EXPLAIN_WINDOW`'s doc), NOT card c2c750a9's `Live.recentWrittenTurns`.
 */
export function detectPastePlaceholderLengthLoss(
  recordedText: string | null | undefined,
  submittedText: string | null | undefined,
  recentWrittenLineCounts: ReadonlyArray<WrittenLineCountEntry>,
): PasteLengthLossCandidate[] {
  if (!recordedText) return [];
  const trimmed = recordedText.trim();
  const out: PasteLengthLossCandidate[] = [];
  for (const match of trimmed.matchAll(PLACEHOLDER_WITH_COUNT_RE)) {
    if (match[2] === undefined) continue; // no stated count ("[Pasted text #N]" alone) — nothing to calibrate against
    const statedLines = Number(match[2]);
    const token = match[0];
    if (submittedText && submittedText.includes(token)) continue; // authored/typed the phrase — same guard as detectBarePastePlaceholderTripwire
    if (findExplainingWrittenGen(statedLines, recentWrittenLineCounts) !== null) continue; // explained — see the gen-discriminator doc above
    out.push({ token, placeholderNum: Number(match[1]), statedLines, estimatedBytesLost: statedLines * PASTE_LOSS_CALIBRATED_BYTES_PER_LINE });
  }
  return out;
}
