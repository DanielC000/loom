# 60e9eae9 — the unanchored-comment advisory reports only blocks new since the last advice, and exempts leading test headers

Platform Auditor finding: the "NEW UNANCHORED COMMENT BLOCK(S)" advisory fired on nearly every `worker_report` / `worker_merge` review (17+ times across two manager seats), re-listing the same untouched blocks (mostly test-contract headers), and told the worker to "re-report", which invited a standalone re-report that then re-flagged the same blocks.

## What it does now

- **Anchor, no new table.** A `worker_report` event's `detail.commentCheckTip` records the branch tip the detector scanned. The next done-report passes it as `sinceTip`. The manager review uses the previous `merge_request` event's `detail.tip` (already recorded). The manager's FIRST review of a branch has no prior `merge_request`, so it still lists every block, by design.
- **Intersection.** With a valid `sinceTip`, a line counts as added only when it is in BOTH `base...tip` and `sinceTip...tip`; the intersection stops main merged into the branch from surfacing mainline's own changes.
- **Fail-open.** `sinceTip` absent, not a full sha, unknown to the repo, or no longer an ancestor of the tip (rewritten history) falls back to the whole-branch scan. It never silently reports nothing.
- **Wording.** The worker text says to include the classification in the next report and not to send a standalone re-report.

## Test-header exemption (generic heuristic)

A block is exempt only when the path is test-shaped (a `test`/`tests`/`__tests__` directory segment, or a `*.test.*`/`*.spec.*` basename) AND it is the file's leading comment (only blanks, a shebang, comment lines, or single-line import/require/"use strict" before it). The advisory runs for end-user projects, so no Loom path is hardcoded.

Accepted false-exempts:
- a long narrative header on a non-test helper or fixture that lives under a `test/` directory;
- product code in a directory literally named `test`/`tests`;
- a production file named `x.test.ts` / `x.spec.ts`.

Mid-file blocks in test files are still reported.

## Do not

- Do not hardcode a repo's own test directory (e.g. `packages/*/test`) into the exemption.
- Do not scope to `sinceTip...tip` alone; keep the intersection with `base...tip`.
- Do not make an unresolvable or non-ancestor `sinceTip` return an empty result; it must fall back to the whole-branch scan.
- Do not anchor the manager review on the worker's report tip; the first review must still see every block.
