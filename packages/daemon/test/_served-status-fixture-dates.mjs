// Shared by served-status.mjs and served-status-dist-drift.mjs.
//
// @decision 2d06e5f1 — never derive a fixture "commit AFTER the build" date from a build-clock probe
// alone: computeDeployStaleness() re-reads the build clock (newest mtime under packages/{daemon,shared}/dist)
// on EVERY call, so any dist write between the probe and the call — another test lane in a full gate —
// moves it past a probe-derived date and the commit silently stops counting (stale:false, commitsBehind:0).
// The date must also postdate "now", which bounds any such write.
export const AFTER_BUILD_MARGIN_MS = 60_000;

/** ISO date strictly after both the probed build clock and the current wall clock. */
export function commitDateAfterBuild(probedDistMtimeMs, nowMs = Date.now()) {
  return new Date(Math.max(probedDistMtimeMs, nowMs) + AFTER_BUILD_MARGIN_MS).toISOString();
}

/** The pre-2d06e5f1 derivation, kept ONLY so the regression test can prove it goes RED. Do not use elsewhere. */
export function commitDateAfterBuildProbeOnly(probedDistMtimeMs) {
  return new Date(probedDistMtimeMs + AFTER_BUILD_MARGIN_MS).toISOString();
}
