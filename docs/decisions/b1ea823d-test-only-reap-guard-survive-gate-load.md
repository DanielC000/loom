# b1ea823d — the test-only reap guard survives gate load instead of crashing the test process

Card `b1ea823d` (from the `24608d33` classification): under gate load, `assertReapTargetIsOwnLiveDescendantUnderTest`'s own `powershell.exe Get-CimInstance Win32_Process` enumeration (pty/host.ts) was tighter-bounded than production's equivalent call, routinely ETIMEDOUT, and — because `refuseReapTarget` throws whenever the calling test process has a test-spawn registry — crashed the whole test process from inside a bare `pty.onExit` callback with nothing above it to catch the throw. A second, narrower race ("not a live descendant") hit the same call site when a just-exited root's own pid number was already reused by an unrelated process before the guard's enumeration ran.

Three independent fixes, all scoped to `assertReapTargetIsOwnLiveDescendantUnderTest` and its two real callers (`reapOrphanedDescendants`'s guard call, `PtyHost.reapExitedDescendants`'s onExit chokepoint):

## 1. The enumeration timeout floor

`TEST_GUARD_ENUMERATION_TIMEOUT_MS` was a hardcoded `5_000`, tighter than production's own `REAP_ENUMERATION_TIMEOUT_MS` (`10_000`) for the identical `powershell.exe`/`ps` call — backwards, since a test run under gate concurrency (`LOOM_GATE_TEST_CONCURRENCY=3`) contends with sibling test files for the same powershell/WMI resources production never has to share.

## Do not

- Do not make the test-only enumeration bound tighter than `REAP_ENUMERATION_TIMEOUT_MS` again — define `REAP_ENUMERATION_TIMEOUT_MS` first in source order and derive the test bound via `resolveTestGuardEnumerationTimeoutMs(rawEnvValue, REAP_ENUMERATION_TIMEOUT_MS)`.
- Do not let `LOOM_TEST_GUARD_ENUMERATION_TIMEOUT_MS` lower the bound below the production floor — it is a ceiling-raising override only, never a replacement value.

## Minor 2 (CR 79a80cd5) — the env seam must reject Infinity/fractional/non-positive values

`resolveTestGuardEnumerationTimeoutMs(rawEnvValue, floorMs)` parses the raw env string with `Number(...)`, then requires `Number.isFinite` AND `Number.isInteger` AND `> 0` before accepting it. The original shape (`Number(v) || 0`) let `"Infinity"` and a fractional string straight through to `execFileSync`'s own `timeout` option, which THROWS `ERR_OUT_OF_RANGE` on every single enumeration call — the opposite of this card's goal (a bad env value would break every test, not just skip the override). An invalid value falls back to `floorMs`; a valid value below `floorMs` is clamped up, never accepted as a lower bound. Negative-controlled: reverting to the old `Number(v) || 0` shape reproduces exactly two red unit checks (Infinity, fractional) in `pty-root-reap-test-tripwire.mjs`'s own `(unit, timeout-clamp)` scenarios — the other edge cases (NaN, zero, negative) happen to still pass under the old shape by incidental JS truthiness, which is why only those two are the real hole.

## 2. Crash containment at the one onExit chokepoint

`PtyHost.reapExitedDescendants` (the single method both the claude and codex `pty.onExit` handlers call) now wraps its `this.sweepOrphanedDescendants(...)` call in a try/catch. The catch discriminates structurally, via a `code` property stamped on the thrown Error by `refuseReapTarget` (never by parsing `message`): `REAP_TEST_GUARD_ENUMERATION_FAILURE_CODE` is set ONLY on the could-not-enumerate refusal path. That one refusal is swallowed and logged (`[pty-reap] ... onExit sweep's enumeration-failure refusal caught at the exit chokepoint, not crashing`) because it proves nothing either way and nothing was killed either way — crashing the whole process to report "I couldn't check" serves no purpose. Every other refusal (the ancestry/lineage refusal above all) still rethrows unconditionally and crashes the process exactly as before this card — that is a genuine "would reap a pid we don't own" finding and must stay loud.

## Do not

- Do not widen the catch in `reapExitedDescendants` to swallow every throw — only the one `code` this file mints. A bare catch-and-log here would silently defeat the tripwire's whole reason to exist for every other refusal shape.
- Do not discriminate by matching `err.message` substrings — match `err.code === REAP_TEST_GUARD_ENUMERATION_FAILURE_CODE` only. Message text is for humans reading the log line, not for a catch site's control flow.
- Do not add this try/catch anywhere else (e.g. around a direct call to the free `reapOrphanedDescendants` function) — the two unit tests that assert a synchronous throw from a direct call (pty-root-reap-test-tripwire.mjs scenario A) call the free function directly, never through `reapExitedDescendants`, and must keep seeing the unmodified throw.
- Do not assume this closes every historical "not a live descendant" crash through this chokepoint — see the dedicated note at the end of section 3 below (the mcp-config-secret-lifecycle incident is a DIFFERENT shape this catch was never meant to cover).

## 3. The just-exited pid-reuse race ("not a live descendant")

⛔ **CORRECTED by Code Review `79a80cd5` (round 2) — the original fix here was itself a kill-widening bug.** The original reasoning argued: "the guard returns `true`, execution reaches `computeOrphanSweepPlan`, which independently re-derives the identical tolerance comparison and aborts." That is false, because **the guard's own enumeration and `computeOrphanSweepPlan`'s enumeration are two SEPARATE, independently-timed OS reads** — `reapOrphanedDescendants`'s own enumeration is reached only after `rootReapEnumerationSemaphore.acquire(ROOT_REAP_ENUMERATION_QUEUE_TIMEOUT_MS)` (decision `6d484a46`, a 30s queue-wait bound), so the two snapshots can be taken up to ~30s apart under load. Concretely:

1. Our real root R (pid P, creation C0) exits.
2. An unrelated process F reuses pid P (creation C1 ≠ C0) and spawns a real child K (ppid P, creation C2 > C0).
3. The guard's enumeration sees P live with creation C1, mismatched against our known C0 → (ORIGINAL BUG) returns `true`, proceeds.
4. F exits before the SECOND (downstream) enumeration ever runs.
5. That second read finds NO live row at P at all (F already gone), so `computeOrphanSweepPlan`'s `liveRootRow` check never fires — there is nothing live to compare, so the live-root abort never triggers either. The walk proceeds to `byParent[P] = [K]`; K's own creation C2 is LATER than C0 (our real root's time — the only `rootCreationTime` `computeOrphanSweepPlan` was ever given), so the stale-ppid filter does **not** exclude it.
6. K — a real, unrelated process's child — is added to `toKill` and SIGKILLed.

The pre-card code (an unconditional throw) never reached this far: it refused and killed nothing. The original (now reverted) fix introduced the kill-widening bug by turning that refusal into a `true`/proceed.

### The fix (corrected)

The same proven-mismatch detection stands, but its action is inverted: **return `false` (a silent skip), never `true`, and never throw.** `reapOrphanedDescendants`'s own call site already reads the guard's boolean return and bails (`if (!assertReapTargetIsOwnLiveDescendantUnderTest(...)) return;`) — this is the SAME contract decision `dbbb52db` already established for every other refusal, so returning `false` here costs nothing new: no enumeration ever starts, no `deps.enumerate`/real OS spawn is ever reached, no kill is ever attempted. Logged once (`[pty-reap-test-guard] SKIPPED ...`), clearly distinguished from a REFUSED/error log line since this is not a bug finding — it is a correctly-recognized, already-understood race, the exact thing this card exists to stop treating as fatal.

Traced across every caller that reads this boolean:
- **`reapOrphanedDescendants`** (the only caller that can ever reach this branch — the only one that passes `expectedCreationTime`): `return;` immediately. No enumeration, no kill. This covers `verifyRootDeadOrForceKill`'s own post-kill sweep too (`this.sweepOrphanedDescendants(rootPid, check.creationTime)`) since that call routes through the SAME `reapOrphanedDescendants` function.
- **`killProcessById`** / **`killSingleProcessById`**: neither ever passes a 3rd argument, so `expectedCreationTime` is always `null` for them and this branch can never fire. Their existing `if (!assert...) return;` contract is unchanged and was never the risk.

### Why this cannot widen what gets killed (now genuinely true)

The new path is a pure early-return with **zero** side effects — it is reached strictly BEFORE the sanity checks, the semaphore acquire, and the enumeration that the (unmodified) kill logic depends on. There is no second read for a bug to hide behind: nothing downstream ever runs for this call. When either creation time is unknown, or the two agree, this branch never fires and the ancestry walk runs exactly as before this card. Negative-controlled: reverting this one `return false` back to `return true` reproduces a genuine kill of a real spawned grandchild process in `pty-root-reap-test-tripwire.mjs`'s own scenario (H).

## Do not

- Do not ever make this branch return `true` — that is the exact regression `79a80cd5` found. A proven mismatch is reason to do NOTHING for this `rootPid`, never reason to proceed.
- Do not apply this to `killProcessById`/`killSingleProcessById` (the guard's other two callers) — neither ever supplies `expectedCreationTime`, so the branch is structurally unreachable for them; don't add a 3rd argument to either call site to "complete the coverage" without a real need, since there is no comparable expected-creation-time source for a worktree-rooted kill target.
- Do not duplicate `computeOrphanSweepPlan`'s own tolerance comparison anywhere else, or diverge the two constants — both must keep reading `ROOT_CREATION_MATCH_TOLERANCE_MS`.
- Do not let this branch fire when `expectedCreationTime` is `null` or the live row's own `creationTime` is `null` — an unprovable case must keep falling through to the unchanged ancestry walk (fail-closed, same posture as `computeOrphanSweepPlan`'s own "abort unless positively proven" default, decision `87691385`).
- Do not assume this closes every historical "not a live descendant" crash. The mcp-config-secret-lifecycle incident (gate log `cc595970`, pid 50664, caller label `reapOrphanedDescendants` via the onExit chokepoint) shows NO `[pty-reap-capture]` line for that pid anywhere in the log — its `liveRef.creationTime` was `null` at the time (this card's own test registry has no companion entry for a real node-pty-spawned root either, only for `cp.spawn`). With `expectedCreationTime == null`, this branch never evaluates; that specific crash shape — a lineage refusal with an unknown occupant creation time — is STILL an unswallowed throw today, by design (section 2's catch is deliberately scoped to the enumeration-failure code only). Confirmed by direct log inspection (CR `79a80cd5` minor 5), not assumed; left as a known, out-of-scope residual per explicit review instruction, not fixed here.
