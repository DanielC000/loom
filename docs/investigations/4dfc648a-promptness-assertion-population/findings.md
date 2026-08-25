# Card `4dfc648a` — promptness-assertion enumeration + harness-timeout read + exit-close-gap re-derivation

Scope of this document (per kickoff): DoD-1's **enumeration** half only (not the margin-measurement half),
DoD-2 (the harness per-test timeout), and DoD-3 (re-deriving the `exit-close-gap` tension from that test's
own output). No full-suite run and no `run_gate` were used anywhere in this work — every measurement below
either reads source directly or runs a single named test file standalone.

## 1. Enumeration of promptness assertions in `packages/daemon/test/**`

### Search strategies used
1. **Positive-control phrase grep** — searched for the exact assertion text of each of the card's five named
   specimens, verbatim. Recovered rows 2, 3 (`exit-close-gap`), 4, and 5 directly by exact substring; row 3's
   other failure (`emit-compare-gate`, killed by the harness, not a `check()` failure) required strategy 2.
2. **Harness-timeout read** — read `TEST_TIMEOUT_MS` / `TEST_TIMEOUT_OVERRIDES` in `scripts/test-daemon.mjs`
   directly (see §2) and cross-referenced `emit-compare-gate` against the override allowlist.
3. **Regex sweep, single-line** — `check\(["'][^"']*["'],[^;]*(elapsed|Elapsed|GapMs|durationMs|Duration|budget|
   ceiling|deadline|withinMs|underMs)[^;]*[<>]=?\s*\d` against every file in `test/`.
4. **Regex sweep, multiline** — the same identifier list, but allowing the label and the numeric condition to
   sit on different lines (`check("...",\n  cond)` — a very common formatting shape in this codebase). This
   caught sites strategy 3 missed entirely (e.g. `gate-runner-failing-test-truncation.mjs:242-243`,
   `mcp-ready-gate.mjs:112-113`, both `merge-rest-route-tracked.mjs` band checks).
5. **Prose-keyword sweep, case-insensitive** — `(well under|promptly|not waiting it out|fast enough|near.
   instant|no hang|did not hang|not a stall|liveness window|alive before|within \w)` etc., across all of
   `test/`, then **manually read every hit** to classify true vs. false positive.
6. **Manual read** of every regex/keyword hit's surrounding block (not just the matched line) to confirm the
   value being compared is a real elapsed-time/duration and the check is genuinely about *speed*, not shape
   or count (a few keyword hits — e.g. `trust-lock-fault-injection.mjs:105`, `companion-grants-rest.mjs:137`
   — turned out to be false positives on inspection; see "false positives" below).

**Positive control result: all five card-named specimens were recovered** by this combined sweep (four by
exact-phrase grep, one — `emit-compare-gate` — by the harness-timeout read). Per the card's own instruction,
that is the bar for trusting the sweep's coverage; it does not prove completeness (see caveat below).

**Coverage caveat, stated plainly:** this was a regex/keyword sweep across ~765 files, not a read of every
file. A promptness assertion phrased with vocabulary and shape outside the patterns above (a non-standard
comparison operator, a helper function that hides the comparison, a synonym not in the keyword list) would
not have been found. The positive control gives confidence the sweep's *shape* is right, not that the count
below is exhaustive.

### Sites found: 40 across 30 files, in three distinct shapes

**Shape A — explicit numeric elapsed/duration bound inside `check()`/`assert()`** (single ceiling, or a
floor+ceiling band): **21 sites, 14 files.**

| File:line | Assertion | Budget | Budget source |
|---|---|---|---|
| `claude-version-prewarm.mjs:60` | `elapsedMs < 4000` | literal `4000` | half of the 8s `execFile` timeout, hand-picked |
| `companion-live-upgrade.mjs:449` | `elapsedMs < 300 + 2000` | literal sum | `LOOM_UPGRADE_BUSY_WAIT_MS` + a fixed margin |
| `companion-mirror.mjs:163` | `elapsed < 200` | literal `200` | hand-picked |
| `exit-close-gap.mjs:59-61` | `exitAt !== null && timeoutFiredAt !== null && exitAt <= timeoutFiredAt` | ordering, not a magnitude | derived from the file's own `timeoutMs:250` fixture setup |
| `exit-close-gap.mjs:62` **(ROW 3 specimen)** | `exitToCloseGapMs !== null && exitToCloseGapMs > 300` | literal `300` | hand-picked floor (this is a *minimum*-gap assertion, the inverse polarity of most entries here) |
| `exit-close-gap.mjs:76-79` | contrast case: `exitToCloseGapMs === null \|\| exitToCloseGapMs < 300` | literal `300` | same constant, opposite polarity (ceiling) |
| `git-writer.mjs:88` | `elapsedMs < 30_000` | literal | hand-picked |
| `git-writer.mjs:100` | `elapsedMs2 < 30_000` | literal | hand-picked |
| `git-writer.mjs:202` | `elapsedLockMs < 30_000` | literal | hand-picked |
| `git-writer.mjs:227` | `elapsedRaceMs < 30_000` | literal | hand-picked |
| `gate-semaphore-concurrency.mjs:378` | `elapsedMs < 200` | literal | hand-picked |
| `gate-runner-failing-test-truncation.mjs:242-243` | `elapsedMs < 2000` | literal | hand-picked ("well under 2s for ~2MB input") |
| `mcp-ready-gate.mjs:112-113` | `elapsedC >= 250 && elapsedC < 2000` | band | derived from the scenario's own configured wait |
| `mcp-ready-gate.mjs:125` **(ROW 5 specimen)** | `elapsedD < 200` | literal `200` | hand-picked |
| `merge-rest-route-tracked.mjs:166-167` | `elapsedMs >= 5000 && elapsedMs < 11000` | band | `gateCommandTimeoutMs:1000` config × documented "6x ceiling" (~6000ms nominal), ±tolerance |
| `merge-rest-route-tracked.mjs:217-218` | `elapsedMs >= 5000 && elapsedMs < 11000` | band | same config-derived multiple, dead-owner variant |
| `merge-rest-route-tracked.mjs:270` **(ROW 2 specimen)** | `finalResult.settled === true && finalResult.ok === true && finalResult.value?.merged === true` | not itself numeric | a correctness check *downstream* of the same block's 6s-ceiling wait — races against a real git squash's own wall-clock cost (see note below) |
| `codescape-supervisor.mjs:326-327` | `elapsedB < 2_000` | literal | hand-picked ("near-instantly... NOT after the delayMs trailing sleep") |
| `codescape-supervisor.mjs:524-525` | `hungElapsed >= HUNG_TIMEOUT_MS - 50 && hungElapsed < HUNG_TIMEOUT_MS + 4_000` | band | config-derived (`HUNG_TIMEOUT_MS` ± tolerance) |
| `gate-timeout-tree-kill.mjs:74-75` | `elapsed < timeoutMs * 10` | derived multiple | 10× the scenario's own `timeoutMs` |
| `pending-ops-registry.mjs:565` | `r.settled === true && order.length === 1 && order[0] === "settle:true"` | behavioral branch, not a magnitude | asserts the FAST resolution path fired, not the slow one — border of Shape A/C |

**Row 2 note:** the card names `merge-rest-route-tracked.mjs:270` as the failing assertion. On inspection,
line 270 itself is a correctness check (did the merge really land), not a numeric time bound — but it sits
immediately after the same block's own 6s-ceiling band checks (166-167) and is racing the real elapsed time
of an actual `git merge` + gate call. It belongs in this population as a *consequence* of a promptness
budget elsewher in the same block, not as a standalone numeric assertion in its own right — worth flagging
so the ONE-vs-FIVE mechanism question (out of this document's scope) isn't answered off an imprecise reading
of what row 2 actually asserts.

**Shape B — liveness-window boolean checks ("X is alive before Y")**: **15 sites, 9 files.** These have no
numeric ms bound anywhere in the `check()` call itself — they assert a process is *still alive* at the
instant of the check, immediately following a `waitUntil(...)` that already confirmed it existed. Structurally
different from Shape A: there is no "margin-to-budget ratio" to compute (see §1 caveat below) — the risk
is a **scheduling gap** between the prior `waitUntil` resolving and the `check()` firing (both compete for
the same event loop), not a magnitude comparison.

| File:line |
|---|
| `cli-stop-auth.mjs:144` |
| `cli-stop-pid-identity.mjs:79` |
| `companion-live-upgrade.mjs:169` |
| `dev-server-teardown.mjs:168` |
| `dev-server-teardown.mjs:169` |
| `graceful-stop.mjs:117` |
| `gate-timeout-tree-kill.mjs:125` |
| `gate-timeout-tree-kill.mjs:126` |
| `pty-conpty-dll-kill.mjs:192` |
| `pty-conpty-dll-kill.mjs:200` **(ROW 4 specimen)** |
| `worker-session-reap.mjs:170` |
| `worker-session-reap.mjs:171` |
| `worktree-process-reap.mjs:325` |
| `worktree-process-reap.mjs:326` |
| `worktree-process-reap.mjs:327` |

**Shape C — harness-external per-test-file timeout ceiling**: **1 mechanism, applying to every hermetic test
file that has no `TEST_TIMEOUT_OVERRIDES` entry.** This is not a `check()` call at all — it's
`scripts/test-daemon.mjs`'s own `TEST_TIMEOUT_MS` (120,000ms), applied to the whole child process. See §2.
`emit-compare-gate.mjs` **(ROW 3's other specimen)** is the confirmed instance: it does real, multi-scenario
git work with no override, and the card's own observed run shows it consuming ~112.5s of the 120s ceiling
standalone (see §2's finding).

**Sites found via the keyword sweep that turned out NOT to be promptness assertions (false positives,
kept here per the card's own "prove the negative" standard rather than silently dropped):**
- `trust-lock-fault-injection.mjs:105` — the message string interpolates `dt.toFixed(1)}ms` for diagnostic
  color, but the asserted boolean is `trusted(isoJson, keyFor(proj))`, a correctness check with no timing
  condition anywhere in it. The "no hang" wording in the label is aspirational, not asserted.
- `companion-grants-rest.mjs:137` — "within UTF-16 `.length` but OVER the real UTF-8 byte bound" is a
  **size** bound (bytes), not a time bound; the keyword match on "within" was a false hit.
- `gate-status.mjs`'s `elapsedMs`/`durationMs`/`totalDurationMs` checks (lines 287, 459, 611) assert the
  field **is a plausible non-negative number that matches its own timestamp arithmetic** — a data-shape/
  consistency check, not a claim that anything happened fast. Excluded from the counts above for that reason,
  named here so a future reader doesn't rediscover and re-litigate the same classification call.

### Total: Shape A (21 sites / 14 files) + Shape B (15 sites / 9 files) + Shape C (1 harness-level mechanism,
applying to `emit-compare-gate.mjs` plus any other unoverridden git-heavy file) = **37 discrete promptness
claims across ~24 files**. This is a real, sizable population — structurally consistent with the card's
"population of marginal assertions" framing being at least a coherent hypothesis, independent of whether the
specific five failures are drawn from its thin tail (see §4).

## 2. The harness per-test timeout (DoD-2)

`packages/daemon/scripts/test-daemon.mjs:882`: `const TEST_TIMEOUT_MS = 120_000;` — **per test FILE** (each
hermetic test is spawned as its own child process by `runOne`; the timer wraps that one child, not the
overall suite run). Applied at `scripts/test-daemon.mjs:1011`: `const timeoutMs = TEST_TIMEOUT_OVERRIDES[name]
?? TEST_TIMEOUT_MS;` — a per-file override map takes precedence when the file's bare name is a key.

The override map (`TEST_TIMEOUT_OVERRIDES`, lines 909-914) currently names exactly **four** files, each with
a documented standalone-measurement justification in the surrounding comment:
- `merge-repo-mutex`: 300,000ms (15 trials × 2 concurrent real merges + a full integrity sweep)
- `merge-stranded-backstop`: 300,000ms (2× real `createWorktree` + `confirmWorkerMerge`)
- `gate-timeout-circuit-breaker`: 300,000ms (measured ~50-52s standalone, 3 runs; ~6x headroom)
- `merge-gate-reuse`: 360,000ms (measured 52-58s ×6 standalone + one 130s outlier across 7 runs — this one
  is called out in its own comment as the file that actually caused a production timeout rejection, card
  `2bb7a114`, before the override existed)

**`emit-compare-gate` is not in this list.** The card's own evidence (9 sequential scenarios, each doing a
real git repo setup + real squash, spanning `t≈9.7s → t≈112.5s` in the one observed run) describes exactly
the same *shape* of workload as the four overridden files — real, repeated git subprocess work with no
internal timing assertion of its own — but sits on the **blanket 120,000ms ceiling** with **no override and
no documented standalone measurement**. At 112.5s observed against a 120s ceiling, that run used ~94% of its
budget *before* any concurrent-gate contention is added on top — the tightest margin of anything measured in
this document, including the four files the project already identified as needing a bigger ceiling.

**Reading:** the override list is a hand-curated allowlist, built reactively — each entry's comment traces
back to a real production timeout rejection or a targeted standalone measurement, not a systematic sweep of
every git-heavy test. `emit-compare-gate` is direct, first-party evidence that the list is **incomplete**,
not merely that one file needs adding: nothing about how the four existing entries were found would have
caught `emit-compare-gate` either, since it was only surfaced by this card's own gate failure. Whether any
*other* uncovered git-heavy file is sitting at a similarly thin margin is unknown — this document did not
attempt to standalone-time every hermetic test (that would be full-suite-shaped work, out of scope here) —
but the mechanism (a blanket ceiling calibrated per-incident rather than per-workload) is now confirmed to
have already missed one real specimen, which is evidence the "calibrated for a suite that no longer exists /
never swept systematically" reading is live, not merely hypothetical.

## 3. Re-deriving the `exit-close-gap` tension (DoD-3)

Ran `packages/daemon/test/exit-close-gap.mjs` directly and standalone (`node test/exit-close-gap.mjs` from
`packages/daemon/`, no build step needed — the file imports `scripts/test-daemon.mjs` as plain JS, not
`dist/`): **all 13 checks passed, 0 failures**, including the two the card names as red
(`the exit->close gap is large`, `exitAt … precedes timeoutFiredAt`).

A standalone pass doesn't show the *margin*, since the test only prints PASS/FAIL labels, not the underlying
numbers. To see the actual `exitToCloseGapMs`/`exitAt`/`timeoutFiredAt` values, I wrote a throwaway probe
script (scratch dir, not committed — imports the same exported `spawnWithTimeout` and the same two fixture
files the real test uses, prints the raw numbers instead of a boolean) and ran it 5× for the mechanism-A
scenario and 3× for the contrast case:

```
[mechanism A run 1] exitAt=...956 timeoutFiredAt=...130 closeAt=...902 exitToCloseGapMs=946 timedOut=true status=timeout
[mechanism A run 2] ... exitToCloseGapMs=944 ...
[mechanism A run 3] ... exitToCloseGapMs=954 ...
[mechanism A run 4] ... exitToCloseGapMs=946 ...
[mechanism A run 5] ... exitToCloseGapMs=962 ...
[contrast B run 1] exitAt=...610 timeoutFiredAt=...599 closeAt=...610 exitToCloseGapMs=0 timedOut=true status=timeout
[contrast B run 2] ... exitToCloseGapMs=0 ...
[contrast B run 3] ... exitToCloseGapMs=0 ...
```

On a quiet, standalone, single-invocation run: mechanism A's gap sits at 944-962ms against the check's 300ms
floor (~3.2x margin — not marginal at all in isolation) and the contrast case sits at exactly 0ms against its
300ms ceiling (equally not marginal). **Neither of the two `exitToCloseGapMs` assertions themselves is close
to its bound on a quiet host.**

The more interesting, tighter number is upstream of the gap check: `timeoutFiredAt - exitAt` is consistently
~174-180ms across the 5 mechanism-A runs, against a configured `timeoutMs:250` for that scenario — meaning the
parent fixture is actually exiting only ~70-76ms after it's spawned, leaving ~70-76ms of its own 250ms budget
used and ~174-180ms of headroom. That headroom is real but far thinner than the 3.2x margin on the gap check
itself, and it is host-scheduling-sensitive in a way the gap check isn't: if the parent process's own spawn-
to-exit time were delayed (by host contention delaying process creation/scheduling, not by anything the test
is deliberately modeling), `exitAt` could land at or after `timeoutFiredAt` — flipping the ordering assertion
at `exit-close-gap.mjs:59-61` from mechanism-A into mechanism-B's shape, which would cascade: the gap-is-large
check (62) and the `timeoutDetail` wording check (63) both depend on the scenario having actually landed in
mechanism A. That is a coherent, evidenced explanation for why this file's checks fail **as a cluster** (the
card's own "×4" observation) rather than one at a time — but it is a **plausible mechanism inferred from a
standalone quiet-host measurement, not a confirmed cause**: this document did not reproduce the failure under
real concurrent-gate contention (that would need `run_gate`, out of scope here), so this is offered as a
sharper, falsifiable hypothesis for that follow-up, not as a settled finding.

### The `exit->close gap: 0ms` line — resolved, not just distrusted

The card was right to distrust this line, and the actual reason is sharper than "the gate tail interleaves
concurrent files." Reading `scripts/test-daemon.mjs:1458-1471` (the `FAILURES:` printer): the
`exit->close gap: <N>ms` line is only ever printed `if (f.status === "timeout")` — i.e. it reports the
**outer harness's own view of the whole test FILE's process** timing out and being killed, not any value
computed *inside* `exit-close-gap.mjs`'s own scenarios. `exit-close-gap.mjs` itself runs in a few seconds and
has no override in `TEST_TIMEOUT_OVERRIDES`, so it would need to blow the full 120s blanket ceiling to ever
produce this line about itself — implausible for a file this fast. Row 3's *other* named failure,
`emit-compare-gate`, **was** killed by exactly this timeout mechanism (§2) — so the far more likely
attribution is that the `exit->close gap: 0ms` line in that gate tail belongs to `emit-compare-gate`, not to
`exit-close-gap` at all. These two files failing in the same run is what let the tail's interleaving
obscure this; the deeper problem is that the diagnostic line's own field name (`exitToCloseGapMs`) is reused
for two *semantically unrelated* measurements — the outer harness's process-level exit→close gap for the
whole test file, and `exit-close-gap.mjs`'s own nested per-fixture exit→close gap — that happen to share a
name and a print format one level apart. **Conclusion: do not build on the `0ms` line as evidence about
`exit-close-gap.mjs`'s own assertions at all; it almost certainly describes a different file's outer-harness
timeout entirely.**

## 4. Reading against the hypothesis (data, not a verdict — DoD-5/6 are out of this document's scope)

The card asks not to let the hypothesis harden by restatement, and to say plainly if the data doesn't
support it. Here's what this document's data actually shows, without extrapolating past it:

- **The population is real and sizable** (~37-40 discrete promptness claims across ~24 files), which is a
  necessary precondition for the "population of marginal assertions" story — a story that needs only one or
  two flaky files could not explain the disjoint-failure-set pattern the card already noted.
- **At least one of the five named specimens (`emit-compare-gate`) has essentially zero margin even
  standalone** (112.5s / 120s ≈ 94% utilization, no concurrency involved) — direct, first-party support for
  "some of these assertions are already marginal on a quiet host," which is the harder and more interesting
  half of the hypothesis (it doesn't need contention to explain, only a suite/workload that's grown).
- **Two of the five specimens (`exit-close-gap`, `mcp-ready-gate`) have generous margins on their own
  headline numeric checks when measured standalone** (3.2x and — for `mcp-ready-gate`'s sibling check at
  line 112-113 — an even wider band), which does NOT support "thin margin" as the mechanism for those two
  *as measured here*. `exit-close-gap` does have a thinner, upstream, unmeasured-under-contention number
  (§3's 70-76ms-of-250ms parent-exit timing) that's a more plausible candidate — but that is a different,
  nested assertion from the one the card names as failing, and it's untested under real contention.
- **Row 4 (`pty-conpty-dll-kill`) doesn't have a numeric margin to measure at all** — it's a Shape-B
  liveness-window boolean, not an elapsed-vs-ceiling comparison (see §1). The margin-distribution
  methodology the card proposes for DoD-1's measurement half (observed-time ÷ asserted-ceiling) has no
  defined value for this specimen's actual failing check. Whoever runs that measurement should know in
  advance that at least one of the five specimens won't fit the metric as stated, rather than discovering
  it mid-analysis.

**Net:** the population exists and one specimen is a clean hit; the other measured specimens don't show thin
margins on their headline numbers, though `exit-close-gap` has a plausible-but-unconfirmed thin margin one
level upstream, and one specimen (row 4) isn't shaped like a margin question at all. This is not a clean
confirmation and not a clean kill — it's exactly the "some support, some complication, one metric gap" result
the card asked to be reported honestly rather than rounded to a verdict.

## What this document did NOT do (by kickoff scope)
- Did not run the DoD-1 margin-measurement half (observed-time ÷ asserted-ceiling for every site above) —
  that needs either a full quiet-host suite run or per-file standalone timing at a scale beyond what a single
  worker turn should spend without the lead's go-ahead, and the kickoff explicitly reserved it.
- Did not run `run_gate` or the full suite, anywhere, for any reason.
- Did not touch any test file, timeout constant, or test-daemon.mjs code. No production files were modified.
- Did not render a verdict on DoD-5 (one mechanism vs. five) — §1's shape breakdown (A/B/C) and the row-2 note
  are offered as raw material for that call, not as an answer to it.

---

# Second session — card's current 7-item DoD, items 2 and 3 only

The card was reopened with a renumbered 7-item DoD (see the card body); items 2 and 3 below refer to
**that** list, not the DoD-1..6 labels used in sections 1-4 above (a different, earlier numbering). Items
1, 4, 5, 6, 7 were explicitly out of this session's scope (they need `run_gate`, reserved by the lead).

## 5. Item 2 — the `deploy-staleness` git ETIMEDOUT, chased separately and structurally

**The timeout: `GIT_TIMEOUT_MS = 1000` (one second), `packages/daemon/src/deploy-staleness.ts:175`.**
Consumed by `runGit()`, same file, lines 178-185:

```ts
function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: nonInteractiveEnv(),
  });
}
```

`execFileSync` with a `timeout` runs the child via Node's `spawnSync` internally and, on timeout, kills
the child and throws an error carrying `code: 'ETIMEDOUT'` — this is the literal origin of the
"spawnSync git ETIMEDOUT" text observed in rows 6-7 of the series. It is **not** the test file's own
fixture-setup `execSync` calls (`packages/daemon/test/deploy-staleness.mjs`'s `git()`/`gitInc()`/`gitSh()`/
`gitWeb()`/`gitNoWeb()`/`gitProc()` helpers) — none of those pass a `timeout` option, so none of them can
themselves throw `ETIMEDOUT` (confirmed by reading every such call site in that file). The failure is in
the **production code under test**, not the test's own fixture setup.

**Is 1000ms defensible under the load that actually produced the failure?** The constant already carries
a considered decision, documented in the same module (`deploy-staleness.ts:99-111`, card `c6e7ebe7`): it
measured this exact call at 147-275ms idle and 220-465ms under **3x CPU oversubscription** (a ~4x
margin) and explicitly rejected widening it for lack of evidence any real call had approached the budget.

That measurement does not cover the load that produced rows 6-7. "3x CPU oversubscription" is
compute-bound scheduling pressure on one process; the merge-gate contention this card is chasing is many
**concurrent git child-process spawns** from other parallel test files (2-3 gate lanes, each running
whichever test file the harness schedules there) plus real disk I/O — process-creation contention, not
CPU-scheduling contention. `emit-compare-gate.mjs`/`emit-compare-gate-scope.mjs` alone spawn 12+ real git
repos/worktrees per run (§6, below) — an ordinary neighbor in the same gate run. Windows process creation
(`CreateProcess`) is markedly more expensive than POSIX `fork`, and `deploy-staleness.mjs` itself calls
`computeDeployStaleness` (hence `runGit`) **17 separate times in one file** — each a fresh 1000ms-budgeted
spawn; any single one tripping under contention fails the whole file.

**Judgment: the `c6e7ebe7` margin was measured against a different load shape than the one that produced
this failure, so "no observed call has approached budget" is not evidence the 1000ms is safe under a real
gate run — but that is not sufficient grounds to widen it myself.** Per this card's own standing rule
(⛔ DO NOT WIDEN TIMEOUT CONSTANTS — already bought a slower flake that way once), this is reported as a
**decision for the lead**, not acted on. Options, weighed but not applied:
- Widen `GIT_TIMEOUT_MS` — directly contraindicated by the card's own instruction, and still unmeasured
  under the actual failure's load shape (nobody has captured this call's latency under genuine
  multi-process git-spawn contention, only CPU oversubscription).
- Retry once specifically on `ETIMEDOUT` (distinct from every other `unavailable()` cause) — bounded and
  narrow, but the module's own doc (`c6e7ebe7`, point (b)) already considered and rejected distinguishing
  a timeout from every other `unavailable()` cause for the one consumer that treats it uniformly
  (`composeManagerStartupPrompt`), on grounds a retry-only change would need to re-litigate.
- Leave as-is and treat this specimen as genuinely environmental under contention — consistent with this
  document's own "ALL SIX REDS WERE ENVIRONMENTAL" finding (above).

**Item 6 (one mechanism or several) is not this session's call, but this specimen is direct structural
evidence for "several."** The `check()`-based promptness assertions (Shape A/B, §1) are in-process margin
comparisons the process's own event loop can still recover from. The git ETIMEDOUT is a hard, OS-level
subprocess-kill enforced by Node's `execFileSync` timeout — it throws (an uncaught-exception path, not a
failed boolean assertion) before any `check()` in that call ever runs, and row 6 shows a *second*, genuinely
different git failure (`git merge --squash failed`) in the same run. That is a categorically different
failure surface from a `check()` racing a fixed ceiling, not a variant of the same thing.

## 6. Item 3 — `emit-compare-gate.mjs` no longer needs 94% of its per-file budget

**Fix applied: split the file in two, not widened via `TEST_TIMEOUT_OVERRIDES`.** The single file's cost
was real, repeated git subprocess work — thirteen scenarios (`(A)`-`(L)`, plus a cheap unit-level `(M)`),
each doing a real `git init`/commit/worktree-add, several with a real squash merge through
`confirmWorkerMerge` — accumulated onto one file across five different cards (`2154b6ad`, `dd4349ff`, a
manager code-review finding, `815b4b30`, `44968963`, `7183540f`). `TEST_TIMEOUT_MS` in
`scripts/test-daemon.mjs` is a **per-FILE** ceiling, so the fix that touches no timeout constant is to
stop asking one file to pay for all thirteen scenarios.

**What changed:**
- `packages/daemon/test/_emit-compare-fixtures.mjs` (new, leading `_` — excluded from harness discovery)
  — every helper/constant both files share (`mk`, `seed`, `makeRepoWithBaseSrcFile`, `GUARD_BASENAMES`,
  `FULL_GATE`, `REAL_TEST_DAEMON_SCRIPT`, etc.), so the split can't drift into two copies that quietly
  diverge.
- `packages/daemon/test/emit-compare-gate.mjs` (existing file, now scenarios `(A)`-`(G)` + `(M)`: the base
  eligibility classification, the `dd4349ff` red-proof, and the two scope-boundary + one soundness case).
- `packages/daemon/test/emit-compare-gate-scope.mjs` (new file: scenarios `(H)`-`(L)` — the
  shell-metacharacter defence-in-depth case, the two `fixtures/`-scope cases, and the cap-queue-admission
  race).
- One stale doc-comment cross-reference fixed in the same commit: `packages/daemon/src/git/worktrees.ts`
  named `test/emit-compare-gate.mjs` case `(J)` — `(J)` now lives in `emit-compare-gate-scope.mjs`, so the
  comment was updated to point at the right file (it would otherwise have quietly gone stale the moment
  this split landed).

**Coverage check — same population, not a smaller one.** The pre-split file (`git show HEAD:packages/
daemon/test/emit-compare-gate.mjs` at the commit that reopened this card) has **48** `check(...)` call
sites. `emit-compare-gate.mjs` (post-split) has **30**; `emit-compare-gate-scope.mjs` has **18**. 30 + 18 =
48 — every assertion site accounted for, none dropped, none duplicated. Both files ran clean standalone:
`emit-compare-gate.mjs` — 45 PASS / 0 FAIL; `emit-compare-gate-scope.mjs` — 18 PASS / 0 FAIL (the higher
runtime PASS count in file 1 is `GUARD_BASENAMES`-loop expansion inside scenarios `(A)`/`(D)`, both of
which stayed in that file).

**Margin, before/after (same host, same standalone-no-concurrency measurement style the card's own
findings above used):**

| | before (single file) | after |
|---|---|---|
| `emit-compare-gate.mjs` | ~112.5s / 120s ≈ **94%** | **34s / 120s ≈ 28%** |
| `emit-compare-gate-scope.mjs` | (same file) | **28s / 120s ≈ 23%** |

Both post-split files ran well clear of `TEST_TIMEOUT_MS` standalone — no `TEST_TIMEOUT_OVERRIDES` entry
needed for either, and none was added. This does not by itself prove either file stays clear **under real
gate contention** (2-3 concurrent lanes, other files also spawning git processes) — only that the
94%-of-budget condition the card named is gone; a margin this wide (>70% headroom on each half) is no
longer a plausible single point of failure the way the pre-split 94% was.

**Verification run, both files:**
- `node packages/daemon/test/emit-compare-gate.mjs` — direct, standalone: 45 PASS, 0 FAIL, exit 0, 34s.
- `node packages/daemon/test/emit-compare-gate-scope.mjs` — direct, standalone: 18 PASS, 0 FAIL, exit 0,
  28s.
- `pnpm --filter @loom/daemon guards` — all 5 guards (`STATIC_GUARD_REPO_PATHS`, read live from
  `packages/daemon/src/git/worktrees.ts` at run time, per this project's own doctrine on that list) passed,
  required because this session touched `packages/daemon/test/**`.
- `pnpm --filter @loom/daemon build` — clean (`tsc` + skill sync), run before both test invocations above.

## What this second session did NOT do
- Did not widen `GIT_TIMEOUT_MS` or any other timeout constant — see §5's explicit decision hand-off.
- Did not run `run_gate` or the full suite, anywhere, for any reason (items 1, 4, 5, 6, 7 are out of this
  session's scope and were not attempted).
- Did not measure either split file's margin **under real gate contention** — only standalone, matching
  how the card's own pre-split 94% figure was itself measured (an apples-to-apples before/after).
- Did not touch `deploy-staleness.mjs`, `deploy-staleness.ts`, or any other test/production file besides
  the emit-compare-gate split and the one stale-comment fix named above.
