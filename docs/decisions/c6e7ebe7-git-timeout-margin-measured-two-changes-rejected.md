# c6e7ebe7 — `GIT_TIMEOUT_MS` margin measured directly; two further changes investigated and rejected

## Narrative

This module runs up to six `runGit` calls in the worst case (three unconditional, plus conditional fourth/fifth/sixth), each capped at `GIT_TIMEOUT_MS`, synchronously (`execFileSync`) blocking the event loop — a real cost since manager spawns can BURST (boot-reconcile resumes every manager across every project at once).

This card measured the baseline three-call cost directly on Windows: **147–275ms at IDLE, 220–465ms at 3× CPU oversubscription** — NOT the "tens of ms" an earlier version of this module's doc claimed (a real 15–27% of the 1s budget consumed at idle alone). Still a comfortable margin even with the fourth call added (a single-object lookup, cheap relative to the two full-history `git log` walks already in the baseline) — the fifth/sixth calls (card `3d7dccb9`'s `builtContentMatchesHead` ancestry check + content diff) are UNMEASURED DIRECTLY, but are the same shape (a single-object ancestry check + one bounded `git diff --name-only`, not a full-history walk) and share the SAME rare gate as the fourth, so they are not expected to change that margin materially. No observed in-flight call, idle or oversubscribed, has ever come close to the timeout. A *different* tail shows up only in the outer node process's own scheduling latency under heavy oversubscription, which is not a git-call tail and must not be conflated with one.

Two further changes were considered and REJECTED:

- **(b) Distinguishing a TIMEOUT specifically from every other `unavailable()` cause** (no `.git`, no HEAD commit, git not installed) — considered because a timed-out call degrades to the same `{available:false, reason}` shape as any other unreadable-repo case. At the time, the one consumer that treats `available:false` as silent (`composeManagerStartupPrompt`) did so deliberately and uniformly for every reason, not just a timeout, so singling out timeouts there would have been inconsistent with that policy, not a fix to it. (Card `d3d4d432` later replaced that uniform policy with a two-class split — see its own record — but still does not single out a timeout beyond that: it classifies as `"could-not-measure"`, the same as any other reachable-but-failed cause, exactly as this rejection intended.)
- **(c) Raising or retrying the timeout** — rejected for lack of evidence: no observed git call, idle or at up to 9× CPU oversubscription, has ever approached this budget. Widening a timeout with no observed stall to justify it is exactly the kind of change this project has a standing rule against.

## Amendment (card bba7a8ec) — the "no measured stall" premise above is FALSE, and the sync cap no longer guards anything in production

The 147–275 ms / 220–465 ms figures above are for the THREE-CALL baseline on a small history. On a 4816-commit checkout (measured 2026-11-06, by card 93e70102's worker) `git log --max-count=2000 -- packages/daemon/src packages/shared/src` alone takes **869–944 ms** — within 6–13% of the 1000 ms cap — the `packages/web/src` walk another 454 ms, and lowering `--max-count` does not help (200 commits still cost 479 ms). So a stall DID get measured: every manager kickoff on that checkout carried `[loom:deploy-staleness-unknown] … ETIMEDOUT`, and the synchronous reads blocked the event loop ~1.4 s while doing it.

The resolution is not to raise the cap (the original reasoning still holds: a wider SYNC cap is a wider event-loop freeze). It is to stop reading synchronously in production:

- The whole computation is one generator (`stalenessSteps`) with two thin drivers. The async driver (`computeDeployStalenessAsync`) awaits EVERY git read, including the conditional ones the old module doc called "small": `merge-base --is-ancestor` runs on every call on self-host (~85 ms), and `computeAncestorBehaviouralMatch` (a `diff` plus up to 2×25 `git show`) runs right after a daemon-src merge (~4 s). Each is bounded by `ASYNC_GIT_TIMEOUT_MS` (10 s), which only bounds a wedged git, never a daemon stall.
- The sync driver (`computeDeployStaleness`) and its `GIT_TIMEOUT_MS` cap survive ONLY as a test/fixture seam. `test/deploy-staleness-sync-driver-test-only-guard.mjs` fails on any production caller, so the cap now bounds a test's wait, never the event loop. Do not "fix" a sync timeout by widening it — there is no production sync caller left to benefit.
- Spawn and boot paths that stay synchronous (`startNew`/`startManager`/`resume`, `resumeFleetOnBoot`, `composeManagerStartupPrompt`) do no git: their async entry points pre-read and pass the result down, and a call with none renders an honest "not measured at spawn" line. See `bba7a8ec-deploy-staleness-async-core.md`.

Windows kill semantics of the async ceiling: Node's `execFile` `timeout` kills the DIRECT child only and settles when that child exits. PROVEN (Git for Windows): a direct-child kill settles for both `cmd\git.exe` (a shim that spawns the real git as a child) and `mingw64\bin\git.exe`, and the shim's git child died with it (checked with a stdin-blocked `hash-object`, so that grandchild exits on pipe EOF). NOT PROVEN: a grandchild blocked on something other than stdin could survive the kill. Not routed through `git/bounded.ts`'s tree-kill path: that is canonical-merge machinery (quarantine, merge-driver enumeration), too heavy and wrong in kind for a read-only log.

## Do not

- Do not raise `GIT_TIMEOUT_MS` (or add a sync retry): the premise that no stall exists is false (see the amendment), but the answer is the async core, not a wider SYNC cap.
- Do not add a production caller of the sync driver (`computeDeployStaleness` / `currentDeployStaleness` / `buildServedStatus`).
- Do not single out a timeout from the `unavailable()` reason taxonomy on its own initiative — see `d3d4d432`'s record for the actual (different) axis that was later added.

## Source

Inline module-doc comment (`DoD #4` measurement note, and the dedicated investigation paragraph) in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
