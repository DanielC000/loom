# cc595ca7 — per-test `TEST_TIMEOUT_MS` overrides for heavy real-git tests, not a raised blanket ceiling

## Narrative

A handful of git-locking/merge tests do heavy REAL git subprocess work (dozens to hundreds of real
`git` spawns — worktree creation, concurrent merges, content-integrity sweeps) with no internal
timing assertion of their own. Under the full suite's ~540-concurrent-git contention, that real
work alone can blow past the blanket `TEST_TIMEOUT_MS` even though nothing is actually wedged.

**Confirmed specimens:** `merge-repo-mutex.mjs` timed out on an unrelated card's gate, all-green
standalone; `merge-stranded-backstop.mjs` flaked the same way at `cap=2`/`concurrent=2`. (Two
further specimens on this same file — `gate-timeout-circuit-breaker.mjs` and `merge-gate-reuse.mjs`
— are recorded separately under cards `6436bd5a` and `2bb7a114`, each with its own measured timing.)

**Why a per-test override map, not a raised blanket ceiling:** raising `TEST_TIMEOUT_MS` itself
would dull fast-fail for the ~296 OTHER hermetic tests that have nothing to do with git contention.
Instead this is a small, explicit per-test override (same documented-list shape as `NOT_HERMETIC`
elsewhere in this file), giving just these git-heavy tests real headroom.

**Hang detection is unaffected:** a genuine infinite hang in any of them still gets killed and
reported — verified: the same kill-and-report path fires and reports `status:"timeout"` regardless
of the ceiling value — just at a ceiling actually sized for their real workload instead of one with
zero margin.

## Do not

- Do not raise the blanket `TEST_TIMEOUT_MS` to cover these tests — use a per-test override instead.
- Do not read a timeout on one of these tests as evidence of a hang before checking its measured
  standalone cost — several of these are near or past the blanket ceiling on real git-work volume
  alone, with every stubbed gate call resolving instantly.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, at the `TEST_TIMEOUT_OVERRIDES`
definition (originally ~lines 830-849). Card `cc595ca7`. Related: `6436bd5a`, `2bb7a114`,
`63bdd2cc` (sibling specimens/fixes in the same override map).
