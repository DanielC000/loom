# 9e6f984d — a drift-detected restart waits for the installed build to sit stable for `driftStabilityMs`

## Narrative

A genuine build-id mismatch does not restart immediately. The installed build must first sit UNCHANGED for `driftStabilityMs` (default 15 minutes) before a restart fires, tracked as `(build, firstSeenAt)` on `driftCandidateBuild`/`driftCandidateFirstSeenAt`. A NEW mismatched build (different from whatever was already being watched) replaces the candidate and restarts the window — so a burst of N distinct rebuilds inside the window collapses into exactly ONE eventual restart, fired only once the LAST build in the burst has been stable for the full window.

Without this, a burst of N distinct rebuilds on the Codescape side (their own legitimate rebuild cadence) becomes N legitimately-distinct drift events, each restarting `serve` and dropping any MCP request that happened to be in flight — a control loop where a peer project's build cadence drives OUR process lifecycle. This stops the Codescape project's own rebuild cadence from becoming Loom's serve-restart cadence: their build action drives our process lifecycle across a boundary where neither side can see the other's activity, so a quiet period is the cheap, coupling-free way to tell "mid-churn" apart from "settled". Never urgent — a stale serve is harmless; a restart that drops an in-flight request is not, so when in doubt this waits longer, not less.

Deferral is LOGGED ONCE per new candidate (not once per tick while waiting) — a `console.warn` distinct from both the eventual restart line and total silence, so "serve didn't restart" is never indistinguishable from "no drift detected" (same discriminator discipline as the rest of this feature).

15 minutes is chosen as long enough that a realistic rebuild burst settles inside one window (collapsing to a single restart once the dust settles), short enough that a genuinely-stable new build still gets picked up promptly.

## Do not

- Do not restart on the first detected mismatch — wait for the installed build to sit unchanged for the full stability window, or a rebuild burst causes N restarts instead of one.
- Do not log the deferral line on every tick while waiting — log it once per new candidate build.

## Source

The stability-window portion of `checkBuildDrift`'s doc in `packages/daemon/src/codescape/supervisor.ts`: originally part of lines 1568-1643, as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
