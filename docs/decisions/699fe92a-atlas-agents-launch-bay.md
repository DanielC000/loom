# The Atlas Agents tab — Launch Bay (card `699fe92a`)

The owner's two items, verbatim, against Projects › tab "Agents":

> "Remove "What a spawn does" card."
> "Update all UI elements. I dont like it currently."

Phase 1 produced three directions as interactive mockups with a measured defect list; the owner picked **direction B — Launch Bay** (request `891ed41f`), with no amendments. Phase 2 is this build. The mockup set and its full write-up are filed in the vault under `Mockups/2026-11-04 Atlas Agents tab/`.

This record holds the decisions that are not obvious from the code, and the things a later card must not undo.

## One card, two weights — not two components

The page used to state one entity in two visual languages: spawnable agents as cards in `.loom-agentgrid`, worker rigs as rows inside a `WorkerRigs` panel with different type, different spacing and a different status treatment. They are the same thing — an agent bound to a rig — so a reader had to learn the tab twice, and neither form answered *which one do I want*: a card held a role badge, a name, one run-together grey string and two buttons.

`AgentRosterCard` is now the only agent renderer on this page, and `dispatched` is the weight it draws at: muted surface, dashed leading edge, and a `MANAGER-DISPATCHED` stamp in the slot the spawn controls occupy on a spawnable card. The stamp is load-bearing, not decoration — an empty gap where a control sits on every neighbouring card reads as a button that failed to render, while the words read as a fact about that agent.

### Do not

- **Do not read `dispatched` as a capability switch.** `splitRoster`'s partition is still the only thing that decides a rig has no spawn — this prop draws what that partition already decided. Reaching for it to hide a control on a *spawnable* agent would put a second, client-side spawn rule next to the real one, which is the exact duplication `components/atlasAgents.tsx` exists to prevent.
- **Do not give the dispatched weight a spawn or a stop.** Unchanged from card `c6160c7d`: a hand-spawned worker gets a branch nobody is reviewing. The Edit it does carry arrived deliberately in card `318b5a21` and must stay.

## The explainer is removed, and its content is not

`WhatASpawnDoes` — a static four-row panel (Primary / Override / Guard / Then) — is gone at the owner's instruction, along with `SpawnTermRow` and the `.loom-spawnterm*` rules, which had no other reader. It spent roughly half the page's lower half on generic documentation pointing at controls it could not reach.

Its four facts were not discarded. Two of them are now *on the card*, stated for the specific agent rather than in the abstract: which rig applies (`RIG`, plus `ENGINE` and `GRANTS`, which the panel never said at all) and which role that confers (the role line under the name). The other two live on the controls that perform them, where they already were — the `▾`'s own `title` ("Override the spawn role"), and the held `Live` button's `title` from `goLiveHeldControl`.

### Do not

- **Do not reinstate a generic explainer panel on this page.** If a spawn fact needs stating, state it on the card or on the control that performs it. A panel that explains controls it cannot point at is what was removed.

## The two counts are reconciled in words

The tab badge counts every agent in the project; the roster head counted only the spawnable ones. At a real render that read `AGENTS 5` against `3 agents`, about 150px apart, with nothing on screen relating them.

`rosterTally` is the one sentence that does: *"5 agents in loom — 3 you spawn, 2 your manager dispatches."* Both halves are named, so the badge's number is accounted for. The one-sided cases say so in words (`all spawned by you` / `all dispatched by your manager`) rather than printing a `0` beside a group the page does not draw — the dispatched group is omitted entirely when the project has no worker rigs, because an empty group bar is a heading over nothing.

This changed what `atlas-agents-count` contains, which two e2e specs assert. Both were updated to the new sentence and still pin the *spawnable* number they were written to pin; the assertion got stronger, not weaker, because it now also pins the total and the dispatched count that the old text left unstated.

## The duplicated sentence became a group's reason for existing

Two components said the same thing 150px apart: the orphan `WorkersDispatchedNote` line above the panels, and the `WorkerRigs` panel's own footer. Neither group had a place to carry its reason, so the fact was stated twice and belonged to neither.

Each group bar now carries one `why` beside its label. The dispatched group's copy keeps the `atlas-agents-worker-note` test id, so the sentence stays addressable under the id it has always had.

`WorkersDispatchedNote` itself is **unchanged and still exported** — it is the band panel's and the quick-spawn dialog's own line, and `e2e/atlas-agents.spec.ts` asserts it inside `atlas-band-agents`. Only this page stopped mounting a second copy of it.

## What the card reads, and what it does not fetch

Every new fact comes from a field the page already fetched and was throwing away. No `api.ts` member was added — the same hard rule the roster was built under (`docs/plans/archive/atlas-ui/02-architecture.md`):

| Fact | Source |
|---|---|
| Mission | `agent.startupPrompt`, first non-heading paragraph (`missionLine`) |
| Rig | `profile.name` — already on `RosterAgent` |
| Engine | `profile.harness` + `profile.model`, via `lib/sessions`' `shortModel` |
| Grants | `rigCapabilities(profile)` + `profile.skills` |
| Cron | the `["schedules"]` cache entry the Schedules strip below already reads |

The card draws **no session vitals** (no `gen · turns · context` strip). It had one until card `291cc8aa`, where the owner asked, verbatim: "from the agent card on a project Agent Tab i want you to remove the "gen 487 · 103 turns 23% context" from the cards." The status pill still says the agent is live. The compact `AgentRosterRow` (band panel, quick-spawn dialog) keeps its one-line `sessionVitals` meta: it is a different component the request did not name.

`RosterAgent` gained one field — `profile`, the whole row — rather than three more flattened ones, so the next fact a card needs is a derivation in `lib/atlasAgents.ts` instead of another field on every mount.

`shortModel` moved from `pages/Usage.tsx` into `lib/sessions.ts` and is now read by both. It is three lines of `replace`, which is exactly the size at which a second copy drifts unnoticed.

### Do not

- **Do not count `profile.skills === null` as zero skills.** `null` means "deliver every skill"; the chip branches on it (`all skills`) rather than reading `.length`. The two are opposite facts and the nullable field reads as the wrong one if counted.
- **Do not add a second schedules read for the card's `CRON` chip.** It shares the strip's cache key deliberately, so the fact and the strip can never disagree about what is scheduled.

## The mission preview

The agent's startup prompt is stored on every agent and had never been shown anywhere on this tab. The card shows its first *non-heading* paragraph, clamped to two lines: a prompt that opens with a markdown heading is naming the agent, which the card's own name line says one row above.

Phase 1's open question 3 scoped a startup-prompt preview to direction C. Direction B's own mockup draws it too, as the `.mission` line, and the owner picked B **as drawn with no amendments** — so it is built. Direction C's *other* addition, per-agent session history, is not in B and was not built.

With no prompt at all the card says so and falls back to the role's own `description` from `lib/roleDisplay.tsx` — copy that already ships and is already verified against the real daemon gates.

### Do not

- **Do not turn this into an editable field.** It is an orienting line; `AgentEditDialog` is where a prompt is read whole and written.

## Schedules got a home, not an implementation

Defect 8 was that the schedules readout floated as a bare line ~60px below the panels, belonging to nothing. `.loom-baysched` is a rule and a gutter around the **same** `ProjectSchedules` component.

The mockup draws schedules as a single horizontal strip. That was deliberately **not** built as a second renderer: `@decision 102bc915` keeps one read-only implementation of this component across both of its mounts, and a copy drawn to this page's own strip is precisely the fork that decision forbids. The project node's mount is untouched.

## The card's own structural styles come from `style`, not a class

`components/ui`'s `Panel` writes `background`, `border` and `padding` as **inline** styles and spreads its own `style` prop last. A stylesheet rule for any of those three, on a `<Panel className="x">`, is therefore silently inert — no error, no warning.

The card's `padding: 0`, its muted dispatched surface and its entire 2px leading edge were all written as CSS first. All three did nothing, and the rendered page still looked close enough to the mockup to pass a visual check: a dark-theme screenshot cannot distinguish a subtle 2px border from no border, and a missing surface step reads as "the two weights are subtle". They were found only by probing `getComputedStyle` on the real rendered card. They now ride `Panel`'s `style` prop.

The same pass found `overflow: hidden` on the card — added to clip the corner radius — clipping the spawn split-button's own `position: absolute` ▾ menu down to one half-visible row. The bottom radius is the control bar's job instead.

### Do not

- **Do not move `padding` / `background` / `border` for this card back into `global.css`.** They will stop working and nothing will say so. The same warning now sits on `Panel` itself.
- **Do not give this card `overflow: hidden`.** It clips the role-override menu, which is a reachable action.
- **Do not assert the leading edge's colour with a single `getComputedStyle` read.** It transitions 120ms when the `allSessions` read settles and the card learns it is live; a one-shot read lands on an intermediate colour. Poll it.

## Roles are presentation-layered, never renamed

The card draws a role's sigil at 34px in its own signal colour, and its `label · tierLabel` under the name. All of it is read from `ROLE_DISPLAY` in `lib/roleDisplay.tsx` — the existing presentation map — keyed by the untouched enum identifiers that gate the daemon's tool surface. The sigil is `aria-hidden`: the label beside it says the same thing in words.

### Do not

- **Do not key any of this on a renamed or re-spelled role string.** The identifiers are the security spine; every display concern here is a lookup in that one map, and a new role gets its presentation by being added there, not by a branch on this page.
