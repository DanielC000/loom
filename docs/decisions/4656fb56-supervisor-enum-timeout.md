# 4656fb56 — widen the supervisor-liveness process enumeration timeout to 60_000, not 120_000

## Narrative

`SUPERVISOR_ENUM_TIMEOUT_MS` (`packages/daemon/src/orchestration/restart.ts`) bounds the real
`Get-CimInstance`/`ps` enumeration `isSupervisorProcessAlive()` runs to re-derive, from the live OS
process table, whether a genuine `daemon-supervisor.mjs` is still an ancestor of this daemon process. It
was `8_000`. Under real full-gate load, `supervisor-liveness.mjs` scenario (C) — the one scenario in
that file that calls the real, non-injected enumerator (every other scenario injects a synthetic `rows`)
— failed: gate log `cc595970` shows it hitting the bound exactly —

```
{"alive":false,"checkFailed":true,"reason":"could not verify supervisor liveness (process enumeration
timed out after 8000ms) — refusing to restart; retry"}
```

— with an unrelated SIGTERM timeout on a sibling test (`solo-merge-watermark-branch-pin`) in the same
gate run, corroborating genuine host contention that day, not a hang in this code. Of 5 sampled gate
logs, only this one failed; the other 4 passed cleanly.

## Measurements

Idle, on a real host, right now: a solo real `Get-CimInstance Win32_Process` enumeration took 1148ms
(476 rows); 3-concurrent (matching `LOOM_GATE_TEST_CONCURRENCY=3`) took 858/878/893ms (494-496 rows
each). Both well under the old 8s bound — this is not a slow mechanism, it's a mechanism that occasionally
contends for CPU/WMI under real gate load.

## Why 60_000, not the 120_000 used by sibling scan bounds

`HARNESS_CONFIG_LOAD_TIMEOUT_MS` and `TEST_IMPORTER_SCAN_TIMEOUT_MS`/`DIRECT_DIST_IMPORTER_SCAN_TIMEOUT_MS`
(also `git/worktrees.ts`) are the closest siblings in shape (fast-idle, fail-closed, correctness-preserving
consumer, raised because real gate load — not a hang — hit the old bound) and are both `120_000`. This
constant is deliberately sized lower: `isSupervisorProcessAlive()` is paid up to **twice** inside one
`daemon_restart` call (`sessions/service.ts`'s `requestDaemonRestart`, both call sites share one
`checkSupervisorAlive` alias) — once before `buildDaemon()`, and once again right before the actual
`process.exit()`, after the build and the merge-danger-window wait have already run (both can take
minutes). A larger bound at that second call site means every second of a genuine hang there is a second
the whole fleet waits on a restart that is otherwise ready to happen. The sibling 120_000 bounds guard
single merge-path scans, where that latency cost doesn't compound the same way.

60_000 is ~50x the measured idle time above and ~7.5x the observed load-failure point (8000ms) — plenty
of headroom for real contention without paying the 120s siblings' latency tax on a path that's charged
twice and ends right before an exit the fleet is waiting on.

## Do not

- Do not raise `SUPERVISOR_ENUM_TIMEOUT_MS` to match the 120_000 sibling scan bounds — this check is paid
  up to twice per `daemon_restart`, the second time immediately before exit, so a larger bound costs the
  whole fleet real wait on every genuine hang there, unlike a single merge-path scan.
- Do not treat this as a hang-detection fix — the `cc595970` specimen and the idle measurements above
  both point to host contention under real gate load, not a mechanism that is actually slow.
- Do not move `supervisor-liveness.mjs` into `ISOLATED_REAL_SPAWN_BASENAMES` (`test-daemon.mjs`) to work
  around this instead — that phase's own decision record (`0f0816e2`) explicitly disclaims it as a proven
  fix for this class of issue, and it is off by default (owner opt-in only), so it would not help in an
  ordinary gate run anyway.
- Do not move it into `NOT_HERMETIC` (`test-daemon.mjs`) either — that exclusion is reserved for real
  authenticated-`claude`-spawn cost/auth/flake concerns; scenario (C) spawns only plain node children, so
  excluding it there would delete real OS-enumeration coverage for no matching benefit.
