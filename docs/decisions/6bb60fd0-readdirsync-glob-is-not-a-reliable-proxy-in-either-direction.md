# 6bb60fd0 — a `readdirSync`-presence glob is wrong in a second, more dangerous direction, and that direction moves on its own clock

## Narrative

`STATIC_GUARD_REPO_PATHS` (`packages/daemon/src/git/worktrees.ts`) was already known to be the deliberately-hardcoded alternative to `grep -l readdirSync packages/daemon/test/*guard*.mjs` — card `a1734000`'s membership criterion documents that a naive glob is the wrong tool because membership is a judgement call, not a filename pattern. Card `6bb60fd0` found a second, independent way the glob is wrong: a `readdirSync`-presence filter is not a reliable proxy for this list's membership criterion in EITHER direction, and — unlike the first mismatch, which is fixed by the array's own contents — WHICH specific files it wrongly drops or picks up can drift without this array changing at all.

**The specimen that made this concrete:** this file's own comment used to cite `fixed-wait-witness-guard.mjs` as an example of a guard the naive glob could never find, reasoning it "contains ZERO `readdirSync` occurrences … BY CONSTRUCTION." That was true when written. Card `5784fb8f` caught that it had gone false by 2026-09-04: cards `40643460`/`21e12d47` gave `fixed-wait-witness-guard.mjs` its own unrelated `readdirSync` call — a supplementary untracked/uncommitted-file check, `listNulBearingTestFiles` — that has nothing to do with why the file belongs on `STATIC_GUARD_REPO_PATHS` (its CORE scan stays diff-scoped against a real `git diff`, per `a1734000`'s criterion, not a scan of the test corpus). The citation had quietly become false without anyone deciding it should.

**Why this isn't just "update the example":** the underlying defect the array itself guards against — a guard silently inert on precisely the diff class it exists to police — is what card `a18c39ba` originally shipped to fix. Recreating that defect via a stale glob-vs-array mismatch is the risk `6bb60fd0` names; it is unaffected by which specific file currently demonstrates it, because a glob is still the wrong way to build this list regardless of which files it currently mismatches.

**The set relationship, restated in kind, not in count:** the `readdirSync` family and `STATIC_GUARD_REPO_PATHS` overlap partially, and neither contains the other — but the overlap size and the specific files on each side are not stable facts to restate in a comment. A prior version of this same paragraph hardcoded a count of the mismatch and it went stale exactly like the `fixed-wait-witness-guard.mjs` citation did. `pnpm --filter @loom/daemon guards` (card `245a3708`) runs exactly this list without anyone needing to re-derive it from `readdirSync` or any other implementation detail that was never the membership criterion.

## Do not

- Do not cite any specific file (present or future) as a standing counter-example of what the glob would miss or wrongly include — re-derive the current mismatch yourself (`grep -l readdirSync packages/daemon/test/*guard*.mjs` vs. `STATIC_GUARD_REPO_PATHS`) before relying on one.
- Do not restate the overlap's size or membership as a fixed count anywhere near this array — it drifts independently of the array's own contents, on its own clock.
- Do not re-derive `STATIC_GUARD_REPO_PATHS` from `readdirSync` or any other implementation detail. Run `pnpm --filter @loom/daemon guards` instead.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `STATIC_GUARD_REPO_PATHS`'s own doc comment (~line 2570), as of commit `084cde93` before this extraction. Wrapped source lines joined into flowing paragraphs, `*` comment markers stripped, no wording changed.
