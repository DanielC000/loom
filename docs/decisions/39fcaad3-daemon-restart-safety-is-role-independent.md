# 39fcaad3 — `daemon_restart` safety gates are role-independent, not weaker for the Platform Lead

## Narrative

The `daemon_restart` tool is registered on BOTH the manager's orchestration MCP and the Lead's platform MCP, for SELF-HOSTING (orchestrating Loom WITH Loom). After merging daemon-`src` worker branches, the new code isn't running until the daemon is rebuilt + restarted; this tool does that and brings the caller (+ its live workers, if any) back on the other side via the restart-intent file (consumed in `index.ts` boot).

Safety: (1) refuses unless under the supervisor (`LOOM_SUPERVISED`) — otherwise nothing relaunches the daemon; (2) REBUILDS FIRST while still alive, so a broken build aborts the restart and leaves the caller running to fix it, instead of exiting into a daemon that won't boot. On a green build it records intent and exits with `RESTART_EXIT_CODE`; the supervisor relaunches. Both gates are ROLE-INDEPENDENT — a platform-Lead caller gets the identical supervisor-check/rebuild-first/full-fleet-capture behavior a manager gets, not a weaker path (the real safety here lives in these structural gates, not in which role holds the tool).

`deps` is a TEST-ONLY injection seam (mirrors `BuildDeps` on `buildDaemon` itself and `resumeOne` on `resumeFleetOnBoot`) — every real caller (`mcp/orchestration.ts`, `mcp/platform.ts`) omits it, so production behavior is byte-identical to before it existed. Without it, exercising the `writeRestartIntent` call from a test would mean either a REAL `pnpm install`/turbo build (slow, heavy, wrong for a hermetic unit test) or a REAL `process.exit(75)` (which would kill the test's own process) — `deps.buildDeps` lets a test fake an instant green build, and `deps.exit` lets it capture the intended exit instead of actually calling it.

## Do not

- Do not give a platform-Lead caller a weaker (or stronger) safety path than a manager caller — both gates (supervisor-check, rebuild-first) are structurally role-independent.
- Do not exit or record restart intent before the rebuild succeeds — a broken build must abort the restart and leave the daemon running to fix it.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`requestDaemonRestart`'s top-of-function doc, opening paragraphs): originally lines 3438-3461, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
