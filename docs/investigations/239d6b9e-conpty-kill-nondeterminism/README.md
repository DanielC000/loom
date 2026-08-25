# Card 239d6b9e — pty-conpty-dll-kill non-determinism

Investigation of `packages/daemon/test/pty-conpty-dll-kill.mjs`: three prior runs (one merge gate, two bare-node, recorded in the card body) produced three different outcomes with no assertion going red twice. This directory holds a fresh 30-run characterization sweep, the mechanism analysis it fed into, and the fix that came out of it.

## TL;DR

- **0/15 bare, 0/15 harness** — the flake did not reproduce in this sweep, in either environment. See "What the null does and does not show" below before reading that as "fixed."
- **The four prior failures stand.** They are real, observed, and unrefuted by this sweep. Exoneration of the card is not exoneration of the failure.
- **Mechanism identified for the baseline-vs-DLL asymmetry** (DoD-2), by reading node-pty's actual source, not by inference from the outcome table alone. This is now the headline result, not an untested lead.
- **A fix shipped** (`packages/daemon/test/pty-conpty-dll-kill.mjs`): removed a redundant, unpolled, single-shot re-probe that ran immediately after an already-successful bounded poll of the exact same fact. No constant widened, no sleep added, no retry added — the poll itself is untouched.
- **The fix is NOT validated by local execution and cannot be**, at this reproduction rate. It rests on a mechanism argument plus a retrodictive proof against the card's own specimen table (below), not on a red→green demonstration.

## Methodology

Two environments, alternated (bare, harness, bare, harness, ...) rather than run block-by-block, so host-load drift over the sweep's ~30-minute wall-clock wouldn't confound environment with time:
- **bare**: `node test/pty-conpty-dll-kill.mjs`, run from `packages/daemon` — the invocation the file's own header prescribes.
- **harness**: `node scripts/test-daemon.mjs --only=pty-conpty-dll-kill`, run from `packages/daemon` — the exact selection form the merge gate itself uses. This environment was untested by the card's own three prior runs (all bare-node) and was the explicit gap this sweep was asked to close.

15 rounds × 2 environments = 30 runs, driven by a small Node script (not committed — a throwaway harness, not test infrastructure) that spawned each environment's process to completion, captured full stdout+stderr, and appended one row per run to `runs.ndjson` before moving to the next.

**The sweep ran against the ORIGINAL, unmodified file — not the fix below.** Timestamps (local, UTC+02:00): the last sweep log (`run-30-harness-pass.txt`, from its original write location) has an original mtime of `2026-08-25 22:07:54 +0200` (`20:07:54Z`); the fix (`packages/daemon/test/pty-conpty-dll-kill.mjs`) was written at `2026-08-25 22:10:31 +0200` (`20:10:31Z`) — about 2.5 minutes after the sweep's last run finished. So the 0/30 result below characterizes the file as the card found it, uncontaminated by the fix, and — for the same reason — running the fixed file again could not produce a red-to-green demonstration: the unfixed file already ran clean 30/30 in this environment.

## Results — counts and denominators, per environment (never pooled)

| environment | runs | PASS | FAIL/CRASH | denominator |
|---|---|---|---|---|
| bare | 15 | 15 | 0 | 15 |
| harness | 15 | 15 | 0 | 15 |

Every run exited 0. Every bare run logged all 24 individual `PASS` assertion lines with zero `FAIL` lines (`grep -c '^FAIL'` returns 0 on every one of the 15 files). Every harness run logged the wrapper's single aggregate `PASS  pty-conpty-dll-kill` line — the harness suppresses a passing sub-test's own stdout, which is why harness rows show `passedCount: 1` in `runs.ndjson` where bare rows show `passedCount: 24`; that is a logging-verbosity difference between the two environments, not a difference in what ran.

Raw per-run durations (ms), in run order:
- bare: 47921, 35826, 39908, 40567, 56428, 63763, 38745, 33550, 33575, 33449, 34342, 50531, 52586, 48129, 57477
- harness: 48270 *(see anomaly note below)*, 40530, 42133, 63301, 61977, 41017, 41156, 31994, 37018, 31991, 33553, 50634, 53733, 50685, 51991

## What the null does and does not show

**0/30 is "not reproduced in 30 clean trials" — never "does not reproduce" or "appears fixed."** Rule-of-three reasoning on the pooled 30: a 95%-confidence upper bound on the true failure rate, given zero observed failures in 30 trials, is approximately 3/30 ≈ 10%. At a true rate of 10%, P(0 failures in 30) ≈ 4% — an unlikely-but-not-impossible miss. At a true rate of 2%, P(0 in 30) ≈ 55% — an unremarkable, expected outcome. **This sweep excludes a failure rate anywhere near 10%+; it is entirely consistent with a true rate in the 1–3% range**, which is also consistent with the card's own history (this file has run on an unknown but presumably large number of merge-gate invocations since `2e3a2741` landed it on 2026-08-05, with 4 known failures recorded).

**The four prior failures in the card body stand as real, observed events.** This sweep does not refute them, explain them away, or reduce their evidentiary weight — it only establishes that whatever produces them is not common enough to hit in an additional, independent 30-trial sample run under quieter conditions than the original merge gate (solo, no concurrent gate lanes, no other host load). That gap — quiet solo sweep vs. contended merge gate — is itself a candidate explanatory factor (more on this below), not a reason to discount the specimens.

## The anomaly in `runs.ndjson` — and why the 30-file population is authoritative anyway

`runs.ndjson` has **31** rows, not 30: `run: 2, env: harness` appears twice (durations 48270ms and 43704ms — two genuinely different executions, not a duplicate write of the same one). This is *not* evidence of a 31st genuine round of the sweep — the 30 committed log files (`run-01-bare-pass.txt` … `run-30-harness-pass.txt`) are uniquely named, non-overlapping in wall-clock (each file's original mtime is 30–90s after the previous one's, strictly monotonic across the whole sweep, no gaps), and there is no `run-31` file.

The most likely explanation: an earlier attempt to launch this same sweep (via a manually-backgrounded `nohup ... & disown`, before switching to the harness's own tracked background-process mechanism for the real sweep) appears to have kept running for a short time after being believed dead, and independently produced one `run: 2 / harness` execution of its own — using its own independent, restarted-at-1 run counter, colliding with the real sweep's own `run: 2`. Its log write landed at the same filename (`run-02-harness-pass.txt`) as the real sweep's, so only one of the two executions' stdout is recoverable from disk; the `runs.ndjson` metadata row for the other survives only as that extra, unmatched entry. Both were genuine `PASS` executions of the (still unmodified) test file, so this does not change any count above — the harness denominator used throughout this document is 15 (the clean, file-verified population), with the stray 31st row noted here rather than silently folded in or silently dropped.

`runs.ndjson` is committed unmodified (warts included) rather than hand-edited into a "clean" 30-row file, so the anomaly stays checkable by a future reader instead of being smoothed away.

## Mechanism — the DoD-2 asymmetry, now explained rather than merely observed

All four prior failures are the same family: the `check(...,  "... pid confirmed gone (no orphan)")` assertion going red, always on a **baseline** (non-DLL) arm, never a DLL arm. Read directly from `node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/lib/windowsPtyAgent.js` (this repo's installed copy — **everything in this section marked "READ" was read from that file directly, not inferred**):

- **READ** (`windowsPtyAgent.js:133-160`, `WindowsPtyAgent.prototype.kill`): the `_useConpty && !_useConptyDll` branch (the baseline arm, today's production default) calls `this._getConsoleProcessList().then(list => list.forEach(pid => process.kill(pid)))` — the *actual* explicit kill of the real target OS processes — as a **fire-and-forget `.then()`**, not awaited. It also calls `this._ptyNative.kill(this._pty, false)` (the native conpty teardown) synchronously, on the same tick.
- **READ** (`windowsPtyAgent.js:181-195`, `_getConsoleProcessList`): forks `conpty_console_list_agent` and races a `'message'` event against a **5000ms `setTimeout` fallback** that resolves to `[this._innerPid]` if the fork never replies.
- **READ** (`node_modules/.../lib/conpty_console_list_agent.js`, full file, 15 lines): the forked agent's entire body is top-level code that calls `getConsoleProcessList(shellPid)` and only *then* does `process.send(...)`. Per this test file's own header comment (confirmed independently, 3rd time, against the same installed node-pty) that call **reliably throws `AttachConsole failed`** as an uncaught exception in the forked child, before it can ever reach `process.send`.
- **⇒ INFERRED from the above three READ facts, not itself read anywhere as a single statement:** on the baseline arm, the explicit `process.kill(pid)` loop — the actual kill of the real target process, as distinct from the native conpty teardown call — structurally can **only** ever fire via the 5000ms fallback timer, because the forked agent that would resolve it faster always crashes first. This makes baseline teardown timing dependent on that fallback timer (and on however long the native conpty teardown call takes on its own, independently), where the DLL arm has no equivalent dependency at all.
- **READ**, DLL arm, same file (`windowsPtyAgent.js:153-159`): `_useConptyDll` takes a structurally different path — `this._inSocket.destroy()`, a synchronous native kill call, and a `conout` dispose deferred to an `outSocket.on('data', ...)` handler. It never calls `_getConsoleProcessList()`, never forks anything, and never touches the 5-second fallback path at all.

This matches `packages/daemon/src/pty/host.ts:8731`'s own inline comment, written independently of this investigation: *"node-pty's conpty kill path walks `_getConsoleProcessList()` to kill the tree (not a Job Object — node-pty@1.1.0 has none)"* — the codebase's own prior understanding lines up with what the source shows here.

**Net: the baseline arm has a real, structural, asymmetric dependency the DLL arm does not — a delayed, crash-then-fallback-timer path to its actual process-kill call. That is a sound, source-grounded explanation for why every DLL-arm equivalent of the flaky check has passed every time (10/10 combined in this sweep, on top of every prior specimen), while the baseline arm is where all four known flakes live.** This asymmetry is not merely "not yet retired" — it now has a named, source-verified cause, and it should be read as this investigation's headline finding, not as an untested lead still waiting on more runs.

## The actual test defect, and why it — not the node-pty asymmetry above — is what should be fixed

The mechanism above explains why baseline teardown is *more variable* than DLL-arm teardown. It does not, by itself, explain why a bounded 15-second poll (`waitUntil(... psAlive ..., { timeoutMs: 15000 })`) would ever fail — 5 seconds is comfortably inside a 15-second budget. The actual defect was architectural, in the test file itself, not in node-pty:

```js
// BEFORE (packages/daemon/test/pty-conpty-dll-kill.mjs, pre-fix):
await waitUntil(async () => !(await psAlive(parentPid)), { label: ..., timeoutMs: 15000, intervalMs: 200 });
// ... other checks (fork count, caught exception) ...
check(`${label} parent pid confirmed gone (no orphan)`, !(await psAlive(parentPid)));  // <-- a SECOND, fresh, unpolled probe
```

The `waitUntil` call already polls `psAlive(parentPid)` to truth, bounded, exactly per this repo's own `_wait.mjs` doctrine. The `check(...)` line that follows re-probes the **exact same fact**, once, with no polling, immediately after the poll already succeeded.

### Retrodictive proof this is the actual bug, from the card's own specimen table

`_wait.mjs`'s `waitUntil` **throws** on timeout (`waitUntil: timed out after ${timeoutMs}ms waiting for ${label} ...`) — it does not return a falsy value for the caller to check. That means: if the poll had genuinely failed (the process never died), the run would crash with a `waitUntil: timed out ...` error, and **the `check("... confirmed gone (no orphan)", ...)` line would never execute at all.**

Every one of the four failures recorded in the card body is that exact `check()` going red, **by name** — e.g. `[baseline-hard] parent pid confirmed gone (no orphan)`. None of the four recorded failures is a `waitUntil` timeout/crash.

**⇒ In every observed failure, the poll had already succeeded (the pid was genuinely, verifiably gone) and the second, fresh probe — run milliseconds later — said it was alive again.** A process that has genuinely terminated cannot become alive again under the same PID; the only mechanism that produces "gone, then immediately alive again, same PID" is the OS handing that just-freed PID number to a new, unrelated, genuinely-alive process before the second probe's own fresh `psAlive` call (which spawns its own new `powershell.exe` — this file spawns one for every single `psAlive`/`psChildPids` call, many per trial) lands. That is Windows PID reuse, landing in the redundant probe's own self-manufactured race window — not an orphaned target process. This is not a plausibility argument; it is the only mechanism consistent with what the card's own four specimens actually recorded.

### The fix

```js
// AFTER:
const parentGone = await waitUntil(async () => !(await psAlive(parentPid)), { label: ..., timeoutMs: 15000, intervalMs: 200 });
// ...
check(`${label} parent pid confirmed gone (no orphan)`, parentGone);  // assert on the poll's OWN result
```

(Symmetric change for `childGone`/the child-pid checks.) The bounded poll itself is untouched — same 15000ms timeout, same 200ms interval, same `_wait.mjs` helper, same shared-doctrine shape as the rest of this file (cards `22796d42`/`a19e4c02`). Nothing was widened, no sleep was added, no retry was added, and the file was not added to `NOT_HERMETIC`. The change is a pure removal of a redundant, race-prone duplicate of an already-bounded check, and a switch to asserting on that check's own already-verified result instead of re-probing.

This cannot reduce real coverage: a process that is genuinely still alive when the poll examines it keeps the poll looping (and eventually throws, failing the run loudly) regardless of whether the second probe exists — the second probe could only ever agree with a poll that already succeeded, or introduce a false disagreement via PID reuse. It was never able to catch a real orphan the poll had missed.

### Verified `_wait.mjs` contract this relies on

`waitUntil`'s success path (`packages/daemon/test/_wait.mjs:77-84`) is `if (last) return last;` inside the polling loop — so on success it returns the predicate's own truthy return value, not `undefined` and not a bare `true`. `parentGone`/`childGone` therefore receive the real result (`true`, since the predicate is `!(await psAlive(...))`), and `check(..., parentGone)` behaves identically to `check(..., true)` on every successful poll. Confirmed by re-reading `_wait.mjs` directly, not assumed.

## Why the fix is not — and cannot be — validated by local execution here

Both the pre-fix and post-fix file pass 100% locally in this investigation:
- Pre-fix: 30/30 (this sweep, both environments, documented above).
- Post-fix: 3/3 additional bare sanity runs + 1/1 harness sanity run, all green (not included in the 30-run corpus above — run after the fix, as a smoke check, not as new characterization).

At an already-near-zero reproduction rate, there is no naturally-occurring red available locally to turn green by applying this fix — the code passes with or without it, in this environment, at this sample size. **The fix is justified by the mechanism argument and the retrodictive proof above, not by a red→green demonstration, and this document does not claim one.** The only real test of whether this closes the flake is the merge gate's own future runs under real contention (concurrent gate lanes, the near-100%-CPU host load this repo's own gate telemetry has independently recorded during real merge-gate runs) — conditions this solo sweep deliberately did not attempt to reproduce, and which plausibly explain why 30 solo runs produced zero PID-reuse collisions where the real gate has produced four.

## What remains unattributed

- **The exact trigger for why a PID-reuse collision window opens on some runs and not others** is not measured here, only argued for structurally (baseline-arm teardown timing variability + this file's own heavy churn of short-lived `powershell.exe` helper processes, one per `psAlive`/`psChildPids` call). Host contention (concurrent gate lanes, near-100% CPU — both observed in this repo's own gate telemetry during real merge-gate runs, not measured directly against this file by this investigation) is a plausible amplifier, not something this sweep directly measured.
- **Whether the fix actually eliminates the flake** is unattributed until the merge gate itself runs this file some further number of times post-fix, under real contention, and racks up zero (or a materially lower) baseline-arm "confirmed gone" failures.

**A candidate discriminator worth naming explicitly, and leaving explicitly unresolved:** all 4 of the card's recorded failures occurred under contended merge-gate conditions (concurrent gate lanes, near-100% CPU); all 30 of this sweep's clean runs were solo (no concurrent gate lanes, no other host load this investigation deliberately introduced). That is a condition present in the failing population and absent from the passing one — exactly the shape of a real discriminator, not merely a caveat. It is **not proven** here: this sweep was not designed or powered to test contention as a variable (no concurrent-lane condition was run), so this is a lead for a future investigation, not a conclusion of this one. It should also **not** be read as importing card `42d9d64c`'s exclusion of cross-gate contention as a cause — that was a different test with a different failure mode, and its exclusion does not transfer to this card.

## Files in this directory

- `README.md` — this file.
- `runs.ndjson` — one row per sweep execution (31 rows; see the anomaly note above for why it's 31, not 30).
- `run-01-bare-pass.txt` … `run-30-harness-pass.txt` — full captured stdout+stderr of each of the 30 file-verified sweep runs, named `run-<NN>-<env>-<outcome>.txt`. All 30 are `pass`; none required truncation (largest is ~6KB, well under the ~200KB cap). (`.txt`, not `.log` — this repo's `.gitignore` has a bare `*.log` rule; `.txt` is the established convention for a committed investigation corpus like this one.)
