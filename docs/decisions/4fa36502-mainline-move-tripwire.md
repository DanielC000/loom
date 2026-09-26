# 4fa36502 — alert when the mainline moves without a Loom landing (a tripwire, not a sandbox)

## Do not

- Do not turn this alert into a refusal, a merge block or a retry. It is DETECTION only: the merge always proceeds exactly as it would without the check.
- Do not let an error, timeout or cap in the check reach the merge. It is FAIL-OPEN: any failure logs `[mainline-watch] check skipped (fail-open)`, files nothing, and leaves the watermark alone.
- Do not advance the watermark after a landing whose own check did not complete. The check returns `false` on failure and the hook then skips the advance, so an unverified move stays visible to the next landing's check.
- Do not read this as protection against an adversarial worker. See "What it cannot detect".
- Do not scan unbounded. The `W..tip` walk, the reflog read and the `refs/heads/loom/` scan are capped (`MAINLINE_RANGE_CAP`, `MAINLINE_LOOM_REF_CAP`); past a cap the outcome is ONE low-severity "unverifiable" event and the watermark advances.
- Do not add a git call to `git/mainline-watch.ts` that bypasses `canonicalGit` (the module is in `canonical-git-helper-guard.mjs`'s STRICT list).
- Do not alert on first sight of a (project, repoKey, branch): the first check initialises the watermark silently.
- Do not store the watermark in a new table or column; it is an `app_meta` key, `mainline-watermark:<projectId>:<repoKey>` (JSON `{branch, sha}`), purged by `deleteProject`.
- Do not treat a `loom/*` tip reachable from the mainline as a bypass unless the BRANCH'S OWN reflog shows it CREATED that commit object (`isAuthoredBranchReflog`): `commit`, `cherry-pick`, `am`, a non-fast-forward `merge`, or a `rebase (finish)` whose tip differs from its `onto` sha. A fast-forward (`merge <x>: Fast-forward`, also what Loom's own `mergeMainIntoWorktree` does) and a no-op rebase (`tip == onto`) only MOVE the ref onto a commit the mainline already had, and a worker spawned with no commits has a tip that IS a mainline commit (`createWorktree` cuts off the current HEAD). The test is "a new object was made", not "the ref moved". A missing branch reflog reads as "cannot tell", not a hit.
- Do not let a cap on the loom-tip signal (`MAINLINE_LOOM_REF_CAP`, the rev-list range, `MAINLINE_LOOM_TIP_CHECK_CAP` applied AFTER trailered tips are dropped) turn the whole move "unverifiable": it skips ONLY that signal (`loomTipsSkipped`), and the reflog-raw-write classification still runs.
- Do not apply the reflog cap to the whole reflog. It bounds the window after W; only a window that fills up WITHOUT reaching W is "unverifiable" (the real repo's main reflog has thousands of entries).
- Do not advance the watermark after a landing unless the landed commit's first parent is the tip the check verified; a move in the window stays catchable.
- Do not spawn one git process per candidate tip: all in-range tip messages are read in one `git log --no-walk` call, and the authored-tip reflog check is capped (`MAINLINE_LOOM_TIP_CHECK_CAP`).
- Do not use `git reflog show` as evidence of WHICH WORKTREE moved the ref. It records none (measured, below).

## The threat, and what Loom already had

A worker's worktree shares the canonical `.git` (see `356538ef-canonical-git-isolation.md`), so it can `git update-ref refs/heads/<main> <sha>` and bypass the merge gate. Loom persisted no "last Loom-landed main sha": `project_merge_gate_state.last_pass_sha` is written only by a PASSING gate (ungated landings record a count only), `tasks.merged_sha` is per task and abbreviated, and the `merge_done` event carries no sha. The Loom trailers on every landing (`Loom-Worker-Branch`, `Loom-Landed-Tip`) make git history a complete ledger of landings, but the latest trailer commit alone hides a bypass under a later legitimate landing, so a high-water mark is needed.

## Design

- **Watermark W** per (project, repoKey): the canonical branch tip Loom last saw or produced. Advanced after a SUCCESSFUL solo landing (`advanceMainlineWatermark`, right after `mergeBranch`, inside the repo guard) and after every completed check.
- **Check** (`checkMainlineMove`) runs inside the repo guard just before the solo squash trusts main's tip. `boot` and `merge_batch` are NOT hooked in this slice: boot would run in boot-reconcile once per repo, and a batch would hook where `mergeBatchTracked` records its landing (`recordMergeGateOutcome(... "pass" ...)`), advancing W to `result.batchHeadSha`. Until then a batch landing looks like a move; it is silent because its commits carry Loom trailers and its reflog message is `merge …: Fast-forward` (porcelain).
- **Strong signals only** (any one alerts):
  1. `reflog-raw-write`: a reflog entry newer than W has an empty or non-porcelain message AND the first-parent range `W..tip` holds a trailer-less commit. A bare `git update-ref` writes an empty message.
  2. `loom-branch-reachable`: a trailer-less `refs/heads/loom/*` tip is reachable from tip but not from W. Squash and cherry-pick landings never put a worker tip into main's history; a bypass that moves main onto the worker's tip does.
  3. `rewind-raw-write`: W is not an ancestor of tip and a raw reflog entry exists.
- **Silent** (explained): a human commit / merge / pull / reset / rebase / fetch (porcelain messages, measured: `commit: …`, `commit (amend): …`, `pull …: Fast-forward`, `merge <x>: Fast-forward`, `reset: moving to …`), Loom's own landings (trailers), and Loom's human-REST `GitWriter.commit` (a plain `git commit`).
- **Alert** = one durable `mainline_moved_outside_loom` event (in `DURABLE_AUDIT_EVENT_KINDS`, `detail.projectId` stamped) + one `[loom:mainline-moved]` warning nudge to the confirming manager. The watermark advances after the alert, which is the dedupe.
- **Unverifiable**: the same event kind with `severity:"low"`, `unverifiable:true`, and no nudge.

## What was measured (git 2.47.0.windows.2, real repos)

- The shared `logs/refs/heads/<main>` records old/new sha, committer and a free-text message, and NO worktree identity. The moving worktree's own `logs/HEAD` records nothing about an `update-ref`.
- A bare `update-ref` writes an EMPTY message; `update-ref -m "commit: x"` is fully spoofable; `git -C <canon> commit` from a worker is byte-identical to a human commit.
- `git branch -f <main>` and `git push . HEAD:<main>` are refused by git while main is checked out in the canonical worktree.
- The reflog is worker-writable: `git reflog delete <ref>@{n}` removes an entry silently.
- After a worker `update-ref`, the canonical index/working tree is stale (staged reverse changes); a human can produce that too.

## What it cannot detect

A worker that forges the reflog message AND removes its `loom/*` branch before the check (pinned in the test as the documented limit, `(S5)`); a worker that edits or deletes the reflog AND has no branch reachability; a worker committing through `git -C <canon> commit`; a bare canonical repo (no reflog by default); a human's own raw `update-ref` (a documented false positive of signal 1). It is a tripwire.

## Tests

`packages/daemon/test/mainline-watch.mjs` — real git through the real solo confirm path: the reflog texts git writes (with a bare-`update-ref` positive control), the pure classifier, first sight silent, human commit + `GitWriter` silent, the RED-first worker bypass, dedupe, human reset silent, forged message, the documented limit, deleted reflog entry, raw write onto a non-loom commit, fail-open (with the still-catchable follow-up landing), and the cap.
