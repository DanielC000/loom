# b5c606aa — companion "lead mode", Option B (no guardrails)

## Narrative

Owner decision `b5c606aa`, 2026-07-20, Option B: companion "lead mode" gives a companion maximal control over the owner's projects with NO guardrails, once the owner turns it on for a session (`sessions.companion_lead_mode`).

**`resolveCompanionGrant` (packages/daemon/src/companion/capabilities.ts):** lead mode is checked FIRST, ahead of any grant-row read — when set on the session, this SHORT-CIRCUITS to `synthesizeLeadModeScope`'s synthesized full-scope answer instead of reading `companion_capability_grants` at all. It SUPERSEDES the rows, never deletes/mutates them, so toggling lead mode back off instantly reverts to whatever was granted before. Every lever downstream of this gate (registration, per-call `mayAct`/`configFor` re-checks, Primitive A/B/C, friction tiers, trust windows) runs completely unchanged — lead mode only changes what `resolveCompanionGrant` returns, never how a lever consumes it.

**`synthesizeLeadModeScope`:** synthesizes a FULL, all-project act-mode `ResolvedGrantScope` for a given capability. Iterates `db.listAllProjects()` LIVE on every call (never cached) — the INCLUSIVE list (the Framework-adjacent `listProjects()`'s reserved-excluding picker feed is deliberately NOT used here): a project created AFTER lead mode was enabled is included on the very next read, and a reserved/system project (e.g. the Platform home) is in scope too — "every project" means every project. Every project resolves to `mode:'act'`, so every lever's own `hasActGrant` gate + per-project `mayAct` check pass unconditionally, and `session-steer`'s per-project `roleFilter` (config-driven, absent here ⇒ `{}`) stays unset — NO role exclusion, reaching an infrastructure (platform/operator/setup) session exactly like an ordinary worker/manager one, per Option B's explicit "no exclusions" ruling.

Per-capability config is synthesized only where a lever actually reads one (every other capability gets `{}`, matching an ordinary grant's own absent-config default — including `session-steer`'s `roleFilter` and `board-reach`'s `authoredContent`, DELIBERATELY left conservative: Option B's decision covers the session-steer exclusion floor and decision/alert visibility only, never a relaxation of verbatim-relay):

- `decisions-relay` → `{decisionClasses: [...DECISION_CLASSES]}` (all 3 classes — a deploy/irreversible decision still ALWAYS steps up via Tier X; lead mode only widens which classes are ELIGIBLE, never the friction tier a resolve runs through).
- `attention-push` → `{alertClasses: ["*"]}` — a wildcard sentinel `attention-push.ts`'s own `resolveConfig` expands, rather than importing that array here (`attention-push.ts` already imports `resolveCompanionGrant` FROM this file — importing back would be a module cycle). The REST grant-config validator only ever accepts a literal class name (gateway/server.ts), so `"*"` can never be written by a human grant — it is reachable ONLY through this synthesis path. As of the owner's 2026-07-21 ruling (request `d024eda7`), that expansion is EVERY class EXCEPT `attention-push.ts`'s own `FLEET_OPS_ALERT_CLASSES` (merge-gate/worker-blocked/worker-crashed/manager-idle) — routine fleet-ops noise stays out of the lead-mode PUSH feed by default (still fully visible in-app/via other reads); this file only ever emits the `"*"` sentinel, so the exclusion lives entirely in `resolveConfig`, not here.
- `media-out` → `{roots: [project.vaultPath]}` when that project has one, else `{}` — the one lever with no safe host-wide wildcard (arbitrary host FS, no closed vocabulary), so lead mode's default is bounded to each project's OWN vault content rather than granting nothing or every path on the host.

Returns `null` (never an empty-but-truthy scope, mirroring `resolveCompanionGrant`'s own contract) when there are zero live projects, or when `db` doesn't implement `listAllProjects` at all (the same minimal test-double tolerance `resolveCompanionGrant` extends to `listCompanionCapabilityGrantsForSession`).

## Do not

- Do not treat lead mode as a mutation of the grant rows — it is a pure runtime supersede; toggling it off must instantly revert to whatever was actually granted.
- Do not widen `attention-push`'s lead-mode expansion beyond "every class except `FLEET_OPS_ALERT_CLASSES`" without a fresh owner ruling — the current exclusion is request `d024eda7`'s explicit scope, not a default this file invented.
- Do not relax `session-steer`'s `roleFilter` or `board-reach`'s `authoredContent` defaults under lead mode — Option B covers the session-steer exclusion floor and decision/alert visibility only, never verbatim-relay.

## Source

Inline comments in `packages/daemon/src/companion/capabilities.ts`: `resolveCompanionGrant`'s lead-mode paragraph (was lines 162-169) and `synthesizeLeadModeScope`'s whole top-of-function doc (was lines 216-252), as of this tranche's HEAD. Relocated by card `2e703a3d` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*`/bullet comment markers.
