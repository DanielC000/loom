# 9966c52d — a timeout-killed retried file is not the same warning as an order-dependent/cross-test-pollution bug

## Narrative

Card 9966c52d: the `[loom:merge-done]` weaker-pass warning generically reads "an order-dependent/
cross-test-pollution bug can pass alone and fail in the full suite" for ANY retry-and-pass — but
`retriedFile`'s attempt-1 `outputTail` sometimes shows the file was KILLED ON A TIMEOUT
(`test-daemon.mjs`'s own `(exit timeout (...))` classification for that file's `FAILURES:` entry), with
every visible assertion `PASS` and the process killed on a clock. The generic wording is WRONG for that
case — nothing about a timeout kill indicates order-dependence/cross-test-pollution, and a manager reading
only the nudge could file a card against a file that has no such defect.

MEASURED ON TWO SPECIMENS, different files (`kickoff-real-spawn`, `batch-merge`), both genuine timeout
kills mislabelled by the generic wording. A contrast case (`concurrentGates 2/2` present in BOTH a
failing and a clean run) already kills "host contention" as the discriminating cause for the first
specimen; the second specimen was killed at `concurrentGates 1/1`, UNCONTENDED on the semaphore — so the
fix's wording asserts NO cause, it only names the failure mode (timeout vs. assertion).

`isTimeoutKillEntry` is anchored on the RETRIED FILE'S OWN `FAILURES:` line — `- <retriedFile> (exit
timeout` — never a bare "exit timeout" mention anywhere else in the tail (e.g. inside a different file's
own echoed stdout/stderr), so a match can only mean `test-daemon.mjs` itself classified THIS file's exit
as a timeout. FAIL-SAFE BY CONSTRUCTION: `outputTail` missing, or present but not matching this exact
shape for this file, both return `false` — never inferred from an absent match, only asserted from a
positive one, so an unrecognised signature keeps the original wording byte-identical.

REJECTED WORDING: an early implementation added "(possibly host-load-related)" to the corrected message —
rejected, because the card's own contrast case already forbids asserting a cause, and a hedge inside a
one-line warning is exactly where the qualifier dies and the reader keeps only the noun. The shipped
wording names no cause and points at the retained gate output instead.

SCOPE SHIPPED: only this wording fix (the card's own DoD item covering it) landed under this id — the
file's own timeout value, the within-run Enter-confirmation split, and the test-shape-vs-code-fix
question were explicitly deferred to a follow-up card, observation-gated.

## `outputTail` threaded through so the timeout signature is checkable (site: `confirmWorkerMergeTracked`)

`outcome.value.outputTail` (attempt 1's own captured tail) is passed through to `formatWeakerPassWarning`
so a genuine timeout kill isn't mislabelled as an order-dependent/cross-test-pollution bug — the SAME
formatter is reused by both the live `[loom:merge-done]` nudge and the pull-based `gate_status(opId)`
read, so the two surfaces can never drift into two different tellings of the same fact.

## Do not

- Do not word a retry-and-pass warning as cross-test-pollution when the retried file's own tail shows a
  timeout kill — check `isTimeoutKillEntry` first.
- Do not assert a cause (host load or otherwise) in the corrected wording — the card's own contrast case
  forbids it; name the failure mode only, and point at the retained output.
- Do not infer a timeout from an absent match — an unrecognised signature must keep the original wording
  byte-identical.
- Do not inline a second copy of the weaker-pass wording elsewhere — one formatter, shared by the nudge
  and `gate_status`, so the two surfaces can't drift.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-runner.ts`, above `isTimeoutKillEntry` (as of
this tranche's HEAD; not itself anchored yet — a future tranche on that file should find this record via
the one-id-one-file `find` and anchor to it rather than create a second one). The threading detail is
from `packages/daemon/src/sessions/service.ts`, `confirmWorkerMergeTracked`'s async settle callback
(`retryNote`), as of this tranche's HEAD. Board card `9966c52d`'s own body (filed by the Loom lead,
2026-09-04, from a free observation on a real merge gate — no gate manufactured).
