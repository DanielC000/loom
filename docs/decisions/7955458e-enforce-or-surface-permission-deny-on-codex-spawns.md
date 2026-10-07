# 7955458e — enforce or loudly surface project `permission.deny` on codex spawns

## Background

`createCodexPty` (`pty/host.ts`) never reads `opts.permission` at all — confirmed at that method's own
comment ("verified: opts.permission/disallowedTools never appear anywhere in this method or
spawnCodexProcess"). Three real claude-side protections live entirely inside `createPty`'s own body,
built from `opts.permission`, and so are silently dropped the instant a session spawns on codex instead:

1. **SETTINGS_DIR read-deny** (`withSettingsDirDenyForSpawn`, `claude-settings.ts`) — unconditional, every
   role. Denies `Read(<LOOM_HOME>/tmp/settings/**)`, which holds every live session's hook token and, for
   a secret-bearing claude spawn, its plaintext `--mcp-config`.
2. **The blanket transcript-root deny** (`withTranscriptRootDenyForSpawn`, card `ac90ca8e`) — denies
   `Read(~/.claude/projects/**)` for `TRANSCRIPT_ROOT_DENY_ROLES` (manager/platform/setup/auditor/
   workspace-auditor/assistant — `worker` deliberately excluded, see below).
3. **The worker per-other-project transcript pair** (card `d78f8217`) — a narrower, already best-effort/
   fail-open deny-list of OTHER live projects' transcript dirs, for `worker` only.
4. **A human-authored PROJECT `permission.deny`** override (`config.permission.deny`, defaults to `[]` —
   `shared/src/config.ts`) — whatever a project actually configured, dropped the same way. PROJECT-only,
   deliberately: a Profile has no `deny` field of its own (only `allowDelta`), and there is no
   platform-level permission layer either (`PlatformConfigOverride` carries no `permission` field) — the
   project config override is the ONLY authored source.

LOOM_HOME **writes** are the one piece that needs no codex-side fix at all: codex's own `-s workspace-write`
sandbox is OS-level deny-by-default (ACL DENY ACE on Windows, Seatbelt on macOS, bubblewrap on Linux —
`docs/decisions/d7657543`), grants writes only to cwd (no `--add-dir` is ever passed), and every
codex-eligible session's cwd is the git worktree — a sibling of `WORKTREES_DIR`, never nested under
LOOM_HOME. `docs/decisions/37310431`'s own "Codex harness — no change needed" section already said this —
this record just scopes that claim precisely: it is **write-side only**. The four items above are all
**read**-side, and codex's sandbox never gates reads at all, on any `sandbox_mode` — verified live against
codex's own current docs (`learn.chatgpt.com/docs/config-file/config-reference`,
`learn.chatgpt.com/docs/permissions.md`, fetched for this card): "workspace-write mode permits reading
from any filesystem location... only restricts write operations to specified writable_roots."

## Investigation: can any of this map onto a real codex lever?

codex does have a native per-path filesystem permission primitive — a `[permissions.<name>.filesystem.
<path>]` profile system with real `"read"|"write"|"deny"` values, selected via a top-level
`default_permissions` config key. Two facts rule it out as a drop-in map, both verified live against
codex's own current docs, independently, twice:

1. **It is marked beta**: "Permission profiles are under active development and may change."
2. **It is mutually exclusive with the `sandbox_mode`/`-a`/`-s` flags `createCodexPty`'s entire probed,
   unattended-boot recipe depends on.** Verbatim: "Permission profiles do not compose with the older
   sandbox settings... If `sandbox_mode` appears in any active config layer, you pass `--sandbox`, or a
   config profile sets `sandbox_mode`, Codex uses those older sandbox settings instead of
   `default_permissions`." `createCodexPty` passes `-s workspace-write` literally (`host.ts`) — so even
   layering a `-c default_permissions=...` override alongside today's flags would be silently ignored, not
   additive.

Adopting it would mean dropping the probed `-a never -s workspace-write` recipe entirely and re-validating
the whole unattended-boot/trust-dialog/busy-idle machinery against a different, beta, never-probed-for-this
mechanism — a ground-up codex-adapter redesign, not a map of one rule, and out of scope for this card.

## Decision

**Split by whether the gap is genuinely config-driven (profile/project-authored) or structural
(role/spawn-shape-keyed), and handle each the way its own shape allows:**

1. **Item 4 (authored PROJECT `permission.deny`) is config-driven and mappable to "keep on claude."**
   Extended `CodexCompatInput`/`codexIncompatibilities` (`profiles/codex-compat.ts`) with a
   `permissionDeny` field — same remedy shape, same single source, as `restrictedTools`/`browserTesting`/
   `documentConversion`/`capabilities` (card `961da6c6`). Threaded through `defaultHarnessForSpawn`
   (`sessions/service.ts`) and `recycleHarness`, filing the SAME durable `harness_default_skipped` event.
   **This does NOT make codex stop running fleet-wide** — `config.permission.deny` reaching
   `createCodexPty`'s `opts.permission.deny` is the PRISTINE project-resolved value, defaulting to `[]`;
   the SETTINGS_DIR/transcript-root denies are only ever added later, inside `createPty`'s own body, and
   never reach `SpawnOpts.permission` at all. Verified against the real self-hosting DB (a read-only copy,
   never the live path): exactly one `harness:"codex"` profile exists today ("Codex Worker (pilot)", role
   `worker`) and zero live/historical codex-harness sessions carry a `TRANSCRIPT_ROOT_DENY_ROLES` role —
   nothing existing is affected either way.
2. **Items 1–3 (structural) are disclosed loudly, not skipped**, via a report **SEPARATE from the
   capability-drop report** (Code Review MAJOR fix, below).
3. **CRITICAL (Code Review round 2): validateProfile's save-time reject is BYPASSABLE and is not the real
   guarantee.** It checks the PROFILE's own `role` field, but every explicit-role start path
   (`startManager`/`startPlatformLead`/`startAuditor`/`startWorkspaceAuditor`/`startSetup`, plus the
   manager/lead recycles) takes the HARNESS from the agent's profile **regardless of that profile's own
   role field** — so a `{role:"worker", harness:"codex"}` profile (exactly the real, pre-existing "Codex
   Worker (pilot)" profile) assigned to an agent and then started via `startManager` yields a codex
   **manager**, with the blanket transcript-root deny silently dropped, and `validateProfile` never once
   saw `role:"manager"` to reject. Agent-reachable: the Setup operator can do this via `profile_assign` +
   `session_spawn manager`. **The real backstop is structural, at the SPAWN chokepoint**: every
   start/recycle path's FINAL harness is decided inside `SessionService.resolveAgentSpawn` (proven by
   enumeration — see "Source" below for the exhaustive call-site list); that function now computes
   `rawHarness = resolved.harness || harnessFromDefault.harness` and, whenever `rawHarness === "codex"` AND
   the RESOLVED session `role` (never the profile's own role field) is a `TRANSCRIPT_ROOT_DENY_ROLES`
   member, FORCES the harness back to `undefined` (claude) — catching the explicit-profile case, the
   default-layer case, AND the role-mismatch bypass uniformly, since all three converge on the same
   `rawHarness` computation. **Does not refuse the spawn** (that would break every ordinary manager/
   platform/auditor/workspace-auditor/setup start) — it silently redirects to claude and files a NEW
   durable `harness_role_forced_claude` event (`{role, agentId, profileId, reason}`), wired at all 8 real
   call sites that can reach this branch: `startNew`, `startManager`, `startPlatformLead`, `startAuditor`,
   `startWorkspaceAuditor`, `startSetup`, `recycleManager`, `recyclePlatformLead`. `validateProfile`'s
   reject STAYS as the early UX error for the common (role-matches-profile) case — it is simply no longer
   the only guard. **This also makes the `adoptProfileUpdate`/`resetProfileToBundled` bypass a reviewer
   flagged separately (a profile update path that could reintroduce a rejected role+harness combo without
   re-running `validateProfile`) MOOT**: regardless of how an incompatible `{role, harness:"codex"}` pair
   reaches a profile or an agent row, the spawn-chokepoint force catches it at the one place every spawn
   must pass through, independent of which write path produced the row. **CORRECTION (round 3, item 6
   below): this was true only for paths that actually CALL `resolveAgentSpawn` for harness — `resume()` and
   `recycleHarness`'s agent-missing fallback do not, and were real, separate bypasses of this exact force.**
4. **MAJOR (Code Review round 2): the structural items' spawn-time disclosure must NEVER reach the codex
   session's own turn input.** The first implementation folded `settingsDirReadDeny`/
   `transcriptRootReadDeny`/`workerProjectTranscriptDeny` into the SAME `onCodexUnsupportedCapability`
   report/handler the capability-drop items (`codescape`/`restrictedTools`) already use — but that
   handler's RECIPIENT delivery (`enqueueSystemNudge(sessionId, ...)`) puts the text straight into the
   affected codex session's own next turn, telling the very session whose isolation was dropped exactly
   which other sessions'/projects' data it can now read, and the capability-drop wording ("use harness
   claude — otherwise no action needed") is also wrong register for a dropped protection. Fixed by adding a
   genuinely SEPARATE event/callback, `onCodexIsolationGapDisclosed` → `SessionService.
   handleCodexIsolationGapDisclosed`, carrying `settingsDirReadDeny`/`transcriptRootReadDeny`/
   `workerProjectTranscriptDeny`/`permissionDeny` (item 5 below) exclusively: it files a durable
   `codex_isolation_gap_disclosed` event on EVERY spawn (mirrors `codex_unsupported_capability`'s own
   per-spawn posture) and sends a MANAGER-side nudge only (never to the session itself), deduped so a
   long-lived manager/platform-lead/assistant's repeated resumes can't flood its manager's inbox and drown
   out the rarer `codescape`/`restrictedTools` signal. **The dedupe key described here (agentId) was WRONG
   and was replaced in round 3 — see item 7 below for the corrected key and why.** The existing
   capability-drop report is UNCHANGED.
5. **Item 3 of the Code Review (also round 2): `permissionDeny` is now ALSO pushed into the same
   `isolationGapItems`/`onCodexIsolationGapDisclosed` report**, unconditionally on `opts.permission.deny.
   length > 0`. This surfaces the two cases item 1's `defaultHarnessForSpawn` skip structurally cannot
   reach: an EXPLICIT codex profile (the default layer is never consulted when `resolved.harness` is set)
   and a pinned/resumed row (recycle/resume never re-run the skip check either). `.deny ?? []` guards
   against a malformed/incomplete test double's `permission` object — found the hard way when an
   unguarded `.deny.length` crashed an unrelated, pre-existing test
   (`companion-codex-restricted-tools-refusal.mjs`) that never set `.deny` on its own fixture.

6. **MAJOR (THIRD review round — "round 3" below, SECOND Code Review on this card overall): the round-2
   force was INCOMPLETE — two real bypasses survived it.** `resume()` never calls `resolveAgentSpawn` for
   harness at all — by design, every OTHER capability (browserTesting/restrictedTools/skills/…) stays
   ROW-PINNED across resume (card `8d4b4433`), and harness followed the same rule — so a codex-pinned row
   whose role forces claude would still attempt a `--resume` of a codex engine id under the claude CLI on
   every automatic resume path (boot-resume, wake, crash-recovery): a codex engine id means nothing to the
   claude CLI. And `recycleManager`/`recyclePlatformLead`'s AGENT-MISSING fallback (`recycleHarness`'s
   `!spawn` branch) returned `old.harness` unchanged, since there is no `resolveAgentSpawn` result to force
   through when the agent row is gone. Three independent fixes closed this:
   - **(a) Fail-closed backstop at `PtyHost.spawn` itself** (`host.ts`): refuses
     (`CodexRoleSpawnRefusedError`, `profiles/codex-compat.ts`'s `codexRoleSpawnRefusedReason`) a codex
     spawn for any `TRANSCRIPT_ROOT_DENY_ROLES` role, keyed on `opts.role` alone — independent of whichever
     caller reached it, present or future. This is the one check that would have caught BOTH of the
     bypasses below even before they were understood individually.
   - **(b) `resume()`'s own graceful redirect** (`resumeForcedRoleAsFreshClaude`): when a row's
     `harness==="codex"` AND its ROLE forces claude, `resume()` boots the SAME session id FRESH on claude
     instead of attempting the doomed `--resume`. Deliberately reuses the SAME id rather than minting a
     recycle-style successor row (the `recycleManager`/`recyclePlatformLead` shape): there is no LIVE
     predecessor to hand ownership off from (the row is already exited by the time `resume()` runs), and
     minting a new id would otherwise require threading a redirected id through `resumeFleetOnBoot`'s
     id-keyed wake-impact/nudge machinery (per-session board/worktree counts, continuation-nudge targets)
     for no behavioral benefit — same id in, same id out means every existing `resume()` caller (including
     `resumeFleetOnBoot`) needs NO changes. `Db.setSessionHarness` is the ONE deliberate exception to
     harness being write-once-at-insert (every other path mints a fresh row instead), added narrowly for
     this one corrective path.
   - **(c) `recycleHarness`'s agent-missing branch** now also forces claude (mirrors (b)'s reasoning) and
     returns a `roleForced` detail the caller (`recycleManager`/`recyclePlatformLead`) feeds to
     `recordHarnessRoleForced` exactly like the agent-present case does.
   All three file `harness_role_forced_claude` — (b)/(c) with `trigger:"resume"`/`"recycle"` respectively,
   matching the existing `trigger` convention from round 2's `recordHarnessDefaultSkipped`.
7. **MAJOR (round 3): the manager-nudge dedupe key (item 4 above) was wrong.** `agentId` is the agent
   DEFINITION, shared across every session EVER spawned from it — not a recycle lineage. A distinct-task
   worker (a different task, hence a different, unrelated lineage) sharing the same agent would wrongly
   inherit another lineage's "already nudged" state; the dedup also ignored WHICH items fired (a later NEW
   item added to the same lineage would be silently swallowed by an earlier, smaller item-set's dedup
   record); and it recorded `detail.nudged:true` even when there was no parent to send to, which would then
   wrongly suppress a LATER, managed occurrence of the same lineage that DOES have a recipient. Fixed:
   `Db.hasNudgedEventForLineageItems` keys on `(lineageRootId, itemsKey)` — lineage root found by walking
   `recycledFrom` via the existing `lineageRootId` helper (`sessions/lineage.ts`, already used elsewhere for
   this exact purpose), item ids sorted + comma-joined — and requires a PRIOR row with `nudged===true`
   specifically, never mere existence. `detail.nudged` is now computed honestly as
   `!alreadyNudged && !!parentSessionId`, so a parentless occurrence (nothing to send to) is recorded
   truthfully as not-nudged and never counts as "already nudged" for a later occurrence that DOES have a
   recipient.
8. **Minor (round 3): `recycleHarness`'s `codexIncompatibilities` branch (the `spawn.harness === "codex"`
   case) and `harnessDrainStatus`'s `blocked` field remain genuinely dead**, unchanged by this round — item
   6(c)'s agent-missing fix is a DIFFERENT branch of the same function (the `!spawn` case), not this one.
   Filed as card `699099b4` rather than removed in-round: removal ripples into REST exposure
   (`switchHarnessNow`'s own `blocked` count) and two existing test files
   (`harness-drain-status.mjs`/`harness-switch-now.mjs`), not a clean/small deletion.
9. **Regression coverage (round 3): `codex-role-force-start-matrix.mjs`** is the first test to prove the
   round-1 repro is closed END TO END, in one place, across every explicit-role start method
   (`startManager`/`startPlatformLead`/`startAuditor`/`startWorkspaceAuditor`/`startSetup`), `startNew`
   (assistant role — the one entry that uses a DIFFERENT fixture, `{role:"assistant", harness:"codex"}`,
   since `startNew` never overrides a profile's own role field the way the other five do, so the
   `{role:"worker",...}` bypass fixture doesn't apply to it), the Setup surface's `session_spawn`(manager)
   via `spawnSessionAsPlatform` (the exact call `mcp/setup.ts`'s tool makes), `resume()` (both
   agent-present and agent-missing variants, plus a CONTROL proving an ordinary claude-pinned resume is
   untouched), and `PtyHost.spawn`'s own refusal (plus a CONTROL proving `role:"worker"` is correctly
   excluded, since it is not a `TRANSCRIPT_ROOT_DENY_ROLES` member).

## Residual risk — NOT closed by this card (carded separately by the manager)

**A codex WORKER can `cat` another session's plaintext `--mcp-config` secret file out of
`<LOOM_HOME>/tmp/settings/` right now, and the loud `settingsDirReadDeny` disclosure (now routed via
`onCodexIsolationGapDisclosed`, never into the affected session's own input) does not prevent that** — it
only names the gap, to the manager, once per lineage. The real fix (per-session directory isolation/ACLs,
or not persisting a plaintext secret readable across sessions in the first place) is its own card,
deliberately not built here.

The worker per-other-project transcript deny (item 3) was already a disclosed, best-effort, fail-open
deny-list before this card (`d78f8217`'s own record: "FAILS OPEN on anything not enumerated... NEVER a
structural guarantee"); losing it entirely on codex is worse in degree, not in kind — still only
disclosed, not closed, by this card.

## 2127d695 (follow-up) — the parentless-recipient case this mechanism's "nowhere to send it" caveat anticipated

`handleCodexIsolationGapDisclosed`'s `nudged = !alreadyNudged && !!s?.parentSessionId` already anticipated
a parentless session having nowhere to send its nudge (see this record's own "Do not" item on
`detail.nudged:true`). Card `2127d695` found the first role where that actually occurs in practice: a
`"run"` session (`startRun`, `sessions/service.ts`) is parentless by design AND reachable on codex, so its
`settingsDirReadDeny`/`permissionDeny` disclosures land as a durable `nudged:false` row nobody is pointed
at — no manager to nudge, and no web UI surfaces this event kind. Ruled legitimate/accepted as-is (not a
bug, and not fixed on that card) — see `docs/decisions/2127d695-codex-run-sessions.md` for the full ruling,
the two rejected options, and why a `"run"`-scoped delivery fix was declined in favor of a future,
UI-surfacing card that benefits every parentless session.

## Do not

- Do not read `docs/decisions/37310431`'s "Codex harness — no change needed" section as covering anything
  but LOOM_HOME **writes** — it does not address reads, and this record is what covers the read side.
- Do not attempt to map `permission.deny` onto codex's `[permissions]` profile system while
  `createCodexPty` still passes `-s workspace-write`/`-a never` as CLI flags — codex's own docs state the
  two mechanisms are mutually exclusive; the older flags win whenever present. Don't "fix" this by adding
  a `-c default_permissions=...` override alongside the existing flags — verified ineffective.
- Do not treat `validateProfile`'s role-keyed reject as sufficient on its own — it is BYPASSABLE (an
  explicit-role start can hand a profile a different resolved role than the one it was saved with). The
  `resolveAgentSpawn` role-based force is the real, structural guarantee; the validator is only the early
  UX layer for the common case.
- Do not key the role-based force off the PROFILE's own `role` field — key it off the RESOLVED session
  `role` (the one actually used to construct the spawned session), which is what an explicit-role start
  can make diverge from the profile's stored role in the first place.
- Do not assume `validateProfile`'s hard-reject (`codexTranscriptRoleUnsupportedError`) only fires on a
  FRESH `{role, harness:"codex"}` assignment — it fires on a CARRY-FORWARD role too (e.g. an existing
  auditor/workspace-auditor profile, per card `71bcb207`'s own update path), not just a fresh one: the
  hazard is the harness+role combination itself, independent of how the role got there.
- Do not add a `Session.harnessRoleForced`-style PERSISTED row field — the force is a per-spawn
  RECOMPUTATION (`resolveAgentSpawn`'s own return value), and the durable audit trail is the
  `harness_role_forced_claude` EVENT, not a row column.
- Do not fold `onCodexIsolationGapDisclosed`'s items into `onCodexUnsupportedCapability` — the latter's
  recipient delivery reaches the affected session's own turn input; the former must never do that. Keep
  them as two genuinely separate events/handlers, not a shared one gated by an item-type check.
- Do not dedupe the MANAGER-side isolation-gap nudge by session id (a resume reuses the same session id
  trivially) OR by `agentId` (ROUND 3 CORRECTION: agentId is the agent DEFINITION, shared by every session
  ever spawned from it, not a recycle lineage — see item 7 above) — dedupe by `(lineageRootId, itemsKey)`
  via `Db.hasNudgedEventForLineageItems`, gated on a PRIOR `nudged===true` row specifically, never mere
  existence. Do not skip filing the DURABLE event on a later spawn just because the nudge was already sent
  once — the durable row still fires every spawn; only the nudge is gated. Do not record
  `detail.nudged:true` when there was no recipient to send to — compute it as
  `!alreadyNudged && !!parentSessionId`, honestly, or a parentless occurrence wrongly suppresses a later
  managed one.
- Do not read `.deny` off `opts.permission` without a `?? []` guard — `PermissionPolicy.deny` is
  non-optional on the real type, but a plain-JS test double can still omit it, and an unguarded read
  crashes `createCodexPty` entirely before it ever reaches the capability-drop report below it in the
  method — this silently breaks an unrelated test file's own assertions with no obvious connection to the
  real cause.
- Do not treat `settingsDirReadDeny`/`transcriptRootReadDeny`/`workerProjectTranscriptDeny`/`permissionDeny`
  as closing anything — they are spawn-time disclosure only, never an enforcement lever; `createCodexPty`
  still never ENFORCES `opts.permission` for any purpose, structural force aside.
- Do not fork a second copy of `TRANSCRIPT_ROOT_DENY_ROLES` — it lives in `profiles/codex-compat.ts`;
  `pty/host.ts` re-exports the SAME binding. A hand-copied second list is exactly the drift CLAUDE.md's
  "point at a source of truth" rule exists to prevent.
- Do not widen the workerProjectTranscriptDeny disclosure to fire when `getOtherProjects()` returns empty
  — report only what was ACTUALLY dropped; an empty-list case drops nothing.
- Do not add a `Session.permissionDeny` row field — `recycleHarness` re-derives it LIVE from the project's
  current `resolveConfig(...).permission.deny` at every call site instead, since it can change between
  spawns and (unlike restrictedTools/browserTesting/documentConversion/capabilities) was never a row field
  to begin with.
- Do not treat the "zero existing rows affected" finding as a standing guarantee — it was true at the time
  this card was measured (a read-only DB copy, never the live path); re-check before relying on it again.
- Do not assume `recycleHarness`'s own `codexIncompatibilities` branch (restrictedTools/browserTesting/
  documentConversion/capabilities/permissionDeny, for the two roles — manager and platform — that ever
  call it) still does anything useful post-fix: the role-force now ALWAYS redirects `spawn.harness` away
  from `"codex"` before `recycleHarness` ever sees it for these two roles, so that branch is genuinely
  unreachable via any real caller today. Left in place deliberately (harmless, and a second layer should a
  future role ever reach `recycleHarness` without being a `TRANSCRIPT_ROOT_DENY_ROLES` member) — do not
  read its continued presence as proof it still fires for manager/platform. **This does NOT extend to
  `recycleHarness`'s `!spawn` (agent-missing) branch** — that one IS reachable (an agent row can genuinely
  go missing) and, per round 3's ruling 1(c), now correctly forces claude there too; the two branches are
  independent, and only the `spawn.harness === "codex"` one is dead.
- Do not reintroduce the false claim that resolveAgentSpawn's role-force alone makes every bypass
  unreachable — `resume()` and `recycleHarness`'s agent-missing fallback do not call it, and were real,
  separate bypasses closed only by round 3's items 6(a)/(b)/(c) above (the fail-closed `PtyHost.spawn`
  backstop, `resume()`'s own graceful redirect, and the agent-missing force respectively).

## Source

Investigation: this worker's `blocked` checkpoint report for card `7955458e` (root-cause verification,
live codex-docs fetches, the mutual-exclusivity finding); a Code Reviewer's CRITICAL + MAJOR findings on
the first build (the bypass proof, the recipient-leak proof) drove the round-2 changes above.

Implementation: `packages/daemon/src/profiles/codex-compat.ts` (`CodexCompatInput.permissionDeny`,
`codexPermissionDenyReason`, `TRANSCRIPT_ROOT_DENY_ROLES`, `codexTranscriptRoleUnsupportedReason`,
`codexTranscriptRoleForcedClaudeReason`, and round 3's `codexRoleSpawnRefusedReason`/
`CodexRoleSpawnRefusedError`), `packages/daemon/src/profiles/validate.ts`
(`codexTranscriptRoleUnsupportedError`), `packages/daemon/src/pty/host.ts` (`createCodexPty`'s
`unsupportedItems` vs. the separate `isolationGapItems`, `onCodexIsolationGapDisclosed`; round 3's
fail-closed refusal inside `PtyHost.spawn` itself, ruling 1(a)), `packages/daemon/src/sessions/service.ts`
(`resolveAgentSpawn`'s `rawHarness`/`roleForcesClaude` force, `recordHarnessRoleForced` [round 3: `trigger`
widened to include `"resume"`], `handleCodexIsolationGapDisclosed` [round 3: lineage+itemset dedup],
`recycleHarness` [round 3: the `!spawn` branch forces claude too, ruling 1(c)], round 3's
`resumeForcedRoleAsFreshClaude` [`resume()`'s own graceful redirect, ruling 1(b)], and the 8 call sites
listed in Decision item 3), `packages/daemon/src/db.ts` (`DURABLE_AUDIT_EVENT_KINDS`; round 3 replaced
`hasEventForAgent` with `hasNudgedEventForLineageItems`, and added `setSessionHarness`, the one deliberate
write-once exception used only by `resumeForcedRoleAsFreshClaude`), `packages/daemon/src/index.ts` (the
`onCodexIsolationGapDisclosed` wiring), `packages/shared/src/types.ts` (`"harness_role_forced_claude"` and
`"codex_isolation_gap_disclosed"` event kinds).

Tests: `packages/daemon/test/codex-fleet-switch-guard.mjs` (permissionDeny pure matrix + the `pPD`
default-skip spawn scenario), `packages/daemon/test/recycle-harness-reresolve.mjs` (the "(M1)"/"(M4)"/
"(S)"/"(PD)"/"(P1)" sections, rewritten round 2 to assert the FORCED-to-claude outcome and
`harness_role_forced_claude` instead of the old codex-landing one; round 3 flipped "(M3)"/"(P3)" — the
agent-missing cases — from asserting a codex landing to asserting the claude force + the event, per
ruling 1(c)), `packages/daemon/test/codex-permission-deny-disclosure.mjs` (sections 1–4: the real
`createCodexPty`'s separate disclosure report incl. permissionDeny; section 5, rewritten round 3 for the
lineage+itemset dedup: a distinct-task worker of the same agent is nudged as its own lineage, a true
resume/recycle of the same lineage+item-set is deduped, a NEW item on the same lineage is nudged again, and
a parentless first spawn never suppresses a later managed spawn of the same lineage), `packages/daemon/
test/profiles.mjs` (the hard-reject validator block), `packages/daemon/test/harness-drain-status.mjs` and
`packages/daemon/test/harness-switch-now.mjs` (both rewritten round 2: the OLD "manager blocked by
codexIncompatibilities" fixture is now structurally unreachable — these two files instead prove a
pre-existing codex-pinned manager/platform row now shows as PENDING, never blocked, and drifts back toward
claude), and round 3's new `packages/daemon/test/codex-role-force-start-matrix.mjs` (the end-to-end
regression matrix: every explicit-role start path, `startNew`(assistant), the Setup surface's
`session_spawn`(manager), `resume()` agent-present/agent-missing, and `PtyHost.spawn`'s own refusal — see
Decision item 9).
