# c6e7ebe7 — `GIT_TIMEOUT_MS` margin measured directly; two further changes investigated and rejected

## Narrative

This module runs up to six `runGit` calls in the worst case (three unconditional, plus conditional fourth/fifth/sixth), each capped at `GIT_TIMEOUT_MS`, synchronously (`execFileSync`) blocking the event loop — a real cost since manager spawns can BURST (boot-reconcile resumes every manager across every project at once).

This card measured the baseline three-call cost directly on Windows: **147–275ms at IDLE, 220–465ms at 3× CPU oversubscription** — NOT the "tens of ms" an earlier version of this module's doc claimed (a real 15–27% of the 1s budget consumed at idle alone). Still a comfortable margin even with the fourth call added (a single-object lookup, cheap relative to the two full-history `git log` walks already in the baseline) — the fifth/sixth calls (card `3d7dccb9`'s `builtContentMatchesHead` ancestry check + content diff) are UNMEASURED DIRECTLY, but are the same shape (a single-object ancestry check + one bounded `git diff --name-only`, not a full-history walk) and share the SAME rare gate as the fourth, so they are not expected to change that margin materially. No observed in-flight call, idle or oversubscribed, has ever come close to the timeout. A *different* tail shows up only in the outer node process's own scheduling latency under heavy oversubscription, which is not a git-call tail and must not be conflated with one.

Two further changes were considered and REJECTED:

- **(b) Distinguishing a TIMEOUT specifically from every other `unavailable()` cause** (no `.git`, no HEAD commit, git not installed) — considered because a timed-out call degrades to the same `{available:false, reason}` shape as any other unreadable-repo case. At the time, the one consumer that treats `available:false` as silent (`composeManagerStartupPrompt`) did so deliberately and uniformly for every reason, not just a timeout, so singling out timeouts there would have been inconsistent with that policy, not a fix to it. (Card `d3d4d432` later replaced that uniform policy with a two-class split — see its own record — but still does not single out a timeout beyond that: it classifies as `"could-not-measure"`, the same as any other reachable-but-failed cause, exactly as this rejection intended.)
- **(c) Raising or retrying the timeout** — rejected for lack of evidence: no observed git call, idle or at up to 9× CPU oversubscription, has ever approached this budget. Widening a timeout with no observed stall to justify it is exactly the kind of change this project has a standing rule against.

## Do not

- Do not raise `GIT_TIMEOUT_MS` without a measured stall to justify it — none has ever been observed, up to 9× CPU oversubscription.
- Do not single out a timeout from the `unavailable()` reason taxonomy on its own initiative — see `d3d4d432`'s record for the actual (different) axis that was later added.

## Source

Inline module-doc comment (`DoD #4` measurement note, and the dedicated investigation paragraph) in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
