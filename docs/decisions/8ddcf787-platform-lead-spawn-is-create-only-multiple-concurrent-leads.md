# 8ddcf787 — a manual Platform Lead spawn is create-only; multiple concurrent Leads are allowed

## Narrative

`startPlatformLead` mirrors `startManager`, but role 'platform' (so it gets the loom-platform MCP + allowlist at spawn, NOT orchestration). A platform-lead creates/configures projects + agents; it runs in its host project's repo.

Create-only (multiple concurrent Leads allowed): a manual Spawn ALWAYS mints a FRESH platform session — exactly like `startAuditor`. The owner may run several live Leads at once; they coordinate via the shared Platform board. The old "never two LIVE Leads" singleton short-circuit — reuse an already-live platform session instead of spawning a second — has been removed.

On-demand RESUME of an EXITED Lead stays an explicit human action (the Lead/Auditor History "Resume" button → `resumeSession`); this path never resumes — it always INSERT+spawns. Restart-resume is independent: `index.ts` → `resumeFleetOnBoot` resumes captured live sessions by id on a `daemon_restart`.

## Do not

- Do not reintroduce a "never two LIVE Leads" singleton short-circuit on this path **on a dev install**
  (`isLoomDev()`) — a manual Spawn there must always mint a fresh platform session; the owner may run
  several concurrently. **Amended by card `be9cb999`:** a NON-dev install is the deliberate exception —
  `startPlatformLead` now refuses while a live platform-role session already exists there (mirrors
  `startSetup`'s own singleton), since a non-dev install has exactly one sanctioned Lead agent by
  construction (`docs/decisions/be9cb999-*.md`, Decision 5/6) and "several concurrent Leads" never
  applied to it in the first place.
- Do not have this path resume an exited Lead — that stays an explicit human action via the History "Resume" button; this path always INSERT+spawns.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`startPlatformLead`'s doc, minus the "this is NOT the trust boundary" guard sentence, which stays inline at the source): originally lines 2717-2735, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
