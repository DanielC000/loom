# 112b8d5d — the solo squash commit-log body strips reserved-trailer-shaped worker subjects

## Background

The batch landing path (`batch-merge.ts`) strips worker-authored reserved-trailer-shaped lines
(`stripReservedLoomTrailerLines`, matching `/^(?:loom-worker|loom-landed)-[a-z0-9-]*$/i`-keyed lines, see
`RESERVED_LOOM_TRAILER_KEY` in `worktrees.ts`) before it ever builds the real trailer paragraph. The SOLO
squash path (`mergeBranchLocked` → `deriveWorkerCommitLogBody`) folds a worker's own commit SUBJECTS
(`git log --format=%s`) into the squash BODY with no equivalent strip — the two landing paths applied
different guards to the same kind of worker-authored content.

An investigation (card `112b8d5d`, worker session, real-git repros against compiled `dist` code) found
this was **harmless in practice, but by accident, not by design**: `deriveWorkerCommitLogBody` always
renders each subject as a bullet (`` `- ${s}` ``), and the leading `- ` defeats every reserved-trailer
reader in the file — both `TRAILER_LINE_RE` (via `parseTrailerParagraph`/`isTrailerShapedParagraph`,
which `tolerantFindLoomTrailerBlock` depends on) and `matchReservedLoomTrailerLine`'s own regex (used by
`scanLoomNamespaceLines`/`verifyLoomNamespaceExact`) require a line that, once past any leading
whitespace they individually tolerate, starts with a bare letter, never a dash — but the two differ on
how much leading whitespace they tolerate: `TRAILER_LINE_RE` allows NONE (`^([A-Za-z]...`, anchored
directly on the first character); only `matchReservedLoomTrailerLine` tolerates leading whitespace
(`^[ \t]*(...)`). Either way, a `- ` prefix defeats both.

Two real-git repros proved this:
1. A worker commit subject literally `Loom-Worker-Base: FORGED...` landed verbatim as
   `- Loom-Worker-Base: FORGED...` in the body. `parseLoomTrailerBlock`, `tolerantFindLoomTrailerBlock`,
   and `scanLoomNamespaceLines` all correctly saw only the genuine final-paragraph trailer.
2. A second branch's commit subject quoted another real, already-landed branch's exact trailer line
   (`Loom-Worker-Branch: <other-branch>`). After landing and deleting that other branch,
   `findLandedSquashCommit` for the quoted branch still resolved to the REAL original squash commit, never
   the forging branch's landing — the `git log --grep` match is only a prefilter (already documented at
   its call site); the per-candidate check requires that candidate's OWN final-paragraph trailer (always
   genuine, since a quote sitting in a non-final bulleted paragraph never satisfies `parseTrailerParagraph`)
   to assert the branch being searched for.

The accidental nature of the immunity (resting entirely on the `- ` bullet format, with no test pinning
it) is the actual defect this card fixes: nothing prevented a future reformat of the bullet style from
silently reopening the hole.

## The fix

`deriveWorkerCommitLogBody` now strips any reserved-trailer-shaped subject OUT of the list before
bulleting/truncation, reusing `stripReservedLoomTrailerLines` (the SAME predicate the batch path already
applies) rather than a second copy of the regex. Because that function always treats its message's own
line 0 as "the subject" and exempts it from stripping, the raw subjects are probed with a leading empty
placeholder line so every real subject — including what would otherwise be line 0 — is actually subject
to the strip. `WORKER_COMMIT_LOG_MAX_ENTRIES`/`WORKER_COMMIT_LOG_MAX_CHARS` truncation, and the existing
"single commit matching the squash subject ⇒ omit the body" dedup check, both still apply to the
post-strip list. If stripping removes every subject, the body degrades to the pre-existing "no commits to
show" case (`undefined`) — behaviorally identical to today's omitted-body path.

**Superseded by round 2 below — this paragraph describes the ORIGINAL mechanism, kept for history.**

## Round 2 (Code Review 07a5095c — SHIP, with four follow-ups)

The review confirmed the strip does real work (negative controls below), then found two things worth
tightening before this is durable:

1. **Simplify the strip itself.** The placeholder-probe mechanism above only existed to route around
   `stripReservedLoomTrailerLines`'s own "line 0 is the subject" exemption — but a bare subject LIST has
   no such line-0 concept to exempt in the first place. `deriveWorkerCommitLogBody` now filters each
   subject directly: `subjects = subjects.filter((s) => !matchReservedLoomTrailerLine(s))` — ONE
   predicate, no index arithmetic, no placeholder line, no dependency on the callee's own newline-collapse
   behavior. `stripReservedLoomTrailerLines` itself is unchanged and still the batch path's own mechanism
   (it strips reserved lines out of a whole MESSAGE, with a real line-0 subject to exempt — a different
   problem shape than a bare subject list).
2. **Surface the strip, never silently.** The original fix stripped forged subjects out with no visible
   trace — satisfying "no forgery lands" but not 8b7b81e0's own "never truncate silently" contract, which
   that card's truncation caps already honor but this strip did not. `deriveWorkerCommitLogBody` now (a)
   `console.warn`s the same shape the batch path's own `landBranchCommitsIndividually` warning uses
   (`[git] mergeBranchLocked: stripped N reserved Loom-* trailer line(s) from <branch>'s own commit(s)
   before folding them into the squash body — …`), and (b) appends a visible body marker,
   `` `- …(${strippedCount} reserved-shaped worker commit subject(s) removed)` ``, whenever
   `strippedCount > 0` — including when every subject was stripped (nothing else survives to bullet) and
   when the post-strip survivor is a pure duplicate of the squash title (8b7b81e0's own dedup, which would
   otherwise omit the body entirely): the marker takes priority over both of those "omit the body" paths,
   since the strip itself is always worth disclosing once it fired. The marker text contains no colon, so
   it can never itself match `matchReservedLoomTrailerLine` — a loop could not have planted a
   self-referential "forgery" through this exact text.

Both are pinned by `packages/daemon/test/solo-squash-reserved-trailer-strip.mjs`'s round-2 scenarios 2–5
(forgery as the branch's first/oldest commit; a single-commit branch whose only subject is
reserved-shaped; a multi-commit branch where every subject is reserved-shaped; and a post-strip survivor
that's a pure title duplicate) plus scenario 1's own added marker/log-line assertions.

## Do not

- Do not write a second copy of the reserved-trailer predicate/regex for this check — reuse
  `matchReservedLoomTrailerLine` directly (round 2) — never a second, independently-drifting regex.
- Do not route a bare subject LIST through `stripReservedLoomTrailerLines` (a message-shaped helper with
  its own line-0 "the subject" exemption) — check `matchReservedLoomTrailerLine` on each subject directly
  instead; there is no line-0 concept to route around in a bare list, so the placeholder-line workaround
  this card originally shipped is no longer needed anywhere in this function (round 2, finding 1).
- Do not rely on `deriveWorkerCommitLogBody`'s `- ` bullet-prefix formatting as the safety mechanism going
  forward — it was proven to work today, but it is a formatting accident, not a guarantee; the explicit
  strip added by this card is what makes the guarantee durable across a future reformat.
- Do not fold worker-authored text into a trusted commit message (subject, trailer paragraph, or body)
  anywhere in this file without routing it through this same reserved-trailer strip first.
- Do not let the strip stay silent (round 2, finding 2) — a nonzero `strippedCount` must always produce
  both the `console.warn` line and the body marker, even when the body would otherwise have been omitted
  entirely (all-stripped, or a post-strip pure-title-duplicate).
