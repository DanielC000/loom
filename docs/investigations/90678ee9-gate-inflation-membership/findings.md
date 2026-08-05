# 90678ee9 — gate-run per-file inflation: key-stability, membership, and the missing population field

Read-only analysis pass against card `90678ee9` DoD-1/DoD-2, plus the one durable code deliverable, DoD-5.
**No gate run. No load generated.** Every measurement below comes from rows already banked at
`~/.loom/gate-timing/daemon-per-file-timing.ndjson` (a live, continuously-growing file — see
"Reproducibility anchor"), snapshotted into `data/pool2-window-per-file-timing.ndjson` for reproducibility.

**Verdict: on our own data, correctly join-verified rather than assumed, the inflated file set is
overwhelmingly RE-DRAWN, not a fixed/reliable set — matching the peer project's independent finding.**
The card's own title ("gate-run inflation is concentrated, not flat") is refuted by this result, not
confirmed; the manager is retitling it before merge. CPU profiling (DoD-3) and a contrast-run analysis
(DoD-4) were **not attempted** — both are moot once membership is re-drawn (per the card's own stated
conditional and its DoD-7 "removing the contention removes the phenomenon" note), per explicit manager
direction.

## Reproducibility anchor

Live source at time of the full-corpus scan (§1 below): `~/.loom/gate-timing/daemon-per-file-timing.ndjson`,
30,323,991 bytes, 101,556 lines, md5 `0e530f5769800e0c839b287c6de44c84`. **This file is append-only and was
still growing while this analysis ran** (a merge gate was live) — every table below is computed either
against the fixed, git-tracked snapshot at `data/pool2-window-per-file-timing.ndjson` (17 runs, 11,314
rows, pinned by exact `runUid` — see `scripts/extract-window.mjs`'s own `WINDOW_RUN_UIDS`), which is
reproducible byte-for-byte regardless of later growth, or against the live file for the one full-corpus
check that genuinely needs it (§1), which is re-runnable but not byte-identical after further growth —
the property it checks (no path separator in `name`) is structural to how the field is produced (see §1)
and is not expected to change from further rows landing.

## Window and exclusions

The 17 consecutive same-`poolSize`(2) runs `2026-08-05T03:04:37.914Z` → `08:06:16.953Z` (16 adjacent
pairs) — the same window the card's own two-run headline comparison (`1785899077914-1828` fast vs
`1785914317958-19828` slow) sits inside. Excluded, per the card's own DoD-6 four-stamp discipline (never
pool a duration across an instrument/condition change):

- The `2026-08-05T08:26:50.564Z` run (`failedCount: 1`) — a distinct condition (a failing suite), not a
  clean pass; the card's own body already treats an adjacent failing run this way for `63bdd2cc` in the
  linked `a591a654` investigation.
- Every run at `2026-08-05T08:49:33.661Z` and later — `poolSize` flips 2→3 there, a different instrument
  (this is the neighborhood of the card's own cited `9f98b245` 2→3 lane change).

## §1. DoD-1 — key-stability check + normalization + positive control

**Our per-file identity field is `name` (e.g. `"gate-cancel"`, `"companion-git-push"`) — a bare test-file
identifier, never an absolute path.** Unlike the peer project's field (an absolute worktree path carrying
a per-worktree hash segment, which made a naive cross-run join return `0 common files` — indistinguishable
from a genuinely re-drawn set), our field needed **no normalization**.

Full-corpus scan (`scripts/check-key-separator.mjs`, run against the live file at the stats above):

```
total "kind":"file" rows scanned: 101318
names containing "/": 0
names containing "\": 0
```

**Why this is true, not just observed today:** `name` comes from `discoverHermeticTests` in
`packages/daemon/scripts/test-daemon.mjs` — `rel.slice(0, -".mjs".length)`, where `rel` is a POSIX-joined
path relative to `test/`. A test file nested in a real subdirectory (not `fixtures/`/`census/`, not
underscore-prefixed) WOULD produce a `name` containing `/`. Checked directly against the tracked tree:
**zero** of the 711 hermetic-eligible `.mjs` files under `packages/daemon/test/` (excluding `fixtures/`,
`census/`, and underscore-prefixed paths) live in a subdirectory today — the flatness is a convention, not
a structural guarantee. This does not threaten run-stability even in principle, though: a nested test's
`name` would still be a **relative, worktree-independent** path segment (e.g. `"sub/foo"`), never an
absolute, per-worktree-hashed one — the specific property that broke the peer's join. So the field would
stay run-stable even if this convention changed; only its current flatness is convention-dependent.

**Positive control 1 — common-name counts between adjacent runs, across the whole window**
(`scripts/analyze-window.mjs`, DoD-1a table): every adjacent pair's common-name count is non-zero and
tracks the small `testCount` churn between runs (e.g. `663→662` common `662`; `665→666` common `665`) —
never the peer's `0 common files` failure signature, and never a trivially-total match that would suggest
the join isn't actually discriminating anything.

**Positive control 2 — reproduce the card's own already-published numbers from raw rows** (DoD-1b table,
stronger control): rejoining the card's own headline pair from the snapshot reproduces its published
figures exactly:

| | this analysis | card's published figure |
|---|---|---|
| aggregate ratio | ×1.4383 | ×1.438 |
| top5 (heavy, ≥8s) | `companion-git-push:x2.803, gate-cancel:x2.780, gate-timeout-circuit-breaker:x1.820, gate-semaphore-concurrency:x1.632, merge-gate-reuse:x1.476` | same, verbatim |
| bottom5 | `worker-kickoff-guarantee:x1.010, pty-giveup-clear:x1.004, pty-healifstuck-clear:x1.004, pty-mode-convergence:x1.003, pty-giveup-false-negative:x0.999` | same, verbatim |

A broken join could not have reproduced figures already independently recorded in the card. **This is a
reusable move worth naming: when a card already publishes a derived number, re-deriving it from raw data
validates the whole pipeline for free** — stronger than the non-zero/non-total common-count check alone,
because it validates the join AND the aggregation AND the ranking, all at once, against a number nobody
in this pass computed.

## §2. DoD-2 — dispersion presence, then membership

Extended the card's 2-point comparison to all 16 adjacent pairs in the window. Heavy-file baseline ≥8s
(card's own threshold), dispersion = std of per-file ratio (next-run / this-run) over common heavy files,
inflated = ratio ≥1.5×. Full table in `scripts/analyze-window.mjs`'s output (reproduced below, condensed):

| pair | window | dispersion(std) | heavy files | inflated (≥1.5×) files |
|---|---|---|---|---|
| 0 | 03:04→03:19 | 0.033 | 46 | — |
| 1 | 03:19→03:33 | 0.038 | 47 | — |
| 2 | 03:33→03:48 | 0.035 | 48 | — |
| 3 | 03:48→04:16 | 0.116 | 48 | — |
| 4 | 04:16→04:51 | 0.093 | 61 | — |
| 5 | 04:51→04:53 | 0.113 | 60 | — |
| 6 | 04:53→05:10 | **0.194** | 58 | companion-git-push, gate-cancel |
| 7 | 05:10→05:17 | **0.232** | 57 | worker-prompt, spawn-recut-stale-branch |
| 8 | 05:17→05:35 | 0.122 | 60 | — |
| 9 | 05:35→05:37 | 0.059 | 51 | — |
| 10 | 05:37→05:54 | 0.108 | 53 | — |
| 11 | 05:54→06:27 | **0.285** | 51 | merge-reject-notify-suppress, merge-repo-mutex, multi-repo-worker-lifecycle, no-gate-by-design-merge-warning, merge-union-gate, merge-spawn-tracked, merge-gate-reuse, pending-op-settle-lineage |
| 12 | 06:27→07:18 | **0.372** | 61 | companion-git-push, gate-cancel, gate-timeout-circuit-breaker, git-identity-warning |
| 13 | 07:18→07:29 | **0.287** | 77 | — |
| 14 | 07:29→07:49 | 0.064 | 56 | — |
| 15 | 07:49→08:06 | 0.053 | 51 | — |

(pair12 is the card's own original slow run, `07:18:37.957Z`.)

**Dispersion presence:** all 16/16 pairs show nonzero dispersion (range 0.033–0.372, mean 0.138) — dispersion
is not absent here the way the peer found it absent in 6/8 of theirs. Using the peer's own reported bands
purely as an informal scale (different suite; not claiming their mechanism transfers — see below): 9/16
pairs sit at or below their "no meaningful inflation" ceiling (0.114), 5/16 sit at or above their "real
divergence" floor (0.159), 2/16 in between. Real divergence shows up in a comparable-or-larger share of
pairs here than on their suite.

**Membership:** of **14 distinct files** ever inflated ≥1.5× across the 16 pairs, **12 appear in exactly
one pair**. Only 2 recur — `companion-git-push` and `gate-cancel`, each in exactly 2 of 16 pairs (pair6 and
pair12, non-adjacent — 6 pairs apart). Every other inflated file (`gate-timeout-circuit-breaker`,
`git-identity-warning`, `worker-prompt`, `spawn-recut-stale-branch`, `merge-reject-notify-suppress`,
`merge-repo-mutex`, `multi-repo-worker-lifecycle`, `no-gate-by-design-merge-warning`, `merge-union-gate`,
`merge-spawn-tracked`, `merge-gate-reuse`, `pending-op-settle-lineage`) appears exactly once, never again
in this window.

⇒ **On our own data, join-verified rather than assumed: the inflated set is overwhelmingly re-drawn run to
run — not a fixed, nameable driver.** This independently corroborates the peer's finding (their 2 divergent
runs had completely disjoint inflated sets) rather than merely inheriting it.

## What could NOT be established

- **Whether `companion-git-push`/`gate-cancel`'s 2-pair recurrence is a real (if weak) signal or
  coincidence.** n=2 each, non-adjacent. Not enough to revive the card's own already-refuted
  git/gate-semaphore clustering hypothesis without a mechanism — and CPU profiling (the tool that would
  supply one) was explicitly not run, per the manager's decision that profiling a once-inflated file on a
  now-quiet host would profile it in its non-inflated state (the card's own DoD-7).
- **No contrast-run analysis (DoD-4)** and **no CPU profiling (DoD-3)** — both out of scope for this pass
  by explicit manager direction, once DoD-2 answered "re-drawn."
- **The 08:26Z (1-failure) run and the poolSize=3 runs were not analyzed** in this pass, to keep the
  four-stamp discipline (population/instrument) clean across every comparison made here.

## §3. DoD-5 — the missing population field

`testCount` (already stamped) says how many test files ran; nothing measured how much each file's own
source actually is, so a reader could not tell "the suite grew" from "the same suite got slower" from the
existing schema alone — the exact gap the peer project also had (they stamped a flat file-count field
while their real cost driver was corpus *content*).

**Landed:** `computeTestSourceBytes(testDir, selected)` in `packages/daemon/scripts/test-daemon.mjs` — sums
the on-disk byte size of every selected test file's own source (cheap `fs.statSync`, no read). Stamped as
`testSourceBytes` on both the `run-start` and `run-summary` NDJSON rows, alongside the existing `testCount`.
A selected name with no file on disk contributes 0 and never throws (mirrors `runOne`'s own
`fs.existsSync` skip).

**What it does NOT distinguish, stated in the code comment itself:** two files of equal byte size can do
wildly different amounts of real work — a loop bound by fixture/DB row count, not by lines of test code —
so a rise in `testSourceBytes` at a flat `testCount` says "the suite's own source grew," not "the suite got
slower." Those remain two separate claims a future reader must not conflate; this field answers the
suite-growth question, not the per-run-slower question this card was chasing.

Tests: `packages/daemon/test/test-daemon-gate-timing.mjs` (positive control: sums exactly the selected
files' sizes, ignoring an unselected on-disk file; negative controls: a missing selected file contributes 0
and does not throw, an empty selection reports 0). Verified against real-spawn coverage too —
`test-daemon-gate-timing-sigkill.mjs` exercises the actual `run-start`/`run-summary` row-writing code path
this field was added to, and still passes.

## Reproduce

```
node docs/investigations/90678ee9-gate-inflation-membership/scripts/extract-window.mjs
node docs/investigations/90678ee9-gate-inflation-membership/scripts/analyze-window.mjs
node docs/investigations/90678ee9-gate-inflation-membership/scripts/check-key-separator.mjs
node packages/daemon/test/test-daemon-gate-timing.mjs
node packages/daemon/test/test-daemon-gate-timing-sigkill.mjs
```

All read-only against the NDJSON (no build, no gate, no test-suite spawn) except the last two, which are
the project's own targeted test files for the DoD-5 code change.
