# cc9a41cc — BusyWorkerWatcher's motivating incident and its rejected pty-output alternative

The full mechanism (SIGNAL, ONCE PER EPISODE, NEVER A HARD KILL + skip conditions) stays inline, verbatim, at `BusyWorkerWatcher`'s own class docstring in `packages/daemon/src/orchestration/busy-worker-watcher.ts` — it is Class C contract/description, not decision narrative, so it belongs at the call site, not here. This record carries only the WHY: the incident that motivated the watcher, and the alternative signal design that was tried and reverted.

## The incident

Motivated by the cc9a41cc incident: a worker hung `busy` ~77min with an empty transcript / no commits, undetected until a manual `worker_status`.

## WHY NOT ALSO GATE ON PTY OUTPUT (tried and reverted)

PtyHost's own `healIfStuck` already clears `busy=false` once pty output has been stale ≥`busyStaleMs` (5min) — so a session can never stay `busy=true` with stale output for a full `stuckWorkerMinutes` window (30–60min by construction); an "AND no recent pty output" gate is provably unreachable dead code, not a real second signal. Nor is there a cheap progress proxy that helps: `ctxTurns`/commit counts don't advance mid-turn either, and a live-repainting hung TUI is indistinguishable from a legitimate long build/test gate on pty bytes alone.

## Do not

- Do not add an "AND no recent pty output" gate — `healIfStuck` already clears `busy=false` within `busyStaleMs` (5min) of stale output, so that condition is provably unreachable dead code within any `stuckWorkerMinutes` window (30–60min by construction).

## Source

Class docstring above `BusyWorkerWatcher` in `packages/daemon/src/orchestration/busy-worker-watcher.ts`, originally lines 25-26 (the incident sentence) and 35-38 up to "...gate on pty bytes alone." (the rejected-alternative paragraph, minus its own concluding Class C sentence, which stays inline), as of this tranche's HEAD. No wording changed.
