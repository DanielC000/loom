# 33aa0291 — `liveness: "pending" | "observed"` disambiguates a MEASURED admission→first-liveness gap

## Narrative

Card 33aa0291: disambiguates the ONE case `idleMs` can't speak to on its own — a `"running"` entry with `idleMs === null` genuinely means "admitted, but this run's own pre-flight work hasn't reached its first liveness event yet", NOT "wedged" and NOT "queued" (a queued entry is already distinguished by living in `.queued` rather than `.running`, and needs no separate tag). Present ONLY while this entry is `.running` — omitted for a `.queued` entry, where the concept doesn't apply. `"pending"` while `idleMs` is still null; `"observed"` from the instant `idleMs` first becomes non-null onward (this run's `lastOutputAt`, once stamped, never reverts to null — see `GateSnapshotEntry.lastOutputAt`'s doc — so this never flips back to `"pending"`).

THIS WINDOW IS REAL AND NOT RARE — MEASURED, not estimated: for `run_gate`/`runWorkerGate` specifically (the ONLY gate type with a gap here — see `idleMs`'s own doc above; a merge/deploy gate reaches its first liveness event essentially at admission), the admission→first-liveness gap was directly instrumented (`process.hrtime.bigint()`; admission timestamped at first `activeCount===1`, first-liveness at first `idleMs != null`, busy-polled via `setImmediate` to avoid the poll interval itself padding the number) against a real `runWorkerGate` op on 2026-08-04, on a 16-logical-core win32/x64 host (AMD Ryzen 7 3700X):
  - quiet host, n=15: min=142.9ms, p50=157.7ms, max=209.2ms.
  - loaded host, n=12 (15 concurrent CPU-saturating busy-loop child processes running throughout): min=171.5ms, p50=199.4ms, max=1717.4ms.

27/27 trials across both conditions were ≥140ms — never a microsecond race. The window's contents are 2 real git subprocess spawns (`rev-parse HEAD`, `status --porcelain`; see `computeWorktreeGateStamp`), so it scales with host git/process-spawn cost, not with anything Loom controls — expect it to differ by host and over time. The `max` figures above are the LARGEST OBSERVED in a small sample, not a guaranteed ceiling — the true tail is unmeasured and may exceed them. Do not read this note as still current without re-measuring; it describes one point-in-time run, not a permanent bound.

## Do not

- Do not read a `"running"` entry with `idleMs === null` as wedged or queued — treat it as `liveness:"pending"`, a real, MEASURED (≥140ms observed, n=27) admission→first-liveness gap for `run_gate`/`runWorkerGate` specifically, not a fabricated or instantaneous state.
- Do not treat the measured timing figures as a still-current ceiling without re-measuring — they describe one point-in-time run on one host, not a permanent bound.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`GateQueueEntry.liveness`): lines 126-150, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
