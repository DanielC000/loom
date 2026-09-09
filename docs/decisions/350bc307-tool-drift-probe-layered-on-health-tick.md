# 350bc307 — tool-drift probe is a live `tools/list` round-trip, layered onto a successful health tick

## Narrative

`checkToolDrift` is the ONE live-introspection caller of `codescapeUnclassifiedTools` (`pty/host.ts`) — a real `tools/list` round-trip against the RUNNING mounted server, not just the two in-memory arrays it partitions. Layered onto a SUCCESSFUL health probe, mirroring `checkBuildDrift`'s own placement and discipline: async, bounded (`toolsProbeTimeoutMs`), best-effort, NEVER throws, and NEVER blocks a spawn/boot/gate (DoD-3 — fail soft) — a probe failure just means "couldn't check this tick," identical in effect to a probe that never ran.

It needs a resolvable Codescape PROJECT id to build the `/mcp/<id>` URL `probeAdvertisedTools` hits — `tools/list` is a property of the served MCP APPLICATION (which tools it registers), not of per-project graph DATA, so ANY currently-registered project id observes the same tool registration a genuinely drifted server would expose on every scope; this instance's own `projectIds` cache (populated by `registerProjectWithRetry` at boot) is reused rather than re-resolving anything. A no-args case (nothing registered yet) is a clean skip: nothing to probe against yet, not a failure.

On a successful round-trip, it ALWAYS persists the result via `writeToolDriftState` (even an EMPTY unclassified set) — so the state file's `checkedAt` stays fresh and a since-cleared drift doesn't linger stale in what `readCodescapeToolDriftNote` reads back. The in-memory `lastToolDriftUnclassified` latch exists purely so a TRANSITION logs once (a new/changed finding, or a recovery back to clean) rather than spamming this line every ~30s tick forever — the persisted file (read by the Platform Lead's kickoff note) is the real addressed signal; the console line is a supplementary breadcrumb, not the mechanism itself.

## Do not

- Do not skip persisting the tool-drift state file just because the unclassified set is empty — always persist on a successful round-trip, so `checkedAt` stays fresh.
- Do not log the drift-finding line on every probe tick — only on a TRANSITION (new/changed finding, or recovery to clean).

## Source

JSDoc method comment in `packages/daemon/src/codescape/supervisor.ts`, above `checkToolDrift`: originally lines 1500-1523, as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
