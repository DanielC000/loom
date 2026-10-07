# acd3c688 — stop an explicit-role spawn from carrying profile grants onto another role

`resolveAgentSpawn` resolves a session's role as `explicitRole ?? profileRole`, while the human-set
grants (`AGENT_FORBIDDEN_PROFILE_KEYS`: connections, capabilities, vaultWrite, harness, browserTesting,
documentConversion, allowDelta) always come from the bound profile regardless of which role wins. Three
agent-reachable paths exploited the split: `session_spawn` → `spawnSessionAsPlatform` → `startManager`
(any agent, no profile-role/grant check); `worker_spawn` (blocked only manager/platform/auditor/run
profile roles, leaving assistant/setup/operator/workspace-auditor unchecked); and `schedule_create` on
both the manager and platform MCP surfaces, whose rows the Scheduler fires by calling
`startManager`/`startAuditor`/`startWorkspaceAuditor` directly with no check at all.

## Chosen design

**Chokepoint:** `resolveAgentSpawn` (`sessions/service.ts`), immediately after `resolveProfile` resolves
`resolved`. `resolved.role` is unclamped and identical to the bound profile's own `role` field
(`resolveProfile`, `shared/config.ts`, passes `profile.role` straight through) — the check needs no raw
`Profile` row, only `resolved` + the caller's `explicitRole`.

**Mechanism:** `explicitRoleGrantCarryoverError` (`profiles/validate.ts`) reuses card `05153988`'s
carried-grant predicate (factored out as `carriedForbiddenGrants`/`describeCarriedGrants`, shared with
`roleChangeCapabilityCarryoverError`) — same mechanism, spawn-context message. Refuses when
`explicitRole` is given, differs from the profile's own `role`, and the profile carries any
`AGENT_FORBIDDEN_PROFILE_KEYS` grant. Two exemptions on top of that, both below: a `harness`-only
mismatch into a role the codex role-force already neutralizes, and a null-role profile spawned as
`"worker"` (not a divergence at all — a LEAD ruling, round 2).

**`harness` carve-out, found by a REAL pre-existing test going RED:** `codex-role-force-start-matrix.mjs`
(card `7955458e`) deliberately constructs a `{role:"worker", harness:"codex"}` profile and spawns it via
`startManager`/`startPlatformLead`/`startAuditor`/`startWorkspaceAuditor`/`startSetup` — the EXACT
explicit-role-mismatch shape this card polices — and asserts the spawn SUCCEEDS, silently redirected to
claude by `resolveAgentSpawn`'s own role-based force (`roleForcesClaude`, keyed off
`TRANSCRIPT_ROOT_DENY_ROLES = {assistant, auditor, workspace-auditor, manager, platform, setup}`), never
refused. A blanket `explicitRoleGrantCarryoverError` check would refuse that same call instead, breaking
already-shipped, already-tested behavior. Fix: the check filters out `harness` specifically when
`explicitRole` is a `TRANSCRIPT_ROOT_DENY_ROLES` member — the role-force already neutralizes a mismatched
codex harness for exactly those five roles, so there is nothing for this card to additionally refuse
there. It stays INCLUDED for every other explicit role this card's chokepoint covers — `"worker"`
(`spawnWorker`) and `"operator"` (`startOperator`) are DELIBERATELY NOT `TRANSCRIPT_ROOT_DENY_ROLES`
members (per that set's own card `7955458e`/`961da6c6` scoping), so nothing else stops a mismatched codex
harness from actually reaching `createCodexPty` for those two — the carve-out must not swallow them too.

**Null-role → worker exemption (LEAD ruling, round 2):** a profile with `role: null` exists specifically
to BE a worker profile (e.g. a "Planning & Triage" rig that layers an `allow` delta onto a profile-less
agent) — spawning it as `"worker"` via `spawnWorker` is the intended, designed use of a role-less
profile, not a divergence to police. `explicitRoleGrantCarryoverError` therefore treats `profileRole ==
null && explicitRole === "worker"` as a non-divergence (returns `null` before the grant check ever
runs), identically to an exact role match. Every OTHER null-role target (`null`→`"manager"`,
`null`→`"auditor"`, etc.) stays fully checked — the exemption is scoped to exactly the one pairing the
ruling named, not to "any null-role profile."

**Bypass threading**, mirroring `3de74275`'s `humanAuthorized` pattern (deliberately renamed to
`spawnHumanAuthorized` here — the two mechanisms are unrelated, and sharing a flag name would make this
card's own allowlist guard collide with `human-authorized-call-site-allowlist-guard.mjs`'s three
pre-existing, unrelated sites):
- `resolveAgentSpawn` gains a 6th param `opts?: { spawnHumanAuthorized?: boolean; skipGrantCarryoverCheck?: boolean }`.
- `opts.spawnHumanAuthorized` is set ONLY by `gateway/server.ts`'s `POST /api/agents/:id/sessions` route
  (the one call site that invokes `startManager`/`startPlatformLead`/`startAuditor`/
  `startWorkspaceAuditor`/`startSetup`/`startOperator` directly for a human) — threaded through each of
  those six methods' own new `opts?: { spawnHumanAuthorized?: boolean }` parameter. The Scheduler ALSO
  threads it, computed (not literal) as `scheduleCreatedByIsHuman(schedule)` — see the `createdBy`
  section below.
- `opts.skipGrantCarryoverCheck` is set by nine call sites, in two groups:
  - Six CARRY-FORWARD callers that re-derive for an EXISTING session's already-pinned role rather than
    minting a fresh one, so there is no "divergence" to police: `resume()`, `forkSession()`,
    `harnessDrainStatus`'s dry-run read (no spawn effect at all), `composeCompanionReinjectPrompt`
    (compose-only, no spawn), `upgradeCompanionCapabilities` (re-pins an EXISTING assistant-role
    session — its only two callers are `companion/controller.ts`'s `upgrade()`, itself only reachable
    from the human-REST `POST /api/companion/:id/upgrade` route, and `startOne`'s auto-respawn-on-enable,
    itself gated to the human/REST companion-enable path per `dbba993f`'s own "Do not": "auto-trigger
    this for a per-capability-grant path — that stays a deliberate human/REST-only opt-in"), and
    `startRun`. **Correction (round 2):** `startRun` does NOT hardcode every forbidden field — it DOES
    thread the profile-resolved `harness` onto the spawned run session and its pty opts (card `56e6c046`),
    unlike `connections`/`capabilities`/`vaultWrite`/`browserTesting`/`documentConversion`, which really
    are hardcoded false/absent regardless of the profile. Whether `startRun` needs its OWN harness-role
    check is tracked on a separate card (the lead's own follow-up) — this card's skip for `startRun` is
    unchanged, but the record no longer claims a blanket "nothing can land" guarantee that was false for
    `harness`.
  - Three RECYCLE methods (`recycleManager`/`recyclePlatformLead`/`recycleWorker`) — see "Recycle" below
    for why a check there was tried in round 1, found to be actively harmful, and removed in round 2.

**Guard test:** `explicit-role-grant-carryover-allowlist-guard.mjs` scans BOTH bypass flags (round 2 —
round 1 only covered `spawnHumanAuthorized`), asserting the only `spawnHumanAuthorized: true` grants are
the six `gateway/server.ts` sites and the only `skipGrantCarryoverCheck: true` grants are the nine sites
named above, each with its own positive control, plus a presence check (not a literal-grant scan — it
can't be one) that the Scheduler's COMPUTED `spawnHumanAuthorized: scheduleCreatedByIsHuman(…)` site still
calls that helper. The guard's own header states plainly what it does NOT prove: a computed or
variable-carried grant anywhere else is invisible to it by construction — it proves the LITERAL-site
surface only, not "the whole bypass surface is accounted for."

## Recycle: round 1 built a check that refused real, on-role recycles — removed

**Round 1** read what each recycle method does with `AGENT_FORBIDDEN_PROFILE_KEYS` fields and found that
all three carry `connections`/`capabilities`/`vaultWrite`/`browserTesting`/`documentConversion` forward
from the OLD session row UNCONDITIONALLY, never from the freshly re-resolved profile, in their own
`fresh: Session` construction (`sessions/service.ts`'s `recycleManager`/`recyclePlatformLead`/
`recycleWorker`); `harness` is re-resolved fresh for manager/platform-lead only (`8d4b4433`, structurally
harmless given the role-force above) and stays row-pinned for worker. From that, round 1 built
`recycleGrantWideningError`: refuse only when the CURRENT profile would introduce a grant the OLD row did
not already carry.

**That check was wrong, and a Code Reviewer caught it (round 2, CR `7aeb24c9`):** it compared grant
VALUES with no role-divergence condition at all. Since every one of those fields is pinned from `old`
regardless of what the re-resolved profile says, an agent profile that a human edits to ADD a grant —
with role UNCHANGED, no divergence, nothing this card is meant to police — makes the NEXT recycle of
EVERY session on that profile throw, forever, because `resolved`'s "carried" state now differs from
`old`'s. The reviewer reproduced this concretely: an on-role manager profile + a human adding
`connections` later ⇒ `recycleManager` throws. That would have stranded every lineage on the owner's own
Orchestrator/Dev profile the moment a grant was ever enabled on it — the exact stranding round 1 was
trying to PREVENT, reintroduced by the fix itself, on a wider trigger (any grant edit, not just an
off-role one).

**Fix (round 2): removed `recycleGrantWideningError` and its wiring entirely** (and the `excludeKeys`
plumbing it needed, since nothing else used it). The spawn-time chokepoint's generic check is ALSO
skipped at recycle (`skipGrantCarryoverCheck: true`, unchanged from round 1) for the same underlying
reason the removed function existed to work around: role cannot diverge within a recycle call (each
method hardcodes the successor's role, checked as a precondition on `old.role` at the top), and every
forbidden-key field that actually reaches the row is pinned from `old` regardless of the current
profile — there is no widening for ANY check to meaningfully guard at the recycle chokepoint. The real
invariant worth pinning is structural, not a check: **replaced** `recycle-2`/`recycle-worker-2`'s tests
(which asserted the wrong, now-removed refusal) with tests of the actual property — after a human adds a
grant to the profile, recycle SUCCEEDS and the successor carries exactly the OLD row's grants, never the
newly-added one (covered for manager, platform-lead, and worker) — so a FUTURE refactor that makes
recycle re-resolve grants from the profile (rather than carrying the row) goes red here, instead of
silently widening what a recycled session can do.

## `schedule_update`'s `kind` change can silently detach a human-created row's provenance

Found in the same round-2 review: the Platform Lead's `schedule_update` (`mcp/platform.ts`) can change a
schedule's `kind` — and that tool is agent-facing by construction (the whole router is the Lead's own MCP
surface). A human creates a schedule (`createdBy: "human"`, carrying the `spawnHumanAuthorized` bypass at
fire time) and an agent later changes its `kind` via `schedule_update` — the schedule would go on firing
under the NEW kind, still carrying the HUMAN bypass, for a role the human never actually chose for that
kind. Fix: `schedule_update` resets `createdBy` to `"agent"` (fail-closed) whenever `kind` is part of the
patch AND the existing row's `createdBy` is `"human"` — an agent asserting control over `kind` is agent
origination of THAT decision, regardless of what minted the row originally. The manager's own
`schedule_update` (orchestration MCP) has no `kind` parameter at all, so this is scoped to the one tool
that can actually cause it. A human editing `kind` via REST needs no reset (the human remains the
authority either way).

## Do not

- Do not reinstate `recycleGrantWideningError`, or any grant-VALUE comparison, inside a recycle method —
  every forbidden-key field that lands on a recycled row is pinned from the OLD row regardless of the
  current profile, so there is nothing for a value comparison to correctly guard; it can only produce
  false refusals on an unrelated, on-role profile edit. See "Recycle" above for the reproduced incident.
- Do not add a recycle-time check back without FIRST re-verifying, for THAT exact recycle method, which
  fields it actually applies to the row from the re-resolved profile vs. from `old` — the round-1 defect
  existed because that verification was done once, informally, and the resulting check's CONDITION (value
  differs) didn't match what was actually verified (role never changes, values are pinned).
- Do not compare `old.harness` against the re-resolved harness for manager/platform recycle expecting a
  real residual risk — `TRANSCRIPT_ROOT_DENY_ROLES` already forces any re-resolved `"codex"` back to
  `"claude"` for those two roles unconditionally.
- Do not add `spawnHumanAuthorized` threading to `spawnWorker` or any of the three recycle methods — none
  has a human-REST caller (verified: `spawnWorker` has none; recycle is only reachable from
  `worker_recycle`/`recycle_me` on the manager/platform MCP surfaces), so there is nothing to bypass for.
- Do not drop `explicitRoleGrantCarryoverError`'s `TRANSCRIPT_ROOT_DENY_ROLES`-conditional `harness`
  filter, and do not widen it to exclude `harness` UNCONDITIONALLY for every explicit role — the
  conditional form is load-bearing in BOTH directions: dropping it entirely reopens
  `codex-role-force-start-matrix.mjs`'s RED (a tested, accepted, already-shipped silent-redirect behavior
  for manager/platform/auditor/workspace-auditor/setup turned into a refusal); widening it unconditionally
  reopens a REAL gap for `"worker"`/`"operator"` — neither is a `TRANSCRIPT_ROOT_DENY_ROLES` member, so a
  mismatched codex harness would actually reach `createCodexPty` for those two with nothing else to stop
  it.
- Do not widen the null→worker exemption to any other null-role target, or to a non-null role spawned as
  worker — the ruling is scoped to exactly `profileRole == null && explicitRole === "worker"`; a profile
  with a REAL role (e.g. `"assistant"`) spawned as worker is still the vector `worker_spawn`'s own check
  exists for, and stays fully checked.
- Do not claim `startRun` "hardcodes every forbidden field" — it threads `harness` for real (`56e6c046`).
  The other five fields really are hardcoded false/absent; only `harness` is the exception.
- Do not trust the allowlist guard's `mustContain` text alone to anchor a `skipGrantCarryoverCheck`
  entry to the right recycle method (round 3, CR `bdf6bb0b` MINOR 1) — `recycleManager`'s
  `"manager", false, undefined` argument-shape text is IDENTICAL to `startManager`'s own
  `resolveAgentSpawn` call (different flag, same shape), so a future flag moved to the wrong method would
  stay allowlisted by text alone. The guard now also anchors each of those three entries to its real
  ENCLOSING METHOD name (a nearest-preceding-2-space-method-declaration text scan); do not remove that
  anchor "for simplicity" — it is what the guard's own regression test proves closes the gap.
- Do not assert only 1-2 forbidden-key fields in a recycle row-carry test (round 3, CR `bdf6bb0b`
  MINOR 2) — assert the FULL set (connections, capabilities, vaultWrite, browserTesting,
  documentConversion) for each of the three recycle methods, plus `harness` under its OWN rule (role-force
  for manager/platform-lead, row-pinned for worker — never the same mechanism as the other five).

## `schedule_create`'s `createdBy` provenance (option 2)

`Schedule` gains a nullable `createdBy: "human" | "agent" | null` column (`SCHEDULE_ADDED_COLUMNS`, same
additive-migration shape already used four times on this table for `kind`/`prompt`/`name`/
`last_deferred_at`). Stamped at all three `insertSchedule` call sites: `gateway/server.ts`'s
`POST /api/schedules` → `"human"`; the manager's `createSchedule` → `"agent"`; the platform's
`schedule_create` → `"agent"`. Legacy/NULL rows resolve the SAME as `"agent"` at fire time (fail-closed —
unknown provenance never gets the bypass), via `scheduleCreatedByIsHuman`, threaded into the Scheduler's
`startManager`/`startAuditor`/`startWorkspaceAuditor` calls as `spawnHumanAuthorized`.

## Round 3 (CR `bdf6bb0b`): the "an agent rebind is already blocked" premise was FALSE for `browserTesting`

Round 2's residual claimed the only way to reach a human-created schedule whose agent is later rebound
onto a grant-carrying off-role profile is a HUMAN rebind, because an AGENT rebind onto such a profile is
"already blocked" by `agentAssignableProfileError`. That is false: `agentAssignableProfileError`
(`profiles/validate.ts`) deliberately leaves `browserTesting` unchecked with no role-match rule at all
(`@decision 3de74275`) — every OTHER forbidden-key field is checked there, but `browserTesting` is not.
Proven: a human creates a manager schedule against a clean agent (`createdBy: "human"`); an AGENT rebinds
that agent onto a QA-Tester-shaped `{role: "worker", browserTesting: true}` profile via `profile_assign`
or `agent_update` — `agentAssignableProfileError` does not refuse it; the schedule then fires under the
Scheduler, still carrying the human bypass, spawning a MANAGER session with `browserTesting` — a grant/role
combination the human never actually chose. Setup's `profile_assign`/`agent_update` and the Platform
Lead's `agent_update`/`agent_create` share the same gap (same shared validator, no role-match rule).

**RULING: fail closed, same shape as the `schedule_update`/`kind` reset above.** Any AGENT-surface rebind
of an agent's bound profile — every path that changes `agents.profileId` via an agent-facing MCP tool —
resets `createdBy` to `"agent"` on every `createdBy: "human"` schedule targeting that agent, unconditional
on which grant the new profile carries or whether the role actually changed (the `browserTesting` gap
proves the carried-grant set can't be trusted as a gate here). A human REST rebind (`POST /api/agents/:id`)
leaves `createdBy` untouched — the human remains the authority either way, same reasoning as the `kind`
reset's REST exemption.

**Mechanism:** one shared helper, `resetScheduleProvenanceOnAgentRebind(db, agentId)`
(`orchestration/scheduler.ts`, alongside `scheduleCreatedByIsHuman`) — iterates every schedule, resets the
`createdBy: "human"` ones targeting `agentId`. Called from the five agent-facing rebind call sites found by
card `8b236b22`'s own audit (its own decision record enumerates them): Setup's `agent_update` (the
`profileId` branch) and `profile_assign`; Platform's `agent_update` (the `profileId` branch) and
`profile_assign`; the manager's `assignAgentProfile`. Never called from `gateway/server.ts`'s
`POST /api/agents/:id` (human REST) — that route is the one call site intentionally excluded.

## Residual, narrowed: only a HUMAN rebind can still reach the stale-provenance shape

The residual is now genuinely narrower than round 2 claimed: the ONLY way a human-created schedule can go
on firing with the bypass after its agent is rebound onto a grant-carrying off-role profile is a HUMAN
REST rebind — every AGENT-surface rebind (whatever grant the new profile carries, `browserTesting`
included) resets `createdBy` immediately. A human doing this is human intent exercised through a
human-only surface — the same trust tier the `spawnHumanAuthorized` bypass already extends everywhere
else. Accepted, not re-derived at fire time.

## Do not (schedule residual)

- Do not re-derive `createdBy`'s bypass decision from the CURRENT profile state at fire time believing it
  closes the residual "for free" — that is a materially different design (option 1's TOCTOU shape, which
  the lead's own design round already weighed and did not choose) and changes the Scheduler's trust model,
  not just this residual.
- Do not treat the residual above as closed because "an agent can't cause it" — true now, but only because
  of the round-3 fix; it is accepted because a HUMAN causing it is human intent on a human-only surface,
  not because the scenario cannot occur at all.
- Do not assume the `schedule_update`/`kind` reset above closes this residual too — it is a DIFFERENT,
  narrower fix (an agent changing `kind` on an already-human-created row), not a re-derivation of
  `createdBy` from the current profile state.
- Do not gate `resetScheduleProvenanceOnAgentRebind`'s reset on WHICH grant the new profile carries, or on
  whether the role actually changed — the `browserTesting` gap that motivated round 3 is exactly a case
  where the carried-grant set looked safe and wasn't; the reset fires on every agent-surface rebind,
  unconditionally.
- Do not add `resetScheduleProvenanceOnAgentRebind` to `gateway/server.ts`'s `POST /api/agents/:id` — a
  human REST rebind is the one case this residual is deliberately accepted for.
