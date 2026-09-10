# 39fcaad3 — `daemon_restart` safety gates are role-independent, not weaker for the Platform Lead

**Two unrelated decisions share this card id (`resolveRecord()` resolves an id to one file — see
`CLAUDE.md`'s "One record file per id" section) — see Decision B below for the second.**

## Decision A — safety gates are role-independent

## Narrative

The `daemon_restart` tool is registered on BOTH the manager's orchestration MCP and the Lead's platform MCP, for SELF-HOSTING (orchestrating Loom WITH Loom). After merging daemon-`src` worker branches, the new code isn't running until the daemon is rebuilt + restarted; this tool does that and brings the caller (+ its live workers, if any) back on the other side via the restart-intent file (consumed in `index.ts` boot).

Safety: (1) refuses unless under the supervisor (`LOOM_SUPERVISED`) — otherwise nothing relaunches the daemon; (2) REBUILDS FIRST while still alive, so a broken build aborts the restart and leaves the caller running to fix it, instead of exiting into a daemon that won't boot. On a green build it records intent and exits with `RESTART_EXIT_CODE`; the supervisor relaunches. Both gates are ROLE-INDEPENDENT — a platform-Lead caller gets the identical supervisor-check/rebuild-first/full-fleet-capture behavior a manager gets, not a weaker path (the real safety here lives in these structural gates, not in which role holds the tool).

`deps` is a TEST-ONLY injection seam (mirrors `BuildDeps` on `buildDaemon` itself and `resumeOne` on `resumeFleetOnBoot`) — every real caller (`mcp/orchestration.ts`, `mcp/platform.ts`) omits it, so production behavior is byte-identical to before it existed. Without it, exercising the `writeRestartIntent` call from a test would mean either a REAL `pnpm install`/turbo build (slow, heavy, wrong for a hermetic unit test) or a REAL `process.exit(75)` (which would kill the test's own process) — `deps.buildDeps` lets a test fake an instant green build, and `deps.exit` lets it capture the intended exit instead of actually calling it.

## Do not

- Do not give a platform-Lead caller a weaker (or stronger) safety path than a manager caller — both gates (supervisor-check, rebuild-first) are structurally role-independent.
- Do not exit or record restart intent before the rebuild succeeds — a broken build must abort the restart and leave the daemon running to fix it.

## Source (Decision A)

Inline comment in `packages/daemon/src/sessions/service.ts` (`requestDaemonRestart`'s top-of-function doc, opening paragraphs): originally lines 3438-3461, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## Decision B — (unrelated decision, same card id, `service.ts`): the deploy requester is derived from the DB, not `entries` alone

### Narrative (this section only)

A separate, unrelated decision under the same card id `39fcaad3`, in a different function
(`resumeFleetOnBoot`, not `requestDaemonRestart`). It fixes how the restart *requester*'s role is
derived when dispatching its own resume nudge.

The requester is no longer ALWAYS a manager — the platform Lead can now request its own restart too
(`RestartIntent.managerSessionId` is kept named for on-disk compat; read it as "the requester" — see
its doc in `orchestration/restart.ts`). The nudge is dispatched via the role-aware
`enqueueDurableNudge` (already used for the non-requester manager/platform branch elsewhere in the
same function): for role `"manager"` it defers on `waitForMcpSeen` (see `usesOrchestrationMcp`), so
the manager path stays byte-identical; a platform-Lead requester never mounts `loom-orchestration`, so
`waitForMcpSeen` could never see it — `enqueueDurableNudge` correctly delivers immediately instead of
waiting out the MCP-ready timeout for a signal that would never fire.

The requester's role is derived from the DB (the authoritative, live source), NOT from `entries`
alone: `entries` comes from `liveFleetResumeSet()`'s capture-time snapshot, which filters on
`fs.existsSync(s.cwd)` — a platform Lead whose project home is transiently unreachable (network/
removable path, an in-flight rename) would be dropped from `entries` at capture time yet still resumed
here (`resumeOne(reqId)` runs unconditionally, un-gated on `entries` membership), and would be
mis-derived as `"manager"` by the old `entries`-only lookup — reinstating exactly the pointless
MCP-ready wait this fix removes. `entries` stays as a fast-path fallback (the pre-existing lookup,
still correct whenever the requester's own row IS present), with `"manager"` as the final fallback for
anything falling through both — the OLD-format `resumeSetFromIntent` path always is one (its
synthesized requester entry is always `role:"manager"`, so this default matches it exactly).

### Do not (this section only)

- Do not derive the restart requester's role from `entries` alone — a transiently-unreachable
  project home can drop a live platform Lead from that capture-time snapshot; read the DB first.
- Do not assume the requester is always a manager — the platform Lead can request its own restart,
  and its nudge must route through the same role-aware `enqueueDurableNudge` dispatch.

### Source (this section only)

Inline comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`'s requester
role derivation: line 4714, as of this tranche's HEAD (tranche 13).
