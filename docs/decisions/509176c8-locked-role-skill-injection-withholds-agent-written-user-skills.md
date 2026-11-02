# 509176c8 — a locked role's deliver-all default withholds AGENT-written user-store skills

## Narrative

Code review of card `4d70cc06` (reviewer `fa981283`) flagged a sibling prompt-injection path: setup's
`skill_write` (and the Platform Lead's) writes into the SAME unified store (`~/.loom/skills`,
`SKILLS_DIR`) that `injectSkills` mirrors into every session's ambient `<cwd>/.claude/skills`. Every
bundled Profile seeds `skills: null` (deliver-all) — including the LOCKED roles (`LOCKED_PROFILE_ROLES`,
`profiles/validate.ts`): Companion (untrusted-chat-driven), Setup Assistant (the authoring surface
itself), Elevated Operator (can commit/push), Workspace Auditor (reads user transcripts), and the dev-only
Platform Lead/Audit. So a setup-written skill whose description says "always load this at the start of
every session" would reach a locked role's ambient context with no human ever having scoped THAT skill to
THAT session — gated only by the `confirm:true` attestation (which attests the human saw the skill, not
that the human approved shipping it to every `skills:null` session on the box).

Confirmed by a hermetic probe (temp `LOOM_HOME`, no live daemon touched): a `skillWriteData`-written user
skill landed byte-identical in a simulated Companion session's injected `.claude/skills`, with no role
check anywhere in `injectSkills`.

The owner's ruling refined the naive fix (bundled-only for locked roles): a human who writes their OWN
skill via the Skills UI and relies on the deliver-all default to reach their Companion would otherwise
silently lose it too. The hole is AGENT-written skills, not human-written ones — so provenance was added:
`SKILL_PROVENANCE_FILE` (`paths.ts`) is a flat `{name: "agent"|"human"}` map, OUTSIDE `SKILLS_DIR` (same
reason `SKILL_BASE_DIR` is — `injectSkills` mirrors the whole skill directory, so a sidecar file living
inside a skill's own dir would get copied into every session's ambient skills too). `writeSkill`'s new
optional `provenance` param stamps `"agent"` from the MCP surfaces (`skillWriteData`, shared by
`loom-setup` and `loom-platform`, since `skill_edit` hands off to it too) and `"human"` from the Skills UI
REST routes (`gateway/server.ts`, the only non-agent write path — agents have no REST access, only MCP).

## Do not

- Do not let `injectSkills`'s deliver-all (null/empty subset) branch hand a LOCKED role
  (`LOCKED_PROFILE_ROLES`) a user-store skill whose `skillProvenance()` is `"agent"` or unstamped — an
  unstamped name (predates this tracking, or a future write path that forgets to pass `provenance`) MUST
  read as agent-written. Fail closed, never permissive-by-omission.
- Do not narrow an EXPLICIT non-empty `subset` this way, for any role. `subset` is human-only to set
  (Profiles UI/REST); a human naming a specific user skill by name there is already a deliberate,
  attributable grant — the same trust tier as `vaultWrite`/`capabilities`/`connections` — not the silent
  ambient default this record is about.
- Do not add a NEW `writeSkill` call site that skips the `provenance` argument when the caller knows which
  side of the agent/human boundary it's on. The two existing production call sites (`skillWriteData`'s
  user-skill branch, `gateway/server.ts`'s `POST`/`PUT /api/skills`) are the only places a genuinely new
  user-store skill is created. A bundled-asset write (`skillWriteData`'s `allowBundledAsset` branch,
  `adoptSkillUpdate`) never needs it — bare `isBundledSkill` is what locked-role trust checks today (round
  2 tried a content-equality gate on top of it; round 3 reverted that — see both below).
- Do not store the provenance map inside a skill's own directory under `SKILLS_DIR` — `injectSkills`
  recursively copies that whole directory into every session's ambient `.claude/skills`; a sidecar there
  would leak into agent-visible context, defeating its own purpose as internal bookkeeping.

## Round 2 (fix round, same card, reviewed tip `522148e4`)

The Code Reviewer reproduced a Critical fail-open in the round-1 implementation and three related gaps:

1. **Ordering fail-open.** `writeSkill` wrote SKILL.md content FIRST and the provenance stamp SECOND, and
   `writeProvenanceMap` swallowed its own write failure. Repro: stamp a skill `"human"`, force the stamp
   write to fail (a directory at `skill-provenance.json.tmp`, EISDIR), then write it again as `"agent"` —
   the content landed, `writeSkill` returned `true`, and the stamp still read `"human"`, so a locked role
   would be delivered agent content under a trusted stamp. Fixed: for an `"agent"` write, the stamp is
   downgraded to `"agent"` FIRST and the whole write ABORTS (returns `false`, no content touched) if that
   downgrade fails; `writeProvenanceMap` now returns `boolean` instead of swallowing the error.
2. **Corrupt-map data loss.** `readProvenanceMap` read a corrupt file as `{}` without persisting anything,
   but the NEXT `writeProvenanceMap` call would then overwrite the still-present corrupt file with a
   near-empty reconstructed map, destroying every real stamp it held with no way back. Fixed: on parse
   failure (or a parsed value that isn't an object), the corrupt file is renamed aside to a timestamped
   `<file>.corrupt-<ms>` sibling BEFORE returning an empty map, so a later write creates a fresh file
   instead of overwriting evidence, and the original bytes stay recoverable.
3. **Bundled-name collision.** The locked-role filter trusted `isBundledSkill(name)` alone. An agent can
   author a plain user skill under a name that is NOT YET bundled (stamped `"agent"`); if Loom later ships
   a bundled asset reusing that exact name, `isBundledSkill` flips `true` over the unchanged agent content
   (seed-if-absent never overwrites an existing store dir), and the old filter would admit it as trusted
   "bundled" doctrine. Fixed: added `isTrustedBundledContent(name)` — bundled AND (content matches the
   shipped asset verbatim OR `skillProvenance(name) === "human"`) — and the locked-role filter now calls it
   instead of the bare `isBundledSkill` check. Content-equality (rather than clearing a stale stamp on
   reseed) was chosen because it also correctly covers a Platform Lead `publishSkillToBundled` (store now
   equals the just-published asset, whatever stale stamp sits underneath) and a plain pristine seed (never
   stamped at all) with no extra bookkeeping on either path.
4. **Prototype-pollution-shaped read bug.** `skillProvenance("constructor")` (a syntactically valid skill
   name per `NAME_RE`) returned the inherited `Object.prototype.constructor` function instead of `null`,
   because the map was a plain `{}` and the read was a bracket access + `??`. Fixed: the map is built via
   `Object.create(null)` and `skillProvenance`/`deleteSkill` use an explicit `Object.hasOwn` check instead
   of relying on `in` / `??` against a prototype-bearing object.

## Do not (round 2)

- **Superseded by round 3 below — kept for history, do not follow this bullet as written.** This round
  added `isTrustedBundledContent(name)` (content-equality with the shipped asset, or an explicit `"human"`
  stamp) on top of `isBundledSkill` for locked-role delivery, to close a same-named-future-bundled-asset
  collision. It was reverted in round 3 for regressing legitimate bundled customizations; see there.
- Do not let the `"agent"` branch of `writeSkill` write SKILL.md content before the provenance stamp lands.
  Downgrade the stamp first and abort the whole write on failure — never swallow a stamp-write failure on
  this path.
- Do not let a corrupt provenance map be silently read as `{}` and then overwritten by the next write —
  move the corrupt file aside first so a later write can't erase it.
- Do not read or write the provenance map as a plain `{}` object — use `Object.create(null)` plus an
  explicit `Object.hasOwn` check, since skill names sharing a name with an `Object.prototype` member
  (`"constructor"`, etc.) are valid per `NAME_RE`.

## Round 3 (scope cut, follow-up filed as card `9a3dea30`)

Review of this card's own implementation (reviewer `0c5a7646`) found that round 2's `isTrustedBundledContent`
rule — trust a bundled name only when the store content equals the shipped asset or carries an explicit
`"human"` stamp — regresses two real, non-malicious cases: a legitimately CUSTOMIZED bundled skill (content
diverges from the shipped asset by design, with no `"human"` stamp to fall back on) and the window where a
Platform Lead publishes an advanced asset before the next reseed lands it. Neither is an agent-authored
collision, but both fail the same content-equality check and would be silently withheld from a locked role.

The obvious patch — treat `customized:true` as equivalent to a `"human"` stamp — does not close the gap:
`customized` is derived as `mine !== base`, and `seedBaseSnapshots` backfills `base := shipped` for a name
that collides, so the agent's own colliding content ALSO reads `customized:true`. That signal alone can't
tell "a human customized this" apart from "an agent's user skill happens to not match a later-shipped
asset."

Scope was cut from this card rather than iterated further here: `isTrustedBundledContent` was REMOVED
(store.ts and its one call site in inject.ts), and locked-role trust reverted to round 1's bare
`isBundledSkill(n) || skillProvenance(n) === "human"` — the two regressions above are gone, and so is the
collision defense round 2 added. Closing the collision properly — without regressing legitimate
customization — is tracked as a design-first follow-up, card `9a3dea30`. Two directions are on the table
there: (a) have seeding itself refuse/flag a new bundled name whose store dir already carries an `"agent"`
stamp (rename aside + warn) — closes the hole at the one place a collision can actually arise; or (b) widen
the trust check to `mine==shipped OR mine==base OR stamped human`, plus a one-time boot stamp for legacy
customizations. `9a3dea30` is blocked on this card merging first, and reports a `blocked` checkpoint with
the chosen design before building.

A corrupt-map nitpick was also closed in this round: `writeProvenanceMap` now independently re-checks the
file on disk for corruption and refuses to write if it's still corrupt — closing the gap where
`readProvenanceMap`'s rename-aside call could itself fail (e.g. EPERM) and leave the corrupt file in place
for the next write to silently overwrite.

## Do not (round 3)

- Do not re-add a content-equality (or any other) gate on top of `isBundledSkill` for locked-role trust
  without reading card `9a3dea30` first — the obvious shape (`isTrustedBundledContent`, round 2) was tried
  and reverted here for regressing legitimate customized bundled skills and the advanced-asset-before-reseed
  window. Locked-role trust for a bundled name is bare `isBundledSkill(n) || skillProvenance(n) === "human"`
  again; the bundled-name collision it can't catch is tracked separately, not patched back in here.
- Do not use `customized:true` as a stand-in for a `"human"` stamp to patch this — `seedBaseSnapshots`
  backfills `base := shipped` on a colliding name, so an agent's own colliding content reads `customized:true`
  too. That signal can't discriminate the two cases.
- Do not let `writeProvenanceMap` write over a provenance file that is CURRENTLY corrupt on disk, even when
  the caller already tried and failed to rename it aside — re-check the on-disk file for corruption in
  `writeProvenanceMap` itself before writing, independent of whether the rename-aside succeeded.

## Round 4 (2026-11-02, card `b8aabf5b`) — the subset bypass is closed at the PROFILE-write path (one of two layers — see round 5)

Round 1's "Do not" #2 above ("Do not narrow an EXPLICIT non-empty `subset`... `subset` is human-only to
set") was a premise about the Profiles UI/REST, not an enforced one: nothing stopped the Platform Lead's
own agent-facing `profile_create`/`profile_update` (`mcp/platform.ts`) from setting a non-empty `skills`
subset directly on a locked-role profile — the explicit-subset branch in `injectSkills` (`inject.ts`)
applies no trust filter at all, by design, so whatever an agent put in `skills` reached the session
verbatim. Found by card `28b2ca6f`'s investigate-first report
(`research/skill-frontmatter-permission-widening-2026-11-02.md`), filed as this card.

Closed by two new predicates in `profiles/validate.ts`, called from `profile_create`/`profile_update` on
both the Platform Lead (`mcp/platform.ts`) and setup (`mcp/setup.ts`) surfaces — setup's own `setupRoleError`/
`setupLockedRoleError` already make a locked role unreachable there, so the call is defense in depth, not
the live enforcement:

- `agentLockedRoleSkillsError(raw, resolvedRole)` — rejects an agent's own RAW payload/patch when it sets
  `skills` to a non-empty array AND the resolved role is locked. Mirrors `agentProfileKeyError`'s
  own-key-present shape.
- `roleChangeLockedSkillsCarryoverError(previousRole, newRole, mergedSkills)` — closes the two-call
  bypass: set `skills` while the role is unlocked (still agent-settable, unchanged), then flip `role` to
  locked in a LATER patch that never mentions `skills`. Checked against the MERGED post-patch `skills`,
  not the stored pre-patch value, so a single call that flips role to locked AND clears `skills` in the
  same patch is allowed — only a resulting non-empty subset is refused.

Both predicates treat CLEARING the subset (`skills: null`/`[]`) as always allowed, on any role — it is a
privilege reduction back to the filtered deliver-all default (`isTrustedForLockedRole`), never a
widening, so there's nothing for a human to review. An agent patch to an already-locked profile that
never mentions `skills` (e.g. a rename) is untouched, exactly like every other `AGENT_FORBIDDEN_PROFILE_KEYS`
field — only the agent's own attempt to introduce/widen `skills` on a locked role is rejected.

`skills` is NOT added to `AGENT_FORBIDDEN_PROFILE_KEYS` (`shared/src/profileGrants.ts`) — unlike that
array's members, `skills` stays agent-writable on an UNLOCKED role (manager/worker) exactly as before;
only the locked-role case is now gated, and only for a non-empty subset. The human REST path
(`gateway/server.ts` `POST`/`PUT /api/profiles`) and the Profiles UI are untouched — neither calls these
new predicates, by construction, the same way neither calls `agentProfileKeyError`.

## Do not (round 4)

- Do not add `skills` to `AGENT_FORBIDDEN_PROFILE_KEYS` — that would make it human-only UNCONDITIONALLY,
  regressing the unlocked-role (manager/worker) case, which must stay agent-settable.
- Do not check `agentLockedRoleSkillsError`/`roleChangeLockedSkillsCarryoverError` inside `validateProfile`
  itself — that validator is shared with the human REST path; the human-only gate for this field belongs
  at the agent-facing MCP call sites only, same precedent as `agentProfileKeyError`.
- Do not reject an own `skills` key whose value is `null`/`[]` on a locked role — clearing is a reduction,
  never a widening, and must stay allowed so the Platform Lead can clear a stale subset without a human.
- Do not check `roleChangeLockedSkillsCarryoverError` against the STORED (pre-patch) `skills` — check the
  MERGED (post-patch) value, or a same-call "flip role to locked AND clear skills" would be wrongly
  refused.
- Do not skip wiring these two predicates into `mcp/setup.ts` on the premise that a locked role is
  already unreachable there — the role checks (`setupRoleError`/`setupLockedRoleError`) are a separate
  mechanism that could itself regress; the skills check is defense in depth, not redundant dead code.

## Round 5 (2026-11-02, card `b8aabf5b` CR round 1) — the SESSION-role chokepoint is the SECOND, separate layer

Code Review of round 4 (CRITICAL) found round 4's own close was incomplete: `injectSkills`'s trust
decision keys on the RESOLVED SESSION role (`skills/inject.ts`'s `role` parameter), not on the bound
profile's own `role` field — but round 4's two predicates only ever validate a WRITE against the
PROFILE's own role. `resolveAgentSpawn` (`sessions/service.ts`) resolves a session's role as
`explicitRole ?? profileRole`, so the two can diverge: an agent could (1) `profile_create`/
`profile_update {role:"worker", skills:[agent-written]}` — allowed, unlocked, exactly as round 4 intends
to leave untouched — (2) bind that profile to an agent, then (3) reach an EXPLICIT locked session role
with no further check on `skills` at all: `schedule_create{kind:"auditor"}` (no profile-role check) ->
the Scheduler's `startAuditor` call, a human-REST explicit-role spawn (`POST /api/agents/:id/sessions
{role:"auditor"}`), or the assistant capability re-pin. The explicit role wins over the profile's own
"worker", and the agent-written subset reached `injectSkills`' subset branch with no trust filter
applied at all — round 4's own "closed at the write path" framing was true of the PROFILE write, but
false of the SESSION that actually gets spawned from it.

Closed by a new pure predicate, `sessionSkillsForRole(sessionRole, profileRole, skills)`
(`profiles/validate.ts`): when the SESSION role is locked AND the subset's own profile role differs,
drop it for injection — it falls back to `injectSkills`' trust-filtered deliver-all (never refuses the
spawn: a scheduled auditor must still run). A subset whose profile role EQUALS the session role is
human-set by construction FOR SUBSETS WRITTEN AFTER ROUND 4 (round 4's own predicates enforce that only
going forward — see round 6 below for the pre-round-4 residual this narrowing leaves, tracked separately
as card `5094d63a`) and is honoured unchanged — this does NOT apply `isTrustedForLockedRole` to the
subset branch, which would still contradict round 1's "subset is human-only" design; that remains an
owner call, not made here.

Wired at the ONE place every fresh spawn + recycle + the companion capability re-pin already consumes
`resolveAgentSpawn`'s returned `.skills` directly — the predicate runs INSIDE `resolveAgentSpawn` itself,
so every one of those callers inherits the fix with no per-call-site change. A SEPARATE set of
carry-forward sites deliberately read the ROW-PINNED `skills` instead of re-resolving the value
(`@decision 547d5fc4` — resume/fork/recycle must never re-resolve a profile's skills subset): `resume()`,
its `resumeForcedRoleAsFreshClaude()` sibling, `forkSession()`, and `recyclePlatformLead()` each
re-validate TRUST on the pinned value against the agent's CURRENT profile role (via the same predicate),
without touching the pinned VALUE itself — this also closes the residual for a session whose row was
pinned BEFORE this fix shipped: the next resume/fork re-checks it. `recycleManager()`/`recycleWorker()`
are untouched — their resolved session role is a HARDCODED literal (`"manager"`/`"worker"`), never a
variable, so they can structurally never produce a locked session role; wiring the predicate there would
be unreachable dead code, not defense in depth.

A durable `locked_role_skills_dropped` event is filed whenever a drop actually happens
(`SessionService.recordSkillsDropped`), mirroring `harness_role_forced_claude`'s own audit convention —
naming the agent/profile/session-role/profile-role, so the drop is visible even though the spawn
proceeds. Audit-only, like that sibling: never added to `EVENT_TRIGGER_EVENT_KINDS`/
`GATE_HISTORY_KINDS`/`ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS`.

**The accurate summary of the full close, superseding round 4's own heading:** a locked-role profile's
explicit skills subset is human-only to set at the PROFILE-write layer (round 4) AND honoured only when
the SESSION it's actually injected into resolves to that SAME role (round 5) — neither layer alone closes
the hole; both are load-bearing.

## Do not (round 5)

- Do not read round 4's predicates as sufficient on their own — they validate a WRITE against the
  PROFILE's own role field; they cannot see an explicit-role spawn/resume/fork that diverges the SESSION
  role from it. Both layers are required.
- Do not apply `isTrustedForLockedRole` to the subset branch in `inject.ts` as an alternative fix — that
  contradicts record round 1's "subset is human-only" design and is an explicit owner call, not made here.
- Do not wire `sessionSkillsForRole` into `recycleManager`/`recycleWorker` — their session role is a
  hardcoded string literal, never a variable; there is no divergence for the predicate to ever catch
  there, so wiring it would be unreachable code, not a real guard.
- Do not re-resolve a carry-forward site's (resume/fork/recycle) pinned `skills` VALUE from the current
  profile to apply this check — `@decision 547d5fc4` forbids that; re-validate TRUST against the current
  profile ROLE instead, leaving the pinned value's content untouched when it isn't dropped.
- Do not skip filing `locked_role_skills_dropped` for a carry-forward drop (resume/fork/recycle) on the
  premise that only a fresh spawn needs the audit trail — a session pinned before this fix shipped can
  still carry a bad subset into a resume/fork, and that drop needs the same visibility a fresh spawn's does.

## Round 6 (2026-11-02, card `b8aabf5b` CR round 2) — persist the drop onto the ROW, or a later re-match re-arms it

Code Review of round 5 (reviewer `30f5b5e1`), BLOCKING: round 5's carry-forward re-validation (`resume()`,
`resumeForcedRoleAsFreshClaude()`, `forkSession()`, `recyclePlatformLead()`) compared only ROLES and
**never cleared the dropped subset off the session row** — it computed the trust-revalidated value for
THAT spawn's own argv, but left the row's `skills` column holding whatever it held before. So a LATER
event that re-converges `profileRole` back to the session's locked role — a `profile_assign` to a
different, matching-role profile, or a role flip on the SAME profile (round 4's own allowed same-call
clear, or a separate edit that re-sets `skills` on the unlocked interval between the mismatch and the
flip) — makes the predicate's role-comparison read "matching" again on the VERY NEXT carry-forward, and
it re-honours the stale value still sitting in the row, exactly the subset round 5 believed it had
already withheld for good. Round 5's own closing line above ("the accurate summary of the full close")
was therefore itself incomplete: both of ITS layers (round 4 profile-write guard + round 5 session-role
chokepoint) are necessary, but round 5's own IMPLEMENTATION of the second layer — re-validate against
role alone, without a persist — was not sufficient on its own, which is the gap this round closes. This
also retroactively corrects round 4's "closed at the PROFILE-write path" heading and round 5's own
closing-summary framing: neither round's commit/record language should be read as "closes the residual"
without this round's persist.

**Fix:** every carry-forward site that computes a drop via `sessionSkillsForRole` now ALSO persists
`skills: null` onto the session row (`Db.setSessionCapabilitySurface`) whenever `dropped === true` — a
reduction, never a re-resolve, so it stays within `547d5fc4`'s own additive-only intent for carry-forward
sites. `resume()` and `resumeForcedRoleAsFreshClaude()` persist onto their OWN row (the same id they just
resumed). `forkSession()` and `recyclePlatformLead()` each mint a NEW row that already carries the
trust-revalidated value at `insertSession`/`insertRecycleSuccessor` time (nothing further needed there) —
but EACH source row (`src` for fork, `old` for recycle) is a SEPARATE, surviving row whose own `skills`
column was never touched by the trust check that ran against it; both are now cleared too, or the SOURCE
row's own next carry-forward (fork/resume/recycle of the source, independent of the one just performed)
could re-arm from the same stale value. Once a row's `skills` is persisted null, `sessionSkillsForRole`
short-circuits on its OWN first guard (`normalized == null`) on every later call — this is also what
stops `locked_role_skills_dropped` from re-filing on every subsequent resume of an already-cleared row.

`upgradeCompanionCapabilities` (the assistant live re-pin) needed NO change — unlike the four carry-
forward sites above, it is a FRESH re-resolve (`resolveAgentSpawn` with an explicit `"assistant"` role),
so it already writes whatever `sessionSkillsForRole` decides straight onto the row via its existing
`setSessionCapabilitySurface` call; there was never a stale row value for it to leave behind.

**Named consequence, accepted (CR round 3, card `34530aad` finding 4):** persisting `null` is a
PERMANENT reduction, not a reversible annotation — the row can no longer distinguish "never had a
subset" from "had a human-curated one that got dropped by a transient mismatch." A genuinely transient
profile-role divergence — e.g. the Platform Lead's own `profile_assign`/`allowElevatedRoles` temporarily
binding a different-role profile, a carry-forward resume landing in that window, then the human rebinding
back to the original matching-role profile — permanently replaces a human-curated subset with the
trust-filtered deliver-all (`isTrustedForLockedRole`) for every session spawned from that row from then
on, until the NEXT fresh spawn re-resolves the subset from the profile directly (a fresh spawn never
reads the row's stale `skills`). Deliver-all is not strictly narrower than the human's subset — it can
ADD a bundled/human-stamped skill the human deliberately excluded from their named list, not just drop
ones they wanted. This is the accepted trade: the row has no field recording WHO set the dropped value or
WHY, so there is nothing for the persist to preserve or restore once the divergence resolves — re-
resolving from the row's own history is not an option (`547d5fc4` forbids re-resolving a carry-forward
site's pinned value from the profile in the first place), and leaving the stale value in place is the
round-6 bug this record exists to close. Mitigated only by a fresh spawn eventually re-establishing the
real subset; no further fix is planned here.

## Do not (round 6)

- Do not trust round 4's "closed at the PROFILE-write path" heading, or round 5's own closing summary,
  as a complete account of the fix — both predate this round's persist and describe an INCOMPLETE close.
  Read this round's finding before citing either as settled.
- Do not compute a carry-forward drop and skip persisting it onto the row because "this spawn's argv is
  already correct" — the argv is correct for THIS spawn only; an un-persisted row is exactly what a later
  role re-match re-arms.
- Do not persist the drop by re-deriving or mutating the VALUE a carry-forward site reads (`547d5fc4`
  still forbids re-resolving it) — only ever write `null` when `dropped === true`, never a different
  computed subset.
- Do not skip clearing a FORK's or RECYCLE's SOURCE/PREDECESSOR row on the premise that the newly-minted
  row already has the correct value — the source/predecessor is a SEPARATE, surviving row with its own
  independent carry-forward future (another fork, another resume, another recycle) and its own `skills`
  column was never touched by the check that just ran against it.
- Do not read "human-set by construction" (round 5's own phrase, just above) as applying to a subset
  written BEFORE round 4 shipped — round 4's predicates only ever gate a write going forward. The
  pre-round-4 data residual (existing profiles whose locked-role `skills` subset was never gated by
  anything) is tracked separately as card `5094d63a`, pending an owner decision; do not conflate the two
  residuals or assume this round's persist retroactively audits old data — it only stops a FUTURE
  carry-forward from re-arming what IT itself already dropped once.
- Do not treat a persisted `null` as reversible, or assume deliver-all is a strictly SAFER/narrower
  fallback than the human-curated subset it replaced — see the "Named consequence, accepted" paragraph
  above. A transient profile-role divergence can permanently lose a human-curated subset until the next
  fresh spawn, and deliver-all can ADD a skill the human deliberately excluded, not just drop ones they
  wanted. This is an accepted trade, not a gap to patch here.

## Source

Round 4 adds `agentLockedRoleSkillsError`/`roleChangeLockedSkillsCarryoverError` (`profiles/validate.ts`),
and their call sites in `mcp/platform.ts`'s and `mcp/setup.ts`'s `profile_create`/`profile_update`.

Round 5 adds `sessionSkillsForRole`/`lockedRoleSkillsDroppedReason` (`profiles/validate.ts`), the
`locked_role_skills_dropped` event kind (`shared/src/types.ts`), and `SessionService.recordSkillsDropped`
plus its call sites (`sessions/service.ts`): `resolveAgentSpawn`'s own return (covering every fresh
spawn/recycle/companion-re-pin that consumes it), `resume()`, `resumeForcedRoleAsFreshClaude()`,
`forkSession()`, and `recyclePlatformLead()`.

Round 6 adds the `Db.setSessionCapabilitySurface(id, { skills: null })` persist call at each of the four
carry-forward sites named above, in `sessions/service.ts` (`resume()`, `resumeForcedRoleAsFreshClaude()`
clear their own row; `forkSession()` clears `src.id`; `recyclePlatformLead()` clears `old.id`).


`packages/daemon/src/skills/inject.ts` (`injectSkills`'s `want` computation, back to bare `isBundledSkill`),
`packages/daemon/src/skills/store.ts` (`writeSkill`, `skillProvenance`, `readProvenanceMap`/
`writeProvenanceMap`, `parseProvenanceMap`, `deleteSkill` — `isTrustedBundledContent` removed in round 3),
`packages/daemon/src/paths.ts` (`SKILL_PROVENANCE_FILE`), `packages/daemon/src/mcp/skillTools.ts`
(`skillWriteData`'s user-skill branch), `packages/daemon/src/gateway/server.ts` (`POST`/`PUT /api/skills`),
`packages/shared/src/types.ts` (`SkillSummary.provenance`), `packages/web/src/pages/Skills.tsx` (the
unstamped/agent-authored user-skill badge + re-save-to-trust affordance).
`LOCKED_PROFILE_ROLES` (`packages/daemon/src/profiles/validate.ts`) is the shared locked-role set, also
used by `mcp/setup.ts`'s `SETUP_LOCKED_ROLES` (card `4d70cc06`). The round-3 redesign of the bundled-name
collision case is tracked separately on card `9a3dea30`, not here.
