# 458028ae — predict git's own commit-message cleanup before a batch lands a candidate's commit

## Background

`landBranchCommitsIndividually` (`git/batch-merge.ts`) builds each commit's `finalMessage` from the
worker's own original message, with the tip's `Loom-Worker-Branch:` trailer paragraph appended. If that
worker message is empty (`--allow-empty-message`) or reduces to nothing but blank lines (reachable via
`commit-tree`, which skips the cleanup an ordinary `git commit -m` applies to the SOURCE message), the
built `finalMessage` is exactly `\n\nLoom-Worker-Branch: <branch>\n` — a leading pair of blank lines, then
the trailer paragraph.

`git commit -m` cleans a non-interactive message under `cleanup=whitespace` (never `cleanup=strip`,
which only applies when the message is edited in `$EDITOR`, OR when the repo's own `commit.cleanup`
config says so — see "The pin is load-bearing" below): it drops leading blank lines before storing the
commit's own `%B`. For this shape that drop consumes BOTH leading blank lines, leaving
`Loom-Worker-Branch: <branch>` as the message's only line — the SUBJECT, not a trailer paragraph. Once
that commit exists, no reader (`parseLoomTrailerBlock`, nor the tolerant discovery reader) can ever find
a trailer there again: both require at least two paragraphs, and none exists.

Since decision `45036494` (commit `c8d4f278`), `verifyLoomTrailersExactAndReadable`'s `"unreadable"` kind
is a KEPT-VERIFIED outcome (a hook can legitimately alter a commit's trailer paragraph without that being
a forgery) — so this shape no longer aborts the whole batch. It lands, silently, with a landed commit
whose `Loom-Worker-Branch:` trailer is permanently unrecoverable. That is the real defect this card fixes
— not a batch-wide DoS (the premise stated when this card was filed), but a silent, untraceable landing.

## The fix

`predictGitCleanupWhitespace` (`git/worktrees.ts`) is a pure-JS, side-effect-free prediction of git's
`cleanup=whitespace` rules — normalize CRLF, strip trailing `[ \t\r]` per line (never leading), drop
leading/trailing blank lines, collapse an interior run of blank lines to one, never touch `#` lines.
Measured against real `git stripspace` (no flag — stripspace's own default is also `whitespace`, not
`strip`) byte-for-byte modulo stripspace's single trailing newline on a non-empty result, across 14 cases
(see `packages/daemon/test/predict-git-cleanup-whitespace.mjs`).

**A line counts as blank ONLY when it is composed entirely of `[ \t\r]`** — never a generic "whitespace"
test. Code Review (session `e8f1f410`) item 2: git's own blank-line classification works byte-by-byte and
does NOT treat `\f`, `\v`, NBSP, U+2028 (line separator), or a BOM as blank — all MEASURED to survive as
real content in `git stripspace`'s own output — unlike a JS `String.prototype.trim()`/`\s`-based test,
which wrongly collapses every one of those. The function's blank test uses `/^[ \t\r]*$/`, never `.trim()`.

Fixing this surfaced an ADJACENT, pre-existing latent bug in the same file: `landedSubject` (the post-loop
verified-read subject derivation) called `.trim()` on a landed commit's first line, which — for the exact
same reason — emptied a genuinely non-blank subject (e.g. a lone `\f`) down to `""`. `assembleBatchBranches`
then read that as `"batch land reported ok with no sha/subject"` and dropped an ALREADY-LANDED commit,
which left the batch worktree's real HEAD advanced past what the bookkeeping tracked — cascading into a
FALSE `batchHeadMoved` refusal worded as if the shared `.git` had been tampered with, when nothing had.
Fixed by removing the `.trim()` entirely: the landed body is already git's own cleaned `%B`, so its first
line needs no further trimming. See `(E4)` in `packages/daemon/test/batch-merge-empty-tip-cleanup-drop.mjs`
and its own RED/GREEN proof (the worker report for this round of review) for both fixes independently.

`landBranchCommitsIndividually` now runs `verifyLoomTrailersExactAndReadable` against the PREDICTED
cleaned message right after `finalMessage` is built, before anything is committed. ANY non-ok kind
(`forged`, `displaced`, or `unreadable`) drops ONLY this candidate — same remedy as the pre-existing A2
reserved-subject check immediately above it: `rollback()` then `fail({ok:false, reason})` WITHOUT
`headMoved`, so `assembleBatchBranches` pushes it to `dropped` and the rest of the batch continues; the
dropped candidate is retried later via the ordinary solo merge path (`mergeBranchLocked`), which builds
its own message from the coerced card title and is structurally immune to this shape.

## The `--cleanup=whitespace` pin is LOAD-BEARING, not defense-in-depth

Both real commit calls (the plain `git commit -m` and the pathset `git commit --amend`) are pinned with
`--cleanup=whitespace`. This pin is REQUIRED for the predictor's own fidelity, not a no-op: the predictor
only ever models `whitespace` mode, but git's REAL cleanup mode, absent an explicit `--cleanup` flag, is
decided by `commit.cleanup` config if set, falling back to the built-in non-interactive default
(`whitespace`) only when no config says otherwise — so an AMBIENT `commit.cleanup=strip` (e.g. a
self-hosting host's own `~/.gitconfig`, or any config layer above the repo) silently changes the REAL
cleanup mode out from under an unpinned call, without changing anything the predictor assumed.

**Measured directly (git 2.47.0, this card's own worker report):** with `commit.cleanup=strip` set and NO
`--cleanup` flag on the call, `git commit -m $'# worker subject\n\nLoom-Worker-Branch: loom/x\n'` strips
the `#`-comment line (strip mode's own distinguishing behavior) and lands with `Loom-Worker-Branch: loom/x`
as the SUBJECT — the exact silent-unreadable landing this card exists to prevent, reached via a
`#`-first-line tip, a shape the predictor itself (which assumes `whitespace`, keeping `#` lines) would
never have flagged as risky. With `--cleanup=whitespace` added to the SAME call, the `#` line survives and
the trailer paragraph stays intact, confirmed byte-for-byte — the command-line flag correctly overrides
the config. `(P1)` in `packages/daemon/test/batch-merge-empty-tip-cleanup-drop.mjs` reproduces this exact
scenario end-to-end (an ambient repo-level `commit.cleanup=strip` + a `#`-subject tip) and RED/GREEN-proves
the AMEND call's own pin decides the outcome for this (the common, amend-succeeds) path — the amend's
`-m amendedMessage` fully REPLACES the message from `finalMessage`, built fresh in-memory, so whichever
cleanup mode the AMEND itself runs under is what the final landed `%B` actually reflects, regardless of
what the earlier plain commit stored. The plain commit's OWN pin is not independently exercised by this
scenario (the later amend overwrites it either way) — it instead guards the narrower, untested-by-a-
committed-case fallback where the amend attempt itself fails (e.g. a rejecting commit-msg hook) and
`pathSetStamped` turns `false`: in that fallback, nothing re-cleans the message afterward, so the plain
commit's own cleanup mode is what survives as the final result. Both pins are correct and necessary; they
cover two different paths, not the same one twice.

For an ORDINARY message under this repo's own default config (no ambient `commit.cleanup` override), the
pin changes NOTHING — measured byte-identical `%B` with vs without `--cleanup=whitespace` for a normal
message, confirming the pin is purely a mode-explicitness fix for the ambient-config case above, never a
behavior change for the common case.

The solo squash path (`mergeBranchLocked`) was NOT given the same pin — its message is built from the
coerced card title (`toConventionalSubject`), which is never empty or blank-first-line by construction
(worst case, an empty title, still returns the non-empty `"chore: "`), so this failure mode cannot occur
there regardless of ambient config; see the card's own worker report for the one-line proof this was
considered and correctly left alone.

## Do not

- Do not let `"unreadable"`/`"displaced"` alone decide whether to commit — only the PREDICTED cleanup of
  the message that is ABOUT to be committed is a sound signal; checking the unclean `finalMessage` itself
  (what the post-commit checks already do) cannot see this defect, because git's cleanup hasn't run yet.
- Do not route this drop through `headMoved` — the batch-wide abort assembleBatchBranches gives that
  outcome has no per-candidate fallback, which is the wrong remedy for a worker-authored message defect,
  not a racer's tamper of the shared `.git`.
- Do not add `cleanup=strip` semantics (dropping `#` lines) to `predictGitCleanupWhitespace` — the real
  commit call uses `whitespace`, which keeps them; drifting the predictor from the real cleanup mode
  defeats its entire purpose.
- Do not classify a blank line with a generic "whitespace" test (`.trim()`, a bare `\s` regex) anywhere
  in this area of the code — git's own notion is byte-narrow (`[ \t\r]` only); a broader test silently
  disagrees with real git on `\f`/`\v`/NBSP/U+2028/a BOM, in BOTH the predictor and the landed-subject
  derivation (both bugs this card fixed independently, from the exact same root misconception).
- Do not assume removing EITHER `--cleanup=whitespace` pin is safe because the other test still passes —
  the plain-commit pin and the amend pin cover two DIFFERENT paths (amend-succeeds vs amend-fails); a
  regression in one is invisible to a test that only exercises the other.
- Do not assume this predictor is a general-purpose git-message formatter — it exists ONLY to predict
  `cleanup=whitespace`'s own effect on a soon-to-be-committed message, for this one caller.
