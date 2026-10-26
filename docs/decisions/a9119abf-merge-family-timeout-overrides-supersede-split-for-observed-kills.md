# a9119abf — per-file 300s overrides for merge-family files with observed in-suite kills; split-not-override superseded only there

## Do not

- Do not read this as licence to raise the blanket `TEST_TIMEOUT_MS` — cc595ca7's no-blanket principle stands; a real hang in any other file is still killed at 120s.
- Do not add an override on thin margin alone — the bar is an OBSERVED kill, or a measured max duration (in-suite, OR — for a real-git/worktree-heavy file — quiet-host solo) at or above ~0.60x of the ceiling (~72,000ms). **Not 0.9x/108,000ms** — this line asserted that figure until the 2026-10-27 addendum below; it was already superseded by cc595ca7's card ae141763 round 2 (2026-10-04). Read the cutoff at source, don't copy a number into this file. ba46a06f's "margin alone is not sufficient warrant" still governs anything thinner than that cutoff.
- Do not size an override off a "solo time x N" factor — the "in-suite ~ 2x solo" figure was one sample and is not supported by the timing corpus (see below).

## Narrative

Three `merge_batch` gates on 2026-09-24 landed nothing, each red only on files SIGTERM-killed at the 120s per-file ceiling (different files each time). Card 4e8e2d82 had split three of them (batch-merge-gate-history, batch-merge-robustness, emit-compare-gate-scope) on the ba46a06f margin rule ("split, do not override"); the kills continued, so that remedy was insufficient for files with observed kills.

**What is superseded, and what is not.** The split-not-override remedy is superseded ONLY for files with an observed kill. The cc595ca7 principle (per-file curated overrides, never a raised blanket ceiling) is unchanged. ba46a06f's paragraph was written on max passes of 79.5s/65.7s; the files then grew to 108-120s, so it was stale by content growth rather than overturned by a new mechanism.

**Data (all bounds stated).** ~/.loom/gate-timing/daemon-per-file-timing.ndjson, cut at 2026-09-24T17:04:57Z. Per-file rows survive for only 7 full-suite runs, all on 2026-09-24 on one host: n=7 per file, one day, one host — this is a set of observations, not a rate. A kill is censored at 120,000ms, so max pass understates. In-suite max pass / kills: batch-merge-gate-history 119,740ms/1, batch-merge-reduced-gate 113,101/1, batch-merge-robustness 112,887/2, batch-merge 111,133/2, merge-gate-single-file-retry 108,722/0, batch-merge-gate-retry 108,380/1, batch-merge-robustness-redundancy n=1 101,942/0, emit-compare-gate-scope 101,446/1, merge-confirm-verdict-cache 75,533/1 (median 67s; the kill is a tail spike). Suite-level: 27 full runs that day, several with merge-family failures (e.g. batch-merge-gate-retry in 9); those runs mostly have no per-file row, so timeout vs real failure is not distinguishable for them.

**The "2x" premise.** The 50s-solo/102s-in-suite pair for robustness-redundancy is one sample and the 50s figure is not in the ndjson. Paired targeted-vs-full rows show ~1.1-1.6x, but the targeted runs were not quiet-host solos, so that is a lower bound. The dominant feature is a heavy tail, not a constant factor. Sizing is therefore off observed in-suite max plus tail.

**Decision.** 300,000ms per-file override (matching the existing style) on the nine files above. Margin over observed max pass is 2.5-4.0x. batch-merge-robustness-redundancy (n=1) is included because it is a split half of a file with 2 kills — inherited risk, not a measurement of its own; merge-gate-single-file-retry is included on the 108s cutoff alone (0 kills).

**Cost.** Passing runs are unchanged. A real hang in one of these nine files is killed at 300s instead of 120s: +180s to detect, per hung file, one pool lane stalled meanwhile. All other files keep the 120s fast-fail. Options rejected: a blanket 180s ceiling (cc595ca7); the isolated real-spawn phase (opt-in/default OFF, adds serial time, 0f0816e2 forbids reusing its numbers, and it does not address a per-file tail).

**Revisit when** per-file rows for many more full runs (across days/hosts) exist — then a rate can replace n=7, and an override whose file never comes near the ceiling can be dropped.

## Card ae60cd4e — 2026-10-27: a thin SOLO margin is unsafe too; corrects this record's stale 0.9x figure

This record's Do-not line stated 0.9x-of-ceiling (108,000ms) — already stale: cc595ca7's card ae141763 round 2 (2026-10-04) re-derived ~0.60x (~72,000ms) after a quiet-host gate killed six files under 108,000ms; read that derivation there, not re-quoted here. This record's line never caught up.

New evidence (2026-10-25/26) reconverges on the same number and adds one finding: a thin QUIET-HOST SOLO margin, not only a thin in-suite max pass, is unsafe for this family.

Card 75e8a845's `batch-merge-head-moved`: 7/14 in-suite SIGTERM kills, all plain 120,000ms timeouts, 0 real failures (every FAILURES-block line quotes the last-passed scenario; ndjson `failureDetail.messages` is `[]` throughout). Solo (6 trials, one host, foreground): 71,434-86,233ms — 0.60x-0.72x of the ceiling, below the old 0.9x bar. In-suite max PASS before any override: 113,613ms (`test-daemon.mjs:1133`). Ratio (in-suite ÷ solo): 1.32x-1.59x — reconverges with round 2's ~1.39x-1.70x (memory `merge-family-ae141763-round2-timing-2026-10-04`) and `2403d1bc`'s 0.60-0.69x. One file, 6 solo + 1 in-suite observation — corroborates round 2's broader sample, not a new rate.

Card 3e51ebf0's other two files don't extend this: `worker-run-gate` (solo 118,220ms; passes 115,212ms/108,889ms, `test-daemon.mjs:971`) already sat at 0.91x-0.99x, inside the OLD bar. `mainline-ledger-rebind-race` (solo 235,897ms, `test-daemon.mjs:1115`) already exceeds the ceiling — an ordinary observed kill, not thin-margin. Only `batch-merge-head-moved` tests the thin-SOLO question.

**Corrected rule** (folded into the Do-not line above): a real-git/worktree-heavy file's quiet-host solo time counts the same as an in-suite max pass — override once either is >= ~0.60x of the ceiling, sized 2-2.5x the observed max as usual. Outside that family, or below ~0.60x, nothing changes; ba46a06f's "margin alone is not sufficient warrant" still governs. Source: `packages/daemon/scripts/test-daemon.mjs` line numbers cited above; `~/.loom/gate-timing/daemon-per-file-timing.ndjson` (read-only, host-local). Cards `75e8a845`, `3e51ebf0`. Related: `cc595ca7`, `2403d1bc`, `ba46a06f`.
