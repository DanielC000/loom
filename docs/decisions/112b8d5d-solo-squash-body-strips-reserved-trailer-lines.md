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
reader in the file — `TRAILER_LINE_RE` (via `parseTrailerParagraph`/`isTrailerShapedParagraph`, which
`tolerantFindLoomTrailerBlock` depends on) and `matchReservedLoomTrailerLine`'s own regex (used by
`scanLoomNamespaceLines`/`verifyLoomNamespaceExact`) both anchor on a line starting with a bare letter
(optionally after whitespace only, never a dash).

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

## Do not

- Do not write a second copy of the reserved-trailer predicate/regex for this check — reuse
  `stripReservedLoomTrailerLines` (which itself reuses `matchReservedLoomTrailerLine`), the same function
  the batch path already calls.
- Do not strip the subjects list directly (without a leading placeholder line) — `stripReservedLoomTrailerLines`
  always exempts its own line 0 as "the subject", so the FIRST real subject would silently escape the
  strip if fed in as line 0.
- Do not rely on `deriveWorkerCommitLogBody`'s `- ` bullet-prefix formatting as the safety mechanism going
  forward — it was proven to work today, but it is a formatting accident, not a guarantee; the explicit
  strip added by this card is what makes the guarantee durable across a future reformat.
- Do not fold worker-authored text into a trusted commit message (subject, trailer paragraph, or body)
  anywhere in this file without routing it through this same reserved-trailer strip first.
