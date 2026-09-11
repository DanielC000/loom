# 8ea85329 — A batched landing has no HTML-entity backstop on a commit subject; a warn-only advisory covers it instead

## Context

`mergeBranchLocked`'s HTML-entity backstop (card `f324e8fa`, `git/worktrees.ts`; see
docs/decisions/f324e8fa-title-entity-backstop-is-the-authoritative-enforcement-point.md) is the solo
squash path's "last line of defence" against an accidentally-escaped title becoming a permanent mainline
commit subject. It is NOT that for the batched path: `landBranchCommitsIndividually`
(`git/batch-merge.ts`) lands every candidate's own commit subjects verbatim (`finalMessage`, sourced from
each commit's real `%B`, never re-derived or checked), with no equivalent entity check anywhere in this
landing path.

## Decision

DECIDED not to add a hard refusal in the batched landing path. Considered and rejected: unlike a card
title (a manager retitles in seconds), a worker-authored commit message has no cheap fix once the worker
may already be retired and `git rebase -i` is unsupported in this repo — refusing mid-batch would strand
the branch with no cheap recovery, a materially worse trade than the one `f324e8fa` made for the solo
path.

Instead, `SessionService.reviewWorkerMerge` (`sessions/service.ts`) surfaces a WARN-ONLY advisory from the
same `ownTipSubject`/`ownNonTipCommitSubjects` fields a manager already reviews before choosing solo vs.
batch — before batch time, while the worker is typically still alive to amend. That advisory is
non-blocking: a manager can still ignore it and batch anyway. Concretely, it is an `entityWarning` folded
into `reviewWorkerMerge`'s own `warning` string, firing when `ownTipSubject` or any
`ownNonTipCommitSubjects` entry carries an HTML entity.

## Do not

- Do not read this file's silence on entity-checking as coverage — the batched landing path remains, by
  design, un-enforced for this class of defect.
- Do not add a hard refusal to `landBranchCommitsIndividually` without re-reading this card first — the
  strand-a-retired-worker trade-off was already weighed and rejected once.

## Consequences

An HTML-entity-escaped commit subject on a worker's own branch can still land verbatim on mainline via a
batched merge, unlike the solo path where `f324e8fa`'s backstop refuses it. The mitigation is a
pre-batch-time advisory a manager can see and act on (or ignore) before routing a worker into a batch,
not a structural block at merge time.

## Source

JSDoc comment (module header) in `packages/daemon/src/git/batch-merge.ts`, as of this worktree's HEAD
before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers
stripped, no wording changed.
