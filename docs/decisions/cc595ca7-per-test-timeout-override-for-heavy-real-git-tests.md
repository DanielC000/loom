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

## Card ae141763 — 2026-10-04: 41-file kill was host-wide starvation; only 2 of 41 warranted an override

Two full merge gates on 2026-10-04 killed 41 files at the 120s ceiling (op `99396155`; 2 of the 41
were also killed independently by batch op `54f67e2a`'s fallback). A taskless triage (`3bfa60d9`)
had already spot-checked 7 standalone on main, all clean (max `emit-compare-gate` 152.8s against its
existing 300k override). This card measured the other 34 (27 distinct files: 26 with no override,
plus a re-measure of `batch-merge-hold-crash-window`'s existing 190k one) the same way: standalone,
one file at a time (`--only=<name>`), sequential — but on an ALREADY-CONTENDED host, since a real
merge gate (`gate_queue` opId `438b8ad1`) ran the entire ~57-minute sweep, confirmed still running at
both ends via `gate_queue`. These are not quiet-host numbers.

**Result: 0/27 failed.** Range 28s-108s; full per-file table recorded in project memory
`merge-family-41-kill-2026-10-04-timing-sweep` (card `ae141763`), not restated here.

**Decision rule applied (per this card's DoD, not re-derived): the a9119abf cutoff — override only a
file at or above 0.9x the ceiling (108,000ms) — not every file the real gate killed.** Exactly two of
the 27 cross it: `merge-gate-retry` (108,800ms, triage) and `merge-batch-fallback-owner-recycle`
(108,000ms, this sweep); both got a new entry at ~2.5x (275,000ms / 270,000ms, matching 2403d1bc's
sizing). `emit-compare-gate`'s existing 300k override stays (1.96x margin at 152.8s, above the 1.6x
re-raise floor); so does `batch-merge-hold-crash-window`'s 190k (2.18x margin at its 87s re-measure).
Every other file — including `batch-fallback-already-landed-skips-gate{,-negatives}`, whose 56s/61s
here is consistent with the 45d6e631 split's own prior measurement, not a regression of it — is a
contention-only casualty: no override, by design.

**The honest limit:** 25 of these 27 measured well under 90s and still got killed in the real gate. A
per-file override cannot fix that — the cause is host-wide starvation under concurrent heavy gates,
not any one file's own margin. Widening comfortable files' overrides would not have prevented these
41 kills, only delayed the eventual kill. If this recurs, look at `gate_queue`'s `activeCount`/`cap`,
not at a file's margin.

## Source (ae141763 addendum)

`packages/daemon/scripts/test-daemon.mjs`, `TEST_TIMEOUT_OVERRIDES` (the `card ae141763` block before
the map's closing brace). Card `ae141763`. Related: `3bfa60d9` (triage), `a9119abf` (the cutoff
applied), `45d6e631` (the batch-fallback split re-confirmed, not re-litigated).

## Card ae141763 — round 2 (2026-10-04): 0.9x-of-standalone cutoff was too lenient; corrected to ~0.60x

A quiet-host full gate (op `438b8ad1`, cap admission 1, fleet idle) still killed 6 files at 120s, all
under round 1's 108,000ms cutoff — `a9119abf`'s 0.9x was derived from IN-GATE data, not a standalone
spot-check; round 1 misapplied it. Re-derived cutoff: ~0.60x of the ceiling (~72,000ms), reconverging
with `2403d1bc` (0.60-0.69x), not superseding it. New overrides (~2.5x re-measured standalone) added
for 8 files; one (`batch-post-gate-throw-outcome`, recorded 68,000ms, nowhere near either cutoff)
produced a real kill on re-measurement and is sized at the 300,000ms observed-kill tier instead. Full
per-file table, every measurement, and the honest-limit discussion: project memory
`merge-family-ae141763-round2-timing-2026-10-04`.

## Source (ae141763 round 2 addendum)

`packages/daemon/scripts/test-daemon.mjs`, `TEST_TIMEOUT_OVERRIDES` round-2 block. Card `ae141763`.
Related: `a9119abf`, `2403d1bc`, `45d6e631`.
