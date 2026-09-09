# 2d72595c — `WorkerGateResult.durationMs` excludes queue wait, but not general fleet load or concurrent-gate overlap

## Narrative

`durationMs` (card 2d72595c — serve the timing need `run_gate` didn't, so a manager stops reaching for a hand-run suite to get one) is `Date.now() - gateStartedAt`: wall-clock from the moment this run was ADMITTED past the semaphore to the moment it settled. It EXCLUDES queue wait — a run that sat behind another gate isn't penalized for that wait. It does NOT exclude general host/fleet load, and at `maxConcurrentGates` >= 2 it does NOT exclude time spent running alongside another CONCURRENTLY-ADMITTED gate — this is a real duration under real conditions, not an isolated benchmark; see the `run_gate` tool description for the caller-facing wording of that caveat. Set on every `ran:true` outcome, same as `validatedHead`.

## Do not

- Do not read `durationMs` as an isolated benchmark — it excludes queue wait only; at `maxConcurrentGates >= 2` it can still include time spent running alongside another concurrently-admitted gate.
- Do not reach for a hand-run suite to get a gate timing number — this field exists to serve that need without one (card 2d72595c).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`WorkerGateResult.durationMs`): lines 664-695, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
