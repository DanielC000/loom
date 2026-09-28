# acf3d337 — bounded-git-kill-on-timeout: an earlier attempt's commit moved HEAD under RED; `git log` raced the ref replace

`packages/daemon/test/bounded-git-kill-on-timeout.mjs` failed two ways under load. Both are fixture-state races, not defects in `withTimeoutKillingChild`.

## Do not

- Do not run the calibration commit or the [setup] leg 2a/2b commits in the repo the RED/GREEN controls use. An aborted attempt whose git is not actually dead lands its commit into the repo it targeted; if that is the shared repo it moves HEAD under RED's pending commit and RED's ref update fails.
- Do not go back to `git log` as the "did it land" observer. Widening `RED_POLL_WINDOW_MS` or adding retries would only mask both failures (`2ed7e384` measured that window comfortable; it is not the cause).

## 1. `RED positive control: "red-commit" never landed within 15000ms` (ref present and valid)

Evidence, from both gate snapshots (gate `1247bf64` and batch gate `6243724b`, archived under `~/.loom/gate-output-archive/acf3d337-gate-snapshots-20260928/`):

- `refs/heads/master` mtime = `hook-started-calibration-commit.marker` mtime + 5.46s / + 5.48s. The hook takes 50 ticks x 100ms = 5s, so a git that started its hook at the calibration marker finished and updated `master` there.
- `COMMIT_EDITMSG` / `objects/` mtime = `hook-started-red-commit.marker` + 5.41s / + 5.48s: RED's git reached its commit step, then `red-commit` rejected at 5558/5657ms and never appeared. RED read HEAD before its hook; the calibration commit moved `master` during it, so RED's ref update lost.
- Deterministic reproduction: a scratch copy of the pre-fix file with one UNKILLED `git commit` fired into the shared repo right after calibration produced the identical failure (same `reason` string, ref mtime = calibration marker + 5.467s, COMMIT_EDITMSG = RED marker + 5.474s, `rejected @5612ms`). The same injection against the fixed file (survivor in `setupRepo`) passes.

Not established: why the aborted calibration git survives in a gate. 96 abort-then-wait probes under 16 CPU hogs, and 186 loaded whole-file runs, never showed a survivor (K=62-67ms in every calibration, so simple-git saw the child exit). The fix does not depend on the answer: no attempt whose kill is not the thing under test shares a repo with a control.

## 2. `git log` -> exit 128 "does not have any commits yet" (card `58d2462c`'s signature)

git-for-windows replaces `refs/heads/master` non-atomically; a `git log` that runs during a landing commit can see an unborn branch. A standalone committer plus 8 `git log` pollers saw it 4/2024, 2/1990, 6/2023 and 5/1979 polls (3 repeats + 1). Reflog-file readers in the same runs: 0 errors, 0 backwards counts in ~17.5k reads. One natural hit (6 concurrent full-file runs, 1/18): snapshot at 03:15:34.252Z, `master` mtime 34.227Z, COMMIT_EDITMSG 34.207Z, i.e. the throw was within 45ms of RED landing. `commitSubjectsOnRepo` now reads the append-only HEAD reflog (`core.logAllRefUpdates` pinned locally; the baseline check proves it works).

## Controls

- Kill made ineffective for the green attempt (no abort signal, wide green window): `[green] THE FIX: the commit NEVER lands` and `no OTHER unexpected commit` both FAIL, so the assertion can still go red through the new observer.
