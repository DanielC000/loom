/**
 * Bare-pasted-text-placeholder tripwire. Pure module (no fs / no host state) so it unit-tests
 * deterministically; host.ts calls it from the Stop/StopFailure hook chokepoint with the turn's submitted
 * text — `live.lastRawSubmit ?? live.lastPrompt` (the raw-terminal channel's baseline when set, else the
 * structured submit() channel's) — and the transcript's recorded turn text for that SAME turn
 * (`ContextStats.lastUserText`).
 *
 * @decision 0f9268cc — detects (card eef4883c) then one-shot-recovers a transient upstream `claude` CLI
 *  paste-collapse race (investigated: card 8a39f544) — NOT a Loom write defect, no production write-fix.
 *  Do not treat a recurrence past v2.1.215 as the upstream fix regressing without re-checking claudeVersion.
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

/** The embedded placeholder token substring in `recordedText` (e.g. "[Pasted text #12 +48 lines]"), or
 *  `null` if none is present. Exported so host.ts can extract the SAME token detectBarePastePlaceholderTripwire
 *  matched on, to record it into `Live.recentPlaceholderTokens` (card 2c58bdd3's `gen` discriminator, below)
 *  without duplicating `PLACEHOLDER_RE` at the call site. */
export function matchEmbeddedPlaceholderToken(recordedText: string | null | undefined): string | null {
  if (!recordedText) return null;
  const match = recordedText.trim().match(PLACEHOLDER_RE);
  return match ? match[0] : null;
}

/** One entry of `Live.recentPlaceholderTokens` (card 2c58bdd3) — the EXACT placeholder token string
 *  observed embedded in a turn's recorded transcript text, plus the `gen` of that turn. See
 *  `detectBarePastePlaceholderTripwire`'s own doc for what this history is used for. */
export interface SeenPlaceholderTokenEntry {
  gen: number;
  token: string;
}

/**
 * Card 2c58bdd3 — how many of the most-recent OBSERVED placeholder tokens `Live.recentPlaceholderTokens`
 * retains, per session, for `detectBarePastePlaceholderTripwire`'s `gen` discriminator above. Its own
 * constant, deliberately smaller than the sibling's `PASTE_LOSS_EXPLAIN_WINDOW` (64): that ring holds one
 * entry per `submit()` call (every turn), so a long horizon in TURN COUNT is needed to span a real gap
 * measured in wall-clock time. This ring holds one entry only when a placeholder was actually SEEN in a
 * turn's recorded text — a genuinely rare event (89 firings against a much larger corpus of ordinary
 * turns in the investigation this card is built from) — so the same wall-clock horizon needs far fewer
 * entries. Cheap regardless (a `gen` plus one short string per entry).
 */
export const PASTE_TRIPWIRE_TOKEN_WINDOW = 16;

/**
 * Trips iff ALL hold: (1) the submitted turn was long/multi-line enough that the CLI's collapse could
 * plausibly apply, (2) the transcript's recorded turn text for that same turn contains a placeholder —
 * anywhere in the text, not only when it's the text's entirety, (3) that EXACT placeholder substring is
 * ABSENT from the submitted text, and (4) that EXACT placeholder token wasn't already observed, verbatim,
 * in an OLDER generation's own recorded turn.
 *
 * @decision 0f9268cc — (3) is a discriminating FIELD, not a filter: a placeholder token is CLI-GENERATED,
 *  never present in text Loom itself wrote. Validated against 18140 transcript turns (18 embedded hits, all
 *  typed discussion of this bug) — do not weaken/remove (3) without re-running that validation.
 *
 * ⚠️ KNOWN RESIDUAL, accepted: guard (3) can over-suppress if the CLI's assigned `#N` coincidentally
 *  matches an `#N` already quoted in the pasted content itself (e.g. a bug report about this bug) — rare
 *  enough to accept; not derivable from these two strings alone, so not a gap to rediscover.
 *
 * @decision 2c58bdd3 — (4) guards a stale-render-ghost: an EARLIER generation's own placeholder token can
 *  resurface in a LATER, unrelated turn's recorded text (investigation 773b3914). Matches the WHOLE token
 *  (id+count), never magnitude alone — a magnitude-only match would let unrelated collapses collide.
 *
 * ⛔ Only a token at a generation STRICTLY OLDER than `currentGen` counts as "already observed" — this
 *  function IS the current-gen detector for its own case and must never defer to itself (the sibling
 *  detector above instead defers current-gen collapses TO this function).
 *
 * `currentGen`/`recentPlaceholderTokens` are OPTIONAL — omitted, this guard simply doesn't run, leaving
 * (1)-(3) as the whole check (the pre-2c58bdd3 shape, still exercised directly by callers that don't carry
 * per-session generation history).
 *
 * Either text arg missing (no submitted text captured, or no recorded user turn read back) → false —
 * there's nothing to compare.
 */
export function detectBarePastePlaceholderTripwire(
  submittedText: string | null | undefined,
  recordedText: string | null | undefined,
  currentGen?: number,
  recentPlaceholderTokens?: ReadonlyArray<SeenPlaceholderTokenEntry>,
): boolean {
  if (!submittedText || !recordedText) return false;
  if (!couldCliCollapseToPlaceholder(submittedText)) return false;
  const token = matchEmbeddedPlaceholderToken(recordedText);
  if (!token) return false;
  if (submittedText.includes(token)) return false;
  if (currentGen !== undefined && recentPlaceholderTokens !== undefined) {
    const seenOlder = recentPlaceholderTokens.some((entry) => entry.gen < currentGen && entry.token === token);
    if (seenOlder) return false;
  }
  return true;
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
 * @decision 2d36337e — wording asks "does something you've done SINCE assume this content?", not "have
 *  you acted?", since the latter alone lets a later message built on this one mask a missed premise. Do
 *  not word it as a claim the content reached the recipient — the detector only observes the transcript.
 */
export function buildPasteRecoveryText(originalText: string): string {
  return `${PASTE_RECOVERY_TAG} The transcript recorded a placeholder instead of your previous message's pasted content — it may not have reached you (a known upstream CLI paste-collapse race; see card eef4883c). Before dismissing this as already-handled: does anything you have done SINCE assume this content, not merely resemble something you recall seeing? A later message can be fully acted-on while still having depended on THIS one — check your own artifact (a reply you sent, a memory write, a turn count) for that, not just whether the topic feels familiar. Otherwise, here is the original content, resent:\n\n${originalText}`;
}

/**
 * Card b68d1f5b DoD-1 — the "compare the placeholder's stated line count against the delivered body"
 * check (adopted from a peer project manager's suggestion). Unlike `detectBarePastePlaceholderTripwire`
 * above, this check works from the RECORDED/delivered side alone: a `[Pasted text #N +M lines]` token
 * surviving into the transcript's recorded turn text always means those M lines never reached the engine
 * (a placeholder is never accompanied by its own expansion — if the paste had gone through, the
 * placeholder wouldn't be there at all). That is what makes it work "regardless of who wrote the text"
 * (card's own framing).
 *
 * @decision 183de1a4 — the raw/human path usually DOES capture `submittedText` (`Live.lastRawSubmit`), but
 *  that slot is one-turn ephemeral, not a durable store. The real gap: the raw path never gets an entry in
 *  `Live.recentWrittenLineCounts` (pushed only by `submit()`), so a stale re-render has nothing to explain it.
 *
 * @decision abeac33a — HARD CONSTRAINT: "placeholder present ⇒ loss" alone FIRES ON A CORRECT SEND — a
 *  stale token can be an already-delivered older generation's CLI-side re-render ghost. Do not flag a
 *  CURRENT-gen match here either — `detectBarePastePlaceholderTripwire` already owns that case.
 *
 * @decision b68d1f5b — silence is guaranteed only while the explaining write is inside
 *  `PASTE_LOSS_EXPLAIN_WINDOW`; beyond it this check WILL fire on a correct send. Do not reuse card
 *  c2c750a9's `COMPOSER_ACCUM_WINDOW` ring here — it's sized for a different job (full-text concatenation).
 *
 * @decision b68d1f5b — `PASTE_LOSS_CALIBRATED_BYTES_PER_LINE` (five specimens, 128.4–132.3 B/line, all
 *  kickoffs delivered intact) is for the ALERT MESSAGE only, never the detection gate. Calibrated against
 *  payload newlines, never wrapped terminal rows — a fixed 120-col pty only ever ADDS rows via wrapping.
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
 * `detectBarePastePlaceholderTripwire` already validated (card 0f9268cc, see above) — a placeholder-shaped
 * substring the sender's own submitted text ALSO contains verbatim was typed/quoted, not CLI-collapsed.
 * Passing `null`/`undefined` simply skips that guard (same as any other caller — it just means whichever
 * caller passed it didn't have one available at that moment); every other guard (the `gen` discriminator)
 * still applies in full.
 *
 * @decision 183de1a4 — null/undefined here does NOT mean "no `submittedText` was ever captured" — the
 *  raw/human path usually DOES capture it (`Live.lastRawSubmit`). Do not treat that slot as durable: it's
 *  one-turn ephemeral, overwritten/cleared well before an older turn's content could be needed again.
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
