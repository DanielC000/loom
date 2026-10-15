# be9cb999 — `migrateSetupHomeToLead`'s four-way resolution order + the Lead-marker stamping rule

Child card C5 of epic `f437d4e9` (seed the end-user Platform agent as a Lead and migrate existing
installs). Full spec: `docs/decisions/f437d4e9-end-user-platform-lead.md` §4, §5 C5.

## Round 2 correction (lockout) — read this before the four cases below

The original case 4 ("no agent at all under `SETUP_AGENT_NAME`") was written as if a RENAME could never
reach it ("a rename is a deliberate user edit; it still resolves normally… failing only when the name
genuinely doesn't match") — but a rename, by definition, changes the name, so `db.listAgents(home.id)
.find(a => a.name === SETUP_AGENT_NAME)` necessarily stops matching the renamed agent and falls into
case 4 anyway. Case 4 never stamped the marker — so a renamed-or-deleted marker agent left a **permanent
lockout**: no agent the marker could ever point at again, even after the user manually rebound a
different (or the same, renamed) agent to the Platform-lead profile.

**The fix:** the home's operator agent is now found via the shared `resolveHomeLeadAgent` helper
(`projects/live-lead-home.ts`), not a bare name lookup. It tries, in order: (1) the stable id marker, (2)
the **lockout-repair fallback** — the single agent in the home bound to a platform-role profile, if there
is exactly one — re-stamping the marker onto it, and (3) a plain name lookup (`SETUP_AGENT_NAME`),
regardless of role, backfilling the marker. This closes the lockout: a user who renames/deletes the
marker agent and then manually rebinds a platform-role profile onto some agent in the home is resolvable
again on the next call, with no second manual step.

## Round 3 correction (N1) — step order matters, not just "any agent"

The sentence above used to read "...manually rebinds ANY agent in the home to a platform-role profile is
resolvable again..." without saying WHICH step finds it, and the original code ran the plain name lookup
*before* the lockout-repair fallback. That ordering has a real failure mode: a STRAY agent that merely
happens to share `SETUP_AGENT_NAME` ("Platform") but is **not** platform-role-bound (e.g. a fresh,
never-migrated duplicate, or one the user created unrelated to the original operator) would be found by
the name step and returned — **shadowing** a genuinely rebound-but-differently-named agent that the
lockout-repair fallback would otherwise have found correctly. The fix reorders the steps: lockout-repair
(2) now runs **before** the plain name lookup (3), so a correctly-opted-in agent (wherever it's named)
always wins over a same-named impostor. The "rebinds ANY agent" framing above is still accurate — it's
the ORDER that was wrong, not the outcome for the common case (no stray same-named agent).

## The four cases, per the home's own operator agent (resolved via `resolveHomeLeadAgent`)

1. **Already role `"platform"`** — a fresh install already seeded the Lead shape directly
   (`seedSetupHome`), or a prior boot already migrated it. Nothing to change; just make sure the Lead
   marker (`SETUP_HOME_LEAD_AGENT_ID_KEY`) points at this agent's id (covers an install that upgraded
   before the marker existed).
2. **Pristine match** (Decision 4 of the parent spec, success path) — bound to the bundled "Setup
   Assistant" profile (role `"setup"`) AND `startupPrompt` byte-identical to `SETUP_ASSISTANT_PROMPT` OR
   any of the four historical shipped values (`SETUP_ASSISTANT_PROMPT_PRIOR_VALUES`, round 2 item 3).
   Rebind to `"Platform-lead"`, overwrite the prompt with `PLATFORM_LEAD_OPERATOR_PROMPT`, and stamp the
   Lead marker onto this agent's id. If the `"Platform-lead"` profile isn't seeded yet, bail WITHOUT
   stamping the one-shot migration key (round 2 item 9) — retry cleanly on a later boot.
3. **Customized / non-match** (Decision 4, offer-card path) — the prompt was edited, or the profile was
   rebound to something else. File the one-time upgrade-offer board card (never auto-apply — that would
   be exactly the clobber the parent card forbids).
4. **No agent resolvable at all** (`resolveHomeLeadAgent` and the name lookup both return nothing — the
   agent was renamed with no platform-role rebind yet, or deleted outright) — file the generic offer
   card. The Lead marker is **not** stamped (there is nothing to point it at) — but a user who then
   rebinds any agent in the home to a platform-role profile is no longer locked out (see the fix above).

## Round 1 interim UX gap, resolved by documentation (not a code change)

Round 1's Code Review asked: a user who assigns the now-ungated "Platform-lead" profile to an arbitrary
(non-Lead) agent gets a PLAIN session from `startNew` (the profile role confers nothing — should the
Profiles UI/validator stop offering it for assignment to non-Lead agents, or is this harmless?

**Resolved: harmless, documented here rather than restricted.** Two independent reasons, both already
proven elsewhere in this epic:
1. `startNew` never resolves `role:"platform"` from a profile at all — `PROFILE_SPAWNABLE_ROLES`
   structurally excludes it (card f437d4e9 C1's own enumeration). Binding the profile to an arbitrary
   agent produces, at most, a `role:null` plain session — no elevation.
2. Even an EXPLICIT `startPlatformLead` call against that same arbitrary agent is refused by this card's
   own Decision 5 guard (`isSanctionedPlatformLeadAgent`) — binding the profile is not binding the
   marker, and the marker (plus the agent's CURRENT profile role) is what the guard actually checks.
So assigning "Platform-lead" to a non-Lead agent is doubly inert: no implicit path produces an elevated
session, and the one explicit path that could is independently gated. No Profiles UI/validator change is
needed.

## Round 3 (J1/M1) — the live-Lead singleton must ALSO hold across resume(), not just the start path

Round 2's singleton lived only in `startPlatformLead`, keyed on the raw DB `processState` flag. Two gaps:
repro — start A, hard-stop A, start B (the singleton allows this, A isn't live), then `resume(A)` — minted
TWO live Leads, because `resume()` had no equivalent check at all. And the start-path check itself could
misfire on a phantom-live row (`processState==="live"` disagreeing with the real pty) just like the
`SETUP_SESSION_RESUME_BARRED_ERROR` sibling check already warns against (decision 39b58667).

**The fix:** `liveOtherPlatformLead(db, isAlive, excludeSessionId?)` (`projects/live-lead-home.ts`) is the
ONE "is there a DIFFERENT live Lead" check, keyed on VERIFIED pty liveness, shared by `startPlatformLead`
AND `resume()`. `!db.hasSuccessor(s.id)` still excludes a `recyclePlatformLead` predecessor mid-handoff
(its real pty can stay alive a few seconds into the deferred hard-stop even after the DB row is retired)
— that brief two-row window is sanctioned and must never trip this check.

## Round 3 (M2) — the web shell's role resolution has a load-race window

`PlatformView.tsx`'s `operatorSpawnRole` reads the operator's bound profile role from a `profiles` React
Query that can still be loading when the page first renders. While it's unresolved, `roleOf()` returns
`null` — which the role-resolution logic used to read as "not platform, so setup", meaning a click during
that window could mint a `role:"setup"` session on what is actually the real platform-role Lead agent.
**Fixed** by `resolveOperatorSpawnRole` (`platformEdition.ts`) taking an explicit `profilesLoaded` flag
and returning `spawnDisabled:true` while unresolved — the caller threads this into the Start button's
disabled state, never into a guessed role value.

## Do not

- Do not skip stamping `SETUP_HOME_LEAD_AGENT_ID_KEY` in the customized (case 3) branch just because the
  agent wasn't actually upgraded. `startPlatformLead`'s Decision-5 "exactly one Lead" guard checks this
  marker by **id equality** — if a customized user later follows the offer card and manually rebinds this
  SAME agent to `"Platform-lead"`, but the marker was never stamped for it, `startPlatformLead` would
  wrongly refuse the one agent the whole upgrade path exists to allow. The marker identifies "the home's
  operator agent" as a stable anchor, independent of whether its profile/prompt happen to match the
  pristine shape at any given moment.
- Do not derive "already offered" from the board (a user closing or deleting the card must not cause it
  to resurface) — always gate on `SETUP_LEAD_UPGRADE_OFFER_CARD_KEY`, never re-scan the board state.
- Do not have `seedSetupHome`'s fresh-seed path skip stamping the Lead marker — a fresh non-dev install's
  directly-seeded Lead must be immediately resolvable by `startPlatformLead`'s guard with no dependency on
  this migration ever running.
- Do not widen `resolveHomeLeadAgent`'s lockout-repair fallback (now step 2) beyond "exactly one agent in
  the home bound to a platform-role profile" — zero or several candidates must resolve to nothing rather
  than guessing; see that function's own doc for the full resolution order.
- Do not move the plain name lookup (step 3) back ahead of the lockout-repair fallback (step 2) — that
  reopens the round-3/N1 shadowing bug (a same-named-but-not-platform-bound agent masking a genuinely
  rebound one).
- Do not key `liveOtherPlatformLead` (or any future "is there a second live Lead" check) on the raw DB
  `processState` flag — verified pty liveness (`isAlive`) is load-bearing, same rule as decision 39b58667's
  setup-singleton sibling.
- Do not let a web role-resolution helper return a guessable role for "unknown/not loaded yet" and expect
  the caller to notice — return an explicit disabled/unknown signal (`spawnDisabled`) instead; a fallback
  role value is for rendering only, never meant to be spawned with.
