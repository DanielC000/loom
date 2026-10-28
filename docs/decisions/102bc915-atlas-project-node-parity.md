# 102bc915 — closing the Atlas project node's parity gaps with the classic `/overview`

Card `102bc915` (epic `9fe8cd4e`), from the audit card `a61d5bc4` filed. `/overview` stays URL-only under Atlas until the owner-gated switch-over (card `3449fb54`, `@decision fd99b2d7`), so anything the classic page carries and no Atlas node does would be dropped SILENTLY the day it retires. The audit named four gaps. Three were built; the fourth was dropped on evidence, which this record exists as much to carry as the three.

The card was run INVESTIGATE-FIRST: every placement below was measured off the built app before anything was written, and the measurements are in this record because two of the four verdicts turn on them.

## The 1440 measurement, and why it decides two of the four

MEASURED at 1440×1000 on the built app (tree rail present, content column 1156px), via a throwaway spec on the e2e fixture daemon:

| Element | top | width | height |
|---|---|---|---|
| tab row | 106 | 1156 | 35 |
| KPI deck | 155 | 1156 | 91 |
| disclosure bar | 260 | 1154 | 33 |
| band (unfolded) | 303 | 1156 | 320 |
| board embed | 637 | 1156 | 359 |
| board grid | 793 | 1156 | 202 |

**The band's five tracks measure `283.9 / 244.7 / 195.8 / 195.8 / 195.8 px`.** `ProjectHome.tsx` and `atlasHome.tsx` both claimed "a band column is ~250px"; that figure was taken at 1600 and both comments are corrected in this card. The tracks are a fixed `fr` template (`minmax(0,1.45fr) minmax(0,1.25fr) repeat(3, minmax(0,1fr))`), so every one of them is a function of the content column — re-measure at the width you care about rather than carrying a remembered number.

Two consequences, each decisive below:

- **A sixth band panel is not additive.** Injecting a sixth track at 1440 takes the five to `239.3 / 206.3 / 165.1 / 165.1 / 165.1` — every existing panel shrinks. There is no such thing as "adding a panel to the band"; there is only "resizing all of them".
- **A band panel absorbs any row count at zero page cost.** `.loom-bandpanel` is a fixed `height: 320px` and `.loom-bandbody` is `overflow-y: auto`. Cloning the Pulse body from 6 to 100 rows moved `bodyScrollH` 243 → 2308 while the band height, the board's top, the board's width and the document height each moved by **exactly 0px**.

The tab row has room too: nine chips total 548px in a 1156px row, one line, with the `More` overflow trigger not showing — ~608px of slack.

## Gap 1 — project-scoped schedules: BUILT, on the Agents tab

Classic `/overview` renders `ProjectSchedules` inline. Under Atlas no project-tier surface carried schedules at all: the only one that does is `/automation`, which is god-eye across every project AND is a WORKSPACE node tab (card `41eab0eb`), so it is the wrong tier twice over.

It lands on the **Agents tab**, not a band panel and not a tab of its own:

- A `Schedule` is keyed to an AGENT (`s.agentId`), and `ProjectSchedules` filters by this project's agent ids. The Agents node is already the surface that owns the things schedules are about.
- A sixth band panel would have shrunk all five existing panels (above). The Agents tab costs the default Overview tab **nothing** — no geometry on it moves at all.
- A tab of its own would FIT (608px of slack), but `/automation` is already claimed as the workspace tab's `from`, so a project one needs a brand-new Atlas-only address, and `@decision 25c08fba` forbids re-addressing a project tab as `?tab=` on `/project`. Real structural cost for no gain over the Agents tab.

`ProjectSchedules` and `ScheduleRow` were LOCAL to `pages/Overview.tsx`. They moved verbatim to `components/projectSchedules.tsx`, which Overview now imports — a pure extraction, same JSX, same props, same query, so the classic page's render is byte-identical and the two mounts cannot drift into two ideas of what "this project's schedules" means. Duplicating ~35 lines instead was the alternative and was rejected as exactly the shared-unit divergence this card was told to avoid.

The id set on the Agents tab is the **roster union** (`roster.spawnable` ∪ `roster.workers`), not a second `api.agents` read: `useAgentRoster` partitions every one of the project's agents into those two lists, so the union IS the set Overview builds from `agents.data` — same membership, no extra request, and it cannot drift from the roster rendered directly above it.

## Gap 2 — the archived fold-in with inline Resume: DROPPED, and why

The audit asked for classic Overview's fold-in of the 10 most recent archived sessions into the Fleet band, with an inline Resume. Not built. Three reasons, in the order they actually decide it:

1. **The fold-in is instrumental to the inline Resume, not content in its own right.** `Overview.tsx`'s own comment says so: it folds archived rows in *"so SessionActions' Resume has a row to act on (finding #15)"*. Remove the inline Resume and the fold-in has no purpose left to serve.
2. **The inline Resume does not fit.** MEASURED on the real classic `/overview` at 1440, a manager's action cluster (`End Session` + `Fork` + `Stop`) is **215px** and a worker's (`Fork` + `Stop`) is **108px** — against a **195.8px** Fleet band column. The manager cluster is wider than the whole column with nothing left for the session name, and those rows already ellipsise at this width. `@decision c2968651` hit the same wall at ~300px and resolved it with a second line; at 196px a manager row would need three. `FleetList`'s own rule — a band panel is a status read, and the exits carry the reader to the real control — is not a preference here, it is what the width permits.
3. **A `N live` count must not lie.** The Fleet panel is headed `N live`. Folding archived rows under that head makes the head false.

Resume for an archived row already has an Atlas home one click away: the **Archive tab**, whose chip carries the live server-side `total`, and whose `api.restoreSession` routes through `resume({ allowSuperseded: true })` daemon-side (`gateway/server.ts`) — functionally the same call `Overview`'s `api.resumeSession` makes, plus search, pagination and Delete.

## Gap 3 — the in-place cockpit and per-row actions: SPLIT, and only ONE thing was actually at risk

The audit frames this as "the actions are one tab away". For four of the five that is true and fine. For the fifth there was no tab at all.

Traced with a positive control (the same grep shown returning a hit on the known-present declaration file):

| Action | Atlas home before this card |
|---|---|
| Fork | `SessionNode`, `SessionView`, `Terminals` — survives |
| Stop | the same, plus `PlatformSessionTile` — survives |
| Resume | the Archive tab (above) — survives |
| Clear rate limit | `fleet.tsx`'s `ClearRateLimitButton` inside an `AttentionRow` — survives, and is better placed there: it renders only when a rate-limit attention item exists |
| **End Session** | **none** |

`SessionActions.tsx` is the only "End Session" button in the web UI, `Overview.tsx` was its only mount, and `useEndSession` had exactly one consumer. **Retiring `/overview` would have removed End Session from the product**, and nothing in the audit would have caught it, because the audit asked which TAB each action was on rather than whether it had one.

It now rides the session node, through TerminalCard's **existing** `actionsExtra` slot (`Terminals.tsx`'s kill cluster is its other user), so `TerminalCard` itself is untouched. The gating is SHARED, not re-expressed: `canEndSession` and `EndSessionButton` are exported from `SessionActions.tsx` and both mounts read them. The predicate is typed on the two fields it reads rather than on `Session`, so the node's narrower `SessionNodeRow` satisfies it without a cast.

The split between the two halves of the gating is deliberate: `canEndSession` owns role + liveness (it HIDES), the button owns busy (it DISABLES). An idle-gated control that vanished mid-turn would read as broken.

The **in-place cockpit** itself is not built and is not a gap: the session node IS that cockpit, reached from the tree's session rows (card `3b563642` made them entities) and from every `FleetRow` link. "In place" versus one click to the node is navigation depth, not lost capability, and Atlas's own IA premise is that a session is a node.

## Gap 4 — activity depth: BUILT, and the cap was the small half

Two separate things were wrong, and the audit only found the smaller one.

**(a) The cap.** `ProjectHome` sliced its Pulse at a local literal `40` while classic `/overview` showed 100. It now reads `GLOBAL_ACTIVITY_CAP` (`lib/fleet.ts`), the same constant Mission Control's Activity column and the workspace node's Pulse already read — so there is no second number left to drift. Free, per the measurement above: the panel absorbed 100 rows at 0px.

**(b) The real defect.** `ProjectHome` polled `liveManagers` ONLY, so an exited-but-unarchived manager's events were reachable **nowhere on the project tier**, while classic `/overview` (which reads every non-archived manager) still showed them. That is the same gap card `ef86b089` found and closed on the WORKSPACE node — and it was left open one tier down. Losing a whole class of manager is worse than losing older events, so this half would have been worth building even without (a). The fix reuses `pulseExitedManagers` / `PULSE_EXITED_REFETCH_MS` / `PULSE_EXITED_MANAGER_CAP` verbatim; `ef86b089`'s record owns that policy and this card does not relax any of it. See the section appended to that record.

**(c) "Always visible versus inside the disclosure" is NOT a gap.** That is the owner's own D1 pick on request `fb8de852` (`@decision 44f725fe`), whose record already names the cost in its own words — *"a folded band stops showing the Pulse feed ambiently"* — and whose prohibitions forbid changing the first-visit default without him. Closing it would have contradicted a live owner decision.

## What the e2e actually proves, and one thing it cannot

`packages/web/e2e/atlas-project-parity.spec.ts`, six legs, four switch-ON and two switch-OFF. MEASURED control: with the six source files reverted to the pre-card tree and rebuilt, **all four ON legs go RED and both OFF legs stay GREEN** — a split, which is what proves the ON legs separable rather than a dead fixture. All seven files restored byte-identically afterwards (md5 7/7).

### What each leg is the witness for

1. **Schedules on the Agents tab — BOTH polarities of the same tab, in one run.** The empty state's pointer is CLICKED and must resolve to `/home?tab=automation` (under Atlas `/automation` is a workspace node tab, so asserting the RESOLVED address rather than the href is what proves the pointer reaches a real surface and not a dead path); then a schedule is seeded and the tab must show its cron row with the pointer gone. A panel that always rendered its populated form, or always its empty form, fails one half or the other. It also asserts the agent ATTRIBUTION, which is the half that fails if the id set were built from the wrong roster — e.g. `spawnable` only, silently dropping every worker rig's schedule.
2. **End Session on the session node.** The button is CLICKED and the round trip is asserted (see below for what that does and does not establish). Its ABSENCE legs are the other polarity and matter more: a WORKER's node must not offer it — a human must never end a worker out from under the manager that dispatched it — and neither must an EXITED session's.
3. **The Pulse's exited-manager tier.** An exited-but-unarchived manager's event must appear in the project node's Pulse, alongside a LIVE manager's, so the two tiers are shown to COMPOSE rather than one replacing the other. Classic `/overview` is the positive control: without it, a zero in the band would not distinguish "the band is blind" from "the seeded event does not render anywhere".
4. **Switch OFF.** The classic shell is untouched — `/overview` still renders its own Schedules section and the same exited manager's event, and the Atlas-only testids do not exist.

Presence-first throughout (card `625d791c`): a leading `toHaveCount(0)` is satisfied by a page that is merely still loading, so every pair asserts what must BE there before what must not. The control run proves that is not theatre — leg 2's absence half went RED pre-card precisely because its presence control (End Session visible on a manager's node) could not pass.

Two traps the legs are written around, both found the hard way:

- **`EventRow` renders no part of `detail`.** A row is time + kind + `w:<workerSessionId.slice(0,8)>`, so a sentinel passed as `detail.branch` is invisible and the leg fails against a working feed. The sentinel must be the event's WORKER ID and exactly 8 characters.
- **Assert the ROW, never the sentinel's own text node.** `EventRow`'s detail span is `flexShrink: 100000` with an ellipsis, and a Pulse band column is 195.8px — the span carrying the sentinel is routinely squeezed to ZERO WIDTH and reports `hidden` while the feed works perfectly. Measured: `toHaveCount(1)` passes on the very render where `toBeVisible()` on that span fails.

**What the End Session leg does NOT prove.** The daemon hands the wrap-up turn straight to the pty: MEASURED, `POST /end` answers `{delivered:true, deliveryState:"handed-off"}` and `/queue` reads `{pending:[]}` both before AND after, in both busy states — so the queue is not a witness, the turn never rests there. And no real agent runs in a hermetic fixture, so nothing can execute `/loom-session-end` + `end_me` and actually retire the session. The leg therefore asserts the round trip: a real click issues the real write and the daemon reports the turn handed to that session's pty. That is the claim that fails if the button is rendered but unwired, which is the defect worth catching; it is not a claim that the session ended.

One sibling test needed updating, and the reason generalizes. `mission-control-archived.mjs` asserted that two files slice with the constant and not a literal, and used **`ProjectHome.tsx`'s own literal 40 as the positive control** for that absence-shaped pattern. Fixing `ProjectHome` made that control vacuous — and the build caught it, correctly. The control is now a synthetic sample plus a negative sample, so it cannot rot again: a control that lives on a real file's defect dies exactly when the defect is fixed, which is when the suite still needs it.

## Do not

- **Do not add a sixth panel to the project node's band.** It is a fixed five-track `fr` grid: a sixth track shrinks all five (measured, 195.8 → 165.1 at 1440). A new project-scoped readout goes on the tab that owns its subject, as the schedules panel did.
- **Do not re-fork `ProjectSchedules`, and do not give it create / enable / delete.** One implementation, two read-only mounts; `/automation` owns the writes and the builder.
- **Do not put the `SessionActions` cluster in a band panel.** A manager's cluster is 215px against a 195.8px column. This is a measurement, not a taste call — re-measure before re-litigating it.
- **Do not re-express "live and not a worker" anywhere.** Both End Session mounts read `canEndSession` and render `EndSessionButton`. A second copy is how one surface keeps offering it after the other stops — which is the exact shape that left `/overview` as the only mount in the first place.
- **Do not fold the archived sessions into the Fleet band** without also solving the 195.8px Resume and the `N live` head. The Archive tab is the home for both.
- **Do not relax `ef86b089`'s cap or its 60s interval** when touching the project Pulse. This card reuses that policy; it does not own it.
- **Do not use a real file's current defect as a positive control.** Assert the pattern against a synthetic sample, or the control dies the moment someone fixes the file it was pointing at.
