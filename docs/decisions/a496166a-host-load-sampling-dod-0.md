# a496166a — host-load sampling for the gate (DoD-0): the cumulative-CPU retraction, and adaptive lanes deferred

## Narrative

Filed to build an adaptive gate-lane count that scales to observed host/fleet load. DoD-0 (the host-load premise) went through a public retraction: the manager who filed the card first cited "~80% CPU with Spotify the largest single consumer, >4x the heaviest agent" — sourced from `Get-Process | Sort CPU -Desc`, which ranks by **cumulative CPU-seconds** (a process's lifetime total), not current load. A process running ten hours at 1% accumulates far more CPU-seconds than one running five minutes at 100%. Spotify ranked #1 at 35,567 CPU-seconds by that instrument; a sampled-delta measurement over the same host showed Spotify absent from the live top-12 entirely. The rule that survives: a cumulative-CPU ranking must never again be cited as host load in this project — use a sampled delta.

**DoD-0b, a contrast pair that reframed the card:** two real merge-gate runs, same suite, ~20 minutes apart, identical pool size 3. Aggregate CPU-time fell 26% (3206.8s → 2381.6s) on a suite that *grew* by one file, while lane efficiency stayed ~99% in both (98.8%/98.4%) — meaning added lanes already buy a near-linear share of an already-efficient pack, but a 26%-scale swing in the underlying per-file work itself is a comparable lever that lane tuning cannot touch at all. Deliberately **not attributed**: host load was measured during the first window only, not the second, so there was no contrast case and no cause was named — "the owner's game slowed the first run" was explicitly rejected as an inference the data didn't support (see project memory `corroborating-a-premise-is-not-corroborating-the-inference`).

**Why the lane count is 2** (the incident this must never repeat, card `301d8c01`): before the fixed cap, the runner fell back to `os.availableParallelism()`, which on this many-core self-hosting box let the command spike to `MAX_CONCURRENCY` lanes with nothing bounding it — that starved the live Codescape service. The measured incident was one gate at 8 lanes; `maxConcurrentGates` is 2, so the real worst case to guard is the **product** (gates × lanes), not either factor alone.

**The `sessionEnv` question is answered no:** confirmed at source (`orchestration/gate-runner.ts`) — a gate child receives the daemon's own `process.env` unconditionally, `GIT_TERMINAL_PROMPT=0`, and whatever a caller explicitly threads through `envOverride`. There is no path from per-project config into the gate child; "just set it per-project" requires new plumbing, not a config flag.

## Why the host-sample row samples periodically, not just before/after

The periodic `kind:"host-sample"` row this card adds (5s cadence, same `runUid` join key as every other row) is emitted *throughout* the run, not just once before and once after like the existing `hostBefore`/`hostAfter` fields on the run-start/run-summary rows. That is the piece that lets a fast run and a slow run be compared **distribution-to-distribution** instead of by one point-in-time snapshot each — exactly the instrument §DoD-0b needed and didn't have (host load was recorded for only one of the two contrasted runs). An unknown row kind is silently ignored by any existing reader that filters by `kind`, so this is additive.

## The `onSample` hook rides the existing RSS-sample timer, rather than a second interval

`runInstrumentedSuite`'s `onSample` parameter (part of DoD-0's "the gate already emits per-file
timing + a `cheapHostSnapshot()` before/after — extend that to a periodic sample rather than
building a new harness") is an optional, additive hook fired on the *same* timer tick as the RSS
sample. It lets a caller — e.g. this card's own periodic host-load sampling — ride the existing
periodic-sampling machinery for its own observability instead of standing up a second interval.
Defaults to a no-op, so every existing call site (and the RSS-gap test, which doesn't pass it) stays
byte-identical in behavior to before this parameter existed.

## Deferred, not cancelled

**Owner, live in chat, 2026-08-05:** *"yes you are right maybe we should hold off on the variable load dependent gate lanes and just raise the number of lanes for now."* This superseded an earlier inbox answer (Request `17b90717`, "build the adaptive version") — a later live instruction beats an earlier inbox answer. Card `2ff32b5c` (the simple 2→3 lane raise) is what the owner chose instead; this card resumes after it, and its 3-lane contrast pair (§DoD-0b above) is itself evidence for what the eventual adaptive function should target: continuous host-load sampling across a fast run AND a slow run, to turn "runs vary 26%" into an attributable cause, rather than another one-off point-in-time snapshot.

## Do not

- Do not cite a cumulative-CPU ranking (`Get-Process | Sort CPU`) as host load — use a sampled delta.
- Do not raise `MAX_CONCURRENCY` above 8, and never let lanes × concurrent gates exceed a bounded product — that product is what starved Codescape once already.
- Do not resurrect the adaptive-lanes build off Request `17b90717` alone; the live 2026-08-05 owner instruction supersedes it.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, module-header decision-history block (originally lines 92-97), as of this tranche's HEAD. Card `a496166a`, filed 2026-08-01, DoD-0 answered 2026-08-05. Related: `2ff32b5c` (the lane raise this defers behind), `a591a654` (the standalone-vs-in-gate gap, possibly the same phenomenon as the 26% swing), `301d8c01` (the starvation regression this must not repeat).
