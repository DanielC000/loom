# effd47d5 — the Atlas project Overview's roster lists all running agents, or only the ones you spawn

Card `effd47d5` (parent `16106aaf`, the owner's 2026-11-03 Atlas feedback round). His words, verbatim, under Projects › tab "Overview":

> "Optionaly show either only tarminals of spawnable agents or teminals of all running agents. Adjustable by user preference."

## What this landed on, and the one thing it is not

The card was written against the Overview as it stood on 2026-11-03. Card `269f46ef` rebuilt that tab the next day (brief line → Needs you → work-in-flight roster → board lanes → Pulse), so the first job was to establish where agent sessions appear on the page now.

**They appear in one place: the "Work in flight" roster, which is a TABLE of sessions.** It draws a row per non-archived manager and worker — state, card, branch, context, last event, and an `Open ↗` into that session — and it mounts no terminal. Neither did the page it replaced: the old tab's Fleet panel was a row list and its Agents panel was a spawn roster. `components/atlasProjectOverview.tsx` has no `TerminalCard` import, and `pages/ProjectHome.tsx` mounts one only inside the re-homed **Sessions** tab body (`pages/Terminals.tsx`).

So the preference shipped here governs **which agents' sessions the roster lists**, which is the part of the owner's sentence this surface can answer. ⚠️ **His word was "terminals", and this page has none** — see "Still open" at the bottom. No terminal area was added: `269f46ef` removed furniture from this tab on his own instruction, and re-adding a live-pty surface is a design decision of its own, not a side effect of a filter.

## The preference

| | |
|---|---|
| values | `"all"` (every manager and worker row — the pre-card behaviour) · `"spawnable"` (only rows whose agent a human may start by hand) |
| default | **`"all"`** |
| stored | `localStorage`, `loom.overviewRoster.<projectId>` |
| control | `RosterScopeToggle` → the kit's `Segmented`, in the card's head, testid `atlas-roster-scope` |
| pure part | `filterRosterRows` / `parseRosterScope` / `DEFAULT_ROSTER_SCOPE` in `lib/atlasProjectOverview.ts` |

The store is the one the Sessions tab's own tile layout already uses — `localStorage`, per project, in the same `<area>.<field>.<projectId>` shape as `loom.sessionsLayout.<id>` (`lib/terminalLayout.ts`, card `ac0cfe91`) — and the read/write pair sits at the bottom of the lib for the same stated reason that file gives: so the key shape has exactly one home. Per project because which agents are worth watching is a fact about one project's fleet: a project whose work is all dispatched to workers wants the opposite answer from one run by hand.

### The default is `"all"`, and the card guessed otherwise

The card says `"spawnable agents only" (today's behaviour, confirm first)`. **Confirmed against the code it was written about: it is not.** The table's rows are `rosterRows(managers, workers)` over every non-archived manager **and** worker, so the page already lists the dispatched workers. Defaulting to `"spawnable"` would silently hide rows from every existing reader on upgrade — a change nobody asked for — so the filter is opt-in and `packages/web/test/atlas-project-overview.mjs` pins the default.

### "Spawnable" has exactly one definition in this app and this is not a second one

It is `splitRoster`'s (`lib/atlasAgents.ts`): an agent whose bound rig's role is not `worker`. That file's header states why there is one derivation — "so the three can never disagree about which agent is spawnable" — and the Agents tab already states the split in words ("3 you spawn, 2 your manager dispatches"). `filterRosterRows` therefore takes that **agent-id set as an argument** instead of re-deriving the predicate from a session's own `role !== "worker"`.

The two agree on every ordinary fleet. They diverge exactly where the app itself has changed its mind — an agent re-bound to another rig after its session started, which project memory already records as reachable for the picker (`atlas-sessions-quick-start-f3b18f27`) — and there the one authoritative answer is the one the rest of the UI is showing. Taking the set as an argument also means a future fix to that definition fixes this surface for free.

### `null` is "not known yet"; an empty set is an answer

`splitRoster` answers a missing agent list with an **empty** roster, and a missing profile list by reading every role as `null` (so every agent looks spawnable). Either state, passed through as the real set, makes the page *state* something false while it is merely loading — "no agent you spawn has a session here" over a live fleet, or dispatched workers listed under a filter that says it hides them.

So `ProjectHome` passes `null` until **both** `agentsQ.data` and `profilesQ.data` have landed, and `filterRosterRows` lists everything for `null` — which is exactly what the page showed one tick earlier. An empty set stays a real answer and filters everything out. Both polarities are tested, because conflating them is the bug.

### A kept worker loses its indent when its manager does not survive

`RosterRow.child` is the table's single level of nesting: "a worker drawn under the manager that owns it". A row that survives the filter while its manager does not would hang that indent off whatever row happens to precede it now, so `filterRosterRows` demotes it. Order is otherwise untouched — a kept row sits where `rosterRows` put it, never re-grouped.

### The head count is left alone; the footer carries the disclosure

The card head still reads `N live · M working`. That is the project's live **fleet**, which is what the `Sessions ↗` exit beside it opens, and restating a filtered figure there would put two populations in one head — the shape card `9b6be377` recorded as "a card reading 3 beside a list showing 2".

What the filter changes instead:

- **the footer**, whose stated job is "the sentence that keeps the card's own label honest" — it gains a leading `Listing only the agents you start by hand; N sessions dispatched by a manager are hidden.` while anything is actually hidden, and says nothing when nothing is;
- **the empty state**, which is now **three** states, not two. A project with no sessions and a project whose sessions are all filtered out are different facts, and reporting the second as the first would tell a reader who just hid four running workers that the project has nothing in flight;
- **the toggle's own labels**, which carry each option's count (`All (2)` / `You spawn (1)`) — so the reading not on screen says what picking it would yield, the same courtesy the Sessions tab's project filter pays with `All (4)`.

### `Segmented`, not a `<Select>`

A `<Select>` is this app's other small-picker vocabulary (`WindowSelect`, the Sessions tab's filters) and it was rejected for one reason: a collapsed select hides the option the reader did not pick, and knowing *which* population is on screen is the whole point of this control. `Segmented` (`components/ui`) is the kit's own single-choice toggle and brings the roving-tabindex keyboard handling with it. `OverviewCard` gained an optional `controls` slot in its head for it; every existing call site is byte-identical.

## Coverage

- **`packages/web/test/atlas-project-overview.mjs`** — 33 checks, 19 of them new: both scopes, the `null`-vs-empty-set pair, indent kept and indent demoted, order preservation, non-mutation, the default, the defensive parse over eleven unreadable stored values, the per-project key, and the storage round-trip against an in-memory `localStorage` stub (plus the throwing-store and corrupted-value paths).
- **`packages/web/e2e/atlas-project-overview.spec.ts`** — two new legs: the toggle changes the listed population **both ways** (and the card says it is filtered), and the choice survives a reload with the per-project key asserted directly.

### The e2e needs rigged agents, and `seedLiveSession` does not bind one

`seedLiveSession` mints its agent with **no profile**, and an agent with no profile has a `null` role, which `splitRoster` reads as *spawnable*. A fleet seeded that way has one population under both scopes and could never fail. `seedRiggedFleet` therefore creates a manager rig and a worker rig over `POST /api/profiles`, binds an agent to each over `POST /api/agents/:id`, and passes those `agentId`s in — the pattern `atlas-agents.spec.ts` already established. The original `seedFleet` is untouched, so the four pre-existing legs keep the fixture they were written against.

The strongest assertion in that spec is the one made **before any click**: the segments read `All (2)` and `You spawn (1)`. A filter that was a no-op would read `You spawn (2)` there and still pass every visibility assertion after it.

## Do not

- ~~**Do not read this card as licence to mount a terminal on this tab.**~~ **SUPERSEDED by card `0bcfa530`**, on the owner's own decision (`925ea659`) — this tab now mounts a terminal list, as its own card under the roster. What still binds is the reason the prohibition existed: a live-pty surface here is the owner's call, not a side effect of a filter, and `269f46ef`'s removals (Board, `KpiDeck`, `BandDisclosure`) stay removed.
- **Do not add a second scope toggle for that card.** One preference drives both surfaces; `0bcfa530`'s record owns that rule.
- **Do not re-derive "spawnable" from `session.role !== "worker"`** in this file or any other. Take `splitRoster`'s agent set as an argument, or this surface becomes a second definition that drifts from the Agents tab silently, in the one case where the app has changed its mind about an agent.
- **Do not pass an empty set to mean "the agent reads have not landed."** `null` is that state. An empty set is the real answer that nothing here is spawnable, and conflating them states an empty fleet over a loading one.
- **Do not flip the default to `"spawnable"`.** It would hide rows from every existing reader on upgrade. If the owner wants that, it is his call to make explicitly, not a tidy-up.
- **Do not restate a filtered row count in the card head.** The head states the project's live fleet, which is what its own exit link opens; the filter's disclosure belongs in the footer, and the footer already exists for exactly that.
- **Do not collapse the empty state back to one message.** "No sessions in this project" over a fleet the reader just filtered is a false statement about the project.
- **Do not shrink the toggle's segments with a CSS rule, and do not swap it for a `<Select>`.** Segment padding and font size are inline in the kit (deliberately — see its own note), so a class rule is silently inert; a collapsed select hides the population comparison the control exists to state. Same trap `Panel`'s inline padding already sets for `.loom-ovcard`'s own `padding` rule, which has been inert since it was written.
- **Do not bind a rig onto `seedFleet`** to save writing `seedRiggedFleet`. The four original legs assert against agents with no rig, and this card's constraint was to leave them byte-identical.

## ✅ CLOSED — the owner's word was "terminals", and he confirmed it

This section asked whether the owner's *terminals* wording meant the project-scoped twin of the Workspace Sessions card (`9b6be377`), filtered, rather than a filter over a table — and recorded that it was his decision to make, not a side effect of this filter.

**He answered it on request `925ea659` (2026-11-04), verbatim: "Also add a filtered terminal list to the project Overview (new card)."** That shipped as card `0bcfa530`: a separate `Sessions` card directly under the roster, mounting the same expandable terminal list the Workspace node mounts, driven by **this** preference — the scope carried straight over, exactly as anticipated above.

So the tab now has two scoped surfaces under one control, and the record of how they relate — why the populations differ, why there is no second toggle, and why the list is not folded into the roster — is `docs/decisions/0bcfa530-atlas-project-overview-sessions-card.md`.
