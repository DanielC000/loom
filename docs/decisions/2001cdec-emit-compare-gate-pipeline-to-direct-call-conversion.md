# 2001cdec — emit-compare-gate.mjs: convert setup-scaffolding scenarios off the full confirmWorkerMerge pipeline

`test/emit-compare-gate.mjs` was flagged by the suite-speedup epic (`24608d33`, via card `eef23028`'s
analysis) for growing 104s → 189s on the shared gate-timing ndjson. Investigation (this card) found that
comparison needs a correction before anything else: **both the 104s and 189s figures are POOL rows from
the same instrument** (`~/.loom/gate-timing/daemon-per-file-timing.ndjson`), not a solo-vs-pool
comparison. There is no like-for-like solo figure for 2026-10-01, so "104 → 189s, +82%" cannot be split
into a contention component and a real-regression component by comparing it against this card's own solo
measurements.

## What was actually measured

- **Solo baseline, pre-conversion** (3 runs, foreground, single-lane, `node test/emit-compare-gate.mjs`):
  101s / 115s / 122s (mean 112.7s), 0 failures.
- **Pool rows for this same file**, read from the ndjson (3 "file"-kind rows named exactly
  `emit-compare-gate`, excluding its siblings `-scope`/`-assets`/`-not-hermetic`/`-test-importers`):
  189,080ms / 147,904ms / 185,656ms (mean 174.2s), all full-suite (~1000-file) pool runs at pool size 3.
  The slowest co-running files in one of those same pool batches are themselves real-git-subprocess-heavy
  families (`mainline-watch-*`, `batch-merge-*`, `merge-gate-*`, `canonical-git-isolation`,
  `merge-confirm-solo-finalize-tip-cas`, `merge-repo-mutex`, `dist-importer-check-glue`).
- **Honest framing**: the pool-minus-solo gap (~61s, ~54%) is *consistent with* lane contention from
  those sibling real-git files sharing the pool, but this is not proven by a contrast case — there is no
  equivalent 2026-10-01 solo figure to compare against, and no isolated-vs-contended pair was run for the
  SAME code state. Treat "contention tax" as a plausible, not demonstrated, explanation for the gap.
- **What IS demonstrated, independent of the pool-vs-solo question**: the file's own design already
  proves which mechanism drives its absolute cost. Four scenarios (`M`, `T`, `V`, `W`) call
  `buildReducedGateCommand()` directly (no real git at all) and cost 0-3ms each. One scenario (`S`) calls
  `createWorktree` plus a direct `computeEmitCompareGate()` call, skipping the full
  `confirmWorkerMerge`/`SessionService`/`Db` pipeline, and cost ~2.1-2.5s. Every other real-git scenario
  additionally called the full pipeline and cost 5.7-11.6s each — 3-5x more than `S` for essentially the
  same `createWorktree` setup. `git diff --stat` against the sha pinned via
  `git log --until=2026-10-02 -1 main` (`0f1501598c73f9fe6ee69706c080c49bc2ae4c67`) confirms this file and
  `_emit-compare-fixtures.mjs` are byte-identical to that point — the cost growth is entirely in what the
  file exercises: `createWorktree` (185→297 lines, +60%, gained a real git subprocess call — an
  operational-home toplevel guard — on every invocation) and `confirmWorkerMerge` (2,586→3,077 lines,
  +19%, gained dozens of new real-git-subprocess-calling steps: a toplevel guard, shallow-repo detection,
  mainline-head read, fork-point/cut-base ancestry checks, three canonical dirty/staged/untracked-overlap
  detectors, repeated `resolveBranchTip`/`findLandedSquashCommit` lookups, a possible second
  `computeEmitCompareGate` call on the reunion path, an ungated-landing-check path, and mainline-watermark
  advancement). None of this is "compiling/transpiling more of a grown tree" — `computeEmitCompareGate`
  here runs against tiny synthetic fixture repos, never the real Loom tree.

## The conversion

Following the `6cf10d10`/`114e96e0` precedent (keep a small anchor set on the real pipeline; convert
scenarios that only use it as setup scaffolding; prove equivalence and a RED mutation for each
conversion): four scenarios were converted from the full `confirmWorkerMerge` pipeline to a direct
`createWorktree` + `computeEmitCompareGate()` call (mirroring the pre-existing `S` scenario's shape):

- **(C)** whitespace-only `.ts` edit → now asserts `eligible:true`, `identicalFileCount===1`,
  `changedTsPaths`, `notApplicable:false` directly.
- **(E)** added `.ts` file (status A) → now asserts `eligible:false` and a reason matching
  `/non-modify status "A" on compiled file/`.
- **(Q)** added `scripts/**/*.mjs` file (status A) → now asserts `eligible:false` and a reason matching
  `/non-modify status "A" on script file/`.
- **(N2)** docs-narrowing-guard (real behavioral edit + a docs/ line) → the scenario already had a direct
  `computeEmitCompareGate()` call (it needed to run before the branch-mutating merge); only the redundant
  `confirmWorkerMerge` back-half (which re-derived the same verdict the direct call already proved) was
  removed.

### Anchor set kept on the real pipeline, and why

- **(A)** — the ts/REDUCED anchor. Its assertions (warning text naming the scanner count, guard-basename
  inclusion, dist-scanner-naming, "informative compiled-count" wording, absence of the isolation caveat)
  all read `confirmWorkerMerge`'s own assembled output, which a direct classifier call cannot produce.
- **(B)** — the ts/FULL_GATE polarity anchor required by card `2db8a3dd` (`emitCompareReduced:false`, the
  decided-not-reducible polarity) — the file's own closing summary names (B) and (F) as "the two required
  polarities."
- **(D)** — the test/*.mjs anchor (the §2 counterexample: a comment-only edit introducing `Date.now()`
  text still runs every static guard and the changed test file itself, through the harness). Its
  assertions read `capturedGate`/warning text directly.
- **(P)** — the scripts/REDUCED anchor, same shape as (A) for the `packages/daemon/scripts/**` scope,
  with its own warning-naming assertions.
- **(R)** — the scripts/FULL_GATE polarity anchor (the "polarity-trap negative control", explicitly
  flagged as such in the file's own header) — the scripts-domain counterpart to (B).
- **(N)** — the docs/REDUCED anchor; this is literally the card `8ee4f11e` fix (the skipped inert docs/
  path must be NAMED in the warning, not silently dropped) — a confirmWorkerMerge-output assertion by
  construction.
- **(F)** — the out-of-scope/`notApplicable:undefined` polarity anchor required by card `2db8a3dd`,
  paired with (B).
- **(O)** — the literal motivating case for card `5149c036` (a real production specimen: a repo-root
  `CLAUDE.md` change alongside an otherwise-reducible edit). Kept rather than converted, per the kickoff's
  own "out-of-scope (B or O)" allowance — preserving the exact real-world specimen was judged worth the
  ~11s it costs.
- **(G)** — the soundness anchor (`emitDecoratorMetadata` in the PACKAGE tsconfig, not just the base one).
  Unique in the file; its only assertion (`capturedGate === FULL_GATE`) reads confirmWorkerMerge's own
  output.
- **(M)/(T)/(V)/(W)/(S)/(U)** — already minimal (pure unit calls or, for S, already the direct-call
  shape); untouched.

## Equivalence (card 2001cdec DoD condition 2)

For (C), (E), (Q) — which had no pre-existing direct call — a throwaway scratch harness
(`test/_ecg-equivalence-scratch.mjs`, deleted after use, never committed) ran BOTH the pre-conversion
`confirmWorkerMerge` pipeline AND a direct `computeEmitCompareGate()` call against the identical fixture,
before the pipeline's merge could advance/delete the branch. Measured, all PASS:

| Scenario | Pipeline verdict | Direct-call verdict | Match |
|---|---|---|---|
| C | `gateRan:true`, reduced (not `FULL_GATE`), `emitCompareReduced:true` | `eligible:true`, `identicalFileCount:1`, `changedTsPaths:["...example.ts"]`, `notApplicable:false` | yes |
| E | `gateRan:true`, `capturedGate===FULL_GATE`, `emitCompareReduced:false` | `eligible:false`, reason `non-modify status "A" on compiled file packages/daemon/src/second.ts`, `notApplicable:false` | yes |
| Q | `gateRan:true`, `capturedGate===FULL_GATE`, `emitCompareReduced:false` | `eligible:false`, reason `non-modify status "A" on script file packages/daemon/scripts/new-helper.mjs`, `notApplicable:false` | yes |

For (N2), the pre-conversion code already ran both calls on the same fixture and already asserted
`confirmWorkerMerge`'s `capturedGate===FULL_GATE` alongside the direct call's `eligible:false`/reason —
the equivalence was already structurally demonstrated by the code itself before conversion; no separate
scratch run was needed.

## RED proof (card 2001cdec DoD condition 3)

A second throwaway scratch harness (`test/_ecg-redproof-scratch.mjs`, deleted after use) mirrored the
FINAL converted (C)/(E)/(Q)/(N2) logic in isolation (~10s total per run instead of paying for the whole
file). Each mutation was applied directly to the compiled `dist/git/worktrees.js` (never
`src/git/worktrees.ts` — out of scope per the kickoff, and three sibling workers were editing that source
file concurrently), backed up first and restored byte-for-byte (verified by md5sum) immediately after
each round:

1. **Mutation A** (`if (outBefore !== outAfter)` → `if (true)` in the `.ts` transpile-compare loop):
   `(C)`'s three affected checks go RED (`eligible`/`identicalFileCount`/`changedTsPaths`); (E)/(Q)/(N2)
   stay GREEN.
2. **Mutation B** (same line → `if (false)`, forcing "always identical"): `(N2)`'s two affected checks go
   RED (`eligible`, the `not transpile-identical` reason match); (C)/(E)/(Q) stay GREEN.
3. **Mutation C** (renamed the compiled-file reason string `non-modify status "A" on compiled file` →
   `weird status "A" seen on compiled file`): `(E)`'s reason-match check goes RED; (C)/(Q)/(N2) stay
   GREEN.
4. **Mutation D** (same rename for the script-file reason string): `(Q)`'s reason-match check goes RED;
   (C)/(E)/(N2) stay GREEN.

Each mutation was reverted before the next; `dist/git/worktrees.js`'s md5sum matched its pre-mutation
backup at the end of the sequence, and the real `pnpm --filter @loom/daemon guards` run (30/30 passed)
and a full solo run of the real file (0 failures) confirmed the restore was complete.

## Timing + the timeout resize — interleaved A/B, not isolated solo repeats

An initial round of 3 solo repeats of the converted file alone (158s/193s/198s) came in HIGHER than the
pre-conversion baseline measured a few hours earlier (101-122s) — a single process-count observation
("21 vs ~17 `node.exe`") is not a load measurement, and without a contrast case that gap was an
unverified inference, not evidence the conversion helps. Redone properly as an INTERLEAVED A/B:
**A** = the pre-conversion file (`git show HEAD^:packages/daemon/test/emit-compare-gate.mjs`, written into
the same `test/` directory under a scratch name so its relative imports resolve identically; deleted
after use — never committed). **B** = the converted file in this commit. Run order A,B,A,B,A,B, foreground,
one lane, same build, no build between runs, with a `node packages/daemon/scripts/host-quiet-check.mjs`
whole-box CPU reading taken immediately before each run:

| Run | File | Load before (whole-box CPU%) | Duration | Pair Δ (A − B) |
|---|---|---|---|---|
| 1 | A (pre-conversion) | 85% | 189s | |
| 2 | B (converted) | 83% | 159s | **−30s (B faster)** |
| 3 | A (pre-conversion) | 97% | 193s | |
| 4 | B (converted) | 80% | 133s | **−60s (B faster)** |
| 5 | A (pre-conversion) | 73% | 208s | |
| 6 | B (converted) | 77% | 140s | **−68s (B faster)** |

All 6 runs: 0 failures. B was faster than A in every one of the 3 pairs, across a measured whole-box CPU
load ranging 73-97% — the load varied substantially across the sequence, and B still won every pair
regardless of which side of that range it landed on. This is the evidence the earlier solo-only
comparison lacked: a genuine contrast case, same build, same host-load window, alternating order so
neither file systematically gets the quieter half of the sequence.

`TEST_TIMEOUT_OVERRIDES["emit-compare-gate"]` (`scripts/test-daemon.mjs`) resized 750,000ms → 400,000ms —
2-2.5x of B's own max (159s → 318,000-397,500ms), rounded up slightly for a clean number. The prior 750k
was sized off a 257,740ms **pool** pass (card `db6df6b8`), not a solo one; this file still runs inside the
shared 3-lane pool at real gate/merge time, so a future pool-context measurement that reads meaningfully
above ~400s should raise this back up rather than trust the solo-only A/B arithmetic alone.

## Do not

- Do not compare the 2026-10-01 "104s" figure against a solo measurement as if it were one — it is a pool
  row from the same ndjson instrument as the 189s figure. There is no solo figure for that date.
- Do not convert (A), (B), (D), (P), (R), (N), (F), (O), or (G) to a direct-call shape — each is the one
  place pinning either a specific required polarity (card `2db8a3dd`'s B/F pair, or the scripts-domain
  B/R pair), a real-world specimen (O, card `5149c036`), or confirmWorkerMerge's own assembled output
  (warning text, gate-call count, capturedGate string) that a direct classifier call cannot produce.
- Do not treat the ~54% pool-vs-solo gap measured here as a proven contention tax — no contrast case (same
  code state, solo vs pool, same day) was run to isolate it from other explanations.
- Do not re-leak scenario D's base fixture repo — it must go through `registerForCleanup` (or an
  equivalent registered-cleanup path), never a bare `fs.mkdirSync` with no cleanup registration; every
  other scenario gets this for free via `makeRepoWithBaseSrcFile`.
