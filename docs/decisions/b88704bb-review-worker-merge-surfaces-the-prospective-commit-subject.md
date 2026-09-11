# b88704bb — `reviewWorkerMerge` surfaces the exact prospective squash-commit subject, before it's written

## Context

`reviewWorkerMerge` is step 1 of the two-step merge gate (#16): it shows the manager a worker's
branch diff. No merge happens at this step — this is the review a manager cannot skip, since
there is no worker-side merge tool.

Filed after four mainline commits in one session shipped with subjects that misdescribed what
they actually did (e.g. claiming a feature that was deferred, describing the bug rather than the
fix, mistyping the conventional-commit type). Root cause, verified in code: the commit subject
was computed LATER, inside `confirmWorkerMerge` → `toConventionalSubject(rawSubject)`
(`git/worktrees.ts`) — strictly *after* review had already happened. The gate presented the diff
for review, and confirming that review meant IMPLICITLY APPROVING an immutable commit subject the
reviewer had never actually been shown. That is the whole mechanism behind the four failures: the
check the doctrine demanded had no
affordance in the tool — a rule that can only be followed by remembering to go look somewhere
else is a rule that will be missed under load.

## Decision

`reviewWorkerMerge` now returns the exact prospective subject — post-`toConventionalSubject`,
byte-for-byte what `mergeBranch` will actually commit if the manager confirms — mirroring
`mergeBranch`'s own derivation (the task title's first line, trimmed) so the preview can never
drift from what actually lands.

`rawTitle` / `commitSubject` / `coerced` are present ONLY when the worker has a task with a
non-empty title. A taskless worker (no card) has no title to preview, so these fields are simply
ABSENT — never a fabricated subject derived from the branch name, which is a `mergeBranch`-internal
fallback, not something surfaced here as if it were a real title.

`coerced` is a plain string comparison against what `toConventionalSubject` does to the raw title
— a FACTUAL comparison, not a judgment of whether the title is accurate. Scanning for hedge
phrases (`(or `, `A/B`, "decide whether") was explicitly rejected as a false-positive generator
that would train reviewers to ignore the signal; the fix is visibility, not cleverness. This
surface never blocks the merge — `confirmWorkerMerge` behavior is unchanged.

## Do not

- Do not add a guessy staleness/accuracy detector on top of `coerced` — it is a factual
  before/after comparison only, not a heuristic accuracy judgment.
- Do not block a merge on anything this surface reports — it is informational only.
- Do not assume a taskless worker gets a fabricated `commitSubject` — the field is absent, not
  derived from the branch name.

## Consequences

- A manager reviewing a worker's diff now sees, at the same step, the exact subject that will
  become a permanent mainline commit — and whether it was silently coerced from the raw title.
- The four historical failure modes (deferred-feature claim, present-tense bug description,
  wrong conventional type) are now visible at the point a manager can still act on them, instead
  of only discoverable after the fact via `git log`.

## Source

JSDoc comment on `SessionService.reviewWorkerMerge` (`packages/daemon/src/sessions/service.ts`),
as of this worktree's HEAD before this extraction (tranche 39), plus board card `b88704bb`'s own
body (filed 2026-07-22, investigated at the owner's prompting after four same-session mainline
commits shipped with misdescribing subjects). Wrapped source lines joined into flowing
paragraphs, `*` comment markers stripped, no wording changed beyond that.
